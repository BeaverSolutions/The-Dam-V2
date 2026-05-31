'use strict';

/**
 * Search service with automatic fallback chain:
 *   1. Brave Search (primary)    — fast, generous free tier
 *   2. Google Custom Search      — 100 queries/day free (needs GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX)
 *   3. DuckDuckGo Instant API    — no key, always available (last resort, results will be sparse)
 */

let axios;
try {
  axios = require('axios');
} catch {
  console.warn('[search] axios not installed');
}

const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';
const DDG_URL        = 'https://api.duckduckgo.com/';
const spendGuard = require('./spendGuard');
const pool = require('../db/pool');
const { getCurrentClientId } = require('../middleware/clientContext');

function currentClientId(options = {}) {
  return options.clientId || getCurrentClientId() || null;
}

function providerBlockedError(provider, guard) {
  const err = new Error(`${provider} provider blocked by spend guard: ${guard.reason || 'not_allowed'}`);
  err.code = 'PROVIDER_SPEND_BLOCKED';
  err.provider = provider;
  err.guard = guard;
  return err;
}

function providerFailureCode(err) {
  if (err?.code === 'PROVIDER_SPEND_BLOCKED') return 'spend_guard_blocked';
  if (/not set|not configured/i.test(String(err?.message || ''))) return 'missing_config';
  if (err?.response?.status === 429) return 'rate_limited';
  if (err?.response?.status) return `http_${err.response.status}`;
  return err?.code || err?.name || 'provider_error';
}

function braveCountryFor(country) {
  const code = String(country || 'MY').toUpperCase();
  // Brave's web-search country enum rejected SG in production. Keep the query
  // SG-specific and use a nearby supported bias.
  return code === 'SG' ? 'MY' : code;
}

async function logProviderError(provider, err, metadata = {}) {
  const clientId = currentClientId();
  if (!clientId || !provider) return;
  try {
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata)
       VALUES ($1, 'system', 'provider_error', 'provider', $2)`,
      [clientId, JSON.stringify({
        provider,
        reason: providerFailureCode(err),
        message: String(err?.message || '').slice(0, 300),
        status: err?.response?.status || null,
        ...metadata,
      })]
    );
  } catch (logErr) {
    console.warn(`[search] provider_error log failed for ${provider}:`, logErr.message);
  }
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_PARALLEL_SEARCH_PAID_QUERY_CAP = envInt('SEARCH_MAX_PAID_QUERIES_PER_OPERATION', 6);

function splitPaidQueryBudget(braveQueries, cseQueries, maxPaidQueries = DEFAULT_PARALLEL_SEARCH_PAID_QUERY_CAP) {
  const cap = Math.max(1, maxPaidQueries);
  let braveBudget = Math.min(braveQueries.length, Math.ceil(cap / 2));
  let cseBudget = Math.min(cseQueries.length, cap - braveBudget);
  const unused = cap - braveBudget - cseBudget;

  if (unused > 0) {
    const braveExtra = Math.min(unused, Math.max(0, braveQueries.length - braveBudget));
    braveBudget += braveExtra;
    cseBudget += Math.min(unused - braveExtra, Math.max(0, cseQueries.length - cseBudget));
  }

  return {
    brave: braveQueries.slice(0, braveBudget),
    cse: cseQueries.slice(0, cseBudget),
    cap,
  };
}

// ── Shared parsing helpers ──────────────────────────────────────────────────

const TITLE_KEYWORDS = '(?:CEO|Founder|Co-Founder|Director|MD|Managing Director|Owner|CTO|COO|CMO|CFO|CRO|CPO|Partner|Head|VP|Vice President|President|Manager|General Manager|Principal|Lead|Chief)';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCompanyFromSnippet(snippet, name, title) {
  if (!snippet) return '';
  const cleanSnippet = snippet.replace(new RegExp(escapeRegex(name), 'gi'), '').trim();

  const atMatch = cleanSnippet.match(new RegExp(TITLE_KEYWORDS + '\\s+(?:and\\s+\\w+\\s+)?(?:&\\s+\\w+\\s+)?at\\s+([^·.;,\\n]{3,60})', 'i'));
  if (atMatch) return atMatch[1].trim();

  const simpleAtMatch = cleanSnippet.match(/\bat\s+([A-Z][^·.;,\n]{2,60})/);
  if (simpleAtMatch) return simpleAtMatch[1].trim();

  const dotMatch = cleanSnippet.match(new RegExp(TITLE_KEYWORDS + '[^·]*·\\s*([^·.;\\n]{3,60})', 'i'));
  if (dotMatch) return dotMatch[1].trim();

  const ofMatch = cleanSnippet.match(/(?:Founder|Director|Owner|Partner|Head|Manager|President)\s+of\s+([^·.;,\n]{3,60})/i);
  if (ofMatch) return ofMatch[1].trim();

  const pengalamanMatch = cleanSnippet.match(/Pengalaman\s*[;:]\s*(?:[^.]*?\.\s*)?([^·.;\n]{3,60})/i);
  if (pengalamanMatch) return pengalamanMatch[1].trim();

  const companyMatch = cleanSnippet.match(/([A-Z][\w\s&'()-]{2,40}(?:Sdn\s*Bhd|Berhad|Pte\.?\s*Ltd|Pvt\.?\s*Ltd|Inc\.?|LLC|Ltd\.?))/i);
  if (companyMatch) return companyMatch[1].trim();

  const firstDotSegment = cleanSnippet.match(/^[^·]+·\s*([^·.;\n]{3,60})/);
  if (firstDotSegment && !/^\d/.test(firstDotSegment[1].trim())) return firstDotSegment[1].trim();

  return '';
}

/**
 * Parse raw search result items (Brave results or Google CSE items[]) into
 * normalised profile leads. Works for both providers — same field shape.
 */
function parseProfileItems(items, dataSource = 'brave') {
  const parsed = items
    .filter(r => r.link?.includes('linkedin.com/in/'))
    .map(r => {
      const titleLine = (r.title || '')
        .replace(/\s*\|?\s*LinkedIn\s*$/, '')
        .trim();

      let parts = titleLine.split(' - ').map(p => p.trim()).filter(Boolean);
      let name = parts[0] || '';
      let title = '';
      let company = '';

      if (parts.length >= 3) {
        title   = parts[1];
        company = parts[2];
      } else if (parts.length === 2) {
        const segment = parts[1];
        const atIdx   = segment.toLowerCase().indexOf(' at ');
        if (atIdx > -1) {
          title   = segment.substring(0, atIdx).trim();
          company = segment.substring(atIdx + 4).trim();
        } else if (/(?:Sdn|Bhd|Berhad|Pte|Ltd|Inc|LLC|Agency|Consulting|Solutions|Group|Studio|Lab|Media|Digital|Tech|Capital)/i.test(segment)) {
          company = segment;
        } else {
          title = segment;
        }
      }

      if (!company) {
        const atIdx = title.toLowerCase().indexOf(' at ');
        if (atIdx > -1) {
          company = title.substring(atIdx + 4).trim();
          title   = title.substring(0, atIdx).trim();
        }
      }

      if (!name) name = titleLine;

      const snippet = r.snippet || '';
      if (!company || company === 'Unknown') {
        company = extractCompanyFromSnippet(snippet, name, title) || '';
      }
      if (!company) company = 'Unknown';

      const linkedinUrl = (r.link || '').split('?')[0].replace(/\/$/, '');

      return { name, title, company, linkedin_url: linkedinUrl, email: '', snippet, verified: false, data_source: dataSource };
    })
    .filter(l => {
      if (!l.name || l.name.length < 2) return false;
      if (!/^https?:\/\/([a-z]{2,}\.)?linkedin\.com\/in\//.test(l.linkedin_url)) return false;
      if (/View the profiles of people named/i.test(l.snippet)) return false;
      if (/LinkedIn profiles/i.test(l.snippet)) return false;
      return true;
    });

  const seen = new Set();
  return parsed.filter(l => {
    if (seen.has(l.linkedin_url)) return false;
    seen.add(l.linkedin_url);
    return true;
  });
}

function parseCompanyItems(items) {
  return items
    .filter(r => r.link?.includes('linkedin.com/company/'))
    .map(r => {
      const raw     = (r.title || '').replace(/\s*\|?\s*LinkedIn\s*$/, '').trim();
      const parts   = raw.split(' - ');
      const company = parts[0]?.trim() || raw;
      const websiteMatch = (r.snippet || '').match(/(?:www\.)?([\w-]+\.(com|my|io|co))/i);
      const website = websiteMatch ? websiteMatch[0].replace(/^www\./, '') : null;
      return {
        company,
        title: raw,
        website,
        linkedin_company_url: (r.link || '').split('?')[0].replace(/\/$/, ''),
        snippet: r.snippet || '',
      };
    })
    .filter(c => c.company && c.company.length > 1);
}

// ── Provider calls (throw on failure so the fallback chain can catch) ────────

async function callBrave(searchQuery, num, country = 'MY') {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('BRAVE_API_KEY not set');
  const clientId = currentClientId();
  const guard = await spendGuard.checkProvider('brave', { clientId, estimatedUnits: 1 });
  if (!guard.allowed) throw providerBlockedError('brave', guard);
  const braveCountry = braveCountryFor(country);

  // 2026-05-23: country now caller-controllable. Default MY for backward
  // compat with existing call sites (LinkedIn search, signal search). New
  // multi-geo query pool (research.js) passes per-query country so AU/US/UK
  // queries don't get heavily MY-biased results.
  const resp = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    params: {
      q: searchQuery,
      count: Math.min(num, 20),
      country: braveCountry,
      search_lang: 'en',
      safesearch: 'moderate',
    },
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
    },
    timeout: 10000,
  });
  await spendGuard.logProviderUsage('brave', {
    clientId,
    units: 1,
    metadata: { query_preview: String(searchQuery).slice(0, 160), country: braveCountry, requested_country: String(country).toUpperCase(), count: Math.min(num, 20) },
  });

  const results = resp.data?.web?.results || [];
  // Map Brave format to normalised format (title, link, snippet)
  return results.map(r => ({
    title: r.title || '',
    link: r.url || '',
    snippet: r.description || '',
  }));
}

async function callGoogleCSE(searchQuery, num, country = 'MY') {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx     = process.env.GOOGLE_CSE_CX;
  if (!apiKey || !cx) throw new Error('GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX not set');
  const clientId = currentClientId();
  const guard = await spendGuard.checkProvider('google_cse', { clientId, estimatedUnits: 1 });
  if (!guard.allowed) throw providerBlockedError('google_cse', guard);

  // CSE is domain-restricted to linkedin.com. Preserve /company when the caller
  // is doing company-first discovery; forcing /in breaks company parsing.
  const siteMatch = String(searchQuery || '').match(/\bsite:(linkedin\.com\/(?:in|company))\b/i);
  const site = siteMatch ? siteMatch[1].toLowerCase() : 'linkedin.com/in';
  const strippedQuery = searchQuery.replace(/\bsite:\S+\s*/gi, '').trim();
  const cseQuery = `site:${site} ${strippedQuery}`;

  console.log('[google-cse] Query:', cseQuery);

  const resp = await axios.get(GOOGLE_CSE_URL, {
    params: { key: apiKey, cx, q: cseQuery, num: Math.min(num, 10), gl: String(country).toLowerCase(), hl: 'en' },
    timeout: 10000,
  });
  await spendGuard.logProviderUsage('google_cse', {
    clientId,
    units: 1,
    metadata: { query_preview: cseQuery.slice(0, 160), country: String(country).toUpperCase(), count: Math.min(num, 10) },
  });
  // Google CSE uses `items[]` with same { link, title, snippet } shape
  return resp.data?.items || [];
}

async function callDuckDuckGo(searchQuery) {
  // DuckDuckGo's Instant Answer API — no key needed, but results are sparse for LinkedIn searches.
  // It won't return lists of profiles, but it will never crash the pipeline.
  // Strip any existing site: operator and preserve /company for company-first search.
  const siteMatch = String(searchQuery || '').match(/\bsite:(linkedin\.com\/(?:in|company))\b/i);
  const site = siteMatch ? siteMatch[1].toLowerCase() : 'linkedin.com/in';
  const strippedQuery = searchQuery.replace(/\bsite:\S+\s*/gi, '').trim();
  const ddgQuery = `site:${site} ${strippedQuery}`;
  console.log('[duckduckgo] Query:', ddgQuery);

  const resp = await axios.get(DDG_URL, {
    params: { q: ddgQuery, format: 'json', no_html: 1, skip_disambig: 1 },
    timeout: 8000,
  });

  const data = resp.data || {};
  const topics = [...(data.Results || []), ...(data.RelatedTopics || [])];

  // Extract any LinkedIn URLs that happen to surface in the response
  return topics
    .filter(t => t.FirstURL?.includes('linkedin.com'))
    .map(t => ({
      link:    t.FirstURL,
      title:   t.Text || '',
      snippet: t.Text || '',
    }));
}

// ── Fallback chain ───────────────────────────────────────────────────────────

async function withFallback(label, searchQuery, num, parseItems, options = {}) {
  const country = options.country || 'MY';
  // 1. Brave (primary)
  try {
    const items = await callBrave(searchQuery, num, country);
    if (items.length > 0) {
      const parsed = parseItems(items);
      if (parsed.length > 0) return parsed;
      console.warn(`[search] Brave returned ${items.length} ${label} item(s), parser extracted 0 usable result(s); falling back to Google CSE`);
    }
  } catch (err) {
    await logProviderError('brave', err, { mode: label, query_preview: String(searchQuery).slice(0, 160) });
    console.warn(`[search] Brave failed: ${err.message}, falling back to Google CSE`);
  }

  // 2. Google CSE
  try {
    const items = await callGoogleCSE(searchQuery, num, country);
    console.log('[search] Using fallback: Google CSE');
    return parseItems(items);
  } catch (err) {
    await logProviderError('google_cse', err, { mode: label, query_preview: String(searchQuery).slice(0, 160) });
    const status = err.response?.status ? ` (${err.response.status})` : '';
    const body   = err.response?.data;
    const detail = body
      ? JSON.stringify(body?.error ?? body)
      : err.message;
    const firstError = body?.error?.errors?.[0];
    if (firstError) {
      console.warn(`[google-cse] Error detail — domain: ${firstError.domain}, reason: ${firstError.reason}, message: ${firstError.message}`);
    }
    console.warn(`[search] Google CSE failed${status}: ${detail}, falling back to DuckDuckGo`);
  }

  // 4. DuckDuckGo (last resort — never throws)
  try {
    const items = await callDuckDuckGo(searchQuery);
    console.log('[search] Using fallback: DuckDuckGo');
    return parseItems(items);
  } catch (err) {
    console.warn(`[search] DuckDuckGo failed: ${err.message} — returning empty results`);
    return [];
  }
}

// ── Parallel search helpers ──────────────────────────────────────────────────

/**
 * Run all Brave queries and collect profile results.
 * Never throws — failed queries are logged and skipped.
 */
async function runAllBraveQueries(queries) {
  // Cap at 10 queries to prevent cost explosion
  if (queries.length > 10) {
    console.log(`[search] Capping search queries from ${queries.length} to 10`);
    queries = queries.slice(0, 10);
  }
  const results = [];
  for (const q of queries) {
    try {
      const items = await callBrave(q, 10);
      if (items.length > 0) {
        results.push(...parseProfileItems(items, 'brave'));
      }
    } catch (err) {
      await logProviderError('brave', err, { mode: 'parallel_profiles', query_preview: String(q).slice(0, 160) });
      console.warn(`[search] Brave query failed for "${q}": ${err.message}`);
    }
  }
  return results;
}

/**
 * Run all CSE queries and collect profile results.
 * callGoogleCSE already strips and re-adds site:linkedin.com/in, so queries
 * can include it or not — same result.
 * Never throws — failed queries are logged and skipped.
 */
async function runAllCSEQueries(queries) {
  // Cap at 10 queries to prevent cost explosion on CSE
  if (queries.length > 10) {
    console.log(`[search] Capping CSE queries from ${queries.length} to 10`);
    queries = queries.slice(0, 10);
  }
  const results = [];
  for (const q of queries) {
    try {
      const items = await callGoogleCSE(q, 10);
      results.push(...parseProfileItems(items, 'cse'));
    } catch (err) {
      await logProviderError('google_cse', err, { mode: 'parallel_profiles', query_preview: String(q).slice(0, 160) });
      console.warn(`[search] CSE query failed for "${q}": ${err.message}`);
    }
  }
  return results;
}

/**
 * parallelSearch(braveQueries, cseQueries)
 *
 * Runs Brave + CSE in parallel (not cascade). Combines fulfilled results.
 * DuckDuckGo runs only if BOTH Brave AND CSE return 0 results.
 *
 * Returns a flat array of parsed profile leads (scorer format not applied here —
 * callers should pass through leadScorer.normalize() if needed).
 */
async function parallelSearch(braveQueries, cseQueries, options = {}) {
  const budget = splitPaidQueryBudget(braveQueries, cseQueries, options.maxPaidQueries);
  const totalRequested = braveQueries.length + cseQueries.length;
  const totalBudgeted = budget.brave.length + budget.cse.length;
  if (totalRequested > totalBudgeted) {
    console.log(`[search] Capping parallelSearch paid queries from ${totalRequested} to ${totalBudgeted}`);
  }
  console.log(`[search] parallelSearch — Brave: ${budget.brave.length} queries, CSE: ${budget.cse.length} queries`);

  const [braveSettled, cseSettled] = await Promise.allSettled([
    runAllBraveQueries(budget.brave),
    runAllCSEQueries(budget.cse),
  ]);

  const combined = [];

  if (braveSettled.status === 'fulfilled') {
    combined.push(...braveSettled.value);
    console.log(`[search] Brave batch: ${braveSettled.value.length} results`);
  } else {
    console.warn(`[search] Brave batch rejected: ${braveSettled.reason?.message}`);
  }

  if (cseSettled.status === 'fulfilled') {
    combined.push(...cseSettled.value);
    console.log(`[search] CSE batch: ${cseSettled.value.length} results`);
  } else {
    console.warn(`[search] CSE batch rejected: ${cseSettled.reason?.message}`);
  }

  // DDG only runs if BOTH Brave AND CSE returned 0 results
  if (combined.length === 0) {
    console.log('[search] Both Brave and CSE returned 0 results — falling back to DuckDuckGo');
    const fallbackQuery = budget.brave[0] || budget.cse[0] || braveQueries[0] || cseQueries[0];
    if (fallbackQuery) {
      try {
        const ddgItems = await callDuckDuckGo(fallbackQuery);
        combined.push(...parseProfileItems(ddgItems, 'ddg'));
        console.log(`[search] DuckDuckGo fallback: ${ddgItems.length} items`);
      } catch (err) {
        console.warn(`[search] DuckDuckGo fallback failed: ${err.message}`);
      }
    }
  }

  console.log(`[search] parallelSearch total: ${combined.length} results`);
  return combined;
}

// ── Public API ──────────────────────────────────────────────────────────────

async function searchLinkedInProfiles(query, limit = 5, options = {}) {
  if (!axios) return [];
  console.log('[search] Profile search:', query, '| Limit:', limit, '| Country:', options.country || 'MY');
  const searchQuery = `site:linkedin.com/in ${query}`;
  const results = await withFallback('profiles', searchQuery, limit * 2, items => parseProfileItems(items, 'brave'), options);
  return results.slice(0, limit);
}

async function searchLinkedInCompanies(query, limit = 5, options = {}) {
  if (!axios) return [];
  console.log('[search] Company search:', query, '| Limit:', limit, '| Country:', options.country || 'MY');
  const searchQuery = `site:linkedin.com/company ${query}`;
  const results = await withFallback('companies', searchQuery, limit * 2, parseCompanyItems, options);
  return results.slice(0, limit);
}

async function searchBySignal(query, limit = 5, options = {}) {
  if (!axios) return [];
  console.log('[search] Signal search:', query, '| Limit:', limit, '| Country:', options.country || 'MY');
  const searchQuery = `site:linkedin.com/in ${query}`;
  const results = await withFallback('signal', searchQuery, limit * 2, items => parseProfileItems(items, 'brave_signal'), options);
  return results.slice(0, limit);
}

/**
 * searchOpenWeb(query, limit)
 *
 * Searches the open web (NOT LinkedIn) for news, articles, press releases.
 * Used by signal hunting AND by Captain Beaver's web_search_brave tool.
 * Returns raw search results with title, link, snippet — no LinkedIn parsing.
 *
 * Fallback chain: Brave → Google CSE.
 */
async function searchOpenWeb(query, limit = 5, options = {}) {
  if (!axios) return [];
  const country = options.country || 'MY';
  console.log('[search] Open web search:', query, '| Limit:', limit, '| Country:', country);

  // Brave Search (primary) — fast, no site: restrictions, gentle rate limits
  try {
    const braveKey = process.env.BRAVE_API_KEY;
    if (!braveKey) throw new Error('BRAVE_API_KEY not set');
    const clientId = currentClientId(options);
    const guard = await spendGuard.checkProvider('brave', { clientId, estimatedUnits: 1 });
    if (!guard.allowed) throw providerBlockedError('brave', guard);

    const braveCountry = braveCountryFor(country);
    const resp = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: {
        q: query,
        count: Math.min(limit, 20),
        country: braveCountry,
        search_lang: 'en',
        safesearch: 'moderate',
      },
      headers: {
        'X-Subscription-Token': braveKey,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
      },
      timeout: 10000,
    });
    await spendGuard.logProviderUsage('brave', {
      clientId,
      units: 1,
      metadata: { query_preview: String(query).slice(0, 160), country: braveCountry, requested_country: String(country).toUpperCase(), count: Math.min(limit, 20), mode: 'open_web' },
    });

    const results = resp.data?.web?.results || [];
    if (results.length > 0) {
      console.log(`[search] Brave returned ${results.length} results`);
      return results.slice(0, limit).map(r => ({
        title: r.title || '',
        link: r.url || '',
        snippet: r.description || '',
        date: r.age || '',
        source: r.profile?.name || new URL(r.url).hostname,
        type: 'organic',
      }));
    }
  } catch (err) {
    await logProviderError('brave', err, { mode: 'open_web', query_preview: String(query).slice(0, 160) });
    console.warn(`[search] Brave open web failed: ${err.message}`);
  }

  // 2. Google CSE (no site: filter for open web)
  try {
    const apiKey = process.env.GOOGLE_CSE_API_KEY;
    const cx     = process.env.GOOGLE_CSE_CX;
    if (!apiKey || !cx) throw new Error('GOOGLE_CSE not configured');
    const clientId = currentClientId(options);
    const guard = await spendGuard.checkProvider('google_cse', { clientId, estimatedUnits: 1 });
    if (!guard.allowed) throw providerBlockedError('google_cse', guard);

    const resp = await axios.get(GOOGLE_CSE_URL, {
      params: { key: apiKey, cx, q: query, num: Math.min(limit, 10), gl: String(country).toLowerCase(), hl: 'en' },
      timeout: 10000,
    });
    await spendGuard.logProviderUsage('google_cse', {
      clientId,
      units: 1,
      metadata: { query_preview: String(query).slice(0, 160), country: String(country).toUpperCase(), count: Math.min(limit, 10), mode: 'open_web' },
    });

    return (resp.data?.items || []).map(r => ({
      title: r.title || '',
      link: r.link || '',
      snippet: r.snippet || '',
      date: '',
      source: '',
      type: 'organic',
    })).slice(0, limit);
  } catch (err) {
    await logProviderError('google_cse', err, { mode: 'open_web', query_preview: String(query).slice(0, 160) });
    console.warn(`[search] Google CSE open web failed: ${err.message}`);
  }

  return [];
}


/**
 * Searches a company domain for email addresses.
 * Used by DB Builder to verify a domain is email-able and infer patterns.
 * Returns array of email strings found on the domain (deduplicated, max 5).
 */
async function searchEmailDomain(domain) {
  try {
    const items = await callBrave(`@${domain} site:${domain}`, 5);
    const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const found = new Set();
    for (const item of items) {
      const text = `${item.title || ''} ${item.description || ''} ${item.url || ''}`;
      for (const e of (text.match(emailRe) || [])) {
        if (e.toLowerCase().endsWith(`@${domain.toLowerCase()}`)) found.add(e.toLowerCase());
      }
    }
    return [...found].slice(0, 5);
  } catch {
    return [];
  }
}

module.exports = { searchLinkedInProfiles, searchLinkedInCompanies, searchBySignal, parallelSearch, searchOpenWeb, searchEmailDomain };
