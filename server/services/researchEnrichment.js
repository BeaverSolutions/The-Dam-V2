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

const ENRICHMENT_STALE_DAYS = 7;
const MAX_ENRICHMENT_PER_DAY = 30; // hard cap to prevent Brave burn

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
async function searchFreshSignals(lead) {
  const company = (lead.company || '').trim();
  if (!company || /^(unknown|n\/a|independent)$/i.test(company)) return null;

  // Three targeted queries — small total Brave footprint per lead
  const queries = [
    `"${company}" hiring OR recruiting OR "we're hiring" 2026`,
    `"${company}" news OR funding OR launch OR announced`,
    lead.name ? `"${lead.name}" "${company}" LinkedIn` : null,
  ].filter(Boolean);

  const allHits = [];
  for (const q of queries) {
    try {
      const hits = await searchOpenWeb(q, 3);
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
async function enrichLeadForFollowUp(clientId, lead) {
  // Skip conditions
  if (isEnrichmentFresh(lead.metadata)) {
    return { enriched: false, reason: 'fresh_enrichment_exists' };
  }
  const company = (lead.company || '').trim();
  if (!company || /^(unknown|independent|n\/a|self[- ]?employed|freelanc|stealth)$/i.test(company)) {
    return { enriched: false, reason: 'thin_context' };
  }

  const searchResult = await searchFreshSignals(lead);
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
  const today = new Date().toISOString().split('T')[0];

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
    [clientId, today, MAX_ENRICHMENT_PER_DAY]
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
      const result = await enrichLeadForFollowUp(clientId, lead);
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
  'product_launch', 'scaling_pain', 'agency_expansion',
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
{"signal": "<one specific verifiable fact about this prospect/company>", "why_now": "<one sentence>", "angle": "<one-line angle tying it to an AI outbound-sales tool>", "signal_type": "<one of: ${COLD_SIGNAL_TYPES.join(', ')}>", "strength": "rich|lite"}`;

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
      return parsed;
    }
    // LLM returned nothing usable — fall through to the deterministic floor.
  } catch (err) {
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
  const meta = lead.metadata || {};
  if (meta.signal) return { enriched: false, reason: 'already_has_signal' };
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
  const searchResult = await searchFreshSignals(lead);
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
  const signalFields = {
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

  return { enriched: true, signal_type: syn.signal_type, strength: syn.strength, signal: syn.signal };
}

/**
 * Batch: enrich up to `limit` cold prospecting-stage leads that have no
 * signal yet. Manual entry point — NOT wired to any cron. Spend-capped:
 * `limit` is hard-bounded 1..25; each lead is <=3 web searches + 1 Haiku call.
 */
async function runColdPoolSignalEnrichment(clientId, opts = {}) {
  const cap = Math.min(Math.max(1, parseInt(opts.limit, 10) || 5), 25);
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
    const dayKey = new Date().toISOString().split('T')[0];
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
  const cap = Math.min(Math.max(1, parseInt(opts.limit, 10) || 20), 50);
  const dryRun = opts.dryRun === true;

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
      const result = await findEmail({ name: lead.name, company: lead.company });
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
    const dayKey = nowIso.split('T')[0];
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
  ensureLeadAngle,
  runColdPoolSignalEnrichment,
  runPoolEmailEnrichment,
};
