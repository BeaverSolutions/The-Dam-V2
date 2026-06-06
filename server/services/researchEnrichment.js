'use strict';

/**
 * Research Beaver — Pre-Enrichment for Follow-ups (Phase 5, 2026-05-11).
 *
 * Runs daily at 08:30 MYT, BEFORE Captain's 09:00 follow-up planning.
 * For each lead with a follow-up due today: fetches fresh signals (hiring
 * posts, company news, exec changes, product launches) and writes them to
 * lead.metadata.research_enrichment.
 *
 * Captain's planFollowUps then uses this fresh context when proposing per-lead
 * angles — leads with NEW signals get prioritized angle types (Hiring,
 * RecentNews, MarketShift). Leads with no fresh signals fall back to
 * conversational templates (TimingCheck, GenuineQuestion).
 *
 * Skip conditions:
 *   - Lead has fresh enrichment (<7 days old): skip
 *   - Lead has no company name (thin context): skip
 *   - Brave quota exhausted: log + skip (graceful — Captain works with existing context)
 *   - Lead is touch 5 (break-up — doesn't need fresh signal)
 *
 * Cost: ~$0.01/lead (one Haiku synthesis call + one Brave search per lead).
 * Only fires for leads with due follow-ups, never the entire pool.
 */

const pool = require('../db/pool');
const { callAgent } = require('./claude');
const { searchOpenWeb } = require('./searchService');
const logger = require('../utils/logger');
const { scoreAndPersist } = require('./qualityScorer');
const { getTenantConfig } = require('./tenantConfig');
const { todayInMalaysia } = require('../utils/businessDay');
const { checkBudget, isBudgetExceededError } = require('./budget');
const { CAPS, providerUsageToday } = require('./spendGuard');
const repairPolicy = require('./repairPolicy');

const ENRICHMENT_STALE_DAYS = 7;
function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Conservative default: this job enriches context; it is not the main outreach
// producer. Keep its Brave footprint small so 09:30 kickoff keeps capacity.
const MAX_ENRICHMENT_PER_DAY = Math.min(30, Math.max(0, envNumber('RESEARCH_ENRICHMENT_DAILY_LEAD_CAP', 5)));
const MAX_ENRICHMENT_BRAVE_UNITS = Math.min(30, Math.max(0, envNumber('RESEARCH_ENRICHMENT_BRAVE_DAILY_CAP', 5)));
const MAX_COLD_SIGNAL_BRAVE_UNITS = Math.min(25, Math.max(0, envNumber('COLD_SIGNAL_ENRICHMENT_BRAVE_DAILY_CAP', 5)));
const ENRICHMENT_EXTRA_QUERIES = process.env.RESEARCH_ENRICHMENT_EXTRA_QUERIES === 'true';

/**
 * Check whether a lead's existing enrichment is fresh enough to skip.
 */
function isEnrichmentFresh(metadata) {
  const enriched = metadata?.research_enrichment;
  if (!enriched?.enriched_at) return false;
  const ageMs = Date.now() - new Date(enriched.enriched_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays < ENRICHMENT_STALE_DAYS;
}

/**
 * Run a Brave search for fresh signals about a single lead.
 * Returns structured findings or null if quota exhausted or no signals found.
 */
async function searchFreshSignals(lead, { clientId = null, maxQueries = 1 } = {}) {
  const company = (lead.company || '').trim();
  if (!company || /^(unknown|n\/a|independent)$/i.test(company)) return null;

  // Default is one query per lead. Extra queries are opt-in because this cron
  // runs before the real outreach producer and must not drain Brave capacity.
  const queries = [
    `"${company}" hiring OR recruiting OR "we're hiring" 2026`,
    `"${company}" news OR funding OR launch OR announced`,
    lead.name ? `"${lead.name}" "${company}" LinkedIn` : null,
  ].filter(Boolean);

  const allHits = [];
  const selectedQueries = ENRICHMENT_EXTRA_QUERIES ? queries : queries.slice(0, 1);
  for (const q of selectedQueries.slice(0, Math.max(1, maxQueries))) {
    try {
      const hits = await searchOpenWeb(q, 3, { clientId });
      if (Array.isArray(hits)) allHits.push(...hits.slice(0, 3));
    } catch (err) {
      const msg = String(err.message || '').toLowerCase();
      if (msg.includes('429') || msg.includes('quota') || msg.includes('rate')) {
        logger.warn({ msg: '[research-enrichment] Brave quota hit — skipping enrichment for rest of run' });
        return { _quota_exhausted: true };
      }
      // Other errors: continue to next query
    }
  }

  if (allHits.length === 0) return null;
  return { hits: allHits };
}

/**
 * Use Haiku to synthesize raw search hits into structured signals.
 */
async function synthesizeSignals(clientId, lead, hits) {
  if (!hits || hits.length === 0) return null;

  const prompt = `Analyze these search results about ${lead.name || 'this person'} at ${lead.company}. Extract any FRESH, VERIFIABLE signals that would make a follow-up message feel timely.

SEARCH RESULTS:
${hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.snippet || ''}\n   ${h.link || ''}`).join('\n\n')}

For each verifiable signal found, classify by type:
- hiring: company posted a relevant role (specify what)
- funding: company raised money, closed a round, or got funded
- exec_change: new hire or departure at exec level
- product_launch: new product or feature announcement
- expansion: market expansion, new office, partnership
- press: notable press mention or award

ONLY include signals you can verify from the actual snippets above. Do NOT invent signals. If snippets only contain stale or generic content, return signals_found: [].

Return JSON ONLY:
{
  "signals_found": [
    {"type": "hiring", "detail": "Hiring a Business Development Manager (posted 5 days ago)", "source_url": "https://..."}
  ],
  "summary": "One-sentence summary of what's fresh about this lead",
  "recommended_angle_template": 1-10 from the angle library
}

Angle templates: 1=Hiring, 2=FounderOutbound, 3=IndustryContrarian, 4=RecentNews, 5=RoleSpecific, 6=PeerReference, 7=MarketShift, 8=TimingCheck, 9=Breakup, 10=Reawaken.

If no fresh signals, return {"signals_found":[],"summary":"No fresh signals — use default template","recommended_angle_template":8}.`;

  try {
    const result = await callAgent('research_beaver', prompt, { clientId });
    const raw = typeof result === 'string' ? result : (result?.brief || result?.summary || JSON.stringify(result));
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    if (isBudgetExceededError(err)) {
      logger.warn({ msg: '[research-enrichment] LLM budget blocked during synthesis', err: err.message });
      throw err;
    }
    logger.warn({ msg: '[research-enrichment] Haiku synthesis failed', err: err.message });
    return null;
  }
}

/**
 * Enrich a single lead. Updates lead.metadata.research_enrichment.
 * Returns:
 *   { enriched: true, signals_count, recommended_template } on success
 *   { enriched: false, reason } on skip or failure
 */
async function enrichLeadForFollowUp(clientId, lead, { maxQueriesPerLead = 1 } = {}) {
  // Skip conditions
  if (isEnrichmentFresh(lead.metadata)) {
    return { enriched: false, reason: 'fresh_enrichment_exists' };
  }
  const company = (lead.company || '').trim();
  if (!company || /^(unknown|independent|n\/a|self[- ]?employed|freelanc|stealth)$/i.test(company)) {
    return { enriched: false, reason: 'thin_context' };
  }

  const searchResult = await searchFreshSignals(lead, { clientId, maxQueries: maxQueriesPerLead });
  if (searchResult?._quota_exhausted) {
    return { enriched: false, reason: 'brave_quota_exhausted' };
  }
  if (!searchResult || !searchResult.hits) {
    return { enriched: false, reason: 'no_search_results' };
  }

  const synthesized = await synthesizeSignals(clientId, lead, searchResult.hits);
  if (!synthesized) {
    return { enriched: false, reason: 'synthesis_failed' };
  }

  // Persist to lead.metadata.research_enrichment
  const enrichmentBlob = {
    enriched_at: new Date().toISOString(),
    signals_found: synthesized.signals_found || [],
    summary: synthesized.summary || '',
    recommended_angle_template: synthesized.recommended_angle_template || 8,
    fresh: true,
  };

  await pool.query(
    `UPDATE leads
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('research_enrichment', $1::jsonb),
         updated_at = NOW()
     WHERE id = $2 AND client_id = $3`,
    [JSON.stringify(enrichmentBlob), lead.id, clientId]
  );

  return {
    enriched: true,
    signals_count: enrichmentBlob.signals_found.length,
    recommended_template: enrichmentBlob.recommended_angle_template,
    summary: enrichmentBlob.summary,
  };
}

/**
 * Run enrichment pass over all leads with follow-ups due today.
 * Called at 08:30 MYT, BEFORE Captain's 09:00 planning.
 *
 * Returns: { processed, enriched, skipped, errors, quota_exhausted_at }
 */
async function runDailyEnrichmentPass(clientId) {
  const today = todayInMalaysia();
  const budget = await checkBudget(clientId);
  if (!budget.allowed) {
    return {
      processed: 0,
      enriched: 0,
      skipped: 0,
      errors: 0,
      blocked: true,
      reason: 'llm_budget_blocked',
      period: budget.period,
      spend: budget.spend,
      budget: budget.budget,
      message: `Research enrichment blocked by ${budget.period} LLM budget guard.`,
    };
  }

  const maxQueriesPerLead = ENRICHMENT_EXTRA_QUERIES ? 3 : 1;
  const braveSpent = await providerUsageToday('brave', clientId);
  const braveRemaining = Math.max(0, (Number(CAPS.brave) || 0) - braveSpent);
  const braveBudgetForThisJob = Math.min(braveRemaining, MAX_ENRICHMENT_BRAVE_UNITS);
  const affordableLeads = Math.floor(braveBudgetForThisJob / maxQueriesPerLead);
  const leadLimit = Math.min(MAX_ENRICHMENT_PER_DAY, affordableLeads);

  if (leadLimit <= 0) {
    return {
      processed: 0,
      enriched: 0,
      skipped: 0,
      errors: 0,
      blocked: true,
      reason: 'brave_capacity_unavailable',
      brave_spent_today: braveSpent,
      brave_cap: CAPS.brave,
      message: 'Research enrichment blocked before Brave spend: no reserved Brave capacity available.',
    };
  }

  const { rows: dueLeads } = await pool.query(
    `SELECT DISTINCT l.id, l.name, l.company, l.title, l.linkedin_url, l.metadata
     FROM followup_queue fq
     JOIN leads l ON l.id = fq.lead_id
     WHERE fq.client_id = $1
       AND fq.scheduled_for <= $2
       AND fq.status = 'pending'
       AND l.sequence_status = 'active'
       AND l.last_reply_at IS NULL
       AND l.deleted_at IS NULL
       AND fq.touch_number < 5
     ORDER BY l.id
     LIMIT $3`,
    [clientId, today, leadLimit]
  );

  if (dueLeads.length === 0) {
    return { processed: 0, enriched: 0, skipped: 0, errors: 0, message: 'No leads need enrichment today.' };
  }

  let enriched = 0;
  let skipped = 0;
  let errors = 0;
  let quotaExhaustedAt = null;

  for (const lead of dueLeads) {
    if (quotaExhaustedAt) {
      skipped++;
      continue;
    }
    try {
      const result = await enrichLeadForFollowUp(clientId, lead, { maxQueriesPerLead });
      if (result.enriched) {
        enriched++;
      } else {
        skipped++;
        if (result.reason === 'brave_quota_exhausted') {
          quotaExhaustedAt = lead.id;
          logger.warn({ msg: '[research-enrichment] Brave quota exhausted — stopping daily pass' });
        }
      }
    } catch (err) {
      if (isBudgetExceededError(err)) {
        return {
          processed: dueLeads.length,
          enriched,
          skipped,
          errors,
          blocked: true,
          reason: 'llm_budget_blocked_mid_run',
          message: `Research enrichment stopped by LLM budget guard after ${enriched} enrichments.`,
        };
      }
      errors++;
      logger.warn({ msg: '[research-enrichment] Error enriching lead', leadId: lead.id, err: err.message });
    }
  }

  // Log the daily pass result for visibility
  try {
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'research_beaver', $2, $3::jsonb, 'journal', NOW())
       ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
      [clientId, `enrichment_pass_${today}`, JSON.stringify({
        ran_at: new Date().toISOString(),
        processed: dueLeads.length,
        enriched,
        skipped,
        errors,
        quota_exhausted: !!quotaExhaustedAt,
      })]
    );
  } catch (e) { /* non-critical */ }

  return {
    processed: dueLeads.length,
    enriched,
    skipped,
    errors,
    quota_exhausted: !!quotaExhaustedAt,
    message: `Enriched ${enriched}/${dueLeads.length} due leads. ${skipped} skipped, ${errors} errors${quotaExhaustedAt ? ' (Brave quota hit)' : ''}.`,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * COLD-POOL SIGNAL ENRICHMENT (2026-05-19)
 *
 * Distinct from the follow-up enrichment above. This enriches COLD
 * prospecting-stage leads that have NO buying signal — the VP-CSV
 * imports that landed firmographic-only. It persists a real signal to
 * the canonical `metadata.signal` fields that Sales Beaver already
 * reads directly (agents.js ~1983 signal pipeline / ~3373 kickoff
 * pipeline), so a personalised cold draft becomes possible without
 * fabrication.
 *
 * Additive: reuses searchFreshSignals (proven on the follow-up path),
 * touches no existing pipeline code. Manual/script-triggered only —
 * NOT wired to any cron. Spend is bounded by the caller's `limit`.
 * ═══════════════════════════════════════════════════════════════════ */

// signal_type values the quality scorer + Beaver ICP recognise.
const COLD_SIGNAL_TYPES = [
  'hiring_sales', 'hiring_bdr', 'expansion', 'funding',
  'product_launch', 'scaling_pain',
];

/**
 * Haiku: produce ONE verifiable personalisation angle for a cold prospect.
 *
 * Direction (MJ, 2026-05-19): a lead we paid to source is NEVER discarded for
 * lack of a dated buying event. Sales Beaver's job is to find SOMETHING real
 * and specific about every prospect before he drafts. So this never returns
 * "nothing found" — it returns the strongest VERIFIABLE angle available:
 *   - RICH: a dated, recent (<3mo) trigger event from the search snippets.
 *   - LITE: a true, specific observation about the company / the prospect's
 *           role — drawn from the snippets OR the prospect's own record.
 * The only hard floor: the angle must be TRUE. Found, never invented.
 *
 * Returns { found:true, signal, why_now, angle, signal_type, strength, source }.
 * Returns { found:false, transient:true } ONLY on a transient API error (retry).
 */
async function synthesizeColdSignal(clientId, lead, hits) {
  const company = (lead.company || '').trim();
  const role = (lead.title || '').trim();
  const hitsBlock = (hits && hits.length)
    ? hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.snippet || ''}\n   ${h.link || ''}`).join('\n\n')
    : '(no web results found for this prospect)';

  const prompt = `Beaver Solutions sells an AI outbound-sales tool to B2B SMBs that run cold outreach manually. We are about to cold-contact ${lead.name || 'a decision-maker'} — ${role || 'role unknown'} at ${company}.

Produce ONE specific, VERIFIABLE personalisation angle for the opening line. Every prospect has one. You never give up and you never invent.

SEARCH RESULTS:
${hitsBlock}

PROSPECT FACTS (always true — usable even with zero search results):
- Name: ${lead.name || 'unknown'}
- Role: ${role || 'unknown'}
- Company: ${company}

Pick the STRONGEST angle, in this priority order:
1. RICH — a dated, recent (within ~3 months) trigger event verifiable in the snippets: hiring sales/BDR, funding round, expansion / new office / new market, product launch, public pipeline pain.
2. LITE — a specific, verifiable observation: what the company actually does, the market it serves, or what the prospect's role implies about how they run outbound. Drawn from the snippets OR the prospect facts above.

RULES:
- Use ONLY facts verifiable in the snippets or the prospect facts above. NEVER invent an event, a metric, a relationship, or a milestone.
- A real recent event is best. If there is none, a true company/role observation is still a valid, specific angle — USE IT. Never return "nothing found".
- "strength": "rich" ONLY for a dated recent (<3mo) trigger event; otherwise "lite".

Return JSON ONLY:
{"signal": "<one specific verifiable fact about this prospect/company>", "why_now": "<one sentence>", "angle": "<one-line angle tying it to an AI outbound-sales tool>", "signal_type": "<one of: ${COLD_SIGNAL_TYPES.join(', ')}>", "strength": "rich|lite", "source_url": "<best source URL from the snippets, or null>"}`;

  try {
    const result = await callAgent('research_beaver', prompt, { clientId });
    const raw = typeof result === 'string'
      ? result
      : (result?.brief || result?.summary || JSON.stringify(result));
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && parsed.signal && String(parsed.signal).trim().length > 3) {
      if (!COLD_SIGNAL_TYPES.includes(parsed.signal_type)) parsed.signal_type = 'scaling_pain';
      if (parsed.strength !== 'rich') parsed.strength = 'lite';
      parsed.found = true;
      parsed.source = (hits && hits.length) ? 'research_beaver_web_enrichment' : 'research_beaver_role_inference';
      parsed.source_url = parsed.source_url || hits?.[0]?.link || null;
      parsed.evidence = parsed.evidence || parsed.signal || hits?.[0]?.snippet || null;
      return parsed;
    }
    // LLM returned nothing usable — fall through to the deterministic floor.
  } catch (err) {
    if (isBudgetExceededError(err)) {
      logger.warn({ msg: '[cold-signal] synthesis blocked by LLM budget', leadId: lead.id, err: err.message });
      throw err;
    }
    const emsg = String(err.message || '');
    // A transient API failure (overload / rate-limit / timeout / 5xx) is NOT a
    // "no angle" result — flag it so the caller leaves the lead for a retry.
    const transient = /\b(429|529|503|502|500)\b|overload|rate.?limit|timeout|ETIMEDOUT|ECONNRESET|ESOCKETTIMEDOUT|socket hang up/i.test(emsg);
    if (transient) {
      logger.warn({ msg: '[cold-signal] synthesis hit a TRANSIENT error — lead left for retry', leadId: lead.id, err: emsg });
      return { found: false, transient: true };
    }
    logger.warn({ msg: '[cold-signal] synthesis failed — using deterministic role/company angle', leadId: lead.id, err: emsg });
  }

  // Deterministic floor: the prospect's own role + company is always a true,
  // specific anchor. Never fabricated, never empty. Only unreachable if the
  // lead has no company name at all (caller already guards that case).
  return {
    found: true,
    signal: `${lead.name || 'The prospect'} is ${role || 'a decision-maker'} at ${company}.`,
    why_now: `${role || 'A decision-maker'} at an SMB like ${company} typically owns outbound personally.`,
    angle: `Open on their role at ${company} and the manual-outbound load it implies — position the AI sales crew as the relief.`,
    signal_type: 'scaling_pain',
    strength: 'lite',
    source: 'role_company_floor',
  };
}

/**
 * Enrich ONE cold lead with a buying signal and persist it to the
 * canonical metadata fields Sales Beaver reads. Re-scores quality.
 * Returns { enriched:true, ... } or { enriched:false, reason }.
 */
async function enrichColdLeadSignal(clientId, lead, tenantConfig) {
  return enrichColdLeadSignalWithOptions(clientId, lead, tenantConfig, {});
}

async function enrichColdLeadSignalWithOptions(clientId, lead, tenantConfig, options = {}) {
  const meta = lead.metadata || {};
  if (meta.signal && options.force !== true) return { enriched: false, reason: 'already_has_signal' };
  // No `already_attempted` short-circuit: the synth now always produces a real
  // angle, so a prior attempt that left no signal (old give-up logic) MUST be
  // retried, not skipped. The meta.signal guard above already prevents re-spend
  // on leads that genuinely have an angle.
  const company = (lead.company || '').trim();
  if (!company || /^(unknown|independent|n\/a|self[- ]?employed|freelanc|stealth)$/i.test(company)) {
    return { enriched: false, reason: 'thin_context' };
  }

  // Web search is best-effort. An empty result is NOT a dead end — the synth
  // falls back to a verifiable role/company angle from the lead's own record.
  const searchResult = options.maxQueries === undefined
    ? await searchFreshSignals(lead, { clientId, maxQueries: 1 })
    : await searchFreshSignals(lead, { clientId, maxQueries: Math.max(1, Number(options.maxQueries || 1) || 1) });
  if (searchResult?._quota_exhausted) return { enriched: false, reason: 'brave_quota_exhausted' };

  const syn = await synthesizeColdSignal(clientId, lead, searchResult?.hits || []);

  if (syn.transient) {
    // Transient API failure (overload / rate-limit / timeout). Do NOT mark the
    // lead 'attempted' — it must be retried on a later run, never lost to a blip.
    return { enriched: false, reason: 'transient_error' };
  }

  if (!syn.found || !syn.signal) {
    // Should be unreachable — synth always returns an angle when a company name
    // exists, and the thin-context guard above already rejected company-less
    // leads. Treat as transient (retry) rather than silently dropping the lead.
    return { enriched: false, reason: 'transient_error' };
  }

  const nowIso = new Date().toISOString();
  const bestHit = Array.isArray(searchResult?.hits) ? searchResult.hits.find(h => h?.link || h?.snippet || h?.title) : null;
  const sourceUrl = syn.source_url || bestHit?.link || lead.linkedin_url || meta.source_url || null;
  const evidence = syn.evidence || syn.signal || bestHit?.snippet || bestHit?.title || `${lead.name || 'Prospect'} is ${lead.title || 'a decision-maker'} at ${company}.`;
  const signalFields = {
    signal_id: syn.signal_type || meta.signal_id || 'cold_lead_repair_signal',
    signal_family: syn.signal_type || meta.signal_family || 'cold_lead_repair',
    source_channel: syn.source || meta.source_channel || 'research_beaver_repair',
    source_url: sourceUrl,
    evidence,
    decision_maker: {
      name: lead.name || null,
      title: lead.title || null,
      source_url: lead.linkedin_url || sourceUrl || null,
    },
    signal: syn.signal,
    why_now: syn.why_now || '',
    angle: syn.angle || '',
    signal_type: syn.signal_type,
    signal_strength: syn.strength === 'rich' ? 0.9 : 0.6,
    signal_recency_days: 0,
    signal_enriched_at: nowIso,
    signal_enrich_result: 'signal_found',
    signal_source: syn.source || 'research_beaver_web_enrichment',
  };

  await pool.query(
    `UPDATE leads
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         buying_signal_strength = $2,
         signal_dated_at = NOW(),
         updated_at = NOW()
     WHERE id = $3 AND client_id = $4`,
    [JSON.stringify(signalFields), syn.strength, lead.id, clientId]
  );

  // Re-score quality so the SIGNAL dimension lifts (was 0 = no_signal).
  if (tenantConfig) {
    try {
      const updatedLead = { ...lead, metadata: { ...meta, ...signalFields } };
      await scoreAndPersist(updatedLead, tenantConfig);
    } catch (err) {
      logger.warn({ msg: '[cold-signal] re-score failed (signal still persisted)', leadId: lead.id, err: err.message });
    }
  }

  return { enriched: true, signal_type: syn.signal_type, strength: syn.strength, signal: syn.signal, metadata: signalFields };
}

async function repairLeadSignalPackage(clientId, payload = {}) {
  const leadId = payload.lead_id || payload.leadId;
  if (!clientId || !leadId) return { repaired: false, reason: 'missing_client_or_lead_id' };

  const { rows } = await pool.query(
    `SELECT id, name, company, title, linkedin_url, metadata, email, email_verified, email_source, lead_tier, pipeline_stage
     FROM leads WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [leadId, clientId]
  );
  const lead = rows[0];
  if (!lead) return { repaired: false, reason: 'lead_not_found' };

  const meta = lead.metadata || {};
  const repairState = repairPolicy.researchRepairState({
    repair_attempt: meta.research_repair?.attempt || 0,
    max_repair_attempts: payload.max_repair_attempts || 1,
  });
  if (repairPolicy.researchRepairExhausted(repairState)) {
    await logsServiceSafe(clientId, {
      action: 'research_repair_skipped',
      target_id: leadId,
      metadata: { reason: 'max_repair_attempts_reached', directive_payload: payload },
    });
    return { repaired: false, reason: 'max_repair_attempts_reached' };
  }

  let tenantCfg = null;
  try { tenantCfg = await getTenantConfig(clientId); } catch { /* re-score skipped */ }

  const enrichment = await enrichColdLeadSignalWithOptions(clientId, lead, tenantCfg, {
    force: true,
    maxQueries: Math.max(1, Number(payload.max_paid_queries || payload.maxPaidQueries || 1) || 1),
  });

  if (!enrichment.enriched) {
    await stampResearchRepair(clientId, lead, {
      status: 'failed',
      attempt: repairState.repairAttempt + 1,
      maxAttempts: repairState.maxRepairAttempts,
      reason: enrichment.reason || 'not_enriched',
      payload,
    });
    return { repaired: false, reason: enrichment.reason || 'not_enriched' };
  }

  const research = require('./research');
  const repairedMeta = {
    ...meta,
    ...(enrichment.metadata || {}),
  };
  const signalPackage = research.buildSignalPackage({ ...lead, metadata: repairedMeta }, {
    evidenceDate: todayInMalaysia(),
  });
  const missingFields = research.signalPackageMissingFields(signalPackage);
  const newHash = repairPolicy.signalPackageHash(signalPackage);
  const originalHash = payload.original_signal_package_hash || payload.do_not_repeat?.signal_package_hash || null;

  if (originalHash && newHash === originalHash) {
    await stampResearchRepair(clientId, lead, {
      status: 'same_package_blocked',
      attempt: repairState.repairAttempt + 1,
      maxAttempts: repairState.maxRepairAttempts,
      reason: 'research_repair_same_package_blocked',
      payload,
      signalPackage,
      packageHash: newHash,
      missingFields,
    });
    await logsServiceSafe(clientId, {
      action: 'research_repair_same_package_blocked',
      target_id: leadId,
      metadata: { original_signal_package_hash: originalHash, package_hash: newHash, missing_fields: missingFields },
    });
    return { repaired: false, reason: 'same_signal_package', missing_fields: missingFields };
  }

  if (missingFields.length > 0) {
    await stampResearchRepair(clientId, lead, {
      status: 'failed',
      attempt: repairState.repairAttempt + 1,
      maxAttempts: repairState.maxRepairAttempts,
      reason: 'signal_package_still_incomplete',
      payload,
      signalPackage,
      packageHash: newHash,
      missingFields,
    });
    return { repaired: false, reason: 'signal_package_still_incomplete', missing_fields: missingFields };
  }

  await stampResearchRepair(clientId, lead, {
    status: 'repaired',
    attempt: repairState.repairAttempt + 1,
    maxAttempts: repairState.maxRepairAttempts,
    reason: 'signal_package_repaired',
    payload,
    signalPackage,
    packageHash: newHash,
    missingFields,
  });
  await logsServiceSafe(clientId, {
    action: 'research_repair_completed',
    target_id: leadId,
    metadata: {
      directive_id: payload.directive_id || null,
      package_hash: newHash,
      original_signal_package_hash: originalHash,
      repair_attempt: repairState.repairAttempt + 1,
      max_repair_attempts: repairState.maxRepairAttempts,
    },
  });

  return { repaired: true, signal_package: signalPackage, package_hash: newHash };
}

async function stampResearchRepair(clientId, lead, {
  status,
  attempt,
  maxAttempts,
  reason,
  payload,
  signalPackage = null,
  packageHash = null,
  missingFields = [],
} = {}) {
  const originalHash = payload.original_signal_package_hash || payload.do_not_repeat?.signal_package_hash || null;
  const patch = {
    ...(signalPackage ? { signal_package: signalPackage } : {}),
    research_repair: {
      status,
      attempt,
      max_attempts: maxAttempts,
      reason,
      missing_fields: missingFields,
      original_signal_package_hash: originalHash,
      package_hash: packageHash,
      repaired_at: new Date().toISOString(),
      failed_rule: payload.failed_rule || null,
      repair_route: payload.repair_route || 'needs_research_repair',
      do_not_repeat: payload.do_not_repeat || {},
    },
  };
  await pool.query(
    `UPDATE leads
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2 AND client_id = $3`,
    [JSON.stringify(patch), lead.id, clientId]
  );
}

async function logsServiceSafe(clientId, { action, target_id = null, metadata = {} } = {}) {
  try {
    const logsService = require('./logs');
    await logsService.createLog(clientId, {
      agent: 'research_beaver',
      action,
      target_type: target_id ? 'lead' : 'system',
      target_id,
      metadata,
    });
  } catch { /* non-critical */ }
}

/**
 * Batch: enrich up to `limit` cold prospecting-stage leads that have no
 * signal yet. Manual entry point — NOT wired to any cron. Spend-capped:
 * `limit` is hard-bounded 1..25; each lead is <=3 web searches + 1 Haiku call.
 */
async function runColdPoolSignalEnrichment(clientId, opts = {}) {
  const budget = await checkBudget(clientId);
  if (!budget.allowed) {
    return {
      processed: 0,
      enriched: 0,
      no_signal: 0,
      skipped: 0,
      errors: 0,
      blocked: true,
      reason: 'llm_budget_blocked',
      period: budget.period,
      spend: budget.spend,
      budget: budget.budget,
      message: `Cold signal enrichment blocked by ${budget.period} LLM budget guard before Brave spend.`,
    };
  }

  const requestedLimit = Math.min(Math.max(1, parseInt(opts.limit, 10) || 5), 25);
  const braveSpent = await providerUsageToday('brave', clientId);
  const braveRemaining = Math.max(0, (Number(CAPS.brave) || 0) - braveSpent);
  const cap = Math.min(requestedLimit, Math.floor(Math.min(braveRemaining, MAX_COLD_SIGNAL_BRAVE_UNITS)));
  if (cap <= 0) {
    return {
      processed: 0,
      enriched: 0,
      no_signal: 0,
      skipped: 0,
      errors: 0,
      blocked: true,
      reason: 'brave_capacity_unavailable',
      brave_spent_today: braveSpent,
      brave_cap: CAPS.brave,
      message: 'Cold signal enrichment blocked before Brave spend: no reserved Brave capacity available.',
    };
  }
  // VP-imported leads enrich at a far higher signal-yield than LinkedIn-scraped
  // leads (the latter are thin micro-SMBs with no web footprint). Default to
  // 'vp' so manual runs don't burn web-search + Haiku spend on the low-yield pool.
  const origin = opts.origin === 'all' ? 'all' : 'vp';
  const originFilter = origin === 'vp' ? `AND (metadata ? 'vp_prospect_id')` : '';

  const { rows: leads } = await pool.query(
    `SELECT id, name, company, title, linkedin_url, metadata, email, email_verified, lead_tier, pipeline_stage
     FROM leads
     WHERE client_id = $1
       AND deleted_at IS NULL
       AND pipeline_stage IN ('prospecting', 'researched')
       AND (metadata->>'signal') IS NULL
       AND (metadata->>'signal_enrich_attempted_at') IS NULL
       ${originFilter}
     ORDER BY created_at DESC
     LIMIT $2`,
    [clientId, cap]
  );

  if (leads.length === 0) {
    return { processed: 0, enriched: 0, no_signal: 0, skipped: 0, errors: 0, message: 'No un-enriched cold leads found.' };
  }

  let tenantCfg = null;
  try {
    tenantCfg = await getTenantConfig(clientId);
  } catch (err) {
    logger.warn({ msg: '[cold-signal] tenantConfig load failed — re-scoring will be skipped', err: err.message });
  }

  let enriched = 0, noSignal = 0, skipped = 0, errors = 0, quotaExhausted = false, transientStop = false;
  const details = [];

  for (const lead of leads) {
    if (quotaExhausted || transientStop) { skipped++; continue; }
    try {
      const r = await enrichColdLeadSignal(clientId, lead, tenantCfg);
      if (r.enriched) {
        enriched++;
        details.push({ lead: lead.name, company: lead.company, signal_type: r.signal_type, strength: r.strength, signal: r.signal });
      } else if (r.reason === 'no_signal_found') {
        noSignal++;
      } else if (r.reason === 'brave_quota_exhausted') {
        quotaExhausted = true;
        skipped++;
      } else if (r.reason === 'transient_error') {
        // API overloaded / rate-limited — stop the batch. Remaining leads would
        // fail the same way; they keep their un-attempted state for the next run.
        transientStop = true;
        skipped++;
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      logger.warn({ msg: '[cold-signal] enrich error', leadId: lead.id, err: err.message });
    }
  }

  // Log the run for visibility (same pattern as the follow-up pass).
  try {
    const dayKey = todayInMalaysia();
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'research_beaver', $2, $3::jsonb, 'journal', NOW())
       ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
      [clientId, `cold_signal_enrichment_${dayKey}`, JSON.stringify({
        ran_at: new Date().toISOString(),
        processed: leads.length, enriched, no_signal: noSignal, skipped, errors,
        quota_exhausted: quotaExhausted, transient_stopped: transientStop,
      })]
    );
  } catch { /* non-critical */ }

  return {
    processed: leads.length,
    enriched, no_signal: noSignal, skipped, errors,
    quota_exhausted: quotaExhausted,
    transient_stopped: transientStop,
    details,
    message: `Enriched ${enriched}/${leads.length} cold leads with a buying signal. ${noSignal} had no findable signal, ${skipped} skipped, ${errors} errors${quotaExhausted ? ' (Brave quota hit)' : ''}${transientStop ? ' (STOPPED EARLY: Anthropic API overloaded; un-attempted leads left for retry)' : ''}.`,
  };
}

/**
 * Ensure a lead carries a verifiable personalisation angle BEFORE Sales Beaver
 * drafts (MJ direction 2026-05-19: Sales Beaver finds something real for every
 * lead — no lead is skipped for lack of a pre-found signal). Idempotent — a
 * no-op if metadata.signal already exists. NEVER throws: the draft proceeds
 * regardless; this only enriches.
 *
 * Returns { ok:true, signal, angle, signal_type, strength, source }
 *      or { ok:false, reason }.
 */
async function ensureLeadAngle(clientId, leadId) {
  try {
    if (!leadId) return { ok: false, reason: 'no_lead_id' };
    const { rows } = await pool.query(
      `SELECT id, name, company, title, linkedin_url, metadata, email, email_verified, lead_tier, pipeline_stage
       FROM leads WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [leadId, clientId]
    );
    const lead = rows[0];
    if (!lead) return { ok: false, reason: 'lead_not_found' };

    const meta = lead.metadata || {};
    if (meta.signal && String(meta.signal).trim()) {
      return {
        ok: true, source: 'existing',
        signal: meta.signal, why_now: meta.why_now, angle: meta.angle,
        signal_type: meta.signal_type,
        strength: Number(meta.signal_strength) >= 0.9 ? 'rich' : 'lite',
      };
    }

    let tenantCfg = null;
    try { tenantCfg = await getTenantConfig(clientId); } catch { /* re-score skipped */ }

    const r = await enrichColdLeadSignal(clientId, lead, tenantCfg);
    if (r.enriched) {
      return {
        ok: true,
        source: r.strength === 'rich' ? 'web_event' : 'web_or_role_observation',
        signal: r.signal, signal_type: r.signal_type, strength: r.strength,
      };
    }
    return { ok: false, reason: r.reason || 'not_enriched' };
  } catch (err) {
    logger.warn({ msg: '[ensure-angle] failed — draft proceeds without enrichment', leadId, err: err.message });
    return { ok: false, reason: 'error' };
  }
}

/**
 * Tier-B → Tier-A EMAIL enrichment worker (2026-05-29 supply fix).
 *
 * The missing graduation mechanism. contactGate.js documents a "Tier B retry
 * worker (server/index.js cron) will run ... up to 3x over 14 days" — but no
 * such worker existed. emailEnrichment.findEmail() (Brave domain discovery +
 * /contact scrape + 8-pattern gen + MillionVerifier consensus) was built and
 * wired into pipeline.enrichEmail, but that only fires INSIDE the draft
 * pipeline for leads that already passed the DB-first selector — which
 * excludes Tier-B (no verified email) leads. Result: LinkedIn-only pool leads
 * never became email-draftable, and only email auto-sends. This worker closes
 * that loop: it proactively enriches pool Tier-B leads and promotes the
 * deliverable ones to Tier A so they become auto-sendable email supply.
 *
 * SPEND: findEmail spends Brave (1 query/lead) + MillionVerifier (<=3/lead,
 * spend-guarded). This worker therefore stays OFF behind
 * POOL_EMAIL_ENRICHMENT_ENABLED in index.js until the money-approved proof.
 * dryRun=true returns the candidate selection WITHOUT calling findEmail — a
 * free way to verify the selector before any spend.
 *
 * @param {string} clientId
 * @param {object} opts — { limit?: 1..50 (default 20), dryRun?: bool }
 */
async function runPoolEmailEnrichment(clientId, opts = {}) {
  const dryRun = opts.dryRun === true;
  const budget = dryRun ? { allowed: true, remaining: Infinity } : await checkBudget(clientId);
  const minLlmRemaining = Number(process.env.POOL_EMAIL_ENRICHMENT_MIN_LLM_REMAINING_USD || 1);
  if (!budget.allowed || budget.remaining < minLlmRemaining) {
    return {
      processed: 0,
      promoted: 0,
      no_email: 0,
      errors: 0,
      blocked: true,
      reason: 'llm_budget_blocked',
      period: budget.period,
      spend: budget.spend,
      budget: budget.budget,
      remaining: budget.remaining,
      message: 'Pool email enrichment blocked by LLM budget guard before provider spend.',
    };
  }

  const requestedLimit = Math.min(Math.max(1, parseInt(opts.limit, 10) || 20), 50);
  const braveSpent = dryRun ? requestedLimit : await providerUsageToday('brave', clientId);
  const braveRemaining = dryRun ? requestedLimit : Math.max(0, (Number(CAPS.brave) || 0) - braveSpent);
  const mvSpent = dryRun ? requestedLimit * 3 : await providerUsageToday('millionverifier', clientId);
  const mvRemaining = dryRun ? requestedLimit * 3 : Math.max(0, (Number(CAPS.millionverifier) || 0) - mvSpent);
  const providerBound = dryRun ? requestedLimit : Math.min(braveRemaining, Math.floor(mvRemaining / 3));
  const cap = Math.min(requestedLimit, Math.floor(providerBound));
  if (cap <= 0) {
    return {
      processed: 0,
      promoted: 0,
      no_email: 0,
      errors: 0,
      blocked: true,
      reason: 'provider_capacity_unavailable',
      brave_spent_today: braveSpent,
      brave_cap: CAPS.brave,
      millionverifier_spent_today: mvSpent,
      millionverifier_cap: CAPS.millionverifier,
      message: 'Pool email enrichment blocked before provider spend: no reserved Brave/MillionVerifier capacity available.',
    };
  }
  // Select Tier-B pool leads that are missing a verified email but HAVE a
  // usable company (required for domain discovery) and a LinkedIn URL, and
  // were not attempted in the last 7 days. Junk-company list mirrors the
  // DB-first selector + contactGate so the three agree.
  const { rows: leads } = await pool.query(
    `SELECT id, name, company, title, linkedin_url, email, email_verified, lead_tier, metadata
       FROM leads
      WHERE client_id = $1
        AND deleted_at IS NULL
        AND status = 'new'
        AND pipeline_stage = 'prospecting'
        AND lead_tier = 'B'
        AND (email IS NULL OR email_verified IS NOT TRUE)
        AND linkedin_url IS NOT NULL
        AND NULLIF(BTRIM(company), '') IS NOT NULL
        AND LOWER(BTRIM(company)) NOT IN ('unknown','unknown company','independent','self-employed','self employed','stealth','confidential')
        AND (
          (metadata->>'email_enrich_attempted_at') IS NULL
          OR (metadata->>'email_enrich_attempted_at')::timestamptz < NOW() - INTERVAL '7 days'
        )
      ORDER BY CASE signal_tier WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at DESC
      LIMIT $2`,
    [clientId, cap]
  );

  if (dryRun) {
    return {
      dry_run: true,
      candidates: leads.length,
      sample: leads.slice(0, 10).map(l => ({ name: l.name, company: l.company })),
      message: `[dry-run] ${leads.length} Tier-B leads would be email-enriched (no findEmail called, no spend).`,
    };
  }

  if (leads.length === 0) {
    return { processed: 0, promoted: 0, no_email: 0, errors: 0, message: 'No Tier-B leads eligible for email enrichment.' };
  }

  const { findEmail } = require('./emailEnrichment');
  let promoted = 0, noEmail = 0, errors = 0;
  const nowIso = new Date().toISOString();

  for (const lead of leads) {
    try {
      const result = await findEmail({ name: lead.name, company: lead.company, clientId });
      if (result?.email && result.status === 'deliverable') {
        await pool.query(
          `UPDATE leads
              SET email = $1, email_verified = TRUE, email_source = $2,
                  lead_tier = 'A', tiered_at = NOW(),
                  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'email_enrich_attempted_at', $3::text,
                    'email_confidence', $4::int,
                    'email_is_catch_all', $5::boolean,
                    'promoted_to_a_by', 'pool_email_enrichment'
                  ),
                  updated_at = NOW()
            WHERE id = $6 AND client_id = $7`,
          [result.email, result.email_source || 'findemail', nowIso,
           Math.round(Number(result.confidence) || 0), !!result.isCatchAll, lead.id, clientId]
        );
        promoted++;
      } else {
        // No deliverable email (or risky/catch-all). Keep Tier B, mark attempted
        // so we don't re-spend on this lead for 7 days.
        await pool.query(
          `UPDATE leads
              SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('email_enrich_attempted_at', $1::text),
                  updated_at = NOW()
            WHERE id = $2 AND client_id = $3`,
          [nowIso, lead.id, clientId]
        );
        noEmail++;
      }
    } catch (err) {
      errors++;
      logger.warn({ msg: '[pool-email-enrich] enrich error', leadId: lead.id, err: err.message });
    }
  }

  try {
    const dayKey = todayInMalaysia(new Date(nowIso));
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'research_beaver', $2, $3::jsonb, 'journal', NOW())
       ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
      [clientId, `pool_email_enrichment_${dayKey}`, JSON.stringify({
        ran_at: nowIso, processed: leads.length, promoted, no_email: noEmail, errors,
      })]
    );
  } catch { /* non-critical */ }

  return {
    processed: leads.length, promoted, no_email: noEmail, errors,
    message: `Promoted ${promoted}/${leads.length} Tier-B leads to Tier-A (verified email). ${noEmail} had no deliverable email, ${errors} errors.`,
  };
}

module.exports = {
  enrichLeadForFollowUp,
  runDailyEnrichmentPass,
  isEnrichmentFresh,
  ENRICHMENT_STALE_DAYS,
  synthesizeColdSignal,
  enrichColdLeadSignal,
  repairLeadSignalPackage,
  ensureLeadAngle,
  runColdPoolSignalEnrichment,
  runPoolEmailEnrichment,
};
