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
  // Always enforce Malaysian context unless the query already has it,
  // to prevent returning US/UK/global results.
  const hasLocation = /malaysia|kuala lumpur|\bkl\b|selangor|klang/i.test(query);
  const locationSuffix = hasLocation ? '' : ' "Kuala Lumpur" OR "Malaysia"';
  const searchQuery = `site:linkedin.com/in ${query}${locationSuffix}`;

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
          verified: true,
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

module.exports = { searchLinkedInProfiles };
