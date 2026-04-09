'use strict';

/**
 * Lead Scorer — V1 Search Upgrade
 *
 * normalize → filter → deduplicate → rank → threshold
 *
 * All functions are pure (no I/O). They transform arrays of lead objects.
 *
 * Scorer format: { name, title, company, url, snippet, source, score? }
 * Input format from searchService/parseProfileItems:
 *   { name, title, company, linkedin_url, snippet, data_source }
 */

/**
 * normalize(results)
 * Maps any provider result shape to the scorer's canonical format.
 * Accepts both raw search items and pre-parsed lead objects.
 */
function normalize(results) {
  return (results || []).map(r => ({
    name:    (r.name    || r.title  || '').trim(),
    title:   (r.title   || '').trim(),
    company: (r.company || '').trim(),
    url:     (r.linkedin_url || r.url || r.link || '').split('?')[0].replace(/\/$/, ''),
    snippet: (r.snippet || r.description || '').trim(),
    source:  (r.data_source || r.source || 'unknown'),
  }));
}

/**
 * filterResults(results, signalKeyword)
 * Removes results that:
 *  - have a URL that does NOT contain linkedin.com/in/
 *  - do NOT contain the signal keyword in their snippet (if signalKeyword is provided)
 */
function filterResults(results, signalKeyword) {
  return (results || []).filter(r => {
    if (!r.url || !r.url.includes('linkedin.com/in/')) return false;
    if (signalKeyword && r.snippet) {
      if (!r.snippet.toLowerCase().includes(signalKeyword.toLowerCase())) return false;
    }
    return true;
  });
}

/**
 * deduplicate(results)
 * Removes duplicate entries by URL using a Set.
 * Entries without a URL are kept (can't dedup).
 */
function deduplicate(results) {
  const seen = new Set();
  return (results || []).filter(r => {
    if (!r.url) return true;
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * rankLeads(results, criteria)
 * Scores each result and returns them sorted highest first.
 *
 * Scoring:
 *   +20  LinkedIn profile URL (linkedin.com/in/)
 *   +15  Role match (title contains target role)
 *   +10  Region match (snippet contains target location)
 *   +10  Signal keyword present in snippet
 *   + 5  Source: CSE
 *   + 3  Source: Serper
 *   + 0  Source: DDG or unknown
 *
 * criteria: { role: string, location: string, signal: string }
 */
function rankLeads(results, criteria = {}) {
  const role     = (criteria.role     || '').toLowerCase().trim();
  const location = (criteria.location || '').toLowerCase().trim();
  const signal   = (criteria.signal   || '').toLowerCase().trim();

  const scored = (results || []).map(r => {
    let score = 0;

    if (r.url && r.url.includes('linkedin.com/in/')) score += 20;

    if (role && r.title && r.title.toLowerCase().includes(role)) score += 15;

    const snippetLower = (r.snippet || '').toLowerCase();
    if (location && snippetLower.includes(location)) score += 10;
    if (signal   && snippetLower.includes(signal))   score += 10;

    const src = (r.source || '').toLowerCase();
    if (src === 'cse' || src === 'google_cse')          score += 5;
    else if (src === 'serper' || src.startsWith('serper')) score += 3;
    // DDG / unknown = +0

    return { ...r, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * thresholdFilter(results, minScore)
 * Discards results below the minimum score threshold.
 * Default: 60 (requires LinkedIn URL + role match + one more signal).
 *
 * For the chat path where we want more results, callers should pass a lower threshold (e.g. 25).
 */
function thresholdFilter(results, minScore = 60) {
  return (results || []).filter(r => (r.score || 0) >= minScore);
}

module.exports = { normalize, filterResults, deduplicate, rankLeads, thresholdFilter };
