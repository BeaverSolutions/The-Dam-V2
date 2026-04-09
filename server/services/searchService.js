'use strict';

/**
 * Search service with automatic fallback chain:
 *   1. Serper (primary)        — 200 queries/month free tier
 *   2. Google Custom Search    — 100 queries/day free (optional: needs GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX)
 *   3. DuckDuckGo Instant API  — no key, always available (last resort, results will be sparse)
 *
 * Drop-in replacement for serper.js — exports the same three functions.
 * Callers don't need to change anything except the require path.
 */

let axios;
try {
  axios = require('axios');
} catch {
  console.warn('[search] axios not installed');
}

const SERPER_URL     = 'https://google.serper.dev/search';
const GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';
const DDG_URL        = 'https://api.duckduckgo.com/';

// ── Shared parsing helpers (ported from serper.js) ──────────────────────────

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
 * Parse raw search result items (Serper organic[] or Google CSE items[]) into
 * normalised profile leads. Works for both providers — same field shape.
 */
function parseProfileItems(items, dataSource = 'serper') {
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
        website,
        linkedin_company_url: (r.link || '').split('?')[0].replace(/\/$/, ''),
        snippet: r.snippet || '',
      };
    })
    .filter(c => c.company && c.company.length > 1);
}

// ── Provider calls (throw on failure so the fallback chain can catch) ────────

async function callSerper(searchQuery, num) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY not set');

  const resp = await axios.post(
    SERPER_URL,
    { q: searchQuery, num: Math.min(num, 10), gl: 'my', hl: 'en' },
    { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  return resp.data?.organic || [];
}

async function callGoogleCSE(searchQuery, num) {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cx     = process.env.GOOGLE_CSE_CX;
  if (!apiKey || !cx) throw new Error('GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX not set');

  // CSE is domain-restricted to linkedin.com — strip any existing site: operator and force linkedin.com/in
  const strippedQuery = searchQuery.replace(/\bsite:\S+\s*/gi, '').trim();
  const cseQuery = `site:linkedin.com/in ${strippedQuery}`;

  console.log('[google-cse] Query:', cseQuery);

  const resp = await axios.get(GOOGLE_CSE_URL, {
    params: { key: apiKey, cx, q: cseQuery, num: Math.min(num, 10), gl: 'MY', hl: 'en' },
    timeout: 10000,
  });
  // Google CSE uses `items[]` with same { link, title, snippet } shape as Serper organic[]
  return resp.data?.items || [];
}

async function callDuckDuckGo(searchQuery) {
  // DuckDuckGo's Instant Answer API — no key needed, but results are sparse for LinkedIn searches.
  // It won't return lists of profiles, but it will never crash the pipeline.
  // Strip any existing site: operator and force linkedin.com/in (same as CSE)
  const strippedQuery = searchQuery.replace(/\bsite:\S+\s*/gi, '').trim();
  const ddgQuery = `site:linkedin.com/in ${strippedQuery}`;
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

async function withFallback(label, searchQuery, num, parseItems) {
  // 1. Serper
  try {
    const items = await callSerper(searchQuery, num);
    return parseItems(items);
  } catch (err) {
    const status = err.response?.status ? ` (${err.response.status})` : '';
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.warn(`[search] Serper failed${status}: ${detail}, falling back to Google CSE`);
  }

  // 2. Google CSE
  try {
    const items = await callGoogleCSE(searchQuery, num);
    console.log('[search] Using fallback: Google CSE');
    return parseItems(items);
  } catch (err) {
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

  // 3. DuckDuckGo (last resort — never throws)
  try {
    const items = await callDuckDuckGo(searchQuery);
    console.log('[search] Using fallback: DuckDuckGo');
    return parseItems(items);
  } catch (err) {
    console.warn(`[search] DuckDuckGo failed: ${err.message} — returning empty results`);
    return [];
  }
}

// ── Public API (same signatures as serper.js) ─────────────────────────────

async function searchLinkedInProfiles(query, limit = 5) {
  if (!axios) return [];
  console.log('[search] Profile search:', query, '| Limit:', limit);
  const searchQuery = `site:linkedin.com/in ${query}`;
  const results = await withFallback('profiles', searchQuery, limit * 2, items => parseProfileItems(items, 'serper'));
  return results.slice(0, limit);
}

async function searchLinkedInCompanies(query, limit = 5) {
  if (!axios) return [];
  console.log('[search] Company search:', query, '| Limit:', limit);
  const searchQuery = `site:linkedin.com/company ${query}`;
  const results = await withFallback('companies', searchQuery, limit * 2, parseCompanyItems);
  return results.slice(0, limit);
}

async function searchBySignal(query, limit = 5) {
  if (!axios) return [];
  console.log('[search] Signal search:', query, '| Limit:', limit);
  const searchQuery = `site:linkedin.com/in ${query}`;
  const results = await withFallback('signal', searchQuery, limit * 2, items => parseProfileItems(items, 'serper_signal'));
  return results.slice(0, limit);
}

module.exports = { searchLinkedInProfiles, searchLinkedInCompanies, searchBySignal };
