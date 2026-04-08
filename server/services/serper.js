'use strict';

/**
 * Serper.dev — Google Search API for real LinkedIn profile discovery.
 *
 * Used as fallback when Apollo is unavailable.
 * Returns real LinkedIn URLs from Google's index — no hallucination.
 *
 * Setup: add SERPER_API_KEY to Railway env vars.
 * Pricing: $50/month for 50k searches. Shared across all clients.
 * Sign up: https://serper.dev
 */

let axios;
try {
  axios = require('axios');
} catch {
  console.warn('[serper] axios not installed');
}

const SERPER_URL = 'https://google.serper.dev/search';

/**
 * Search Google for LinkedIn profiles matching the ICP query.
 * Returns an array of seed leads with real LinkedIn URLs.
 *
 * @param {string} query    - e.g. "founder CEO digital agency Kuala Lumpur"
 * @param {number} limit    - how many results to return (max 10)
 * @returns {Array}         - array of { name, linkedin_url, title, company, snippet }
 */
async function searchLinkedInProfiles(query, limit = 5) {
  if (!axios) return [];

  console.log('[serper] Query:', query, '| Limit:', limit);

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn('[serper] SERPER_API_KEY not set — skipping LinkedIn search');
    return [];
  }

  // Build a targeted LinkedIn search query.
  // DO NOT auto-append location — it causes "query pollution" where all snippets
  // contain the location keyword, making location verification circular.
  // Instead, rely on Serper's gl:'my' param for geographic bias + Layer 2 verification.
  const searchQuery = `site:linkedin.com/in ${query}`;

  try {
    const resp = await axios.post(
      SERPER_URL,
      { q: searchQuery, num: Math.min(limit * 2, 10), gl: 'my', hl: 'en' },
      {
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const results = resp.data?.organic || [];

    const parsed = results
      .filter(r => r.link?.includes('linkedin.com/in/'))
      .slice(0, limit * 2) // over-fetch before validation trims some out
      .map(r => {
        // LinkedIn titles in Google look like: "John Doe - CEO at Acme Corp | LinkedIn"
        // Sometimes: "John Doe | LinkedIn" (no title/company in snippet)
        const titleLine = (r.title || '')
          .replace(/\s*\|?\s*LinkedIn\s*$/, '')  // strip " | LinkedIn" or "| LinkedIn" from end
          .trim();

        // Try splitting on first " - " (most common)
        let parts = titleLine.split(' - ');
        let name = parts[0]?.trim() || '';
        let rest = parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';

        // Fallback: if no rest found, try splitting on the LAST " - "
        // LinkedIn sometimes formats as "Name - Title - Company | LinkedIn"
        if (!rest && titleLine.includes(' - ')) {
          const lastDash = titleLine.lastIndexOf(' - ');
          name = titleLine.substring(0, lastDash).trim();
          rest = titleLine.substring(lastDash + 3).trim();
        }

        // If still no parseable name, warn and use full title line as name
        if (!name) {
          console.warn('[serper] Could not parse title:', r.title);
          name = titleLine;
        }

        // "CEO at Acme Corp" → title + company
        const atIdx = rest.toLowerCase().indexOf(' at ');
        const title = atIdx > -1 ? rest.substring(0, atIdx).trim() : rest;
        let company = atIdx > -1 ? rest.substring(atIdx + 4).trim() : '';

        // Company should never be empty string — use 'Unknown' as fallback
        if (!company) company = 'Unknown';

        // Normalise LinkedIn URL — strip query params and trailing slashes
        const rawUrl = r.link || '';
        const linkedinUrl = rawUrl.split('?')[0].replace(/\/$/, '');

        return {
          name,
          title,
          company,
          linkedin_url: linkedinUrl,
          email: '',
          snippet: r.snippet || '',
          verified: false,
          data_source: 'serper',
        };
      })
      .filter(l => {
        // Name must have at least 2 characters
        if (!l.name || l.name.length < 2) return false;

        // linkedin_url must be a real profile URL (any subdomain with /in/)
        if (!/^https?:\/\/([a-z]{2,}\.)?linkedin\.com\/in\//.test(l.linkedin_url)) return false;

        // Reject search result pages, not actual profiles
        if (/View the profiles of people named/i.test(l.snippet)) return false;
        if (/LinkedIn profiles/i.test(l.snippet)) return false;

        return true;
      });

    // Deduplicate by linkedin_url (Google sometimes returns same profile multiple times)
    const seen = new Set();
    const deduped = parsed.filter(l => {
      if (seen.has(l.linkedin_url)) return false;
      seen.add(l.linkedin_url);
      return true;
    });

    return deduped.slice(0, limit);
  } catch (err) {
    console.error('[serper] Search failed:', err.message);
    return [];
  }
}

/**
 * Search Google for LinkedIn company pages matching an industry + location.
 * Used by Strategy 2 (company-first) in research.js.
 *
 * @param {string} query   - e.g. "digital agency Kuala Lumpur"
 * @param {number} limit   - how many companies to return
 * @returns {Array}        - array of { company, website, snippet }
 */
async function searchLinkedInCompanies(query, limit = 5) {
  if (!axios) return [];
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn('[serper] SERPER_API_KEY not set — skipping company search');
    return [];
  }

  // DO NOT append location keywords — query pollution makes Haiku verification circular.
  // Geographic bias is handled by gl:'my' param only.
  const searchQuery = `site:linkedin.com/company ${query}`;

  console.log('[serper] Company search query:', searchQuery);

  try {
    const resp = await axios.post(
      SERPER_URL,
      { q: searchQuery, num: Math.min(limit * 2, 10), gl: 'my', hl: 'en' },
      {
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const results = resp.data?.organic || [];

    return results
      .filter(r => r.link?.includes('linkedin.com/company/'))
      .slice(0, limit)
      .map(r => {
        // Title format: "Company Name | LinkedIn" or "Company Name - Industry | LinkedIn"
        const raw = (r.title || '').replace(/\s*\|?\s*LinkedIn\s*$/, '').trim();
        const parts = raw.split(' - ');
        const company = parts[0]?.trim() || raw;

        // Try to extract website from snippet
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
  } catch (err) {
    console.error('[serper] Company search failed:', err.message);
    return [];
  }
}

/**
 * Signal-based LinkedIn search — finds people by activity/trigger keywords.
 * e.g. site:linkedin.com/in "Kuala Lumpur" "Founder" "hiring"
 *
 * @param {string} query   - e.g. '"Founder" "Kuala Lumpur" "hiring"'
 * @param {number} limit
 * @returns {Array}        - same shape as searchLinkedInProfiles
 */
async function searchBySignal(query, limit = 5) {
  if (!axios) return [];
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.warn('[serper] SERPER_API_KEY not set — skipping signal search');
    return [];
  }

  const searchQuery = `site:linkedin.com/in ${query}`;
  console.log('[serper] Signal search query:', searchQuery);

  try {
    const resp = await axios.post(
      SERPER_URL,
      { q: searchQuery, num: Math.min(limit * 2, 10), gl: 'my', hl: 'en' },
      {
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const results = resp.data?.organic || [];

    const parsed = results
      .filter(r => r.link?.includes('linkedin.com/in/'))
      .slice(0, limit * 2)
      .map(r => {
        const titleLine = (r.title || '')
          .replace(/\s*\|?\s*LinkedIn\s*$/, '')
          .trim();

        let parts = titleLine.split(' - ');
        let name = parts[0]?.trim() || '';
        let rest = parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';

        if (!rest && titleLine.includes(' - ')) {
          const lastDash = titleLine.lastIndexOf(' - ');
          name = titleLine.substring(0, lastDash).trim();
          rest = titleLine.substring(lastDash + 3).trim();
        }

        if (!name) name = titleLine;

        const atIdx = rest.toLowerCase().indexOf(' at ');
        const title = atIdx > -1 ? rest.substring(0, atIdx).trim() : rest;
        let company = atIdx > -1 ? rest.substring(atIdx + 4).trim() : 'Unknown';
        if (!company) company = 'Unknown';

        const linkedinUrl = (r.link || '').split('?')[0].replace(/\/$/, '');

        return {
          name,
          title,
          company,
          linkedin_url: linkedinUrl,
          email: '',
          snippet: r.snippet || '',
          verified: false,
          data_source: 'serper_signal',
        };
      })
      .filter(l => {
        if (!l.name || l.name.length < 2) return false;
        if (!/^https?:\/\/([a-z]{2,}\.)?linkedin\.com\/in\//.test(l.linkedin_url)) return false;
        if (/View the profiles of people named/i.test(l.snippet)) return false;
        return true;
      });

    const seen = new Set();
    return parsed
      .filter(l => {
        if (seen.has(l.linkedin_url)) return false;
        seen.add(l.linkedin_url);
        return true;
      })
      .slice(0, limit);
  } catch (err) {
    console.error('[serper] Signal search failed:', err.message);
    return [];
  }
}

module.exports = { searchLinkedInProfiles, searchLinkedInCompanies, searchBySignal };
