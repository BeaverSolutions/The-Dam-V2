'use strict';

/**
 * Email enrichment for newly-ingested leads.
 *
 * Primary: Brave Search via searchService.searchEmailDomain — searches the
 *   inferred company domain for email patterns, picks the one most likely
 *   to belong to the named person.
 * Provider sourcing: Lusha -> Snov -> Hunter. Provider emails are candidates
 *   only; MillionVerifier is the deliverability authority.
 *
 * Returns: { email, confidence, source } or null.
 *   confidence is 0-100 from the provider/heuristic.
 *   source is 'brave' | 'lusha' | 'snov' | 'hunter' | null.
 */

const { searchEmailDomain } = require('./searchService');
const hunter = require('./hunter');
const logger = require('../utils/logger');
const spendGuard = require('./spendGuard');
const { getCurrentClientId } = require('../middleware/clientContext');

// Domain guesser mirrors hunter.domainsFromCompany so Brave gets a domain to search.
// Slightly looser (no Bahasa-specific suffixes) — Hunter still handles those on fallback.
function domainsFromCompany(company) {
  if (!company) return [];
  const cleaned = company
    .toLowerCase()
    .replace(/\bsdn\.?\s*bhd\.?\b/gi, '')
    .replace(/\bpte\.?\s*ltd\.?\b/gi, '')
    .replace(/\bpty\.?\s*ltd\.?\b/gi, '')
    .replace(/\b(inc|ltd|llc|corp|co|group|holdings|technologies|technology|solutions|services|global|berhad|bhd|sdn|pte|pty|plc|gmbh|ag|bv|nv|sa)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '');
  if (!cleaned) return [];
  return [`${cleaned}.com`, `${cleaned}.com.my`, `${cleaned}.io`];
}

// Split a display name into firstName + lastName. Handles 2-part Western names,
// 3+ part names (first stays first, rest joined as last), and single-token names.
function splitName(name) {
  if (!name || typeof name !== 'string') return { firstName: '', lastName: '' };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Score how well an email matches a given first/last name.
// Returns 0-100 — higher = more likely the right person.
function scoreEmailNameMatch(email, firstName, lastName) {
  const local = String(email).split('@')[0].toLowerCase();
  const f = String(firstName).toLowerCase();
  const l = String(lastName).toLowerCase();
  if (!local) return 0;

  if (f && l && local === `${f}.${l}`) return 95;
  if (f && l && local === `${f}${l}`) return 90;
  if (f && l && local === `${f[0]}${l}`) return 80;
  if (f && local.startsWith(f) && local.includes(l)) return 75;
  if (f && local.includes(f) && l && local.includes(l)) return 70;
  if (l && local.includes(l)) return 50;
  if (f && local.includes(f)) return 40;
  return 0;
}

async function tryBrave(firstName, lastName, company) {
  const domains = domainsFromCompany(company);
  if (!domains.length) return null;

  for (const domain of domains) {
    let emails;
    try {
      emails = await searchEmailDomain(domain);
    } catch (err) {
      logger.warn({ msg: '[enrichment] Brave searchEmailDomain failed', domain, err: err.message });
      return null; // Brave hard fail — fall through to Hunter, don't keep trying domains.
    }
    if (!emails || emails.length === 0) continue;

    // Best match by name-similarity score
    let best = null;
    for (const e of emails) {
      const score = scoreEmailNameMatch(e, firstName, lastName);
      if (!best || score > best.score) best = { email: e, score };
    }
    // Require minimum 50 confidence to claim this is the right person's email.
    if (best && best.score >= 50) {
      return { email: best.email, confidence: best.score, source: 'brave' };
    }
  }
  return null;
}

function envKey(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

function firstEmailFromValue(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0].toLowerCase() : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = firstEmailFromValue(item);
      if (email) return email;
    }
    return null;
  }
  if (typeof value === 'object') {
    const priorityKeys = ['email', 'value', 'address', 'workEmail', 'work_email', 'emails'];
    for (const key of priorityKeys) {
      const email = firstEmailFromValue(value[key]);
      if (email) return email;
    }
    for (const item of Object.values(value)) {
      const email = firstEmailFromValue(item);
      if (email) return email;
    }
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), options.timeoutMs || 12000);
  try {
    const res = await fetch(url, { ...options, signal: ctl.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

async function tryLusha(clientId, { firstName, lastName, company, domain }) {
  const apiKey = envKey('LUSHA_API_KEY');
  if (!apiKey || !firstName || !company) return null;

  const guard = await spendGuard.checkProvider('lusha', { clientId, estimatedUnits: 1 });
  if (!guard.allowed) {
    console.warn(`[emailEnrichment] Lusha blocked by spend guard: ${guard.reason}`);
    return null;
  }

  try {
    const { res, data } = await fetchJson('https://api.lusha.com/v3/contacts/search-and-enrich', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        api_key: apiKey,
      },
      body: JSON.stringify({
        contacts: [{
          firstName,
          lastName: lastName || undefined,
          companyName: company,
          companyDomain: domain || undefined,
        }],
        reveal: ['emails'],
        options: { includePartialProfiles: true },
      }),
    });
    if (!res.ok) {
      if ([401, 402, 403, 429].includes(res.status)) {
        console.warn(`[emailEnrichment] Lusha HTTP ${res.status} - unavailable for this call`);
      }
      return null;
    }
    await spendGuard.logProviderUsage('lusha', {
      clientId,
      units: Math.max(1, Number(data?.billing?.creditsCharged) || 1),
      metadata: { operation: 'contacts-search-and-enrich', domain: domain || null },
    });
    const email = firstEmailFromValue(data?.results);
    return email ? { email, confidence: 75, source: 'lusha' } : null;
  } catch (err) {
    logger.warn({ msg: '[enrichment] Lusha lookup failed', err: err.message });
    return null;
  }
}

async function getSnovAccessToken() {
  const clientId = envKey('SNOV_CLIENT_ID');
  const clientSecret = envKey('SNOV_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const { res, data } = await fetchJson('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok || !data?.access_token) return null;
  return data.access_token;
}

async function trySnov(clientId, { firstName, lastName, domain }) {
  if (!firstName || !domain) return null;
  const token = await getSnovAccessToken();
  if (!token) return null;

  const guard = await spendGuard.checkProvider('snov', { clientId, estimatedUnits: 1 });
  if (!guard.allowed) {
    console.warn(`[emailEnrichment] Snov blocked by spend guard: ${guard.reason}`);
    return null;
  }

  try {
    const params = new URLSearchParams({
      firstName,
      lastName: lastName || '',
      domain,
    });
    const start = await fetchJson(`https://api.snov.io/v2/emails-by-domain-by-name/start?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!start.res.ok) return null;
    await spendGuard.logProviderUsage('snov', {
      clientId,
      units: 1,
      metadata: { operation: 'emails-by-domain-by-name', domain },
    });
    const resultUrl = start.data?.links?.result;
    const taskHash = start.data?.meta?.task_hash || start.data?.task_hash;
    const url = resultUrl || (taskHash ? `https://api.snov.io/v2/emails-by-domain-by-name/result/${encodeURIComponent(taskHash)}` : null);
    if (!url) return firstEmailFromValue(start.data) ? { email: firstEmailFromValue(start.data), confidence: 70, source: 'snov' } : null;
    const maxPolls = providerCapInt(process.env.SNOV_RESULT_POLLS, 2);
    const pollDelayMs = providerCapInt(process.env.SNOV_RESULT_POLL_MS, 750);
    for (let i = 0; i < maxPolls; i++) {
      if (i > 0 && pollDelayMs > 0) await new Promise(resolve => setTimeout(resolve, pollDelayMs));
      const result = await fetchJson(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!result.res.ok) return null;
      const email = firstEmailFromValue(result.data);
      if (email) return { email, confidence: 70, source: 'snov' };
      const status = String(result.data?.meta?.status || result.data?.status || '').toLowerCase();
      if (status && !/progress|pending|process/.test(status)) return null;
    }
    return null;
  } catch (err) {
    logger.warn({ msg: '[enrichment] Snov lookup failed', err: err.message });
    return null;
  }
}

async function tryHunter(clientId, firstName, lastName, company) {
  try {
    const result = await hunter.findEmail(clientId, { firstName, lastName, company });
    if (!result || !result.email) return null;
    return {
      email: result.email,
      confidence: result.confidence || 0,
      verified: result.verified === true,
      source: 'hunter',
    };
  } catch (err) {
    logger.warn({ msg: '[enrichment] Hunter findEmail failed', err: err.message });
    return null;
  }
}

/**
 * Find an email for a person at a company.
 * Legacy wrapper kept for older routes. It delegates to findEmail() so every
 * caller uses Lusha -> Snov -> Hunter sourcing and MillionVerifier authority.
 */
async function enrichEmail(clientId, { name, company }) {
  const result = await findEmail({ name, company, clientId });
  if (!result?.email) return null;
  return { ...result, source: result.email_source || result.source || null };
}

/* ════════════════════════════════════════════════════════════════════════
 * Email-discovery v2 (P0 2026-05-23). Spec source: NEXT-SESSION.md P0
 * "Email-discovery service for Research Beaver".
 *
 * Replaces direct Hunter/VP in pipeline.enrichEmail. Hunter stays in this file
 * as the final provider fallback inside findEmail().
 *
 * Architecture: discover domain (Brave 1-2 searches) -> Lusha -> Snov ->
 * Hunter candidate sourcing -> scrape/pattern candidates -> verify via
 * provider-agnostic interface (MillionVerifier impl) -> consensus scoring.
 *
 * Spend discipline (corrections.md 2026-05-23):
 *   - MillionVerifier 500 free credits is a finite asset. Free signals
 *     (Brave, page scrape, pattern gen) ALWAYS run first; verify call only
 *     fires when scoring is genuinely ambiguous AND no high-confidence
 *     consensus exists. Each verify is one credit; per-tenant cap upstream.
 *   - 1-2 Brave searches per discoverDomain call. Hard ceiling.
 *
 * No SMTP RCPT-TO probe (banned per spec — Google/M365 accept-all
 * false-positives).
 * No new scraping libraries — native fetch only.
 * Provider-agnostic verifier interface so swappable.
 * ════════════════════════════════════════════════════════════════════════ */

const { searchOpenWeb } = require('./searchService');

function providerCapInt(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

// ── 1. Domain discovery ─────────────────────────────────────────────────
/**
 * Find the canonical web domain for a company.
 *
 * Path: Brave search "<company> official site" (1 query) → if first result
 * is a credible match, return its hostname. Fallback: domainsFromCompany()
 * guesses (no API call).
 *
 * @param {object} lead — must have .company; optional .name for query bias
 * @returns {Promise<string|null>} bare hostname like "tincityimpact.com"
 */
async function discoverDomain(lead) {
  if (!lead?.company) return null;
  const maxDomainSearches = providerCapInt(lead.maxDomainSearches, 1);
  const cleaned = String(lead.company)
    .replace(/\b(inc|ltd|llc|corp|corporation|company|holdings|technologies|solutions|services|group)\b/gi, '')
    .replace(/\bsdn\.?\s*bhd\.?\b/gi, '')
    .replace(/\bpte\.?\s*ltd\.?\b/gi, '')
    .trim();
  if (!cleaned) return null;

  // Single open-web query — official site lookup. Spec budget: 1-2 max per
  // call. searchOpenWeb is Brave-primary with Google CSE + DDG fallbacks.
  if (maxDomainSearches > 0) {
    try {
      const items = await searchOpenWeb(`"${cleaned}" official website`, 5, {
        clientId: lead.clientId || lead.client_id || null,
      });
      for (const item of items) {
        // searchOpenWeb shape: { title, description, url } (Brave) or { link, title, snippet } (DDG).
        const url = item.url || item.link || '';
        if (!url) continue;
        try {
          const host = new URL(url).hostname.replace(/^www\./, '');
          if (!host) continue;
          // Reject obvious aggregator/directory domains; we want the company's own.
          if (/linkedin\.com|facebook\.com|crunchbase\.com|glassdoor\.com|wikipedia\.org|youtube\.com|twitter\.com|x\.com|instagram\.com|bloomberg\.com/i.test(host)) continue;
          // Loose match: any token of the cleaned company name appears in host.
          const tokens = cleaned.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
          if (tokens.some(t => host.toLowerCase().includes(t))) return host;
        } catch { /* invalid URL — skip */ }
      }
    } catch (err) {
      // Search failed — fall through to guesses (no spend).
      console.warn('[emailEnrichment] discoverDomain searchOpenWeb failed:', err.message);
    }
  }

  // Fallback: pattern-guess from company name. No API spend.
  const guesses = domainsFromCompany(lead.company);
  return guesses[0] || null;
}

// ── 2. Contact-page email scraping ──────────────────────────────────────
/**
 * Fetch /contact + /about on a domain, regex-extract emails, de-obfuscate
 * "name [at] domain [dot] com" / "name (at) domain (dot) com" / etc.
 *
 * Native fetch, 5s timeout, fail-silent. Returns [] on any error.
 *
 * @param {string} domain — bare hostname
 * @returns {Promise<string[]>} unique lowercased emails @ this domain
 */
async function scrapeContactEmails(domain) {
  if (!domain) return [];
  const paths = ['/contact', '/contact-us', '/about', '/about-us'];
  const found = new Set();
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  for (const path of paths) {
    const url = `https://${domain}${path}`;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' }).catch(() => null);
      clearTimeout(timer);
      if (!res || !res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/') && !ct.includes('html')) continue;
      let text = await res.text();
      // De-obfuscate common patterns BEFORE regex.
      text = text
        .replace(/\s*\[at\]\s*/gi, '@')
        .replace(/\s*\(at\)\s*/gi, '@')
        .replace(/\s+at\s+/gi, '@')
        .replace(/\s*\[dot\]\s*/gi, '.')
        .replace(/\s*\(dot\)\s*/gi, '.');
      const matches = text.match(emailRe) || [];
      for (const e of matches) {
        const lower = e.toLowerCase();
        if (lower.endsWith(`@${domain.toLowerCase()}`)) found.add(lower);
      }
    } catch { /* timeout / fetch error — skip */ }
  }
  return Array.from(found);
}

// ── 3. Pattern generation ───────────────────────────────────────────────
/**
 * Generate 8 candidate email addresses from a person's name + domain,
 * ordered by hit-rate priority. Lowercase + accent-strip applied.
 *
 * Patterns (in order, by B2B hit-rate priority): first.last, first,
 *   firstlast, f.last, last, flast, first_last, firstl
 *
 * Order matters: findEmail's verify ceiling is 3 calls per lead to bound
 * MillionVerifier spend. Patterns ranked here in real-world hit frequency
 * (Hunter / Apollo public stats): first.last ~32%, first ~14%, firstlast
 * ~10%, f.last ~9%, etc. The original "first" pattern at position 4 cost
 * Jacob's known-good jacob@ a verify slot during 2026-05-23 testing.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain
 * @returns {string[]} candidate emails
 */
function generateEmailCandidates(firstName, lastName, domain) {
  if (!domain) return [];
  const f = stripAccents(String(firstName || '')).toLowerCase().replace(/[^a-z]/g, '');
  const l = stripAccents(String(lastName || '')).toLowerCase().replace(/[^a-z]/g, '');
  if (!f) return [];
  const d = String(domain).toLowerCase().trim();
  const out = [];
  if (f && l) out.push(`${f}.${l}@${d}`);   // #1 first.last
  out.push(`${f}@${d}`);                     // #2 first  ← bumped up from #4
  if (f && l) out.push(`${f}${l}@${d}`);    // #3 firstlast
  if (f && l) out.push(`${f[0]}.${l}@${d}`); // #4 f.last
  if (l) out.push(`${l}@${d}`);              // #5 last
  if (f && l) out.push(`${f[0]}${l}@${d}`); // #6 flast
  if (f && l) out.push(`${f}_${l}@${d}`);   // #7 first_last
  if (f && l) out.push(`${f}${l[0]}@${d}`); // #8 firstl
  return Array.from(new Set(out));
}

function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ── 4. Provider-agnostic verification ───────────────────────────────────
/**
 * Verify deliverability of an email via the configured provider.
 * Default impl: MillionVerifier. Swappable via env or injection.
 *
 * Returns a normalised shape regardless of provider:
 *   { status: 'deliverable'|'undeliverable'|'risky'|'unknown',
 *     score: 0-100,
 *     isCatchAll: bool,
 *     provider: string|null }
 *
 * If no API key configured → returns { status: 'unknown', ... } and logs
 * warning. Never throws. Spec contract: missing key MUST NOT crash callers.
 *
 * Spend rule (corrections.md 2026-05-23): MillionVerifier 500-credit cap
 * is finite. Each call = 1 credit. Caller must gate (see findEmail
 * consensus logic — only fires when ambiguous).
 *
 * @param {string} email
 * @returns {Promise<{status,score,isCatchAll,provider}>}
 */
async function verifyEmail(email, clientIdOverride = null) {
  const unknown = { status: 'unknown', score: 0, isCatchAll: false, provider: null };
  if (!email || typeof email !== 'string') return unknown;

  const apiKey = process.env.MILLION_VERIFIER || process.env.EMAIL_VERIFY_API_KEY;
  if (!apiKey) {
    console.warn('[emailEnrichment] verifyEmail: no MILLION_VERIFIER / EMAIL_VERIFY_API_KEY set — returning unknown');
    return unknown;
  }
  const clientId = clientIdOverride || getCurrentClientId() || null;
  const guard = await spendGuard.checkProvider('millionverifier', { clientId, estimatedUnits: 1 });
  if (!guard.allowed) {
    console.warn(`[emailEnrichment] MillionVerifier blocked by spend guard: ${guard.reason}`);
    return { ...unknown, provider: 'millionverifier', blocked: true, reason: guard.reason };
  }

  try {
    const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=10`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
    await spendGuard.logProviderUsage('millionverifier', {
      clientId,
      units: 1,
      metadata: { email_domain: email.split('@')[1] || null },
    });
    if (!res.ok) {
      console.warn(`[emailEnrichment] MillionVerifier HTTP ${res.status} for ${email}`);
      return { ...unknown, provider: 'millionverifier' };
    }
    const data = await res.json();
    // MillionVerifier result field: 'ok' | 'catch_all' | 'unknown' | 'error' | 'disposable' | 'invalid'
    const r = String(data?.result || '').toLowerCase();
    const quality = String(data?.quality || '').toLowerCase(); // 'good'|'risky'|'bad'
    let status = 'unknown';
    if (r === 'ok' || quality === 'good') status = 'deliverable';
    else if (r === 'catch_all' || quality === 'risky') status = 'risky';
    else if (r === 'invalid' || r === 'disposable' || quality === 'bad') status = 'undeliverable';
    const isCatchAll = r === 'catch_all';
    // Score: 90 deliverable, 50 risky/catch_all, 10 undeliverable, 0 unknown.
    const score = status === 'deliverable' ? 90 : status === 'risky' ? 50 : status === 'undeliverable' ? 10 : 0;
    return { status, score, isCatchAll, provider: 'millionverifier' };
  } catch (err) {
    console.warn(`[emailEnrichment] verifyEmail error for ${email}: ${err.message}`);
    return { ...unknown, provider: 'millionverifier' };
  }
}

// ── 5. Orchestrator ─────────────────────────────────────────────────────
/**
 * Find a deliverable email for a lead via the full v2 pipeline.
 *
 * Order (each step is conditional on prior step's confidence):
 *   1. Discover domain (Brave 1-2 searches, fallback to name-pattern guess)
 *   2. Source via Lusha -> Snov -> Hunter while caps allow
 *   3. Scrape /contact + /about -> emails published by the company
 *   4. Generate 8 candidate patterns from name + domain
 *   5. Score candidates against scraped emails (name-match heuristic)
 *   6. Verify every selected email candidate through MillionVerifier
 *   7. Consensus scoring: 2+ sources agreeing -> confidence 80+. Single-source
 *      on catch-all domain -> cap confidence 50 + flag isCatchAll
 *
 * Spend: provider calls and MillionVerifier are spendGuard-capped. Provider
 * emails are never trusted as deliverable until MillionVerifier confirms.
 *
 * @param {object} lead — { name, company, domain?, first_name?, last_name? }
 * @returns {Promise<{email, status, confidence, isCatchAll, email_source}|null>}
 */
async function findEmail(lead) {
  if (!lead?.name || !lead?.company) return null;
  const clientId = lead.clientId || lead.client_id || null;
  const maxLushaCalls = providerCapInt(lead.maxLushaCalls, lead.skipLusha === true ? 0 : 1);
  const maxSnovCalls = providerCapInt(lead.maxSnovCalls, lead.skipSnov === true ? 0 : 1);
  const maxHunterCalls = providerCapInt(lead.maxHunterCalls, lead.skipHunter === true ? 0 : 1);
  const maxVerifierCalls = providerCapInt(lead.maxVerifierCalls, 3);
  let verifierCallsRemaining = maxVerifierCalls;

  const domain = lead.domain || await discoverDomain(lead);
  if (!domain) return null;

  // Split name (reuse legacy helper)
  let firstName = lead.first_name || '';
  let lastName = lead.last_name || '';
  if (!firstName) {
    const split = splitName(lead.name);
    firstName = split.firstName;
    lastName = split.lastName;
  }
  if (!firstName) return null;

  async function verifyProviderEmail(providerResult) {
    if (!providerResult?.email || verifierCallsRemaining <= 0) return null;
    verifierCallsRemaining--;
    const candidateEmail = providerResult.email;
    const v = await verifyEmail(candidateEmail, clientId);
    if (v.status === 'deliverable') {
      return {
        email: candidateEmail,
        status: 'deliverable',
        confidence: Math.min(Math.max(providerResult.confidence || 50, 40) + v.score / 2, 95),
        isCatchAll: v.isCatchAll,
        email_source: providerResult.source,
      };
    }
    if (v.status === 'risky' && v.isCatchAll) {
      return {
        email: candidateEmail,
        status: 'risky',
        confidence: 50,
        isCatchAll: true,
        email_source: `${providerResult.source}+catch_all`,
      };
    }
    return null;
  }

  if (maxLushaCalls > 0) {
    const lushaResult = await tryLusha(clientId, { firstName, lastName, company: lead.company, domain });
    const verified = await verifyProviderEmail(lushaResult);
    if (verified) return verified;
  }

  if (maxSnovCalls > 0) {
    const snovResult = await trySnov(clientId, { firstName, lastName, domain });
    const verified = await verifyProviderEmail(snovResult);
    if (verified) return verified;
  }

  if (maxHunterCalls > 0) {
    const hunterResult = await tryHunter(clientId, firstName, lastName, lead.company);
    const verified = await verifyProviderEmail(hunterResult);
    if (verified) return verified;
  }

  // Step 2: scrape contact pages (free)
  const scraped = await scrapeContactEmails(domain);
  const scrapedSet = new Set(scraped.map(e => e.toLowerCase()));

  // Step 3: generate candidates
  const candidates = generateEmailCandidates(firstName, lastName, domain);
  if (candidates.length === 0) return null;

  // Step 4: name-match scoring + scrape consensus
  const scored = candidates.map(c => {
    const nameScore = scoreEmailNameMatch(c, firstName, lastName);
    const scrapeHit = scrapedSet.has(c);
    let confidence = nameScore;
    if (scrapeHit) confidence = Math.max(confidence, 80) + 10; // boost for scrape confirmation
    return { email: c, nameScore, scrapeHit, confidence };
  }).sort((a, b) => b.confidence - a.confidence);

  // If top candidate is name-scored 90+ AND confirmed by scrape, treat as deliverable
  // only after MillionVerifier confirms deliverability.
  const top = scored[0];
  if (top && top.scrapeHit && top.nameScore >= 90) {
    const verified = await verifyProviderEmail({ email: top.email, confidence: top.confidence, source: 'scrape+pattern' });
    if (verified) return verified;
  }

  // If scraped emails contain ANY @domain address that name-matches, surface it
  // even if not in our generated set (covers edge cases like "founder@" or "jacob.f@").
  for (const e of scraped) {
    const ns = scoreEmailNameMatch(e, firstName, lastName);
    if (ns >= 50) {
      const verified = await verifyProviderEmail({ email: e, confidence: ns + 10, source: 'scrape' });
      if (verified) return verified;
    }
  }

  // Step 6: verify ambiguous top candidates via MillionVerifier (paid).
  // Cap to first-3 in GENERATION order (hit-rate priority), NOT name-score
  // order. Name-score over-weights "first.last" patterns that match BOTH
  // name tokens vs. simpler "first@" patterns that match one but are more
  // common in real B2B (Hunter/Apollo stats). Worst case: 3 credits/lead.
  const verifyCandidates = candidates.slice(0, verifierCallsRemaining);
  for (const email of verifyCandidates) {
    const nameScore = scoreEmailNameMatch(email, firstName, lastName);
    const v = await verifyEmail(email, clientId);
    if (v.status === 'deliverable') {
      return {
        email,
        status: 'deliverable',
        confidence: Math.min(Math.max(nameScore, 40) + v.score / 2, 95),
        isCatchAll: v.isCatchAll,
        email_source: 'pattern+verify',
      };
    }
    if (v.status === 'risky' && v.isCatchAll && nameScore >= 80) {
      // Catch-all domain: single-source flag, capped confidence per spec.
      return {
        email,
        status: 'risky',
        confidence: 50,
        isCatchAll: true,
        email_source: 'pattern+catch_all',
      };
    }
    // 'undeliverable' or 'unknown' — try next candidate.
  }

  return null;
}

module.exports = {
  // Legacy (kept for any non-pipeline.enrichEmail callers)
  enrichEmail,
  splitName,
  domainsFromCompany,
  scoreEmailNameMatch,
  // v2 (P0 2026-05-23)
  discoverDomain,
  scrapeContactEmails,
  generateEmailCandidates,
  verifyEmail,
  findEmail,
};
