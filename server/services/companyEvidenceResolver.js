'use strict';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_TEXT = 2400;
const evidenceCache = new Map();

function listFrom(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompanyName(value = '') {
  return normalizeText(value)
    .replace(/\b(sdn bhd|sdn|bhd|pte ltd|pte|ltd|limited|inc|llc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function activeVerticals(icp = {}) {
  return [
    ...listFrom(icp.active_industries),
    ...listFrom(icp.icp?.active_industries),
  ].filter(Boolean);
}

function isMarketingAgencyTerm(term = '') {
  return /\b(agenc(y|ies)|studio|studios|firm|firms)\b/.test(term)
    && /\b(marketing|digital|creative|pr|communications?|advertising|media|content|public relations)\b/.test(term);
}

function isCorporateTrainingTerm(term = '') {
  return /\b(training|learning|coaching|skill|skills|upskill|upskilling|l and d|development)\b/.test(term);
}

function marketingAgencyEvidenceMatches(text = '') {
  if (/\b(recruit|recruitment|staffing|headhunt|employment agency|talent acquisition)\b/.test(text)) {
    return false;
  }
  return /\b(agenc(y|ies)|studio|studios|firm|firms)\b/.test(text)
    && /\b(marketing|digital|creative|pr|communications?|advertising|media|content|brand|branding|social media|public relations)\b/.test(text);
}

function corporateTrainingEvidenceMatches(text = '') {
  return /\b(corporate training|professional training|workplace training|employee training|training provider|training company|training firm|training consultancy|learning and development|l and d|executive coaching|leadership coaching|sales coaching|skills development|skill development|upskill|upskilling|workforce development)\b/.test(text);
}

function termMatchesEvidence(term = '', text = '') {
  const normalizedTerm = normalizeText(term);
  const normalizedEvidence = normalizeText(text);
  if (!normalizedTerm || !normalizedEvidence) return false;
  if (isMarketingAgencyTerm(normalizedTerm)) return marketingAgencyEvidenceMatches(normalizedEvidence);
  if (isCorporateTrainingTerm(normalizedTerm)) return corporateTrainingEvidenceMatches(normalizedEvidence);
  return normalizedEvidence.includes(normalizedTerm);
}

function matchedVertical(text = '', icp = {}) {
  return activeVerticals(icp).find(term => termMatchesEvidence(term, text)) || null;
}

function snippetEvidenceText(signal = {}) {
  const metadata = signal.metadata || {};
  return [
    signal.company,
    signal.signal_summary,
    signal.raw_snippet,
    signal.snippet,
    signal.description,
    signal.company_description,
    signal.why_now,
    signal.angle,
    metadata.signal_summary,
    metadata.raw_snippet,
    metadata.evidence,
    metadata.company_description,
  ].filter(Boolean).join(' ').slice(0, MAX_EVIDENCE_TEXT);
}

function htmlToText(html = '') {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EVIDENCE_TEXT);
}

function urlWithProtocol(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return null;
}

function originFor(value = '') {
  const raw = urlWithProtocol(value);
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function isLikelyCompanyWebsite(url = '') {
  try {
    const host = new URL(urlWithProtocol(url)).hostname.toLowerCase();
    return !/(linkedin\.com|jobstreet|hiredly|indeed|glassdoor|mycareersfuture|jobsdb|foundit|wobb)/i.test(host);
  } catch {
    return false;
  }
}

// A vertical web search returns listicles, directories and SEO ranking pages
// far more often than individual company homepages. Those pages are not
// companies — their <title> is a headline ("Top 10 ... Providers in Malaysia").
// Detect and skip them so discovery anchors on real company domains instead.
const AGGREGATOR_HOSTS = /(clutch\.co|goodfirms|sortlist|designrush|trustpilot|yelp|yellowpages|glassdoor|crunchbase|wikipedia|facebook\.com|instagram\.com|youtube\.com|medium\.com|quora|reddit)/i;
function isAggregatorUrl(url = '') {
  const raw = String(url || '').toLowerCase();
  if (!raw) return false;
  let path = raw;
  let host = '';
  try {
    const u = new URL(urlWithProtocol(raw));
    host = u.hostname.replace(/^www\./, '');
    path = `${u.pathname}${u.search}`;
  } catch { /* treat the whole string as a path */ }
  if (host && AGGREGATOR_HOSTS.test(host)) return true;
  // Listicle / directory / SEO ranking path shapes.
  if (/top[-\s]?\d+/.test(path)) return true;                                  // "top 10", "top-20"
  if (/\btop[-\s][a-z]/.test(path)) return true;                               // "top-training-..."
  if (/\bbest[-\s]/.test(path)) return true;                                   // "best-agencies-..."
  if (/(providers?|companies|agencies|firms|vendors)[-\s](in|malaysia|singapore|my|sg|kl|asia)\b/.test(path)) return true;
  if (/[-/](list|listing|listicle|directory|ranking|rankings|reviews?|comparison|guide)\b/.test(path)) return true;
  if (/\/(category|categories|tag|tags|blog|news|article|articles)\//.test(path)) return true;
  return false;
}

function companyNameFromDomain(url = '') {
  try {
    const host = new URL(urlWithProtocol(url)).hostname.replace(/^www\./, '');
    const root = host.split('.')[0];
    if (!root || root.length < 2) return '';
    return root
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
  } catch {
    return '';
  }
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'")
    .replace(/&(?:quot|#0*34|#x0*22);/gi, '"')
    .replace(/&(?:nbsp|#0*160);/gi, ' ')
    .replace(/&(?:#0*38|#x0*26);/gi, '&');
}

// Many sites stuff a tagline into og:site_name / <title> ("Brand | We do X").
// Keep the brand portion before the first separator.
function brandPortion(value = '') {
  return String(value || '').split(/\s*[|–—\-:·»]\s*/)[0];
}

function cleanResolvedName(value = '', { keepFull = false } = {}) {
  const decoded = decodeHtmlEntities(value);
  const candidate = keepFull ? decoded : brandPortion(decoded);
  const name = candidate
    .replace(/\s+/g, ' ')
    .replace(/^[\s,|·\-–—]+|[\s,|·\-–—]+$/g, '')
    .trim();
  if (!name || name.length < 2 || name.length > 80) return '';
  // Reject obvious non-company headlines.
  if (/\b(top\s*\d+|best\s|listicle|ranking|reviews?|directory|guide|how to|in\s+malaysia\b.*\bprovider|leading\s+corporate\s+training)/i.test(name)) return '';
  return name;
}

// Canonical company name from the homepage HTML: og:site_name, then a
// schema.org Organization/LocalBusiness name, then the brand portion of <title>.
function companyNameFromHtml(html = '') {
  if (!html) return '';
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  if (og) {
    const name = cleanResolvedName(og[1]);
    if (name) return name;
  }
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data['@graph']) ? data['@graph'] : [])];
      for (const node of nodes) {
        if (node && /organization|localbusiness|corporation/i.test(String(node['@type'])) && node.name) {
          const name = cleanResolvedName(node.name, { keepFull: true });
          if (name) return name;
        }
      }
    } catch { /* malformed ld+json — skip */ }
  }
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) {
    const brand = title[1].split(/[|–—\-:·»]/)[0];
    const name = cleanResolvedName(brand);
    if (name && name.split(' ').length <= 6) return name;
  }
  return '';
}

function evidenceUrls(signal = {}) {
  const urls = [];
  const website = signal.company_website || signal.website || signal.company_url || signal.domain;
  const origin = originFor(website);
  if (origin && isLikelyCompanyWebsite(origin)) urls.push({ url: `${origin}/about`, source: 'about_page' });

  const sourceUrl = urlWithProtocol(signal.company_profile_url || signal.profile_url || signal.source_url || signal.url);
  if (sourceUrl) urls.push({ url: sourceUrl, source: 'company_profile' });

  const seen = new Set();
  return urls.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function fetchEvidenceText(url, fetchImpl) {
  if (typeof fetchImpl !== 'function') return null;
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'BeavrDamEvidenceResolver/1.0' },
  });
  if (!res || res.ok === false) return null;
  const html = await res.text();
  return htmlToText(html);
}

function unresolvedResult(company, evidence = []) {
  return {
    company,
    vertical_match: null,
    evidence,
    source: 'unresolved',
    confidence: 0,
  };
}

function matchedResult(company, vertical, evidence, source, confidence) {
  return {
    company,
    vertical_match: vertical,
    evidence,
    source,
    confidence,
  };
}

async function resolveCompanyEvidence(signal = {}, icp = {}, {
  fetchImpl = global.fetch,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const company = String(signal.company || signal.company_name || '').trim();
  const cacheKey = normalizeCompanyName(company);
  if (!company || activeVerticals(icp).length === 0) return unresolvedResult(company);

  const cached = evidenceCache.get(cacheKey);
  if (cached && cached.expires_at > now) {
    return { ...cached.value, from_cache: true };
  }

  const evidence = [];
  const snippet = snippetEvidenceText(signal);
  if (snippet) {
    evidence.push({ source: 'snippet', text: snippet });
    const vertical = matchedVertical(snippet, icp);
    if (vertical) {
      const value = matchedResult(company, vertical, evidence, 'snippet', 0.8);
      evidenceCache.set(cacheKey, { value, expires_at: now + ttlMs });
      return value;
    }
  }

  for (const candidate of evidenceUrls(signal)) {
    try {
      const text = await fetchEvidenceText(candidate.url, fetchImpl);
      if (!text) continue;
      evidence.push({ source: candidate.source, url: candidate.url, text });
      const vertical = matchedVertical(text, icp);
      if (vertical) {
        const confidence = candidate.source === 'about_page' ? 0.9 : 0.7;
        const value = matchedResult(company, vertical, evidence, candidate.source, confidence);
        evidenceCache.set(cacheKey, { value, expires_at: now + ttlMs });
        return value;
      }
    } catch {
      // Free evidence lookup failed; unresolved is safer than guessing.
    }
  }

  const value = unresolvedResult(company, evidence);
  evidenceCache.set(cacheKey, { value, expires_at: now + ttlMs });
  return value;
}

const identityCache = new Map();

// Resolve a real company identity for a vertical-first discovery candidate.
// Anchors on the result domain (not the scraped page title) and reads the
// canonical company name from the homepage (og:site_name / schema.org / title
// brand). Returns the homepage text too, so the caller can confirm the vertical
// without a second fetch. Free (native fetch) + cached by origin.
async function resolveCompanyIdentity(signal = {}, {
  fetchImpl = global.fetch,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const provisional = String(signal.company || signal.company_name || '').trim();
  const website = signal.company_website || signal.website || signal.company_url
    || signal.domain || signal.source_url || signal.url;
  const origin = originFor(website);

  if (!origin || !isLikelyCompanyWebsite(origin) || isAggregatorUrl(website) || isAggregatorUrl(origin)) {
    return { company: provisional, website: origin, source: 'provisional', page_text: '', resolved: false };
  }

  const cacheKey = `identity:${origin}`;
  const cached = identityCache.get(cacheKey);
  if (cached && cached.expires_at > now) {
    return { ...cached.value, from_cache: true };
  }

  let html = '';
  try {
    const res = await fetchImpl(origin, { headers: { 'user-agent': 'BeavrDamEvidenceResolver/1.0' } });
    if (res && res.ok !== false) html = await res.text();
  } catch { /* fall back to domain-derived name */ }

  const name = companyNameFromHtml(html) || companyNameFromDomain(origin) || provisional;
  const value = {
    company: name || provisional,
    website: origin,
    source: html ? (companyNameFromHtml(html) ? 'homepage' : 'domain') : 'domain',
    page_text: htmlToText(html),
    resolved: Boolean(name && name !== provisional),
  };
  identityCache.set(cacheKey, { value, expires_at: now + ttlMs });
  return value;
}

// Deterministic enterprise / global markers on free homepage text. Designed
// to run BEFORE any paid decision-maker lookup so giants are killed for free
// instead of burning budget the ICP gate would later reject anyway. Only
// fires on high-confidence markers — false positives bias toward rejection
// (acceptable: real MY/SG SMEs that splash "global ambition" copy on their
// homepage are rare; the user can edit markers if a real SME gets caught).
const GLOBAL_HUB_CITIES = /(london|new york|nyc|paris|tokyo|sydney|berlin|amsterdam|chicago|san francisco|los angeles|toronto|dublin|stockholm|zurich|geneva|hong kong|shanghai|beijing|delhi|mumbai|bangalore|bengaluru|hyderabad)/i;
const ENTERPRISE_GLOBAL_PATTERNS = [
  ['offices in N+ countries', /\b(?:offices?|presence|operations?|teams?|hubs?)\s+(?:in|across)\s+(?:\w+\s+)?(\d{1,3})\+?\s+(countries|markets|cities|locations)\b/i],
  ['global network/agency/firm', /\b(global|worldwide|international)\s+(?:\w+\s+){0,2}(network|leader|provider|agency|agencies|firm|firms|consultancy|consultancies|brand|brands|company|companies|organi[sz]ation)\b/i],
  ['worldwide presence', /\b(worldwide|across the globe|around the world)\s+(presence|footprint|reach|operations|clients?|customers?)\b/i],
  ['Fortune 500/1000', /\bFortune\s*(?:500|1000)\b/i],
  ['team of 100+', /\b(?:team|workforce|staff|employees?)\s+of\s+(\d{3,5})\+?\b/i],
  ['100+ employees', /\b(\d{3,5})\+?\s+(?:employees|professionals|consultants|specialists|people)\b/i],
  ['part of <global group>', /\b(?:part of|a member of|company of|brand of)\s+(?:the\s+)?(WPP|Publicis|Dentsu|Omnicom|IPG|Interpublic|Havas|Stagwell|S4 Capital|Edelman|Burson|Hill\s*\+?\s*Knowlton)\b/i],
];

function detectEnterpriseOrGlobalMarkers(text = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return { matches: [] };
  const matches = [];
  for (const [label, pattern] of ENTERPRISE_GLOBAL_PATTERNS) {
    const m = normalized.match(pattern);
    if (!m) continue;
    // Threshold filters for numeric markers.
    if (label === 'offices in N+ countries' && Number(m[1]) < 5) continue;
    if (label === 'team of 100+' && Number(m[1]) < 100) continue;
    if (label === '100+ employees' && Number(m[1]) < 100) continue;
    matches.push({ marker: label, evidence: m[0].slice(0, 120) });
  }
  // Non-MY/SG global HQ marker (separate so we can tag it distinctly).
  const hq = normalized.match(/\b(?:headquartered|head\s*offices?|global\s+hq)\s+(?:in|at)\s+([A-Za-z][A-Za-z ,]{2,40})/i);
  if (hq && GLOBAL_HUB_CITIES.test(hq[1]) && !/malaysia|singapore|kuala lumpur|kl\b|petaling jaya|cyberjaya|johor|penang/i.test(hq[1])) {
    matches.push({ marker: 'headquartered in non-MY/SG global hub', evidence: hq[0].slice(0, 120) });
  }
  return { matches };
}

function clearCompanyEvidenceCache() {
  evidenceCache.clear();
  identityCache.clear();
}

module.exports = {
  resolveCompanyEvidence,
  resolveCompanyIdentity,
  detectEnterpriseOrGlobalMarkers,
  isAggregatorUrl,
  companyNameFromDomain,
  companyNameFromHtml,
  clearCompanyEvidenceCache,
  _test: {
    activeVerticals,
    evidenceUrls,
    htmlToText,
    matchedVertical,
    normalizeCompanyName,
    snippetEvidenceText,
    isAggregatorUrl,
    companyNameFromDomain,
    companyNameFromHtml,
    detectEnterpriseOrGlobalMarkers,
  },
};
