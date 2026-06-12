'use strict';

const ETRIS_BASE_URL = 'https://etris.my';
const DEFAULT_USER_AGENT = 'BeavrDam/2.0 etris-directory (+https://app.beaver.solutions)';
const DEFAULT_MAX_PROVIDER_PAGES = 5;
const MAX_PROVIDER_PAGES = 25;

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function compactText(value = '') {
  return decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(path = '') {
  try {
    return new URL(path, ETRIS_BASE_URL).toString();
  } catch {
    return '';
  }
}

function canonicalUrl(html = '', fallback = '') {
  const match = String(html || '').match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || String(html || '').match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  return absoluteUrl(decodeHtmlEntities(match?.[1] || fallback || ''));
}

function parseJsonLdBlocks(html = '') {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    try {
      const parsed = JSON.parse(decodeHtmlEntities(match[1]).trim());
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else if (parsed && typeof parsed === 'object') blocks.push(parsed);
    } catch {
      // Ignore malformed structured data; visible HTML fallback handles it.
    }
  }
  return blocks;
}

function jsonType(value) {
  const type = value?.['@type'];
  return Array.isArray(type) ? type.join(' ') : String(type || '');
}

function providerOrganizationFromJsonLd(html = '') {
  return parseJsonLdBlocks(html).find(block => {
    const type = jsonType(block).toLowerCase();
    const name = String(block?.name || '').toLowerCase();
    return type.includes('organization') && name && name !== 'etris directory';
  }) || {};
}

function textFieldAfterLabel(html = '', label = '') {
  const escaped = String(label || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dtRe = new RegExp(`<dt[^>]*>\\s*${escaped}\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`, 'i');
  const rowRe = new RegExp(`<tr[^>]*>\\s*<t[dh][^>]*>\\s*${escaped}\\s*<\\/t[dh]>\\s*<t[dh][^>]*>([\\s\\S]*?)<\\/t[dh]>`, 'i');
  return compactText((String(html || '').match(dtRe) || String(html || '').match(rowRe) || [])[1] || '');
}

function firstMatchText(html = '', patterns = []) {
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1]) return compactText(match[1]);
  }
  return '';
}

function parseDateOnly(value = '') {
  const raw = compactText(value);
  if (!raw) return null;
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const match = raw.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/);
  if (!match) return null;
  const months = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', sept: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  };
  const month = months[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${String(match[1]).padStart(2, '0')}`;
}

function parseAreaServed(areaServed) {
  if (Array.isArray(areaServed)) {
    return compactText(areaServed.map(item => item?.name || item).filter(Boolean)[0] || '');
  }
  if (areaServed && typeof areaServed === 'object') return compactText(areaServed.name || '');
  return compactText(areaServed || '');
}

function parseKnowsAbout(value) {
  if (Array.isArray(value)) return value.map(compactText).filter(Boolean).slice(0, 12);
  return String(value || '').split(/[,;\n]/).map(compactText).filter(Boolean).slice(0, 12);
}

function parseBrowsePage(html = '', { sourceUrl = '' } = {}) {
  const providers = [];
  const seen = new Set();
  const re = /<li[^>]*>([\s\S]*?<a[^>]+href=["'](\/training-provider\/[^"']+\/?)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?)<\/li>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    const source_url = absoluteUrl(match[2]);
    const key = source_url.toLowerCase();
    if (!source_url || seen.has(key)) continue;
    seen.add(key);
    const chunk = match[1];
    const state = compactText((chunk.match(/<span[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '') || null;
    providers.push({
      name: compactText(match[3]),
      state,
      source_url,
    });
  }
  void sourceUrl;
  return providers.filter(provider => provider.name && provider.source_url);
}

function parseProviderPage(html = '', { sourceUrl = '' } = {}) {
  const org = providerOrganizationFromJsonLd(html);
  const source_url = canonicalUrl(html, sourceUrl);
  const titleName = firstMatchText(html, [/<h1[^>]*>([\s\S]*?)<\/h1>/i, /<title[^>]*>([\s\S]*?)\|/i]);
  const category = textFieldAfterLabel(html, 'Category') || null;
  const location = textFieldAfterLabel(html, 'Location');
  const state = parseAreaServed(org.areaServed) || location.replace(/,\s*Malaysia$/i, '') || null;
  const lastVerifiedText = textFieldAfterLabel(html, 'Last verified')
    || firstMatchText(html, [/Last verified:\s*([^<]+)/i]);
  const email = compactText(org.email || firstMatchText(html, [/mailto:([^"']+)/i, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i])).toLowerCase() || null;
  const phone = compactText(org.telephone || firstMatchText(html, [/tel:([^"']+)/i])) || null;
  const etrisRecord = textFieldAfterLabel(html, 'ETRIS record').replace(/^#/, '').trim() || null;
  const registration = textFieldAfterLabel(html, 'Registration') || null;
  const description = compactText(org.description || firstMatchText(html, [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  ]));

  return {
    name: compactText(org.name || titleName),
    description,
    category,
    state,
    email,
    phone,
    etris_record: etrisRecord,
    registration,
    last_verified: parseDateOnly(lastVerifiedText),
    source_url,
    training_areas: parseKnowsAbout(org.knowsAbout),
  };
}

function providerToSignal(provider = {}, query = {}) {
  const signalId = query.signal_id || query.signal_type || 'etris_registered_training_provider';
  const signalFamily = query.signal_family || 'pain_friction_evidence';
  const category = provider.category || 'training provider';
  const state = provider.state || 'Malaysia';
  const verifiedText = provider.last_verified ? `last verified ${provider.last_verified}` : 'publicly listed';
  const evidence = [
    provider.description,
    provider.training_areas?.length ? `Training areas: ${provider.training_areas.join(', ')}` : '',
    provider.registration ? `Registration: ${provider.registration}` : '',
  ].filter(Boolean).join(' ');

  return {
    company: provider.name,
    company_website: null,
    source_url: provider.source_url,
    signal_type: signalId,
    signal_id: signalId,
    signal_family: signalFamily,
    source_channel: 'etris_directory',
    platform: 'etris_directory',
    provider: 'etris_directory',
    country: 'MY',
    tier: query.tier || 'P1',
    confidence: 0.8,
    signal_date: provider.last_verified || undefined,
    signal_summary: `${provider.name} is an HRD Corp ETRIS-listed ${category} in ${state}, ${verifiedText}.`,
    why_now: `ETRIS public provider record ${verifiedText}; HRD-claimable training provider with public contact evidence.`,
    angle: 'Open on how HRD-claimable training providers win more corporate training conversations without relying only on referrals.',
    raw_snippet: evidence || `${provider.name} is listed in the public ETRIS directory.`,
    company_description: evidence || provider.description || '',
    metadata: {
      etris_record: provider.etris_record || null,
      registration: provider.registration || null,
      last_verified: provider.last_verified || null,
      category: provider.category || null,
      state: provider.state || null,
      training_areas: provider.training_areas || [],
      contact: {
        email: provider.email || null,
        phone: provider.phone || null,
      },
    },
  };
}

function normalizeLetters(value) {
  const raw = Array.isArray(value) ? value : String(value || 'a').split(/[,;\s]+/);
  const letters = raw
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .map(item => item === '0' || item === '09' ? '0-9' : item)
    .filter(item => item === '0-9' || /^[a-z]$/.test(item));
  return [...new Set(letters)].slice(0, 6);
}

function maxProviderPages(value) {
  const n = Math.floor(Number(value || DEFAULT_MAX_PROVIDER_PAGES));
  return Math.max(1, Math.min(MAX_PROVIDER_PAGES, Number.isFinite(n) ? n : DEFAULT_MAX_PROVIDER_PAGES));
}

async function fetchText(url, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT },
  });
  if (!res?.ok) {
    const err = new Error(`etris_directory_http_${res?.status || 'unknown'}`);
    err.status = res?.status || null;
    throw err;
  }
  return await res.text();
}

async function fetchEtrisSignals(query = {}, { fetchImpl = globalThis.fetch } = {}) {
  const letters = normalizeLetters(query.letters || query.browse_letters || query.browseLetters);
  const maxPages = maxProviderPages(query.max_provider_pages || query.maxProviderPages);
  const candidates = [];
  const seen = new Set();

  for (const letter of letters) {
    const browseUrl = `${ETRIS_BASE_URL}/training-providers/browse/${letter}/`;
    const html = await fetchText(browseUrl, fetchImpl);
    for (const provider of parseBrowsePage(html, { sourceUrl: browseUrl })) {
      const key = provider.source_url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(provider);
      if (candidates.length >= maxPages) break;
    }
    if (candidates.length >= maxPages) break;
  }

  const signals = [];
  for (const candidate of candidates.slice(0, maxPages)) {
    const html = await fetchText(candidate.source_url, fetchImpl);
    const detail = parseProviderPage(html, { sourceUrl: candidate.source_url });
    signals.push(providerToSignal({
      ...candidate,
      ...detail,
      state: detail.state || candidate.state,
    }, query));
  }
  return signals.filter(signal => signal.company && signal.source_url);
}

module.exports = {
  ETRIS_BASE_URL,
  parseBrowsePage,
  parseProviderPage,
  providerToSignal,
  fetchEtrisSignals,
  _test: {
    absoluteUrl,
    compactText,
    decodeHtmlEntities,
    normalizeLetters,
    parseDateOnly,
    maxProviderPages,
  },
};
