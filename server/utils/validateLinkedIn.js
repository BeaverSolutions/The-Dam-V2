/**
 * Validates a LinkedIn profile URL — catches fabricated/template-generated URLs.
 * Returns true if the URL is valid (or absent). Returns false for fake patterns.
 */
function isValidLinkedInUrl(url) {
  if (!url) return true; // no URL is fine
  // Must be linkedin.com/in/ format
  if (!/^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(url)) return false;
  // Extract the slug part
  const slug = url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, '').replace(/\/.*$/, '');
  // Reject fabricated patterns: ends with -001, -01, _001, _01 etc
  if (/[-_]\d{2,3}$/.test(slug)) return false;
  // Reject template subdomains: my.linkedin.com, test.linkedin.com etc
  if (/^https?:\/\/(my|test|example|fake|sample)\./i.test(url)) return false;
  // Slug too short to be real
  if (slug.length < 3) return false;
  return true;
}

/**
 * Sanitises a LinkedIn URL — returns null (with a warning log) if it looks fabricated.
 * Otherwise returns the original URL.
 */
function sanitiseLinkedInUrl(url, context = '') {
  if (!url) return null;
  if (isValidLinkedInUrl(url)) return url;
  console.warn(`[linkedin-validator] Stripping fake LinkedIn URL: ${url}${context ? ` (${context})` : ''}`);
  return null;
}

module.exports = { isValidLinkedInUrl, sanitiseLinkedInUrl };
