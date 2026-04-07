'use strict';

const pool = require('../db/pool');
const serperService = require('./serper');
const hunterService = require('./hunter');

/* ─── Rotation pools ─────────────────────────────────────── */

const DEFAULT_TITLES = [
  'CEO', 'Founder', 'Co-Founder', 'Managing Director', 'Owner',
  'Director', 'MD',
];

const DEFAULT_INDUSTRIES = [
  'consulting', 'agency', 'SaaS', 'training',
  'professional services', 'recruitment',
];

const KL_LOCATIONS = [
  'Kuala Lumpur', 'Petaling Jaya', 'Bangsar', 'Damansara',
  'Subang Jaya', 'Shah Alam', 'TTDI', 'Klang Valley',
];

const SIGNALS = [
  'hiring', 'expanding', 'growing team',
  'new clients', 'launched', 'Series A',
];

const ICP_TITLE_KEYWORDS = [
  'ceo', 'founder', 'co-founder', 'director', 'md',
  'managing director', 'owner',
];

/* ─── Helpers ────────────────────────────────────────────── */

/**
 * Parse a comma-separated string into a trimmed array, ignoring empties.
 */
function parseCsvField(value) {
  if (!value || typeof value !== 'string') return [];
  return value.split(',').map(v => v.trim()).filter(Boolean);
}

/**
 * Normalise a lead to the standard output shape.
 */
function normaliseLead(partial) {
  return {
    name:           partial.name           || '',
    title:          partial.title          || '',
    company:        partial.company        || '',
    linkedin_url:   partial.linkedin_url   || '',
    email:          partial.email          || '',
    email_verified: partial.email_verified || false,
    email_source:   partial.email_source   || '',
    verified:       true,
    data_source:    partial.data_source    || 'serper',
    snippet:        partial.snippet        || '',
  };
}

/* ─── Query pool ─────────────────────────────────────────── */

/**
 * QUERY POOL — generates all possible Serper queries from ICP config.
 * Returns array of { query, strategy, title, industry, location }
 */
function buildQueryPool(icpMemory) {
  const icp = icpMemory || {};

  // Resolve titles
  const rawTitles = parseCsvField(icp.job_titles || icp.who);
  const titles = rawTitles.length > 0 ? rawTitles : DEFAULT_TITLES;

  // Resolve industries
  const rawIndustries = parseCsvField(icp.industries);
  const industries = rawIndustries.length > 0 ? rawIndustries : DEFAULT_INDUSTRIES;

  // Resolve base location (use first entry of KL_LOCATIONS if empty)
  const rawLocation = (icp.location || icp.geography || '').trim();
  const baseLocation = rawLocation || KL_LOCATIONS[0];

  const pool = [];

  for (const title of titles) {
    for (const industry of industries) {
      // Strategy: direct people search
      pool.push({
        query:    `site:linkedin.com/in ${title} ${industry} "${baseLocation}"`,
        strategy: 'direct',
        title,
        industry,
        location: baseLocation,
      });

      // Strategy: company search (one per industry × location, deduplicated later)
      pool.push({
        query:    `site:linkedin.com/company ${industry} "${baseLocation}"`,
        strategy: 'company',
        title:    '',
        industry,
        location: baseLocation,
      });

      // Strategy: buying signal — job postings (indicates growth/hiring intent)
      pool.push({
        query:    `site:linkedin.com/jobs "Head of Sales" "${industry}" "${baseLocation}"`,
        strategy: 'signal_jobs',
        title,
        industry,
        location: baseLocation,
      });

      // Strategy: buying signal — news (hiring/raised/launched)
      pool.push({
        query:    `"${industry}" "${baseLocation}" hiring OR raised OR launched 2024 OR 2025`,
        strategy: 'signal_news',
        title:    '',
        industry,
        location: baseLocation,
      });
    }

    for (const signal of SIGNALS) {
      // Strategy: signal-based
      pool.push({
        query:    `site:linkedin.com/in "${title}" "${baseLocation}" ${signal}`,
        strategy: 'signal',
        title,
        industry: '',
        location: baseLocation,
      });
    }

    // Strategy: buying signal — LinkedIn company growth
    for (const industry of industries.slice(0, 3)) { // cap to avoid too many queries
      pool.push({
        query:    `site:linkedin.com/company "${industry}" "${baseLocation}" employees`,
        strategy: 'signal_growth',
        title:    '',
        industry,
        location: baseLocation,
      });
    }
  }

  // Deduplicate by query string (company queries repeat per title loop)
  const seen = new Set();
  return pool.filter(item => {
    if (seen.has(item.query)) return false;
    seen.add(item.query);
    return true;
  });
}

/* ─── Query tracker ──────────────────────────────────────── */

/**
 * QUERY TRACKER — loads used queries from agent_memory.
 * Returns a Set of used query strings.
 */
async function loadUsedQueries(clientId) {
  try {
    const result = await pool.query(
      `SELECT content FROM agent_memory
       WHERE client_id = $1
         AND agent = 'research_beaver'
         AND key = 'used_queries'
       LIMIT 1`,
      [clientId]
    );
    if (result.rows.length === 0) return new Set();
    const arr = result.rows[0].content;
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    console.warn('[research] loadUsedQueries failed:', err.message);
    return new Set();
  }
}

/**
 * QUERY TRACKER — saves updated used queries back to agent_memory.
 */
async function saveUsedQueries(clientId, usedSet) {
  try {
    const arr = Array.from(usedSet);
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'research_beaver', 'used_queries', $2::jsonb, 'config', NOW())
       ON CONFLICT (client_id, agent, key)
       DO UPDATE SET content = $2::jsonb, updated_at = NOW()`,
      [clientId, JSON.stringify(arr)]
    );
  } catch (err) {
    console.warn('[research] saveUsedQueries failed:', err.message);
  }
}

/* ─── Strategy 1: Direct LinkedIn people search ──────────── */

/**
 * STRATEGY 1: Direct LinkedIn people search.
 * Serper: site:linkedin.com/in [title] [industry] [location]
 */
async function strategyDirectPeople(query, limit) {
  try {
    const results = await serperService.searchLinkedInProfiles(query, limit);
    return results.map(r => normaliseLead({
      ...r,
      data_source:  'serper',
      email_source: r.email ? 'serper' : '',
    }));
  } catch (err) {
    console.warn('[research] Strategy 1 (direct people) failed:', err.message);
    return [];
  }
}

/* ─── Strategy 2: Company-first search ───────────────────── */

/**
 * STRATEGY 2: Company-first search.
 * Step 1 — Serper: site:linkedin.com/company [industry] [location]
 * Step 2 — For each company: Hunter domainSearch to find decision-makers.
 * Returns leads with real emails where Hunter finds them.
 */
async function strategyCompanyFirst(clientId, icpMemory, limit) {
  const leads = [];

  try {
    // Pull company queries from the query pool
    const queryPool = buildQueryPool(icpMemory);
    const companyQueries = queryPool
      .filter(q => q.strategy === 'company')
      .slice(0, 3); // cap at 3 company queries to limit API spend

    for (const item of companyQueries) {
      try {
        // Step 1: find company LinkedIn pages via Serper
        const companyResults = await serperService.searchLinkedInCompanies
          ? serperService.searchLinkedInCompanies(item.query, 3)
          : Promise.resolve([]);

        const companies = await companyResults;

        for (const c of companies) {
          const companyName = c.company || c.name || '';
          const domain = c.website || c.domain || '';

          if (!companyName && !domain) continue;

          // Step 2: Hunter domain search
          let hunterLeads = [];
          try {
            hunterLeads = await hunterService.domainSearch(clientId, {
              company: companyName,
              domain:  domain || undefined,
              limit:   3,
            });
          } catch (hErr) {
            console.warn('[research] Hunter domainSearch error:', hErr.message);
          }

          // Filter Hunter results by ICP-relevant titles
          const filtered = hunterLeads.filter(h => {
            if (!h.title) return false;
            const t = h.title.toLowerCase();
            return ICP_TITLE_KEYWORDS.some(kw => t.includes(kw));
          });

          if (filtered.length > 0) {
            for (const h of filtered) {
              leads.push(normaliseLead({
                name:           `${h.firstName || ''} ${h.lastName || ''}`.trim(),
                title:          h.title || '',
                company:        companyName,
                linkedin_url:   h.linkedin_url || '',
                email:          h.email || '',
                email_verified: h.confidence >= 70,
                email_source:   h.email ? 'hunter_domain' : '',
                data_source:    'hunter_domain',
              }));
            }
          } else if (companyName) {
            // Fallback: Serper people search scoped to this company
            try {
              const fallbackQuery = `site:linkedin.com/in "${companyName}" CEO OR Founder`;
              const fallbackResults = await serperService.searchLinkedInProfiles(fallbackQuery, 3);
              for (const r of fallbackResults) {
                leads.push(normaliseLead({
                  ...r,
                  company:     companyName || r.company,
                  data_source: 'serper_company',
                  email_source: r.email ? 'serper' : '',
                }));
              }
            } catch (fbErr) {
              console.warn('[research] Strategy 2 fallback Serper failed:', fbErr.message);
            }
          }
        }
      } catch (innerErr) {
        console.warn('[research] Strategy 2 inner loop failed:', innerErr.message);
      }
    }
  } catch (err) {
    console.warn('[research] Strategy 2 (company-first) failed:', err.message);
  }

  return leads.slice(0, limit);
}

/* ─── Strategy 3: Signal-based search ───────────────────── */

/**
 * STRATEGY 3: Signal-based search.
 * Serper: "[location]" "[title]" "[signal]" site:linkedin.com/in
 */
async function strategySignalBased(query, limit) {
  try {
    const results = await serperService.searchLinkedInProfiles(query, limit);
    return results.map(r => normaliseLead({
      ...r,
      data_source:  'serper_signal',
      email_source: r.email ? 'serper' : '',
    }));
  } catch (err) {
    console.warn('[research] Strategy 3 (signal-based) failed:', err.message);
    return [];
  }
}

/* ─── Main export ────────────────────────────────────────── */

/**
 * MAIN EXPORT — multi-source research orchestrator.
 * Runs all strategies, merges results, deduplicates by linkedin_url.
 * Returns { leads: [], queriesUsed: [], source: 'multi' }
 */
async function researchLeads(clientId, { icpMemory = {}, targetCount = 5, batchIndex = 0 } = {}) {
  const emptyResult = { leads: [], queriesUsed: [], source: 'multi' };

  try {
    // 1. Load used queries
    const usedSet = await loadUsedQueries(clientId);

    // 2. Build full query pool
    const queryPool = buildQueryPool(icpMemory);

    // 3. Pick next N unused queries (N = targetCount * 2, min 6)
    const pickCount = Math.max(targetCount * 2, 6);

    // Separate unused from used
    const unusedQueries = queryPool.filter(q => !usedSet.has(q.query));
    const usedQueries   = queryPool.filter(q =>  usedSet.has(q.query));

    // Prefer unused; fall back to used if pool is exhausted
    const combined = [...unusedQueries, ...usedQueries];

    // Apply batchIndex offset so repeated calls rotate through the pool
    // Cap pick count to available unique queries to prevent duplicates
    const safeLength = Math.max(combined.length, 1);
    const safePick = Math.min(pickCount, combined.length);
    const offset = safePick > 0 ? (batchIndex * safePick) % safeLength : 0;
    const rotated = [...combined.slice(offset), ...combined.slice(0, offset)];
    const picked  = rotated.slice(0, safePick);

    // 4. Split by strategy
    const directQueries      = picked.filter(q => q.strategy === 'direct');
    const signalQueries      = picked.filter(q => q.strategy === 'signal');
    const signalJobsQueries  = picked.filter(q => q.strategy === 'signal_jobs');
    const signalNewsQueries  = picked.filter(q => q.strategy === 'signal_news');
    const signalGrowthQueries = picked.filter(q => q.strategy === 'signal_growth');
    // Company queries are handled inside strategyCompanyFirst via buildQueryPool

    // 5 & 6. Run all strategies in parallel
    const allSignalCount = signalQueries.length + signalJobsQueries.length + signalNewsQueries.length + signalGrowthQueries.length;
    const perQueryLimit = Math.max(Math.ceil(targetCount / Math.max(directQueries.length + allSignalCount, 1)), 2);

    const directPromises = directQueries.map(q =>
      strategyDirectPeople(q.query, perQueryLimit)
        .catch(err => {
          console.warn('[research] Direct query failed:', err.message);
          return [];
        })
    );

    const signalPromises = signalQueries.map(q =>
      strategySignalBased(q.query, perQueryLimit)
        .catch(err => {
          console.warn('[research] Signal query failed:', err.message);
          return [];
        })
    );

    // Buying signal queries — tag matched leads with signal + why_now
    const signalJobsPromises = signalJobsQueries.map(q =>
      strategySignalBased(q.query, perQueryLimit)
        .then(leads => leads.map(l => ({
          ...l,
          signal: l.signal || `Hiring signal: ${q.industry} company in ${q.location} is actively hiring`,
          why_now: l.why_now || `Hiring activity detected via job posting for "${q.industry}" in ${q.location} — likely scaling team now`,
          data_source: 'serper_signal_jobs',
        })))
        .catch(err => {
          console.warn('[research] Signal-jobs query failed:', err.message);
          return [];
        })
    );

    const signalNewsPromises = signalNewsQueries.map(q =>
      strategySignalBased(q.query, perQueryLimit)
        .then(leads => leads.map(l => ({
          ...l,
          signal: l.signal || `Growth signal: ${q.industry} company in ${q.location} recently hired, raised, or launched`,
          why_now: l.why_now || `Recent growth event detected for "${q.industry}" company in ${q.location} — timing is right for outreach`,
          data_source: 'serper_signal_news',
        })))
        .catch(err => {
          console.warn('[research] Signal-news query failed:', err.message);
          return [];
        })
    );

    const signalGrowthPromises = signalGrowthQueries.map(q =>
      strategyCompanyFirst(clientId, { ...icpMemory, industries: q.industry }, 3)
        .then(leads => leads.map(l => ({
          ...l,
          signal: l.signal || `Growth signal: ${q.industry} company in ${q.location} showing employee growth`,
          why_now: l.why_now || `Team expansion detected for "${q.industry}" company in ${q.location}`,
          data_source: l.data_source || 'serper_signal_growth',
        })))
        .catch(err => {
          console.warn('[research] Signal-growth query failed:', err.message);
          return [];
        })
    );

    const companyPromise = strategyCompanyFirst(clientId, icpMemory, targetCount)
      .catch(err => {
        console.warn('[research] Company-first strategy failed:', err.message);
        return [];
      });

    const [directResults, signalResults, signalJobsResults, signalNewsResults, signalGrowthResults, companyLeads] = await Promise.all([
      Promise.all(directPromises).then(arrays => arrays.flat()),
      Promise.all(signalPromises).then(arrays => arrays.flat()),
      Promise.all(signalJobsPromises).then(arrays => arrays.flat()),
      Promise.all(signalNewsPromises).then(arrays => arrays.flat()),
      Promise.all(signalGrowthPromises).then(arrays => arrays.flat()),
      companyPromise,
    ]);

    // 7. Merge and deduplicate by linkedin_url
    // Signal-tagged leads are prioritised (they come first, dedup keeps first occurrence)
    const allLeads = [
      ...signalJobsResults,   // P1: active hiring signal
      ...signalNewsResults,   // P1: growth event signal
      ...signalGrowthResults, // P2: growth signal
      ...signalResults,       // P2: signal-based
      ...directResults,       // P3: direct people
      ...companyLeads,        // P3: company-first
    ];

    const seen = new Set();
    const deduped = allLeads.filter(lead => {
      // Leads without a LinkedIn URL are kept but only one per name+company combo
      const key = lead.linkedin_url
        ? lead.linkedin_url
        : `${lead.name}||${lead.company}`.toLowerCase();
      if (!key || key === '||') return true; // can't dedup, keep it
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 8. Mark all picked queries as used, save back
    for (const q of picked) {
      usedSet.add(q.query);
    }
    await saveUsedQueries(clientId, usedSet);

    // 9. Return results
    const queriesUsed = picked.map(q => q.query);
    return {
      leads:       deduped,
      queriesUsed,
      source:      'multi',
    };
  } catch (err) {
    console.warn('[research] researchLeads total failure:', err.message);
    return emptyResult;
  }
}

module.exports = { researchLeads, buildQueryPool };
