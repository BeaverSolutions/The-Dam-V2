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

    return results
      .filter(r => r.link?.includes('linkedin.com/in/'))
      .slice(0, limit)
      .map(r => {
        // Extract name and title from the Google snippet
        // LinkedIn titles in Google typically look like: "John Doe - CEO at Acme Corp | LinkedIn"
        const titleLine = r.title || '';
        const parts = titleLine.split(' - ');
        const name = parts[0]?.replace(' | LinkedIn', '').trim() || '';
        const rest = parts[1]?.replace(' | LinkedIn', '').trim() || '';

        // "CEO at Acme Corp" → title + company
        const atIdx = rest.indexOf(' at ');
        const title = atIdx > -1 ? rest.substring(0, atIdx).trim() : rest;
        const company = atIdx > -1 ? rest.substring(atIdx + 4).trim() : '';

        return {
          name,
          title,
          company,
          linkedin_url: r.link,
          email: '',
          snippet: r.snippet || '',
          verified: true,        // Google confirmed this URL exists
          data_source: 'serper', // transparent sourcing
        };
      })
      .filter(l => l.name && l.linkedin_url); // drop any that failed to parse
  } catch (err) {
    console.error('[serper] Search failed:', err.message);
    return [];
  }
}

module.exports = { searchLinkedInProfiles };
