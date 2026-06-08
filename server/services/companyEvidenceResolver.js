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

function clearCompanyEvidenceCache() {
  evidenceCache.clear();
}

module.exports = {
  resolveCompanyEvidence,
  clearCompanyEvidenceCache,
  _test: {
    activeVerticals,
    evidenceUrls,
    htmlToText,
    matchedVertical,
    normalizeCompanyName,
    snippetEvidenceText,
  },
};
