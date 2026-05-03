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

  // Contact gate (MJ direction 2026-05-03): every sourced lead must have BOTH
  // email AND linkedin_url. Misses get logged to research_misses for tuning,
  // but the lead is NOT inserted. Manual override via metadata.linkedin_only_override.
  const contactGate = require('./contactGate');
  const gateResult = await contactGate.tryPersistSourcedLead(clientId, lead, {
    sourceStrategy: 'db_builder',
    queryUsed: searchQuery,
    allowLinkedinOnly: !!lead.linkedin_only_override,
  });
  if (gateResult.missed) {
    return null;
  }

  try {
    const res = await pool.query(
      `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                          pipeline_stage, status, email_verified, email_source, linkedin_url, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'research_beaver','prospecting','new',$8,$9,$10,$11)
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
      ]
    );
    return res.rows[0]?.id || null;
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

    if (enabledSlugs.length === 0) return;

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
        });
      } catch (err) {
        logger.warn({ msg: '[db-builder] Client error', slug: client.slug, err: err.message });
      }
    }
  } finally {
    _running = false;
  }
}

module.exports = { runDbBuilder, checkDbHealth };
