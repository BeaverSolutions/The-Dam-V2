'use strict';

/**
 * ============================================================
 * SIGNAL HUNT — Phase C: Signal-First Lead Generation
 * ============================================================
 *
 * Philosophy: signal is the INPUT, not a filter.
 *
 * Flow:
 *   1. Load signal_hunt_config from agent_memory for the client
 *      (or fall back to sensible defaults based on ICP)
 *   2. Run open-web searches for each signal query (funding, hiring, expansion)
 *   3. Use Haiku to parse company name + signal summary from each result
 *   4. For each extracted company, run LinkedIn people search to find founder/decision-maker
 *   5. Enrich with Hunter email
 *   6. Return leads with P1 tag + signal + why_now + angle
 *
 * These leads become the FIRST batch the outreach pipeline processes
 * before falling back to cold research.
 */

const pool = require('../db/pool');
const logsService = require('./logs');
const { searchOpenWeb, searchLinkedInProfiles } = require('./searchService');
const hunterService = require('./hunter');
const { callAgent } = require('./claude');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_SIGNAL_QUERIES_PER_RUN = envInt('SIGNAL_HUNT_MAX_QUERIES', 6);
const MAX_SIGNAL_RESULTS_PER_QUERY = envInt('SIGNAL_HUNT_RESULTS_PER_QUERY', 3);

// Default signal queries — used when no client-specific config exists.
// Phrased as Google search queries with SEA/MY bias.
const DEFAULT_SIGNAL_QUERIES = [
  // Hiring signals (strongest — means they're scaling)
  { query: '"hiring" "sales" "Malaysia" site:linkedin.com/jobs', signal_type: 'hiring_sales', tier: 'P1' },
  { query: '"hiring" "marketing" "Kuala Lumpur"', signal_type: 'hiring_marketing', tier: 'P1' },
  { query: '"hiring" "growth" OR "revops" Malaysia', signal_type: 'hiring_growth', tier: 'P1' },

  // Funding signals
  { query: '"raised" "Malaysia" "Series A" OR "seed round" 2026', signal_type: 'funding', tier: 'P1' },
  { query: '"Malaysia" startup "raised" OR "closed" funding 2026', signal_type: 'funding', tier: 'P1' },

  // Launch / expansion signals
  { query: '"launched" "Malaysia" B2B 2026', signal_type: 'launch', tier: 'P2' },
  { query: '"Malaysia" "expanding" OR "expansion" 2026', signal_type: 'expansion', tier: 'P2' },
  { query: '"Malaysia" "new CEO" OR "new Managing Director" 2026', signal_type: 'leadership_change', tier: 'P2' },
];

const SIGNAL_HUNT_CONFIG_KEY = 'signal_hunt_config';

function listFrom(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}

function countryCodeFromText(value) {
  const s = String(value || '').toLowerCase();
  if (/\b(united states|usa|u\.s\.|us)\b/.test(s)) return 'US';
  if (/\b(singapore|sg)\b/.test(s)) return 'SG';
  if (/\b(malaysia|my|kuala lumpur|klang valley)\b/.test(s)) return 'MY';
  if (/\b(australia|au)\b/.test(s)) return 'AU';
  if (/\b(united kingdom|uk|great britain|gb|england)\b/.test(s)) return 'GB';
  return null;
}

function countryNameFromCode(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'US') return 'United States';
  if (c === 'SG') return 'Singapore';
  if (c === 'AU') return 'Australia';
  if (c === 'GB' || c === 'UK') return 'United Kingdom';
  return 'Malaysia';
}

function countriesFromIcp(icp = {}) {
  const raw = [
    ...listFrom(icp.geographies),
    ...listFrom(icp.geo),
    ...listFrom(icp.countries),
    ...listFrom(icp.locations),
    ...listFrom(icp.target_markets),
  ];
  const countries = raw
    .map(v => countryCodeFromText(v))
    .filter(Boolean)
    .map(code => ({ code, name: countryNameFromCode(code) }));
  const seen = new Set();
  const unique = countries.filter(c => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });
  return unique.length > 0 ? unique : [{ code: 'MY', name: 'Malaysia' }];
}

function industriesFromIcp(icp = {}) {
  const industries = [
    ...listFrom(icp.industries),
    ...listFrom(icp.verticals),
    ...listFrom(icp.segments),
  ];
  return (industries.length > 0 ? industries : ['B2B corporate training', 'digital agency'])
    .slice(0, 3);
}

function hasIcpSearchScope(icp = {}) {
  return [
    ...listFrom(icp.industries),
    ...listFrom(icp.verticals),
    ...listFrom(icp.segments),
    ...listFrom(icp.geographies),
    ...listFrom(icp.geo),
    ...listFrom(icp.countries),
    ...listFrom(icp.locations),
    ...listFrom(icp.target_markets),
  ].length > 0;
}

function buildSignalQueriesFromIcp(icp = {}) {
  const countries = countriesFromIcp(icp);
  const industries = industriesFromIcp(icp);
  const queries = [];
  for (const industry of industries) {
    for (const country of countries) {
      queries.push({
        query: `"${industry}" "${country.name}" "hiring" "sales"`,
        signal_type: 'hiring_sales',
        tier: 'P1',
        country: country.code,
      });
      queries.push({
        query: `"${industry}" "${country.name}" ("expanding" OR "launched" OR "growth") founder OR CEO`,
        signal_type: 'growth_signal',
        tier: 'P1',
        country: country.code,
      });
    }
  }
  return queries;
}

function normalizeSignalQuery(item, fallbackCountry = 'MY') {
  const raw = typeof item === 'string' ? { query: item } : (item || {});
  const query = String(raw.query || raw.search || raw.text || '').trim();
  if (!query) return null;
  const country = String(raw.country || countryCodeFromText(query) || fallbackCountry || 'MY').toUpperCase();
  return {
    query,
    signal_type: raw.signal_type || raw.type || 'buying_signal',
    tier: raw.tier || 'P2',
    country,
  };
}

function queriesFromConfigContent(content) {
  if (Array.isArray(content?.queries) && content.queries.length > 0) return content.queries;
  const signalQueries = content?.signal_queries;
  if (Array.isArray(signalQueries)) return signalQueries;
  if (signalQueries && typeof signalQueries === 'object') {
    return Object.entries(signalQueries).flatMap(([signalType, value]) => {
      const items = Array.isArray(value) ? value : [value];
      return items.map(item => (
        typeof item === 'string'
          ? { query: item, signal_type: signalType }
          : { ...(item || {}), signal_type: item?.signal_type || signalType }
      ));
    });
  }
  return [];
}

/**
 * Load the client's signal hunt config, or return defaults.
 */
async function loadSignalConfig(clientId, icp = {}) {
  let content = null;
  try {
    const { rows } = await pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND key = $2 LIMIT 1`,
      [clientId, SIGNAL_HUNT_CONFIG_KEY]
    );
    content = rows[0]?.content || null;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch { content = null; }
    }
  } catch (err) {
    console.warn('[signalHunt] Failed to load config, using defaults:', err.message);
  }

  const configuredQueries = queriesFromConfigContent(content);
  const icpQueries = hasIcpSearchScope(icp) ? buildSignalQueriesFromIcp(icp) : [];
  const fallbackQueries = icpQueries.length > 0
    ? [...icpQueries, ...configuredQueries]
    : (configuredQueries.length > 0 ? configuredQueries : DEFAULT_SIGNAL_QUERIES);
  const querySource = icpQueries.length > 0
    ? (configuredQueries.length > 0 ? 'current_icp_then_config' : 'current_icp')
    : (configuredQueries.length > 0 ? 'stored_config' : 'default');
  const seenQueries = new Set();
  const fallbackCountry = countriesFromIcp(icp)[0]?.code || 'MY';
  const queries = fallbackQueries
    .map(q => normalizeSignalQuery(q, fallbackCountry))
    .filter(Boolean)
    .filter(q => {
      const key = q.query.toLowerCase();
      if (seenQueries.has(key)) return false;
      seenQueries.add(key);
      return true;
    })
    .slice(0, MAX_SIGNAL_QUERIES_PER_RUN);
  const requestedResults = Number(content?.max_results_per_query || MAX_SIGNAL_RESULTS_PER_QUERY);

  return {
    ...(content || {}),
    queries,
    query_source: querySource,
    max_results_per_query: Number.isFinite(requestedResults) && requestedResults > 0
      ? Math.min(requestedResults, MAX_SIGNAL_RESULTS_PER_QUERY)
      : MAX_SIGNAL_RESULTS_PER_QUERY,
  };
}

/**
 * Extract companies + signal data through the budgeted Research Beaver path.
 */
async function extractSignalsFromResults(clientId, results, signal_type, geoText = 'the configured target geographies') {
  if (!results || results.length === 0) return [];

  const snippetsForBudgetedAgent = results.map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}${r.date ? `\nDate: ${r.date}` : ''}`
  ).join('\n\n');

  try {
    const parsed = await callAgent('research_beaver', `You are a buying signal detector. Analyse these search results and extract real buying signals for B2B outreach.

Signal type: ${signal_type}

Search results:
${snippetsForBudgetedAgent}

For each result containing a REAL buying signal from a company in ${geoText}, return JSON array:
[{
  "company": "Exact company name",
  "signal_type": "${signal_type}",
  "signal_summary": "One sentence: what happened and why it matters for outreach",
  "why_now": "One sentence: why NOW is the right time to reach out",
  "angle": "One sentence: the opening angle Sales Beaver should use",
  "signal_date": "YYYY-MM-DD or empty",
  "source_url": "the URL",
  "raw_snippet": "original snippet",
  "confidence": 0.0-1.0
}]

Rules:
- Only include REAL signals from companies in ${geoText}
- Ignore generic articles, listicles, job boards with no specific company
- Confidence 0.9 = very clear specific company + event, 0.5 = weak
- If no real signals found, return []
- Return ONLY the JSON array, nothing else`, { clientId });
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.signals)) return parsed.signals;
    if (Array.isArray(parsed?.data)) return parsed.data;
    if (typeof parsed?.raw === 'string') {
      const jsonMatch = parsed.raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.warn('[signalHunt] budgeted signal parsing failed:', err.message);
  }

  return [];

}

/**
 * For a company with a signal, find the best decision-maker via LinkedIn.
 * Returns { name, title, linkedin_url } or null.
 */
async function findDecisionMaker(companyName, icpTitles = [], country = 'MY') {
  if (!companyName) return null;

  const titleHints = icpTitles.length > 0 ? icpTitles.slice(0, 3).join(' OR ') : 'founder OR CEO OR director';
  const query = `"${companyName}" (${titleHints})`;

  try {
    const profiles = await searchLinkedInProfiles(query, 3, { country });
    if (profiles.length === 0) return null;

    // Prefer the highest-seniority title
    const seniorityRank = (title) => {
      const t = (title || '').toLowerCase();
      if (/founder|ceo|co-founder/.test(t)) return 5;
      if (/managing director|md|president/.test(t)) return 4;
      if (/director|head of|vp/.test(t)) return 3;
      if (/manager|lead/.test(t)) return 2;
      return 1;
    };

    const sorted = profiles
      .filter(p => p.name && p.linkedin_url)
      .sort((a, b) => seniorityRank(b.title) - seniorityRank(a.title));

    return sorted[0] || null;
  } catch (err) {
    console.warn(`[signalHunt] findDecisionMaker failed for ${companyName}:`, err.message);
    return null;
  }
}

/**
 * Main entry point: run a signal hunt for a client.
 * Returns an array of lead objects ready for the outreach pipeline.
 *
 * @param {string} clientId
 * @param {object} options
 * @param {number} options.maxLeads - stop after finding this many leads (default 20)
 * @param {object} options.icp - ICP memory for seniority ranking
 * @returns {Promise<Array<Lead>>}
 */
async function runSignalHunt(clientId, { maxLeads = 20, icp = {}, maxPaidQueries = null } = {}) {
  console.log(`[signalHunt] Starting signal hunt for client ${clientId} (target: ${maxLeads})`);

  const config = await loadSignalConfig(clientId, icp);
  const allSignals = [];
  const leads = [];
  let queriesRun = 0;
  let paidQueriesRemaining = Number.isFinite(Number(maxPaidQueries))
    ? Math.max(0, Number(maxPaidQueries))
    : null;
  const consumePaidQuery = (units = 1) => {
    if (paidQueriesRemaining === null) return true;
    const needed = Math.max(1, Number(units) || 1);
    if (paidQueriesRemaining < needed) return false;
    paidQueriesRemaining -= needed;
    return true;
  };

  // Step 1: Run all signal queries in sequence (cost control)
  for (const q of config.queries) {
    if (allSignals.length >= maxLeads * 2) break; // 2x buffer — some will fail contact lookup

    if (!consumePaidQuery(1)) {
      console.log('[signalHunt] Paid-query budget exhausted before open-web signal search');
      break;
    }

    console.log(`[signalHunt] Running query: ${q.query}`);
    queriesRun++;
    try {
      const country = q.country || 'MY';
      const geoText = countryNameFromCode(country);
      const results = await searchOpenWeb(q.query, config.max_results_per_query || 5, { country });
      if (results.length === 0) continue;

      const extracted = await extractSignalsFromResults(clientId, results, q.signal_type, geoText);
      const validSignals = extracted.filter(s => s.company && s.confidence >= 0.5);

      // Assign tier from the query config
      validSignals.forEach(s => {
        s.tier = q.tier || 'P2';
        s.country = country;
      });
      allSignals.push(...validSignals);

      console.log(`[signalHunt] Query "${q.signal_type}" extracted ${validSignals.length} signals`);
    } catch (err) {
      console.warn(`[signalHunt] Query failed: ${err.message}`);
    }
  }

  console.log(`[signalHunt] Total signals extracted: ${allSignals.length}`);

  if (allSignals.length === 0) {
    await logsService.createLog(clientId, {
      agent: 'research_beaver',
      action: 'signal_hunt_complete',
      metadata: {
        query_source: config.query_source,
        queries_run: queriesRun,
        queries_preview: config.queries.slice(0, queriesRun).map(q => q.query),
        paid_query_budget_remaining: paidQueriesRemaining,
        total_signals: 0,
        unique_companies: 0,
        leads_with_contacts: 0,
        tiers: {},
      },
    }).catch(() => {});
    return [];
  }

  // Step 2: Dedupe by company name
  const seenCompanies = new Set();
  const uniqueSignals = allSignals.filter(s => {
    const key = (s.company || '').toLowerCase().trim();
    if (!key || seenCompanies.has(key)) return false;
    seenCompanies.add(key);
    return true;
  });

  // Step 3: Sort P1 first
  uniqueSignals.sort((a, b) => {
    const rank = { P1: 3, P2: 2, P3: 1 };
    return (rank[b.tier] || 0) - (rank[a.tier] || 0);
  });

  // Step 4: For each signal, find the decision-maker
  const icpTitles = (icp.job_titles || icp.who || '').split(',').map(t => t.trim()).filter(Boolean);

  for (const signal of uniqueSignals.slice(0, maxLeads * 2)) {
    if (leads.length >= maxLeads) break;

    if (!consumePaidQuery(1)) {
      console.log('[signalHunt] Paid-query budget exhausted before decision-maker lookup');
      break;
    }

    const country = signal.country || countryCodeFromText(signal.raw_snippet || signal.signal_summary || '') || 'MY';
    const countryName = countryNameFromCode(country);
    const person = await findDecisionMaker(signal.company, icpTitles, country);
    if (!person || !person.linkedin_url) {
      console.log(`[signalHunt] No decision-maker found for ${signal.company}`);
      continue;
    }

    const { applyIcpV2Filter } = require('./agents');
    const gate = applyIcpV2Filter({
      name: person.name,
      company: signal.company,
      title: person.title || '',
      country: countryName,
      score: signal.tier === 'P1' ? 90 : 70,
      metadata: { country: countryName },
    });
    if (!gate.pass) {
      console.log(`[signalHunt] ICP gate blocked ${person.name} / ${signal.company}: ${gate.reason}`);
      continue;
    }

    // Step 5: Hunter email enrichment
    let email = null;
    let email_source = null;
    let email_verified = false;
    const hunterEnabled = Number(require('./spendGuard').CAPS.hunter || 0) > 0;
    if (hunterEnabled) {
      try {
        const nameParts = (person.name || '').trim().split(/\s+/);
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        const hunter = await hunterService.findEmail(clientId, {
          firstName,
          lastName,
          company: signal.company,
        });
        if (hunter?.email) {
          email = hunter.email;
          email_source = 'hunter';
          email_verified = !!hunter.verified;
        }
      } catch (err) {
        console.warn(`[signalHunt] Hunter enrichment failed for ${person.name}:`, err.message);
      }
    }

    leads.push({
      name: person.name,
      title: person.title || '',
      company: signal.company,
      linkedin_url: person.linkedin_url,
      email,
      email_source,
      email_verified,
      signal_tier: signal.tier,
      score: signal.tier === 'P1' ? 90 : 70,
      verified: true,
      data_source: 'signal_hunt',
      metadata: {
        signal: signal.signal_summary,
        why_now: signal.why_now,
        angle: signal.angle,
        signal_type: signal.signal_type,
        signal_source_url: signal.source_url,
        signal_confidence: signal.confidence,
        country: countryName,
        tier: signal.tier,
        source: 'signal_hunt',
      },
    });
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'signal_hunt_complete',
    metadata: {
      query_source: config.query_source,
      queries_run: queriesRun,
      queries_preview: config.queries.slice(0, queriesRun).map(q => q.query),
      paid_query_budget_remaining: paidQueriesRemaining,
      total_signals: allSignals.length,
      unique_companies: uniqueSignals.length,
      leads_with_contacts: leads.length,
      tiers: leads.reduce((acc, l) => {
        acc[l.signal_tier] = (acc[l.signal_tier] || 0) + 1;
        return acc;
      }, {}),
    },
  }).catch(() => {});

  console.log(`[signalHunt] Returning ${leads.length} leads with decision-makers`);
  return leads;
}

/**
 * Save signal-sourced leads directly to the DB, bypassing the Captain gates
 * (signals are pre-qualified — they ARE the filter).
 */
async function saveSignalLeads(clientId, leads) {
  const saved = [];
  const contactGate = require('./contactGate');

  for (const lead of leads) {
    // Dedup check on LinkedIn URL
    if (lead.linkedin_url) {
      const dup = await pool.query(
        `SELECT id FROM leads WHERE client_id = $1 AND linkedin_url = $2 AND deleted_at IS NULL LIMIT 1`,
        [clientId, lead.linkedin_url]
      );
      if (dup.rows.length > 0) {
        console.log(`[signalHunt] Skipping duplicate: ${lead.linkedin_url}`);
        continue;
      }
    }

    // Tiered contact gate (migration 061, 2026-05-05): assigns A/B tier;
    // C rejected and logged. Signals are pre-qualified by intent but signal
    // alone doesn't grant Tier A — channel-presence still required.
    const gateResult = await contactGate.tryPersistSourcedLead(clientId, lead, {
      sourceStrategy: 'signal_hunt',
      allowLinkedinOnly: !!lead.linkedin_only_override,
    });
    if (!gateResult.passed) {
      console.log(`[signalHunt] Tier C ${lead.name} — reason: ${gateResult.missReason}`);
      continue;
    }
    const leadTier = gateResult.tier;

    // Phase 2 V2 Step 6 (2026-05-08): buying_signal_strength + signal_dated_at.
    // signalHunt is a SIGNAL-FIRST producer — by definition every lead it
    // sources has a buying signal in metadata. Default to 'rich' (the source
    // of truth IS the signal hunt) unless explicitly overridden, with the
    // signal date pulled from metadata.signal_dated_at if Research Beaver
    // emitted it, else NOW() (today's hunt).
    const buyingSignalStrength = lead.buying_signal_strength
      || lead.metadata?.buying_signal_strength
      || 'rich';
    const signalDatedAt = lead.signal_dated_at
      || lead.metadata?.signal_dated_at
      || new Date().toISOString();

    try {
      const res = await pool.query(
        `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                            pipeline_stage, status, email_verified, email_source, linkedin_url, metadata,
                            lead_tier, tiered_at,
                            buying_signal_strength, signal_dated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'signal_hunt','prospecting','new',$8,$9,$10,$11,$12,NOW(),$13,$14)
         RETURNING *`,
        [
          clientId, lead.name, lead.email || null, lead.company, lead.title || null,
          lead.signal_tier, lead.score,
          lead.email_verified, lead.email_source, lead.linkedin_url,
          JSON.stringify(lead.metadata || {}),
          leadTier,
          buyingSignalStrength, signalDatedAt,
        ]
      );
      if (res.rows.length > 0) saved.push(res.rows[0]);
    } catch (err) {
      console.error('[signalHunt] Failed to save signal lead:', err.message);
    }
  }

  return saved;
}

module.exports = { runSignalHunt, saveSignalLeads, loadSignalConfig };
