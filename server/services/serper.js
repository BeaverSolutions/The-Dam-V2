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
 * Extract company name from a Google snippet when the title line didn't have it.
 * LinkedIn snippets follow predictable patterns:
 *   "CEO at Company Name · Pengalaman: ..."
 *   "Co-Founder and CEO at Company Sdn Bhd. ..."
 *   "Title · Company Name · Location: ..."
 *   "Founder of Company Name. ..."
 *   "Company Name. Title. ..."  (snippet starts with company)
 */
// Title keywords — used across all extraction patterns
const TITLE_KEYWORDS = '(?:CEO|Founder|Co-Founder|Director|MD|Managing Director|Owner|CTO|COO|CMO|CFO|CRO|CPO|Partner|Head|VP|Vice President|President|Manager|General Manager|Principal|Lead|Chief)';

function extractCompanyFromSnippet(snippet, name, title) {
  if (!snippet) return '';

  // Clean the person's name from the snippet so it doesn't match as company
  const cleanSnippet = snippet.replace(new RegExp(escapeRegex(name), 'gi'), '').trim();

  // Pattern 1: "Title at Company" — most common in LinkedIn snippets
  const atMatch = cleanSnippet.match(new RegExp(TITLE_KEYWORDS + '\\s+(?:and\\s+\\w+\\s+)?(?:&\\s+\\w+\\s+)?at\\s+([^·.;,\\n]{3,60})', 'i'));
  if (atMatch) return atMatch[1].trim();

  // Pattern 2: "at Company" — without title prefix (e.g. "Working at Company")
  const simpleAtMatch = cleanSnippet.match(/\bat\s+([A-Z][^·.;,\n]{2,60})/);
  if (simpleAtMatch) return simpleAtMatch[1].trim();

  // Pattern 3: "Title · Company" — LinkedIn uses middle dot as separator
  const dotMatch = cleanSnippet.match(new RegExp(TITLE_KEYWORDS + '[^·]*·\\s*([^·.;\\n]{3,60})', 'i'));
  if (dotMatch) return dotMatch[1].trim();

  // Pattern 4: "Founder of Company" / "Director of Company" / "Head of Sales at Company"
  const ofMatch = cleanSnippet.match(/(?:Founder|Director|Owner|Partner|Head|Manager|President)\s+of\s+([^·.;,\n]{3,60})/i);
  if (ofMatch) return ofMatch[1].trim();

  // Pattern 5: "Pengalaman: Company" or "Pengalaman ; Title. Company" (Malay LinkedIn)
  const pengalamanMatch = cleanSnippet.match(/Pengalaman\s*[;:]\s*(?:[^.]*?\.\s*)?([^·.;\n]{3,60})/i);
  if (pengalamanMatch) return pengalamanMatch[1].trim();

  // Pattern 6: Look for "Sdn Bhd", "Berhad", "Pte Ltd", "Pvt Ltd", "Inc", "LLC", "Ltd"
  const companyMatch = cleanSnippet.match(/([A-Z][\w\s&'()-]{2,40}(?:Sdn\s*Bhd|Berhad|Pte\.?\s*Ltd|Pvt\.?\s*Ltd|Inc\.?|LLC|Ltd\.?))/i);
  if (companyMatch) return companyMatch[1].trim();

  // Pattern 7: First segment after middle dot (LinkedIn profile structure: "Title · Company · Location")
  const firstDotSegment = cleanSnippet.match(/^[^·]+·\s*([^·.;\n]{3,60})/);
  if (firstDotSegment && !/^\d/.test(firstDotSegment[1].trim())) {
    return firstDotSegment[1].trim();
  }

  return '';
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
        // Sometimes: "John Doe - CEO | LinkedIn" (no company in title)
        // Sometimes: "John Doe - CompanyName - | LinkedIn" (company is in title position)
        const titleLine = (r.title || '')
          .replace(/\s*\|?\s*LinkedIn\s*$/, '')  // strip " | LinkedIn" or "| LinkedIn" from end
          .trim();

        // Split on " - " — LinkedIn uses this as separator
        let parts = titleLine.split(' - ').map(p => p.trim()).filter(Boolean);
        let name = parts[0] || '';
        let title = '';
        let company = '';

        if (parts.length >= 3) {
          // "Name - Title - Company" or "Name - Title at Company - Extra"
          title = parts[1];
          company = parts[2];
        } else if (parts.length === 2) {
          // Could be "Name - Title at Company" or "Name - Title" or "Name - Company"
          const segment = parts[1];
          const atIdx = segment.toLowerCase().indexOf(' at ');
          if (atIdx > -1) {
            // "Title at Company"
            title = segment.substring(0, atIdx).trim();
            company = segment.substring(atIdx + 4).trim();
          } else if (/(?:Sdn|Bhd|Berhad|Pte|Ltd|Inc|LLC|Agency|Consulting|Solutions|Group|Studio|Lab|Media|Digital|Tech|Capital)/i.test(segment)) {
            // Looks like a company name, not a title
            company = segment;
          } else {
            title = segment;
          }
        }
        // else: just a name, no extra info

        // Extract company from "Title at Company" in already-parsed title
        if (!company) {
          const atIdx = title.toLowerCase().indexOf(' at ');
          if (atIdx > -1) {
            company = title.substring(atIdx + 4).trim();
            title = title.substring(0, atIdx).trim();
          }
        }

        // If still no parseable name, use full title line
        if (!name) {
          console.warn('[serper] Could not parse title:', r.title);
          name = titleLine;
        }

        // ── Snippet fallback: extract company from Google's description ──
        // Snippets contain patterns like: "CEO at Company Name", "Title · Company",
        // "Title at Company · Pengalaman:", "Founder of Company Sdn Bhd"
        const snippet = r.snippet || '';
        if (!company || company === 'Unknown') {
          company = extractCompanyFromSnippet(snippet, name, title) || '';
        }

        // Last resort
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
          snippet,
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
        let company = atIdx > -1 ? rest.substring(atIdx + 4).trim() : '';

        const snippet = r.snippet || '';
        const linkedinUrl = (r.link || '').split('?')[0].replace(/\/$/, '');

        // Snippet fallback — same as searchLinkedInProfiles
        if (!company || company === 'Unknown') {
          company = extractCompanyFromSnippet(snippet, name, title) || '';
        }
        if (!company) company = 'Unknown';

        return {
          name,
          title,
          company,
          linkedin_url: linkedinUrl,
          email: '',
          snippet,
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
