'use strict';

/**
 * DB Builder — Research Beaver's continuous lead sourcing service.
 *
 * Runs every 15 minutes via setInterval (registered in index.js).
 * For each enabled client: checks lead pool health, sources new leads
 * when pool is low. Keeps the DB healthy so kickoff can pull from it
 * instead of doing fresh research every time.
 *
 * Follows the same background-job pattern as sendQueueWorker.js.
 */

const pool = require('../db/pool');
const pipelineTrace = require('./pipelineTrace');
const { runWithClientContext } = require('../middleware/clientContext');
const { checkBudget } = require('./budget');
const logsService = require('./logs');
const logger = require('../utils/logger');
const { evaluateLeadQuality } = require('../utils/leadQuality');
const { searchEmailDomain } = require('./searchService');

// ── Email pattern helpers ─────────────────────────────────────────────────────

async function loadEmailPatterns(clientId) {
  try {
    const { rows } = await pool.query(
      `SELECT content FROM agent_memory
       WHERE client_id = $1 AND agent = 'research_beaver' AND key = 'email_patterns_verified'
       LIMIT 1`,
      [clientId]
    );
    if (!rows.length) return {};
    const raw = typeof rows[0].content === 'string' ? JSON.parse(rows[0].content) : rows[0].content;
    if (Array.isArray(raw)) {
      return raw.reduce((acc, e) => { if (e.domain && e.pattern) acc[e.domain] = e.pattern; return acc; }, {});
    }
    return raw || {};
  } catch { return {}; }
}

async function saveEmailPattern(clientId, domain, pattern, currentPatterns) {
  try {
    const updated = { ...currentPatterns, [domain]: pattern };
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'research_beaver', 'email_patterns_verified', $2::jsonb, 'config', NOW())
       ON CONFLICT (client_id, agent, key)
       DO UPDATE SET content = $2::jsonb, updated_at = NOW()`,
      [clientId, JSON.stringify(updated)]
    );
  } catch { /* non-critical */ }
}

function normalizeToDomains(company) {
  const clean = (company || '')
    .replace(/\bSdn\.?\s*Bhd\.?\b/gi, '')
    .replace(/\bBerhad\b/gi, '')
    .replace(/\bMalaysia\b/gi, '')
    .replace(/\(M\)/gi, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  if (!clean) return [];
  return [`${clean}.com.my`, `${clean}.com`];
}

function applyPattern(pattern, firstName, lastName) {
  return pattern
    .replace('{first}', firstName.toLowerCase())
    .replace('{last}', lastName.toLowerCase())
    .replace('{fi}', (firstName[0] || '').toLowerCase());
}

function inferPattern(email, domain) {
  const local = email.split('@')[0].toLowerCase();
  if (/^[a-z]+$/.test(local)) return `{first}@${domain}`;
  if (/^[a-z]+\.[a-z]+$/.test(local)) return `{first}.{last}@${domain}`;
  if (/^[a-z]\.[a-z]+$/.test(local)) return `{fi}.{last}@${domain}`;
  return `{first}@${domain}`;
}

async function tryEnrichEmail(lead, patterns) {
  const parts = (lead.name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join('') || '';
  if (!firstName || firstName.length < 2) return null;

  const candidateDomains = normalizeToDomains(lead.company);
  if (!candidateDomains.length) return null;

  // Step 1: check known patterns
  for (const domain of candidateDomains) {
    if (patterns[domain]) {
      const email = applyPattern(patterns[domain], firstName, lastName);
      if (email && email.includes('@')) {
        return { email, source: 'pattern_derived', domain, newPattern: null };
      }
    }
  }

  // Step 2: one Brave search per domain until we find an email
  for (const domain of candidateDomains) {
    try {
      const found = await searchEmailDomain(domain);
      if (found.length > 0) {
        const pattern = inferPattern(found[0], domain);
        const email   = applyPattern(pattern, firstName, lastName);
        if (email && email.includes('@')) {
          return { email, source: 'brave_derived', domain, newPattern: pattern };
        }
      }
    } catch { /* continue to next domain */ }
  }

  return null;
}



let _running = false;

// ── Defaults (overridden per-client via agent_memory) ────────────────────────

const DEFAULTS = {
  min_ready_pool: 200,
  min_email_ready_pool: 300,   // email-ready leads floor (was missing — fell back to 100)
  batch_size: 20,
  max_batches_per_run: 3,
  budget_cap_pct: 0.5,
};

// ── Config loader ────────────────────────────────────────────────────────────

async function getConfig(clientId) {
  try {
    const { rows } = await pool.query(
      `SELECT content FROM agent_memory
       WHERE client_id = $1 AND agent = 'research_beaver' AND key = 'db_builder_config'
       LIMIT 1`,
      [clientId]
    );
    if (rows.length > 0) {
      const stored = typeof rows[0].content === 'string'
        ? JSON.parse(rows[0].content)
        : rows[0].content;
      return { ...DEFAULTS, ...stored };
    }
  } catch (err) {
    logger.warn({ msg: '[db-builder] Failed to load config, using defaults', err: err.message });
  }
  return { ...DEFAULTS };
}

// ── DB Health Check ──────────────────────────────────────────────────────────

async function checkDbHealth(clientId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE email IS NOT NULL) AS ready_with_email,
       COUNT(*) FILTER (WHERE email IS NULL) AS ready_no_email,
       COUNT(*) AS total
     FROM leads
     WHERE client_id = $1
       AND pipeline_stage = 'prospecting'
       AND status = 'new'
       AND deleted_at IS NULL
       AND created_at >= NOW() - INTERVAL '30 days'`,
    [clientId]
  );

  const total = parseInt(rows[0].total, 10) || 0;
  const withEmail = parseInt(rows[0].ready_with_email, 10) || 0;
  const noEmail = parseInt(rows[0].ready_no_email, 10) || 0;

  return { total, withEmail, noEmail };
}

// ── Lead Saver (mirrors agents.js:1849-1937 dedup + INSERT pattern) ──────────

async function saveLead(clientId, lead, searchQuery, enrichContext = null) {
  // Quality gate — reject placeholder/freelance/generic-company leads at source.
  // Saves enrichment budget downstream and keeps the prospecting pool clean.
  const quality = evaluateLeadQuality(lead);
  if (!quality.ok) {
    logger.info({
      msg: '[db-builder] Lead rejected by quality gate',
      reason: quality.reason,
      name: lead.name,
      company: lead.company,
    });
    await logsService.createLog(clientId, {
      agent: 'research_beaver',
      action: 'lead_quality_reject',
      target_type: 'system',
      metadata: {
        reason: quality.reason,
        name: lead.name,
        company: lead.company,
        source: 'db_builder',
      },
    });
    return null;
  }

  // Email dedup
  if (lead.email) {
    const { rows } = await pool.query(
      `SELECT id FROM leads WHERE client_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
      [clientId, lead.email]
    );
    if (rows.length > 0) return null;
  }

  // LinkedIn URL dedup
  if (lead.linkedin_url) {
    const { rows } = await pool.query(
      `SELECT id FROM leads WHERE client_id = $1 AND linkedin_url = $2 AND deleted_at IS NULL LIMIT 1`,
      [clientId, lead.linkedin_url]
    );
    if (rows.length > 0) return null;
  }

  // Name+company fallback dedup
  if (!lead.email && !lead.linkedin_url && lead.name && lead.company) {
    const nameKey = lead.name.toLowerCase().trim();
    const companyKey = lead.company.toLowerCase().trim();
    if (nameKey !== 'unknown contact' && companyKey !== 'unknown company') {
      const { rows } = await pool.query(
        `SELECT id FROM leads WHERE client_id = $1 AND LOWER(name) = $2 AND LOWER(company) = $3 AND deleted_at IS NULL LIMIT 1`,
        [clientId, nameKey, companyKey]
      );
      if (rows.length > 0) return null;
    }
  }

  // Validate LinkedIn URL — strip fakes before saving
  const { sanitiseLinkedInUrl } = require('../utils/validateLinkedIn');
  lead.linkedin_url = sanitiseLinkedInUrl(lead.linkedin_url, `db_builder ${lead.name}`);

  // Must have at least one contact channel — quick reject before enrichment cost
  if (!lead.email && !lead.linkedin_url) return null;

  // Build metadata
  const meta = lead.metadata || {};
  if (lead.signal)    meta.signal    = lead.signal;
  if (lead.angle)     meta.angle     = lead.angle;
  if (lead.friction)  meta.friction  = lead.friction;
  if (lead.why_now)   meta.why_now   = lead.why_now;
  if (lead.notes)     meta.notes     = lead.notes;
  if (lead.snippet)   meta.snippet   = lead.snippet;
  if (searchQuery)    meta.search_query = searchQuery;
  meta.source = 'db_builder';
  if (lead.data_source) meta.data_source = lead.data_source;

  // Email enrichment at source time — last chance before the contact gate
  if (!lead.email && enrichContext?.patterns) {
    const enriched = await tryEnrichEmail(lead, enrichContext.patterns).catch(() => null);
    if (enriched) {
      lead.email = enriched.email;
      lead.email_source = enriched.source;
      if (enriched.newPattern) {
        saveEmailPattern(clientId, enriched.domain, enriched.newPattern, enrichContext.patterns).catch(() => {});
        enrichContext.patterns[enriched.domain] = enriched.newPattern;
      }
    }
    meta.outreach_route = lead.email ? 'email' : 'linkedin';
  }

  // Tiered contact gate (migration 061, 2026-05-05): assigns A/B tier;
  // C rejected and logged to research_misses. Manual override via
  // lead.linkedin_only_override forces Tier B regardless of score.
  const contactGate = require('./contactGate');
  const gateResult = await contactGate.tryPersistSourcedLead(clientId, lead, {
    sourceStrategy: 'db_builder',
    queryUsed: searchQuery,
    allowLinkedinOnly: !!lead.linkedin_only_override,
  });
  if (!gateResult.passed) {
    return null;
  }
  const leadTier = gateResult.tier;

  // 2026-05-14 (Path B / Mismatch 6 source-side fix): ICP v2 gate at sourcing time.
  // contactGate only checks tier (email-verified / linkedin+score). It does NOT
  // catch off-persona ("Account Director"), wrong size (MNC like Shopee), wrong
  // vertical (freelance), or data-integrity (name == company placeholder). Per
  // PLAN.md Phase 2 V2: "ICP gate enforced AT SOURCE only" — re-running this gate
  // at every kickoff (autonomous.js:1606) wastes tokens AND was silently broken
  // (rejected_legacy_audit isn't in leads_status_check). Run it here once instead.
  const { applyIcpV2Filter } = require('./agents');
  const v2 = applyIcpV2Filter(lead);
  if (!v2.pass) {
    console.warn(`[db_builder] ICP v2 reject at sourcing: ${lead.name} (${lead.company}) — ${v2.reason}`);
    await pool.query(
      `INSERT INTO research_misses
         (client_id, candidate_name, candidate_company, candidate_title,
          candidate_linkedin, candidate_email, miss_reason, source_strategy, query_used, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        clientId,
        lead.name || null,
        lead.company || null,
        lead.title || null,
        lead.linkedin_url || null,
        lead.email || null,
        `icp_v2_${v2.status || 'rejected'}: ${v2.reason}`,
        'db_builder_icp_v2_gate',
        searchQuery,
        JSON.stringify({ ...(lead.metadata || {}), icp_v2_status: v2.status, icp_v2_reason: v2.reason }),
      ]
    ).catch(err => console.warn('[db_builder] icp_v2 miss insert failed:', err.message));
    return null;
  }

  try {
    // Phase 2 V2 Step 6 (2026-05-08): buying_signal_strength + signal_dated_at
    // contract enforcement at write time. Producer should emit these from the
    // Research Beaver structured response. Defaults: 'lite' + NOW() if absent
    // (graceful degradation while prompt rolls out — Step 9 adds CHECK constraint
    // after 5 days clean production data).
    const buyingSignalStrength = lead.buying_signal_strength
      || (lead.metadata?.buying_signal_strength)
      || 'lite';
    const signalDatedAt = lead.signal_dated_at
      || lead.metadata?.signal_dated_at
      || new Date().toISOString();

    const res = await pool.query(
      `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                          pipeline_stage, status, email_verified, email_source, linkedin_url, metadata,
                          lead_tier, tiered_at,
                          buying_signal_strength, signal_dated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'research_beaver','prospecting','new',$8,$9,$10,$11,$12,NOW(),$13,$14)
       ON CONFLICT (client_id, linkedin_url) WHERE linkedin_url IS NOT NULL AND deleted_at IS NULL
       DO NOTHING
       RETURNING id`,
      [
        clientId,
        lead.name || 'Unknown Contact',
        lead.email || null,
        lead.company || 'Unknown Company',
        lead.title || null,
        lead.signal_tier || null,
        lead.score || 0,
        lead.email_verified || false,
        lead.email_source || null,
        lead.linkedin_url || null,
        JSON.stringify(meta),
        leadTier,
        buyingSignalStrength,
        signalDatedAt,
      ]
    );
    const insertedId = res.rows[0]?.id || null;
    // Phase 1 (2026-05-08): pipeline_traces enrolled at sourcing time
    if (insertedId) {
      pipelineTrace.traceStage(clientId, {
        lead_id: insertedId,
        stage: 'enrolled',
        status: 'sourced',
        agent: 'research_beaver',
        score: lead.score || null,
        pipeline_path: 'dbBuilder',
        metadata: {
          lead_tier: leadTier,
          signal_tier: lead.signal_tier || null,
          email_verified: !!lead.email_verified,
          email_source: lead.email_source || null,
          has_linkedin: !!lead.linkedin_url,
        },
      }).catch(() => {});
    }
    return insertedId;
  } catch (err) {
    logger.warn({ msg: '[db-builder] Failed to save lead', name: lead.name, err: err.message });
    return null;
  }
}

// ── Source Leads ──────────────────────────────────────────────────────────────

async function sourceLeads(clientId, deficit, config) {
  // Lazy-load to avoid circular requires at startup
  const researchModule = require('./research');

  // Load ICP memory
  const { rows: icpRows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
    [clientId]
  );
  const icpMemory = icpRows[0]?.content || null;

  if (!icpMemory) {
    logger.warn({ msg: '[db-builder] No ICP memory found, skipping sourcing', clientId });
    await logsService.createLog(clientId, {
      agent: 'research_beaver',
      action: 'db_builder_skipped',
      target_type: 'system',
      metadata: { reason: 'no_icp_memory' },
    });
    return 0;
  }

  const batchCount = Math.min(
    Math.ceil(deficit / config.batch_size),
    config.max_batches_per_run
  );

  let totalSaved = 0;

  // 2026-05-15: enrichContext was referenced by saveLead() below but never
  // defined in this scope — every cron batch threw ReferenceError, caught
  // silently by the per-batch try/catch and logged as "saved: 0". The 08:30
  // and 13:00 cron has sourced 0 leads for days because of this. sourceLeadsOnDemand
  // already passes { patterns } correctly; mirror that here.
  const enrichContext = { patterns: await loadEmailPatterns(clientId) };

  for (let i = 0; i < batchCount; i++) {
    // Re-check budget before each batch
    const budget = await checkBudget(clientId);
    if (!budget.allowed || budget.pct >= config.budget_cap_pct) {
      logger.info({ msg: '[db-builder] Budget cap reached, stopping', clientId, pct: budget.pct });
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'db_builder_budget_pause',
        target_type: 'system',
        metadata: { spend: budget.spend, budget: budget.budget, pct: budget.pct, batch: i },
      });
      break;
    }

    try {
      const result = await researchModule.researchLeads(clientId, {
        icpMemory,
        targetCount: config.batch_size,
        batchIndex: Date.now(), // unique batch index for query rotation
      });

      const leads = result.leads || [];
      const searchQuery = result.queriesUsed?.join(' | ') || '';

      let batchSaved = 0;
      for (const lead of leads) {
        const savedId = await saveLead(clientId, lead, searchQuery, enrichContext);
        if (savedId) batchSaved++;
      }

      totalSaved += batchSaved;

      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'db_batch_complete',
        target_type: 'system',
        metadata: {
          batch: i + 1,
          of: batchCount,
          found: leads.length,
          saved: batchSaved,
          queries: result.queriesUsed?.length || 0,
        },
      });

      logger.info({
        msg: '[db-builder] Batch complete',
        batch: i + 1,
        found: leads.length,
        saved: batchSaved,
      });

      // Brief pause between batches
      if (i < batchCount - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    } catch (err) {
      logger.warn({ msg: '[db-builder] Batch failed', batch: i + 1, err: err.message });
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'db_batch_error',
        target_type: 'system',
        metadata: { batch: i + 1, error: err.message },
      });
    }
  }

  return totalSaved;
}

// ── Main Loop ────────────────────────────────────────────────────────────────

async function runDbBuilder() {
  if (_running) return;
  _running = true;

  try {
    const enabledSlugs = (process.env.DB_BUILDER_ENABLED_CLIENTS || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (enabledSlugs.length === 0) {
      // 2026-05-14: was silent `return` — masked the fact that DB Builder
      // has been disabled (env empty) since 2026-05-05 Brave-quota burn,
      // even after MJ raised the Brave cap 2026-05-12. Without this log
      // MJ can't tell from the runtime that the pool isn't being
      // replenished. To re-enable: set DB_BUILDER_ENABLED_CLIENTS in
      // Railway env to a comma-separated list of slugs (e.g. 'beaver-solutions').
      console.warn('[db-builder] SKIPPED — DB_BUILDER_ENABLED_CLIENTS env is empty. No leads will be sourced. Set the env var in Railway to enable.');
      return;
    }

    const { rows: clients } = await pool.query(
      `SELECT id, slug FROM clients WHERE slug = ANY($1)`,
      [enabledSlugs]
    );

    for (const client of clients) {
      try {
        await runWithClientContext(client.id, async () => {
          const config = await getConfig(client.id);

          // Wave 1 (2026-05-03): Captain may have written a rebuild_email_pool
          // directive with a higher email-ready target than the default config.
          // Read it before sizing the run.
          const directivesSvc = require('./directives');
          const dbDirectives = await directivesSvc.readPendingDirectives(client.id, 'db_builder').catch(() => []);
          const rebuildDirective = dbDirectives.find(d => d.directive_type === 'rebuild_email_pool');
          const consumedDirectiveIds = [];
          if (rebuildDirective) consumedDirectiveIds.push(rebuildDirective.id);

          // ── Phase 2 V2 Step 8b (2026-05-09): cold_research_request consumer ──
          // When DIRECTOR_INLINE_RESEARCH_DISABLED=true, directorExecute queues
          // cold_research_request directives instead of running research inline.
          // Process them here regardless of pool health — they're explicit commands
          // from the director, not deficit-driven.
          const coldResearchDirectives = dbDirectives.filter(d => d.directive_type === 'cold_research_request');
          if (coldResearchDirectives.length > 0) {
            const researchModule = require('./research');
            const { rows: icpRows } = await pool.query(
              `SELECT content FROM agent_memory
               WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
              [client.id]
            );
            const icpMemory = icpRows[0]?.content || null;
            const enrichPatterns = await loadEmailPatterns(client.id);

            for (const directive of coldResearchDirectives) {
              const { command, limit: targetCount, plan_id } = directive.payload || {};
              if (!command) {
                consumedDirectiveIds.push(directive.id);
                continue;
              }

              // Budget gate per directive
              const budget = await checkBudget(client.id);
              if (!budget.allowed) {
                logger.info({ msg: '[db-builder] Budget exhausted, skipping cold_research_request', command });
                break;
              }

              try {
                logger.info({ msg: '[db-builder] Processing cold_research_request', command, plan_id });
                const result = await researchModule.researchLeads(client.id, {
                  icpMemory: icpMemory || {},
                  targetCount: targetCount || 10,
                  batchIndex: Date.now(),
                  commandOverride: command,
                });

                const leads = result.leads || [];
                let saved = 0;
                for (const lead of leads) {
                  const savedId = await saveLead(client.id, lead, command, { patterns: enrichPatterns });
                  if (savedId) saved++;
                }

                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'cold_research_consumed',
                  target_type: 'system',
                  metadata: { command, plan_id, found: leads.length, saved, directive_id: directive.id },
                });

                logger.info({ msg: '[db-builder] cold_research_request complete', command, found: leads.length, saved });
              } catch (err) {
                logger.warn({ msg: '[db-builder] cold_research_request failed', command, err: err.message });
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'cold_research_error',
                  target_type: 'system',
                  metadata: { command, plan_id, error: err.message, directive_id: directive.id },
                });
              }
              consumedDirectiveIds.push(directive.id);
            }
          }

          // Check pool health
          const health = await checkDbHealth(client.id);
          // Deficit is now computed against EMAIL-READY pool size, not raw total.
          // LinkedIn-only leads exist but don't count toward the floor — they
          // can't be drafted under the email-first policy.
          const emailPoolTarget = rebuildDirective?.payload?.target_min || config.min_email_ready_pool || 100;
          const emailDeficit = Math.max(0, emailPoolTarget - health.withEmail);

          await logsService.createLog(client.id, {
            agent: 'research_beaver',
            action: 'db_health_check',
            target_type: 'system',
            metadata: {
              total: health.total,
              with_email: health.withEmail,
              no_email: health.noEmail,
              email_pool_target: emailPoolTarget,
              email_deficit: emailDeficit,
              healthy: emailDeficit === 0,
              captain_directive: rebuildDirective ? { reason: rebuildDirective.reason, severity: rebuildDirective.severity } : null,
            },
          });

          if (emailDeficit === 0) {
            logger.info({ msg: '[db-builder] Email pool healthy', slug: client.slug, with_email: health.withEmail, target: emailPoolTarget });
            if (consumedDirectiveIds.length > 0) {
              await directivesSvc.markConsumed(client.id, consumedDirectiveIds).catch(() => {});
            }
            return;
          }
          const deficit = emailDeficit;

          // Check budget before sourcing
          const budget = await checkBudget(client.id);
          if (!budget.allowed || budget.pct >= config.budget_cap_pct) {
            logger.info({ msg: '[db-builder] Budget cap, skipping', slug: client.slug, pct: budget.pct });
            return;
          }

          logger.info({
            msg: '[db-builder] Pool low, sourcing',
            slug: client.slug,
            total: health.total,
            deficit,
          });

          const totalSaved = await sourceLeads(client.id, deficit, config);

          // Log summary
          const newHealth = await checkDbHealth(client.id);
          await logsService.createLog(client.id, {
            agent: 'research_beaver',
            action: 'db_sourcing_complete',
            target_type: 'system',
            metadata: {
              saved: totalSaved,
              pool_before_total: health.total,
              pool_after_total: newHealth.total,
              email_pool_before: health.withEmail,
              email_pool_after: newHealth.withEmail,
              email_pool_target: emailPoolTarget,
              email_deficit_remaining: Math.max(0, emailPoolTarget - newHealth.withEmail),
            },
          });

          // Mark Captain's directive consumed once the rebuild attempt is done.
          if (consumedDirectiveIds.length > 0) {
            await directivesSvc.markConsumed(client.id, consumedDirectiveIds).catch(() => {});
          }

          logger.info({
            msg: '[db-builder] Sourcing complete',
            slug: client.slug,
            saved: totalSaved,
            email_pool: newHealth.withEmail,
            email_target: emailPoolTarget,
          });

          // 2026-05-14: Daily brief for Captain. Captain reads this at the
          // 09:00 MYT morning brief to surface miss-to-target + ICP source-side
          // reject patterns. Per PER-BEAVER-KPI-ARCHITECTURE.md.
          // Upsert: morning fire writes initial, midday fire updates with
          // top-up numbers under the same key.
          try {
            const todayUtc = new Date().toISOString().slice(0, 10);
            const { rows: [missRow] } = await pool.query(
              `SELECT COUNT(*)::int AS n FROM research_misses
               WHERE client_id = $1 AND created_at >= CURRENT_DATE
                 AND source_strategy = 'db_builder_icp_v2_gate'`,
              [client.id]
            );
            await pool.query(
              `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
               VALUES ($1, 'research_beaver', $2, $3::jsonb, 'config')
               ON CONFLICT (client_id, agent, key) DO UPDATE
                 SET content = EXCLUDED.content, updated_at = NOW()`,
              [
                client.id,
                `daily_brief_${todayUtc}`,
                JSON.stringify({
                  date: todayUtc,
                  target: 40,
                  saved_today: totalSaved,
                  email_pool_now: newHealth.withEmail,
                  email_target: emailPoolTarget,
                  email_deficit: Math.max(0, emailPoolTarget - newHealth.withEmail),
                  icp_v2_source_rejects: missRow?.n || 0,
                  captured_at: new Date().toISOString(),
                  hit_target: totalSaved >= 40,
                }),
              ]
            );
          } catch (err) {
            logger.warn({ msg: '[db-builder] daily_brief write failed', err: err.message });
          }
        });
      } catch (err) {
        logger.warn({ msg: '[db-builder] Client error', slug: client.slug, err: err.message });
      }
    }
  } finally {
    _running = false;
  }
}

// ── On-Demand Sourcing (called by autonomous kickoff when pool is dry) ───────

async function sourceLeadsOnDemand(clientId, { neededChannel = 'email', batchSize = 20 } = {}) {
  const researchModule = require('./research');

  const { rows: icpRows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
    [clientId]
  );
  const icpMemory = icpRows[0]?.content || null;
  if (!icpMemory) {
    logger.warn({ msg: '[db-builder] on-demand: no ICP memory, cannot source' });
    return { saved: 0, reason: 'no_icp_memory' };
  }

  const budget = await checkBudget(clientId);
  if (!budget.allowed) {
    logger.info({ msg: '[db-builder] on-demand: budget exhausted' });
    return { saved: 0, reason: 'budget_exhausted' };
  }

  const patterns = await loadEmailPatterns(clientId);

  let result;
  try {
    result = await researchModule.researchLeads(clientId, {
      icpMemory,
      targetCount: batchSize,
      batchIndex: Date.now(),
    });
  } catch (err) {
    logger.warn({ msg: '[db-builder] on-demand research failed', err: err.message });
    return { saved: 0, reason: 'research_error' };
  }

  const leads = result.leads || [];
  let saved = 0;
  for (const lead of leads) {
    const savedId = await saveLead(clientId, lead, result.queriesUsed?.join(' | ') || '', { patterns });
    if (savedId) saved++;
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'on_demand_sourcing_complete',
    target_type: 'system',
    metadata: { trigger: 'pool_dry_kickoff', neededChannel, found: leads.length, saved },
  });

  const health = await checkDbHealth(clientId);
  logger.info({ msg: '[db-builder] on-demand complete', found: leads.length, saved, pool_email: health.withEmail });
  return { saved, health, reason: saved > 0 ? 'sourced' : 'no_results' };
}

module.exports = { runDbBuilder, checkDbHealth, sourceLeadsOnDemand };
