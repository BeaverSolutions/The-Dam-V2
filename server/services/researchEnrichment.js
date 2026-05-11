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

module.exports = {
  enrichLeadForFollowUp,
  runDailyEnrichmentPass,
  isEnrichmentFresh,
  ENRICHMENT_STALE_DAYS,
};
