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
const spendGuard = require('./spendGuard');
const { todayInMalaysia } = require('../utils/businessDay');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function loadCanonicalIcp(clientId) {
  const { rows: icpRows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
    [clientId]
  );
  const fallback = icpRows[0]?.content || null;
  try {
    const { getLegacyIcpForClient } = require('./tenantContext');
    return await getLegacyIcpForClient(clientId, { source: 'service', fallback });
  } catch (err) {
    logger.warn({ msg: '[db-builder] canonical ICP load failed, using agent_memory fallback', err: err.message });
    return fallback;
  }
}

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
  // Daily autonomy needs 30 email + 20 LinkedIn, not a 300-lead hoard.
  // Keeping this low prevents the 08:30 pool maintainer from spending a full
  // provider day before kickoff proves it needs more supply.
  min_email_ready_pool: 30,
  min_linkedin_ready_pool: 20,
  batch_size: 20,
  max_batches_per_run: 3,
  budget_cap_pct: 0.5,
};

function finiteScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function effectiveLeadScore(lead = {}) {
  const candidates = [
    lead.score,
    lead.quality_score,
    lead.verification?.score,
    lead.metadata?.verification?.score,
    lead.metadata?.score,
  ];
  for (const value of candidates) {
    const n = finiteScore(value);
    if (n !== null && n > 0) return n;
  }
  return 0;
}

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
       COUNT(*) FILTER (
         WHERE lead_tier = 'A'
           AND email IS NOT NULL AND email <> ''
           AND NOT EXISTS (
             SELECT 1 FROM messages m
              WHERE m.client_id = leads.client_id
                AND m.lead_id = leads.id
                AND m.status <> 'deleted'
           )
       ) AS available_with_email,
       COUNT(*) FILTER (
         WHERE lead_tier = 'B'
           AND linkedin_url IS NOT NULL AND linkedin_url <> ''
           AND NOT EXISTS (
             SELECT 1 FROM messages m
              WHERE m.client_id = leads.client_id
                AND m.lead_id = leads.id
                AND m.status <> 'deleted'
           )
       ) AS available_linkedin,
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
  const availableWithEmail = parseInt(rows[0].available_with_email, 10) || 0;
  const availableLinkedin = parseInt(rows[0].available_linkedin, 10) || 0;

  return { total, withEmail, noEmail, availableWithEmail, availableLinkedin };
}

// ── Lead Saver (mirrors agents.js:1849-1937 dedup + INSERT pattern) ──────────

async function saveLead(clientId, lead, searchQuery, enrichContext = null) {
  const leadScore = effectiveLeadScore(lead);
  lead.score = leadScore;
  if (lead.quality_score === undefined || lead.quality_score === null || lead.quality_score === '') {
    lead.quality_score = leadScore;
  }

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
  if (lead.metadata?.signal_package) meta.signal_package = lead.metadata.signal_package;

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
  const v2 = applyIcpV2Filter({ ...lead, score: leadScore });
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
        leadScore,
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
        score: leadScore || null,
        pipeline_path: 'dbBuilder',
        metadata: {
          lead_tier: leadTier,
          signal_tier: lead.signal_tier || null,
          signal_package: meta.signal_package || null,
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
  const { runSignalHunt, saveSignalLeads, platformFunnelFromSignalHuntResult } = require('./signalHunt');
  const { loadLatestApprovedPlatformPlan } = require('./platformPlan');
  const { recordSignalHuntPlatformFunnel, updateStrategyStateFromPlan } = require('./platformYield');
  const researchModule = require('./research');

  // Load canonical tenant ICP, falling back to director memory when needed.
  const icpMemory = await loadCanonicalIcp(clientId);

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

  const hardBatchCap = Math.max(1, envInt('DB_BUILDER_MAX_BATCHES_PER_RUN', 1));
  const batchCount = Math.min(
    Math.ceil(deficit / config.batch_size),
    config.max_batches_per_run,
    hardBatchCap
  );

  let totalSaved = 0;
  const signalQueryCap = Math.max(
    1,
    Math.min(envInt('DB_BUILDER_SIGNAL_FIRST_QUERY_CAP', 12), config.batch_size || 20)
  );
  const legacyResearchFallbackEnabled = process.env.DB_BUILDER_LEGACY_RESEARCH_FALLBACK_ENABLED === 'true';
  const deficitPlatformPlan = await loadLatestApprovedPlatformPlan(clientId, {
    discoveryMode: 'vertical_first',
  }).catch(err => {
    logger.warn({ msg: '[db-builder] approved platform plan lookup failed', clientId, err: err.message });
    return null;
  });
  const effectiveSignalQueryCap = deficitPlatformPlan
    ? Math.max(1, Math.floor(Number(deficitPlatformPlan.max_paid_queries || signalQueryCap) || signalQueryCap))
    : signalQueryCap;

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
      let signalLeads = [];
      let savedSignalLeads = [];
      let signalSaved = 0;
      let platformYieldEvents = [];

      if (deficitPlatformPlan) {
        signalLeads = await runSignalHunt(clientId, {
          maxLeads: config.batch_size,
          icp: icpMemory,
          maxPaidQueries: effectiveSignalQueryCap,
          platformPlan: deficitPlatformPlan,
          plan_id: deficitPlatformPlan.id || deficitPlatformPlan.plan_hash || 'db_builder_deficit',
        });
        savedSignalLeads = await saveSignalLeads(clientId, signalLeads);
        signalSaved = Array.isArray(savedSignalLeads) ? savedSignalLeads.length : 0;
        totalSaved += signalSaved;
        platformYieldEvents = await recordSignalHuntPlatformFunnel(clientId, {
          funnel: platformFunnelFromSignalHuntResult(signalLeads),
          savedLeads: savedSignalLeads,
          plan: deficitPlatformPlan,
          mode: deficitPlatformPlan.mode || 'proof',
          source: 'db_builder_deficit',
          metadata: {
            trigger: 'db_builder_deficit',
          },
        }).catch(err => {
          logger.warn({ msg: '[db-builder] deficit platform yield record failed', err: err.message });
          return [];
        });
        await updateStrategyStateFromPlan(clientId, deficitPlatformPlan, {
          saved_leads: signalSaved,
          approval_ready: signalSaved,
          blocker: signalSaved > 0 ? null : 'zero_saved_leads',
          trusted_by: 'db_builder_deficit',
        }).catch(err => logger.warn({ msg: '[db-builder] deficit strategy state update failed', err: err.message }));
      }

      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'db_signal_first_complete',
        target_type: 'system',
        metadata: {
          batch: i + 1,
          of: batchCount,
          source: deficitPlatformPlan ? 'signal_hunt' : 'none',
          found: signalLeads.length,
          saved: signalSaved,
          save_stats: savedSignalLeads?.saveStats || null,
          max_paid_queries: effectiveSignalQueryCap,
          platform_plan_id: deficitPlatformPlan?.id || null,
          platform_plan_hash: deficitPlatformPlan?.plan_hash || null,
          platform_yield_events: platformYieldEvents.map(row => row.id),
          legacy_research_fallback_enabled: legacyResearchFallbackEnabled,
        },
      });

      if (signalSaved > 0 || !legacyResearchFallbackEnabled) {
        await logsService.createLog(clientId, {
          agent: 'research_beaver',
          action: 'db_batch_complete',
          target_type: 'system',
          metadata: {
            batch: i + 1,
            of: batchCount,
            source: deficitPlatformPlan ? 'signal_hunt' : 'none',
            found: signalLeads.length,
            saved: signalSaved,
            queries: deficitPlatformPlan ? effectiveSignalQueryCap : 0,
            platform_plan_id: deficitPlatformPlan?.id || null,
            platform_plan_hash: deficitPlatformPlan?.plan_hash || null,
            platform_yield_events: platformYieldEvents.map(row => row.id),
            legacy_research_fallback_enabled: legacyResearchFallbackEnabled,
            fallback_skipped_reason: signalSaved > 0 ? 'signal_first_saved' : (deficitPlatformPlan ? 'legacy_research_disabled' : 'platform_plan_required'),
          },
        });

        logger.info({
          msg: '[db-builder] Signal-first batch complete',
          batch: i + 1,
          found: signalLeads.length,
          saved: signalSaved,
          platform_plan_id: deficitPlatformPlan?.id || null,
          legacy_research_fallback_enabled: legacyResearchFallbackEnabled,
        });

        // Brief pause between batches
        if (i < batchCount - 1) {
          await new Promise(r => setTimeout(r, 3000));
        }
        continue;
      }

      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'db_signal_first_legacy_fallback',
        target_type: 'system',
        metadata: {
          batch: i + 1,
          of: batchCount,
          reason: deficitPlatformPlan ? 'signal_first_saved_zero' : 'platform_plan_required',
          max_paid_queries: effectiveSignalQueryCap,
          platform_plan_id: deficitPlatformPlan?.id || null,
          platform_plan_hash: deficitPlatformPlan?.plan_hash || null,
        },
      });

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
          source: 'legacy_research',
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
          const [dbDirectives, researchDirectives] = await Promise.all([
            directivesSvc.readPendingDirectives(client.id, 'db_builder').catch(() => []),
            directivesSvc.readPendingDirectives(client.id, 'research_beaver').catch(() => []),
          ]);
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
            const icpMemory = await loadCanonicalIcp(client.id);
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

          const repairSignalPackageDirectives = researchDirectives.filter(d => d.directive_type === 'repair_signal_package');
          if (repairSignalPackageDirectives.length > 0) {
            const { repairLeadSignalPackage } = require('./researchEnrichment');

            for (const directive of repairSignalPackageDirectives) {
              const payload = { ...(directive.payload || {}), directive_id: directive.id };
              if (!payload.lead_id) {
                consumedDirectiveIds.push(directive.id);
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'research_repair_skipped',
                  target_type: 'system',
                  metadata: { reason: 'missing_lead_id', directive_id: directive.id, payload },
                }).catch(() => {});
                continue;
              }

              const budget = await checkBudget(client.id);
              if (!budget.allowed) {
                logger.info({ msg: '[db-builder] Budget exhausted, keeping repair_signal_package pending', lead_id: payload.lead_id });
                break;
              }

              try {
                logger.info({ msg: '[db-builder] Processing repair_signal_package', lead_id: payload.lead_id, directive_id: directive.id });
                const result = await repairLeadSignalPackage(client.id, payload);
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: result.repaired ? 'research_repair_consumed' : 'research_repair_not_completed',
                  target_type: 'lead',
                  target_id: payload.lead_id,
                  metadata: {
                    directive_id: directive.id,
                    repaired: result.repaired === true,
                    reason: result.reason || null,
                    package_hash: result.package_hash || null,
                    missing_fields: result.missing_fields || [],
                  },
                }).catch(() => {});
                consumedDirectiveIds.push(directive.id);
              } catch (err) {
                logger.warn({ msg: '[db-builder] repair_signal_package failed', lead_id: payload.lead_id, err: err.message });
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'research_repair_error',
                  target_type: 'lead',
                  target_id: payload.lead_id,
                  metadata: { directive_id: directive.id, error: err.message },
                }).catch(() => {});
              }
            }
          }

          const approvedPlatformPlanDirectives = researchDirectives.filter(d => d.directive_type === 'execute_approved_platform_plan');
          if (approvedPlatformPlanDirectives.length > 0) {
            const { loadApprovedPlatformPlan } = require('./platformPlan');
            const { runSignalHunt, saveSignalLeads, platformFunnelFromSignalHuntResult } = require('./signalHunt');
            const { recordSignalHuntPlatformFunnel } = require('./platformYield');
            const icpMemory = await loadCanonicalIcp(client.id);

            for (const directive of approvedPlatformPlanDirectives) {
              const payload = directive.payload || {};
              if (!payload.plan_id || !payload.plan_hash) {
                consumedDirectiveIds.push(directive.id);
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'platform_plan_skipped',
                  target_type: 'system',
                  metadata: {
                    reason: 'platform_plan_required',
                    directive_id: directive.id,
                    payload,
                  },
                }).catch(() => {});
                continue;
              }

              const budget = await checkBudget(client.id);
              if (!budget.allowed) {
                logger.info({ msg: '[db-builder] Budget exhausted, keeping execute_approved_platform_plan pending', plan_id: payload.plan_id });
                break;
              }

              try {
                const platformPlan = await loadApprovedPlatformPlan(client.id, payload.plan_id, payload.plan_hash);
                const cap = Math.max(1, Number(payload.cap || platformPlan.requested_count || 5) || 5);
                const maxPaidQueries = Math.max(1, Number(platformPlan.max_paid_queries || cap) || cap);
                logger.info({ msg: '[db-builder] Processing execute_approved_platform_plan', plan_id: platformPlan.id, cap });
                const signalLeads = await runSignalHunt(client.id, {
                  maxLeads: cap,
                  icp: icpMemory || {},
                  maxPaidQueries,
                  platformPlan,
                  plan_id: platformPlan.id,
                });
                const savedSignalLeads = await saveSignalLeads(client.id, signalLeads);
                const platformYieldEvents = await recordSignalHuntPlatformFunnel(client.id, {
                  funnel: platformFunnelFromSignalHuntResult(signalLeads),
                  savedLeads: savedSignalLeads,
                  plan: platformPlan,
                  mode: payload.mode || platformPlan.mode || 'proof',
                  directiveId: directive.id,
                  source: 'db_builder_execute_approved_platform_plan',
                });

                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'platform_plan_consumed',
                  target_type: 'system',
                  metadata: {
                    directive_id: directive.id,
                    plan_id: platformPlan.id,
                    plan_hash: platformPlan.plan_hash,
                    query_set_hash: platformPlan.query_set_hash,
                    mode: payload.mode || platformPlan.mode || null,
                    send_allowed: false,
                    cap,
                    max_paid_queries: maxPaidQueries,
                    platform_sequence_count: platformPlan.platform_sequence.length,
                    found: signalLeads.length,
                    saved: savedSignalLeads.length,
                    platform_yield_events: platformYieldEvents.map(row => row.id),
                  },
                });
                consumedDirectiveIds.push(directive.id);
                logger.info({ msg: '[db-builder] execute_approved_platform_plan complete', plan_id: platformPlan.id, found: signalLeads.length, saved: savedSignalLeads.length });
              } catch (err) {
                const errorCode = err.code || null;
                logger.warn({ msg: '[db-builder] execute_approved_platform_plan failed', plan_id: payload.plan_id, err: err.message, code: errorCode });
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: errorCode === 'platform_plan_required' ? 'platform_plan_skipped' : 'platform_plan_error',
                  target_type: 'system',
                  metadata: {
                    reason: errorCode === 'platform_plan_required' ? 'platform_plan_required' : 'execution_failed',
                    directive_id: directive.id,
                    plan_id: payload.plan_id || null,
                    plan_hash: payload.plan_hash || null,
                    error: err.message,
                    code: errorCode,
                  },
                }).catch(() => {});
                if (errorCode === 'platform_plan_required') {
                  consumedDirectiveIds.push(directive.id);
                }
              }
            }
          }

          const signalPlaybookDirectives = researchDirectives.filter(d => d.directive_type === 'run_signal_playbook');
          if (signalPlaybookDirectives.length > 0) {
            const { loadApprovedPlatformPlan } = require('./platformPlan');
            const { runSignalHunt, saveSignalLeads, platformFunnelFromSignalHuntResult } = require('./signalHunt');
            const { recordSignalHuntPlatformFunnel } = require('./platformYield');
            const icpMemory = await loadCanonicalIcp(client.id);

            for (const directive of signalPlaybookDirectives) {
              const payload = directive.payload || {};
              const hasApprovedPlatformPlanRef = !!(payload.plan_id && payload.plan_hash);
              if (!hasApprovedPlatformPlanRef && payload.allow_legacy_paid_signal_playbook !== true) {
                consumedDirectiveIds.push(directive.id);
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'signal_playbook_skipped',
                  target_type: 'system',
                  metadata: {
                    reason: 'platform_plan_required',
                    directive_id: directive.id,
                    payload,
                  },
                }).catch(() => {});
                continue;
              }

              if (!payload.signal_id && payload.replacement_for_rejection !== true && !hasApprovedPlatformPlanRef) {
                consumedDirectiveIds.push(directive.id);
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'signal_playbook_skipped',
                  target_type: 'system',
                  metadata: {
                    reason: 'missing_signal_id',
                    directive_id: directive.id,
                    payload,
                  },
                }).catch(() => {});
                continue;
              }

              const budget = await checkBudget(client.id);
              if (!budget.allowed) {
                logger.info({ msg: '[db-builder] Budget exhausted, keeping run_signal_playbook pending', signal_id: payload.signal_id });
                break;
              }

              try {
                const cap = Math.max(1, Number(payload.cap || 6) || 6);
                const platformPlan = hasApprovedPlatformPlanRef
                  ? await loadApprovedPlatformPlan(client.id, payload.plan_id, payload.plan_hash)
                  : null;
                const maxPaidQueries = platformPlan
                  ? Math.max(1, Number(platformPlan.max_paid_queries || cap) || cap)
                  : cap;
                logger.info({ msg: '[db-builder] Processing run_signal_playbook', signal_id: payload.signal_id, cap });
                const signalLeads = await runSignalHunt(client.id, {
                  maxLeads: cap,
                  icp: icpMemory || {},
                  maxPaidQueries,
                  signalPlaybook: payload,
                  platformPlan,
                  plan_id: platformPlan?.id || payload.plan_id || null,
                });
                const savedSignalLeads = await saveSignalLeads(client.id, signalLeads);
                const platformYieldEvents = platformPlan
                  ? await recordSignalHuntPlatformFunnel(client.id, {
                    funnel: platformFunnelFromSignalHuntResult(signalLeads),
                    savedLeads: savedSignalLeads,
                    plan: platformPlan,
                    mode: payload.mode || platformPlan.mode || 'proof',
                    directiveId: directive.id,
                    source: 'db_builder_run_signal_playbook',
                  })
                  : [];

                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: 'signal_playbook_consumed',
                  target_type: 'system',
                  metadata: {
                    directive_id: directive.id,
                    signal_id: payload.signal_id,
                    source_channel: payload.source_channel || null,
                    geo: payload.geo || [],
                    plan_id: platformPlan?.id || payload.plan_id || null,
                    plan_hash: platformPlan?.plan_hash || payload.plan_hash || null,
                    cap,
                    max_paid_queries: maxPaidQueries,
                    found: signalLeads.length,
                    saved: savedSignalLeads.length,
                    platform_yield_events: platformYieldEvents.map(row => row.id),
                  },
                });
                consumedDirectiveIds.push(directive.id);
                logger.info({ msg: '[db-builder] run_signal_playbook complete', signal_id: payload.signal_id, found: signalLeads.length, saved: savedSignalLeads.length });
              } catch (err) {
                const errorCode = err.code || null;
                logger.warn({ msg: '[db-builder] run_signal_playbook failed', signal_id: payload.signal_id, err: err.message, code: errorCode });
                await logsService.createLog(client.id, {
                  agent: 'research_beaver',
                  action: errorCode === 'platform_plan_required' ? 'signal_playbook_skipped' : 'signal_playbook_error',
                  target_type: 'system',
                  metadata: {
                    directive_id: directive.id,
                    signal_id: payload.signal_id,
                    reason: errorCode === 'platform_plan_required' ? 'platform_plan_required' : 'execution_failed',
                    plan_id: payload.plan_id || null,
                    plan_hash: payload.plan_hash || null,
                    error: err.message,
                    code: errorCode,
                  },
                }).catch(() => {});
                if (errorCode === 'platform_plan_required') {
                  consumedDirectiveIds.push(directive.id);
                }
              }
            }
          }

          // Check pool health
          const health = await checkDbHealth(client.id);
          // Deficits are computed against eligible, uncontacted supply. Raw pool
          // counts include already-drafted/requested leads and can make Research
          // Beaver think tomorrow has capacity when kickoff cannot select them.
          const emailPoolTarget = rebuildDirective?.payload?.target_min || config.min_email_ready_pool || 30;
          const linkedinPoolTarget = config.min_linkedin_ready_pool || 20;
          const emailDeficit = Math.max(0, emailPoolTarget - health.availableWithEmail);
          const linkedinDeficit = Math.max(0, linkedinPoolTarget - health.availableLinkedin);
          const totalDeficit = Math.max(emailDeficit, linkedinDeficit);

          await logsService.createLog(client.id, {
            agent: 'research_beaver',
            action: 'db_health_check',
            target_type: 'system',
            metadata: {
              total: health.total,
              with_email: health.withEmail,
              no_email: health.noEmail,
              available_with_email: health.availableWithEmail,
              available_linkedin: health.availableLinkedin,
              email_pool_target: emailPoolTarget,
              linkedin_pool_target: linkedinPoolTarget,
              email_deficit: emailDeficit,
              linkedin_deficit: linkedinDeficit,
              healthy: totalDeficit === 0,
              captain_directive: rebuildDirective ? { reason: rebuildDirective.reason, severity: rebuildDirective.severity } : null,
            },
          });

          if (totalDeficit === 0) {
            logger.info({
              msg: '[db-builder] Pool healthy',
              slug: client.slug,
              available_email: health.availableWithEmail,
              email_target: emailPoolTarget,
              available_linkedin: health.availableLinkedin,
              linkedin_target: linkedinPoolTarget,
            });
            if (consumedDirectiveIds.length > 0) {
              await directivesSvc.markConsumed(client.id, consumedDirectiveIds).catch(() => {});
            }
            return;
          }
          const deficit = totalDeficit;

          // Check budget before sourcing
          const budget = await checkBudget(client.id);
          if (!budget.allowed || budget.pct >= config.budget_cap_pct) {
            logger.info({ msg: '[db-builder] Budget cap, skipping', slug: client.slug, pct: budget.pct });
            if (consumedDirectiveIds.length > 0) {
              await directivesSvc.markConsumed(client.id, consumedDirectiveIds).catch(() => {});
            }
            return;
          }

          logger.info({
            msg: '[db-builder] Pool low, sourcing',
            slug: client.slug,
            total: health.total,
            available_email: health.availableWithEmail,
            available_linkedin: health.availableLinkedin,
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
              available_email_before: health.availableWithEmail,
              available_email_after: newHealth.availableWithEmail,
              available_linkedin_before: health.availableLinkedin,
              available_linkedin_after: newHealth.availableLinkedin,
              email_pool_target: emailPoolTarget,
              linkedin_pool_target: linkedinPoolTarget,
              email_deficit_remaining: Math.max(0, emailPoolTarget - newHealth.availableWithEmail),
              linkedin_deficit_remaining: Math.max(0, linkedinPoolTarget - newHealth.availableLinkedin),
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
            const today = todayInMalaysia();
            const { rows: [missRow] } = await pool.query(
              `SELECT COUNT(*)::int AS n FROM research_misses
               WHERE client_id = $1
                 AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
                 AND source_strategy = 'db_builder_icp_v2_gate'`,
              [client.id, today]
            );
            await pool.query(
              `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
               VALUES ($1, 'research_beaver', $2, $3::jsonb, 'config')
               ON CONFLICT (client_id, agent, key) DO UPDATE
                 SET content = EXCLUDED.content, updated_at = NOW()`,
              [
                client.id,
                `daily_brief_${today}`,
                JSON.stringify({
                  date: today,
                  target: 40,
                  saved_today: totalSaved,
                  email_pool_now: newHealth.withEmail,
                  available_email_now: newHealth.availableWithEmail,
                  available_linkedin_now: newHealth.availableLinkedin,
                  email_target: emailPoolTarget,
                  linkedin_target: linkedinPoolTarget,
                  email_deficit: Math.max(0, emailPoolTarget - newHealth.availableWithEmail),
                  linkedin_deficit: Math.max(0, linkedinPoolTarget - newHealth.availableLinkedin),
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

// ── VP Sourcing (Vibe Prospecting / Explorium — Brave-free) ──────────────────
//
// 2026-05-15: the structural fix for the recurring Brave quota burn. Sources
// ICP-matched leads with VERIFIED EMAIL from Explorium instead of Brave search.
//
// Credit discipline (memory/preferences.md 2026-05-15):
//   - fetch-businesses + fetch-prospects are FREE (0 credits, confirmed).
//   - fetch-prospects uses has_email:true so we never enrich a prospect with
//     no email to retrieve.
//   - applyIcpV2Filter runs on every prospect BEFORE enrichment — credits are
//     never spent on a lead that would be rejected.
//   - enrich-prospects requests CONTACTS ONLY (~5cr observed) — never the full report.
//   - Hard daily cap is enforced by spendGuard and VP_DAILY_CREDIT_CAP.
//
// EMAIL CHANNEL ONLY. VP exists to get verified emails. LinkedIn sourcing
// continues via guarded search providers only when provider caps are enabled.

async function sourceLeadsViaVP(clientId, { batchSize = 20 } = {}) {
  const vp = require('./vibeProspecting');
  const { applyIcpV2Filter } = require('./agents');

  if (process.env.ALLOW_VP_PAID_ENRICHMENT !== 'true') {
    return { saved: 0, credits: 0, reason: 'vp_paid_enrichment_disabled' };
  }

  const budget = await checkBudget(clientId);
  if (!budget.allowed) {
    return {
      saved: 0,
      credits: 0,
      reason: 'llm_budget_blocked_before_vp',
      period: budget.period,
      spend: budget.spend,
      budget: budget.budget,
    };
  }

  // Hard daily credit cap via central spend guard.
  const vpGuard = await spendGuard.checkProvider('vp', { clientId, estimatedUnits: 5 });
  if (!vpGuard.allowed) {
    logger.info({ msg: '[db-builder] VP spend guard blocked sourcing', reason: vpGuard.reason, spentToday: vpGuard.spentToday, cap: vpGuard.cap });
    return { saved: 0, credits: 0, reason: vpGuard.reason || 'daily_credit_cap', spentToday: vpGuard.spentToday };
  }
  const maxEnrichments = Math.min(batchSize, vpGuard.affordableLeads || 0);
  if (maxEnrichments <= 0) {
    return { saved: 0, credits: 0, reason: 'daily_credit_cap', spentToday: vpGuard.spentToday };
  }

  const icp = await loadCanonicalIcp(clientId);
  if (!icp) return { saved: 0, credits: 0, reason: 'no_icp_memory' };

  // Build ICP-precise filters using autocomplete for linkedin_category.
  const industries = Array.isArray(icp.industries)
    ? icp.industries
    : (typeof icp.industries === 'string' ? icp.industries.split(',') : []);

  // Resolve linkedin_category values via autocomplete (FREE).
  // Each ICP industry phrase becomes an autocomplete query; we collect
  // the top match from each to build a precise category filter.
  const linkedinCats = new Set();
  for (const ind of industries) {
    const trimmed = String(ind).trim();
    if (!trimmed) continue;
    try {
      const ac = await vp.autocomplete(clientId, 'linkedin_category', trimmed);
      if (ac.ok && ac.values.length > 0) {
        const val = typeof ac.values[0] === 'string' ? ac.values[0] : ac.values[0]?.value;
        if (val) linkedinCats.add(val);
      }
    } catch (_) { /* autocomplete is best-effort */ }
  }
  logger.info({ msg: '[db-builder] VP linkedin_category resolved', categories: [...linkedinCats] });

  // Derive geography from ICP (default MY).
  const geoRaw = icp.geographies || '';
  const geoCodes = [];
  if (/malaysia|MY/i.test(geoRaw)) geoCodes.push('MY');
  if (/singapore|SG/i.test(geoRaw)) geoCodes.push('SG');
  if (/indonesia|ID/i.test(geoRaw)) geoCodes.push('ID');
  if (/philippines|PH/i.test(geoRaw)) geoCodes.push('PH');
  if (geoCodes.length === 0) geoCodes.push('MY');

  // Compose tool_reasoning as a human-readable ICP description.
  const valueProp = icp.value_prop || 'AI-powered sales outreach for founder-led B2B companies';
  const toolReasoning = `Find founder-led ${industries.slice(0, 3).join(', ')} companies in ${geoCodes.join('+')} with 2-200 employees that would benefit from: ${valueProp}`;

  // 1. fetch-businesses — FREE. ICP-filtered company discovery.
  const bizFilters = {
    country_code: { values: geoCodes },
    company_size: { values: ['1-10', '11-50', '51-200'] },
    company_revenue: { values: ['0-500K', '500K-1M', '1M-5M', '5M-10M'] },
    is_public_company: false,
    has_website: true,
  };
  if (linkedinCats.size > 0) bizFilters.linkedin_category = { values: [...linkedinCats] };

  const bizResult = await vp.fetchBusinesses(clientId, { filters: bizFilters, size: 200, pageSize: 50, toolReasoning });
  if (!bizResult.ok || bizResult.businesses.length === 0) {
    return { saved: 0, credits: 0, reason: bizResult.error || 'no_businesses' };
  }
  const bizMap = {};
  for (const b of bizResult.businesses) {
    if (b.business_id) bizMap[b.business_id] = { name: b.name, domain: b.domain || b.website || null };
  }

  // 2. fetch-prospects — FREE. Decision-makers with an email available.
  // size MUST be >= pageSize or Explorium 422s the whole call. fetch-prospects
  // is free; credit burn is controlled downstream at the enrich step (maxEnrichments).
  const prResult = await vp.fetchProspects(clientId, {
    filters: {
      business_id: { values: Object.keys(bizMap).slice(0, 100) },
      job_level: { values: ['founder', 'owner', 'c-suite', 'president'] },
      has_email: true,
    },
    size: Math.max(batchSize * 3, 60),
    pageSize: 50,
    toolReasoning,
  });
  if (!prResult.ok || prResult.prospects.length === 0) {
    return { saved: 0, credits: 0, reason: prResult.error || 'no_prospects' };
  }

  // 3. ICP-gate every prospect (FREE) before spending a credit.
  const candidates = [];
  for (const p of prResult.prospects) {
    const biz = bizMap[p.business_id] || {};
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    const company = p.company_name || biz.name || '';
    if (!name || !company) continue;
    const v2 = applyIcpV2Filter({
      name, company, title: p.job_title || '',
      country: p.country_name || 'malaysia', score: 0, metadata: {},
    });
    if (!v2.pass) continue;
    candidates.push({ p, biz, name, company });
    if (candidates.length >= maxEnrichments) break;
  }
  if (candidates.length === 0) {
    return { saved: 0, credits: 0, reason: 'all_filtered_by_icp', businesses: bizResult.businesses.length };
  }

  // ── spendGuard (2026-05-16): hard, in-code brake on VP credit spend ──────
  // The brake no longer depends on anyone remembering to check the quota.
  // Trim the enrichment batch to what today's remaining VP budget affords;
  // refuse entirely if the daily cap is already spent.
  const spendGuard = require('./spendGuard');
  const vpBudget = await spendGuard.checkVP(0, { clientId });
  if (vpBudget.affordableLeads <= 0) {
    console.warn(`[db-builder] spendGuard: VP daily cap reached (${vpBudget.spentToday}/${vpBudget.cap}) — enrichment skipped`);
    return { saved: 0, credits: 0, reason: 'vp_daily_cap_reached', cap: vpBudget.cap, spent_today: vpBudget.spentToday };
  }
  if (candidates.length > vpBudget.affordableLeads) {
    console.warn(`[db-builder] spendGuard: trimming ${candidates.length} candidates to ${vpBudget.affordableLeads} (VP daily budget: ${vpBudget.remaining}/${vpBudget.cap} credits left)`);
    candidates.length = vpBudget.affordableLeads;
  }

  // 4. enrich-prospects CONTACTS ONLY (~3cr each) → verified email. Save as Tier A.
  const patterns = await loadEmailPatterns(clientId);
  let saved = 0;
  let creditsSpent = 0;
  for (const c of candidates) {
    const contacts = await vp.enrichProspectContacts(clientId, c.p.prospect_id);
    creditsSpent += contacts.credits || 0;
    if (!contacts.ok || !contacts.email) continue;

    const savedId = await saveLead(clientId, {
      name: c.name,
      company: c.company,
      title: c.p.job_title || '',
      email: contacts.email,
      email_verified: !!contacts.email_verified,
      email_source: 'vibe_prospecting',
      linkedin_url: c.p.linkedin || '',
      country: c.p.country_name || 'malaysia',
      data_source: 'vibe_prospecting',
      metadata: {
        vp_prospect_id: c.p.prospect_id,
        vp_business_id: c.p.business_id,
        vp_email_status: contacts.email_status || null,
      },
    }, 'vibe_prospecting', { patterns });
    if (savedId) saved++;
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'vp_sourcing_complete',
    target_type: 'system',
    metadata: {
      businesses: bizResult.businesses.length,
      prospects: prResult.prospects.length,
      icp_passed: candidates.length,
      saved,
      credits_spent: creditsSpent,
    },
  });
  logger.info({ msg: '[db-builder] VP sourcing complete', saved, credits: creditsSpent, icp_passed: candidates.length });
  return { saved, credits: creditsSpent, reason: saved > 0 ? 'sourced_vp' : 'no_email_retrieved' };
}

// ── On-Demand Sourcing (called by autonomous kickoff when pool is dry) ───────

async function sourceLeadsOnDemand(clientId, {
  neededChannel = 'email',
  batchSize = 20,
  maxPaidQueries = null,
  platformPlan = null,
  platformPlanSource = null,
} = {}) {
  const budget = await checkBudget(clientId);
  if (!budget.allowed) {
    logger.info({ msg: '[db-builder] on-demand: budget exhausted before provider work' });
    return { saved: 0, reason: 'budget_exhausted', period: budget.period };
  }

  // Autonomous policy (2026-06-02): VP is manual CSV/subscribed-client only.
  // Beaver autonomous sourcing is web/LinkedIn discovery first, then downstream
  // email enrichment uses Hunter before MillionVerifier pattern verification.
  const { runSignalHunt, saveSignalLeads, platformFunnelFromSignalHuntResult } = require('./signalHunt');
  const { recordSignalHuntPlatformFunnel, updateStrategyStateFromPlan } = require('./platformYield');

  const icpMemory = await loadCanonicalIcp(clientId);
  if (!icpMemory) {
    logger.warn({ msg: '[db-builder] on-demand: no ICP memory, cannot source' });
    return { saved: 0, reason: 'no_icp_memory' };
  }

  const legacyResearchFallbackEnabled = process.env.DB_BUILDER_LEGACY_RESEARCH_FALLBACK_ENABLED === 'true';
  const paidQueryCap = Math.max(0, Math.floor(Number(maxPaidQueries) || 0));
  const platformPaidQueryCap = Number(platformPlan?.max_paid_queries);
  const effectivePaidQueryCap = Number.isFinite(platformPaidQueryCap) && platformPaidQueryCap > 0
    ? Math.floor(platformPaidQueryCap)
    : paidQueryCap;

  if (!platformPlan) {
    await logsService.createLog(clientId, {
      agent: 'research_beaver',
      action: 'on_demand_sourcing_complete',
      target_type: 'system',
      metadata: {
        trigger: 'pool_dry_kickoff',
        mode: 'web_linkedin_topup',
        source: 'none',
        neededChannel,
        found: 0,
        saved: 0,
        fallback_skipped_reason: legacyResearchFallbackEnabled ? null : 'platform_plan_required',
        legacy_research_fallback_enabled: legacyResearchFallbackEnabled,
      },
    }).catch(() => {});
    if (!legacyResearchFallbackEnabled) {
      logger.info({ msg: '[db-builder] on-demand: approved platform plan required before scheduled web/LinkedIn spend' });
      return { saved: 0, reason: 'platform_plan_required' };
    }
  }

  if (platformPlan) {
    try {
      const signalLeads = await runSignalHunt(clientId, {
        maxLeads: batchSize,
        icpMemory,
        icp: icpMemory,
        maxPaidQueries: effectivePaidQueryCap,
        platformPlan,
        plan_id: platformPlan.id || platformPlan.plan_hash || 'kickoff_on_demand_topup',
      });
      const savedSignalLeads = await saveSignalLeads(clientId, signalLeads);
      const saved = Array.isArray(savedSignalLeads) ? savedSignalLeads.length : 0;
      const platformYieldEvents = await recordSignalHuntPlatformFunnel(clientId, {
        funnel: platformFunnelFromSignalHuntResult(signalLeads),
        savedLeads: savedSignalLeads,
        plan: platformPlan,
        mode: platformPlan.mode || 'trusted_scheduled',
        source: 'db_builder_on_demand_topup',
        metadata: {
          trigger: 'pool_dry_kickoff',
          platform_plan_source: platformPlanSource,
        },
      }).catch(err => {
        logger.warn({ msg: '[db-builder] on-demand platform yield record failed', err: err.message });
        return [];
      });
      await updateStrategyStateFromPlan(clientId, platformPlan, {
        saved_leads: saved,
        approval_ready: saved,
        blocker: saved > 0 ? null : 'zero_saved_leads',
        trusted_by: 'db_builder_on_demand_topup',
      }).catch(err => logger.warn({ msg: '[db-builder] on-demand strategy state update failed', err: err.message }));

      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'on_demand_signal_first_complete',
        target_type: 'system',
        metadata: {
          trigger: 'pool_dry_kickoff',
          mode: 'web_linkedin_topup',
          source: 'signal_hunt',
          neededChannel,
          found: signalLeads.length,
          saved,
          save_stats: savedSignalLeads?.saveStats || null,
          maxPaidQueries: effectivePaidQueryCap,
          platform_plan_id: platformPlan.id || null,
          platform_plan_hash: platformPlan.plan_hash || null,
          platform_plan_source: platformPlanSource || null,
          platform_yield_events: platformYieldEvents.map(row => row.id),
          legacy_research_fallback_enabled: legacyResearchFallbackEnabled,
        },
      });

      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'on_demand_sourcing_complete',
        target_type: 'system',
        metadata: {
          trigger: 'pool_dry_kickoff',
          mode: 'web_linkedin_topup',
          source: 'signal_hunt',
          source_order: 'signal_hunt_contact_gate',
          neededChannel,
          found: signalLeads.length,
          saved,
          save_stats: savedSignalLeads?.saveStats || null,
          maxPaidQueries: effectivePaidQueryCap,
          platform_plan_id: platformPlan.id || null,
          platform_plan_hash: platformPlan.plan_hash || null,
          platform_plan_source: platformPlanSource || null,
          platform_yield_events: platformYieldEvents.map(row => row.id),
          fallback_skipped_reason: saved > 0 ? 'signal_first_saved' : (legacyResearchFallbackEnabled ? null : 'legacy_research_disabled'),
        },
      });

      if (saved > 0 || !legacyResearchFallbackEnabled) {
        const health = await checkDbHealth(clientId);
        logger.info({ msg: '[db-builder] on-demand signal-first complete', found: signalLeads.length, saved, pool_email: health.withEmail });
        return { saved, health, reason: saved > 0 ? 'signal_hunt_topup' : 'signal_hunt_no_results' };
      }
    } catch (err) {
      logger.warn({ msg: '[db-builder] on-demand signal hunt failed', err: err.message });
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'on_demand_signal_first_error',
        target_type: 'system',
        metadata: {
          trigger: 'pool_dry_kickoff',
          mode: 'web_linkedin_topup',
          neededChannel,
          error: err.message,
          maxPaidQueries: effectivePaidQueryCap,
          platform_plan_id: platformPlan?.id || null,
          platform_plan_hash: platformPlan?.plan_hash || null,
          platform_plan_source: platformPlanSource || null,
        },
      }).catch(() => {});
      if (!legacyResearchFallbackEnabled) {
        return { saved: 0, reason: 'signal_hunt_error' };
      }
    }
  }

  const researchModule = require('./research');
  const patterns = await loadEmailPatterns(clientId);
  let result;
  try {
    result = await researchModule.researchLeads(clientId, {
      icpMemory,
      targetCount: batchSize,
      batchIndex: Date.now(),
      maxPaidQueries: paidQueryCap,
    });
  } catch (err) {
    logger.warn({ msg: '[db-builder] on-demand legacy research failed', err: err.message });
    return { saved: 0, reason: 'legacy_research_error' };
  }

  const leads = result.leads || [];
  let saved = 0;
  for (const lead of leads) {
    if ((lead.metadata?.signal_id || lead.signal) && !lead.metadata?.signal_package) {
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'research_blocker',
        target_type: 'research',
        metadata: {
          blocker: 'contact_zero',
          reason: 'missing_signal_package_before_save',
          lead_name: lead.name || null,
          lead_company: lead.company || null,
        },
      });
      continue;
    }
    const savedId = await saveLead(clientId, lead, result.queriesUsed?.join(' | ') || '', { patterns });
    if (savedId) saved++;
  }
  const stageStats = result.stage_stats ? { ...result.stage_stats, saved } : null;

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'on_demand_sourcing_complete',
    target_type: 'system',
    metadata: {
      trigger: 'pool_dry_kickoff',
      mode: 'web_linkedin_topup',
      source: 'legacy_research',
      source_order: 'web_linkedin_anymail_icypeas_snov_hunter_millionverifier',
      neededChannel,
      found: leads.length,
      saved,
      stage_stats: stageStats,
      blocker: result.diagnostics?.reason || null,
      maxPaidQueries: paidQueryCap,
    },
  });

  const health = await checkDbHealth(clientId);
  logger.info({ msg: '[db-builder] on-demand complete', found: leads.length, saved, pool_email: health.withEmail });
  return { saved, health, reason: saved > 0 ? 'web_linkedin_topup' : 'web_linkedin_no_results' };
}

module.exports = { runDbBuilder, checkDbHealth, sourceLeadsOnDemand, sourceLeadsViaVP, effectiveLeadScore };
