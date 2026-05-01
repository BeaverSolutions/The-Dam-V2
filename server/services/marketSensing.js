'use strict';

/**
 * Phase E — Market Sensing Layer (MY-only v1).
 *
 * Pulls Malaysia business/tech/marketing news from a fixed source set,
 * uses Brave Search (already authenticated) to query each source for
 * signals matching the tenant's signal_preferences weights and ICP
 * verticals, then asks Haiku to extract named opportunities with a
 * specific outreach angle per row.
 *
 * Persists to agent_memory keyed `market_signals_YYYY-MM-DD` so:
 *   1. Captain's morning brief can surface "3 fresh signals today"
 *   2. Research Beaver can read at start of run and source those leads
 *   3. Sales Beaver can use the outreach_angle as personalization seed
 *
 * v1 scope: MY-only sources. SEA expansion (TechCrunch / e27 /
 * DealStreetAsia / Tech in Asia) deferred to v2 once MY signal quality
 * is proven.
 */

const axios = require('axios');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const { callAgent } = require('./claude');

// MY-only news sources for v1. Each carries a domain (for site: queries)
// and a friendly name (for surfacing to MJ + the LLM).
const MY_SOURCES = [
  { name: 'Edge Markets MY',     domain: 'theedgemalaysia.com' },
  { name: 'Vulcan Post MY',      domain: 'vulcanpost.com' },
  { name: 'Digital News Asia',   domain: 'digitalnewsasia.com' },
  { name: 'SoyaCincau',          domain: 'soyacincau.com' },
  { name: 'Marketing Magazine',  domain: 'marketingmagazine.com.my' },
  { name: 'Free Malaysia Today', domain: 'freemalaysiatoday.com' },
  { name: 'The Star',            domain: 'thestar.com.my' },
];

// Generic high-signal triggers, keyed by signal_preferences slot.
// Brave site:DOMAIN <signal-clause> [<vertical-clause>] composes per query.
const SIGNAL_KEYWORDS = {
  funding:           '("raises" OR "Series A" OR "Series B" OR "seed round" OR funding OR raised)',
  hiring_sales:      '("head of sales" OR "VP sales" OR "sales director" OR "hiring sales")',
  hiring_marketing:  '(CMO OR "head of marketing" OR "marketing director" OR "appoints marketing")',
  exec_change:       '("appoints" OR "named CEO" OR "named CMO" OR "new CEO" OR "new CMO")',
  expansion:         '("expansion" OR expands OR "new office" OR "Malaysia office" OR "launches in Malaysia")',
  product_launch:    '("launches" OR "launched a" OR unveils OR "rolls out")',
  scaling_pain:      '("hiring spree" OR "doubled headcount" OR "scaling team")',
  competitor_switch: '("switches from" OR "replaces" OR "migrated from")',
};

const TOP_SIGNALS_PER_RUN = 3;            // Pick top-N weighted signals per run
const RESULTS_PER_QUERY   = 5;            // Brave count per query
const QUERY_GAP_MS        = 150;          // Gap between Brave calls (politeness)
const MAX_RAW_FOR_LLM     = 80;           // Cap input to Haiku to avoid token blowout

/**
 * Pull tenant config + return ranked signal slots and the vertical clause.
 */
async function loadTenantContext(clientId) {
  const { rows: [client] } = await pool.query(
    `SELECT name, signal_preferences, offering, icp_config FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!client) throw new Error(`client ${clientId} not found`);

  const verticals     = client.icp_config?.verticals || [];
  const signalWeights = client.signal_preferences || {};

  // Top-N signals by weight, filtered to ones we have keyword templates for
  const topSignals = Object.entries(signalWeights)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter(k => SIGNAL_KEYWORDS[k])
    .slice(0, TOP_SIGNALS_PER_RUN);

  // Vertical clause — humanize underscores so search engines match prose
  const verticalsClause = verticals.length
    ? `(${verticals.map(v => `"${v.replace(/_/g, ' ')}"`).join(' OR ')})`
    : '';

  return { client, topSignals, verticalsClause };
}

/**
 * Fan out Brave queries: SOURCES × topSignals. Sequential with small gap
 * so we don't trip the free-tier rate limit. Results deduped by URL.
 */
async function fetchSignals(clientId) {
  const { topSignals, verticalsClause } = await loadTenantContext(clientId);
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    logger.warn({ msg: '[market-sensing] BRAVE_API_KEY not set, returning empty' });
    return [];
  }
  if (topSignals.length === 0) {
    logger.warn({ msg: '[market-sensing] no usable signal_preferences slots' });
    return [];
  }

  // v1 loosens the query to signal-only (no vertical clause) — combined
  // site: + signal + vertical was too narrow on smaller MY publications
  // and starved the LLM input. Vertical filtering moves to the Haiku
  // extraction step instead, which has the full ICP context.
  const queries = [];
  for (const source of MY_SOURCES) {
    for (const sig of topSignals) {
      const q = `site:${source.domain} ${SIGNAL_KEYWORDS[sig]}`;
      queries.push({ source: source.name, signal: sig, query: q });
    }
  }
  // Mark the (currently unused) vertical clause so future v2 reuse is obvious
  void verticalsClause;

  const all = [];
  let okCount = 0;
  let errCount = 0;
  for (const { source, signal, query } of queries) {
    try {
      const resp = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q: query, count: RESULTS_PER_QUERY, country: 'MY', search_lang: 'en', safesearch: 'moderate' },
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json', 'Accept-Encoding': 'gzip' },
        timeout: 8000,
      });
      const items = (resp.data?.web?.results || []).map(r => ({
        title:   r.title || '',
        url:     r.url || '',
        snippet: r.description || '',
        page_age: r.page_age || null,
        source,
        signal,
      }));
      all.push(...items);
      okCount++;
    } catch (err) {
      errCount++;
      logger.warn({ msg: '[market-sensing] brave query failed', source, signal, err: err.message });
    }
    await new Promise(r => setTimeout(r, QUERY_GAP_MS));
  }

  // Dedupe by URL — same article may come up under multiple signal clauses
  const byUrl = new Map();
  for (const r of all) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, r);
  }
  const deduped = Array.from(byUrl.values());

  logger.info({
    msg: '[market-sensing] fetch done',
    queries: queries.length,
    ok: okCount,
    err: errCount,
    raw_results: all.length,
    deduped: deduped.length,
  });

  return deduped;
}

/**
 * Hand raw signals to Haiku for opportunity extraction. Strict instruction:
 * named company in our ICP, recent specific buying signal, ruthless quality
 * filter. Returns array of opportunity objects.
 */
async function extractOpportunities(clientId, rawSignals) {
  if (rawSignals.length === 0) return [];

  const { client } = await loadTenantContext(clientId);
  const tenantContext = `Tenant: ${client.name}
Offering: ${client.offering?.headline || 'AI outreach platform'}
Pitch frame: ${client.offering?.pitch_frame || ''}
Target persona: ${client.offering?.target_persona || ''}
ICP verticals: ${(client.icp_config?.verticals || []).join(', ')}
ICP countries: ${(client.icp_config?.countries || []).join(', ')}
ICP company size: ${client.icp_config?.company_size?.min ?? '?'}-${client.icp_config?.company_size?.max ?? '?'}`;

  const trimmed = rawSignals.slice(0, MAX_RAW_FOR_LLM);

  const userMessage = `${tenantContext}

You are scanning Malaysia news for HIGH-INTENT buying signals for THIS tenant. Below are ${trimmed.length} raw search snippets from MY business/tech/marketing publications. Extract ONLY items where:
- A real named company is identifiable (not "an agency" — name it)
- The company is plausibly in the tenant's ICP (or close enough to be worth outreach)
- A specific recent signal is present (funding, exec hire, expansion, product launch, hiring spree)

OUTPUT — JSON array, each item:
{
  "company": "<exact company name>",
  "signal_type": "funding|hiring|exec_change|expansion|product_launch",
  "signal_summary": "<1-line specific fact, no fluff>",
  "url": "<source url>",
  "source": "<publication>",
  "confidence": "high|medium|low",
  "outreach_angle": "<1-line specific angle that ties this signal to the tenant's offering>"
}

Be RUTHLESS:
- Skip generic listicles, opinion pieces, year-end roundups
- Skip companies clearly out of ICP size band (e.g. multinationals if ICP is SMB)
- Skip if you can't name a specific company with high confidence
- Skip if the signal is stale (>30 days) when a publication date suggests so
- Quality > quantity — a 0-row return is fine if nothing meaningful surfaces

Raw search results:
${JSON.stringify(trimmed, null, 2)}

Respond with the JSON array only — no markdown fences, no preamble.`;

  let opportunities = [];
  try {
    const result = await callAgent('market_sensor', userMessage, { clientId });
    if (Array.isArray(result)) {
      opportunities = result;
    } else if (Array.isArray(result?.opportunities)) {
      opportunities = result.opportunities;
    } else if (Array.isArray(result?.raw)) {
      opportunities = result.raw;
    } else if (typeof result?.raw === 'string') {
      // Sometimes Haiku wraps in {raw: "[...]"}; try to parse
      try {
        const parsed = JSON.parse(result.raw);
        if (Array.isArray(parsed)) opportunities = parsed;
      } catch { /* leave empty */ }
    }
  } catch (err) {
    logger.warn({ msg: '[market-sensing] LLM extraction failed', err: err.message });
  }

  logger.info({
    msg: '[market-sensing] extraction done',
    raw: trimmed.length,
    opportunities: opportunities.length,
  });

  return opportunities;
}

/**
 * Persist a market-sensing run to agent_memory. UPSERT so multiple runs
 * the same day overwrite cleanly (cron has time-gate + dedup separately).
 */
async function persistMarketSignals(clientId, payload) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'market_sensor', $2, $3::jsonb, 'config')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, `market_signals_${today}`, JSON.stringify(payload)]
  );
}

/**
 * Public entry: full market-sensing flow. Returns payload (saved + returned).
 */
async function runMarketSensing(clientId) {
  const startedAt = new Date();
  const rawSignals = await fetchSignals(clientId);
  const opportunities = await extractOpportunities(clientId, rawSignals);

  const payload = {
    date: startedAt.toISOString().slice(0, 10),
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    sources_queried: MY_SOURCES.length,
    raw_results_count: rawSignals.length,
    opportunities,
    // Compact debug view — first 25 raw titles by source, so we can audit
    // why opportunities count is low without re-querying Brave
    raw_sample: rawSignals.slice(0, 25).map(r => ({
      source: r.source, signal: r.signal, title: r.title.slice(0, 120), url: r.url,
    })),
  };

  await persistMarketSignals(clientId, payload).catch(err =>
    logger.warn({ msg: '[market-sensing] persist failed', err: err.message })
  );

  return payload;
}

module.exports = { runMarketSensing, fetchSignals, extractOpportunities, MY_SOURCES };
