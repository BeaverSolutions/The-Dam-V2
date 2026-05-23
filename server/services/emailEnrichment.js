'use strict';

/**
 * Email enrichment for newly-ingested leads.
 *
 * Primary: Brave Search via searchService.searchEmailDomain — searches the
 *   inferred company domain for email patterns, picks the one most likely
 *   to belong to the named person.
 * Fallback: Hunter.io email-finder via services/hunter.findEmail.
 *
 * Returns: { email, confidence, source } or null.
 *   confidence is 0-100 (Hunter's score) or a heuristic 0-100 for Brave.
 *   source is 'brave' | 'hunter' | null.
 */

const { searchEmailDomain } = require('./searchService');
const hunter = require('./hunter');
const logger = require('../utils/logger');

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

async function tryHunter(clientId, firstName, lastName, company) {
  try {
    const result = await hunter.findEmail(clientId, { firstName, lastName, company });
    if (!result || !result.email) return null;
    return {
      email: result.email,
      confidence: result.confidence || 0,
      source: 'hunter',
    };
  } catch (err) {
    logger.warn({ msg: '[enrichment] Hunter findEmail failed', err: err.message });
    return null;
  }
}

/**
 * Find an email for a person at a company.
 * Brave primary → Hunter fallback.
 */
async function enrichEmail(clientId, { name, company }) {
  if (!name || !company) return null;
  const { firstName, lastName } = splitName(name);
  if (!firstName) return null;

  const brave = await tryBrave(firstName, lastName, company);
  if (brave) return brave;

  const hunter = await tryHunter(clientId, firstName, lastName, company);
  if (hunter) return hunter;

  return null;
}

/* ════════════════════════════════════════════════════════════════════════
 * Email-discovery v2 (P0 2026-05-23). Spec source: NEXT-SESSION.md P0
 * "Email-discovery service for Research Beaver".
 *
 * Replaces Hunter+VP in pipeline.enrichEmail. Hunter/VP stays in this file
 * for other callers (legacy enrichEmail above) per spec ("file kept").
 *
 * Architecture: discover domain (Brave 1-2 searches) → scrape /contact +
 * /about for published emails → generate 8 candidate patterns from name +
 * domain → verify via provider-agnostic interface (MillionVerifier impl)
 * → consensus scoring (≥80 only when 2+ sources agree).
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
  const cleaned = String(lead.company)
    .replace(/\b(inc|ltd|llc|corp|corporation|company|holdings|technologies|solutions|services|group)\b/gi, '')
    .replace(/\bsdn\.?\s*bhd\.?\b/gi, '')
    .replace(/\bpte\.?\s*ltd\.?\b/gi, '')
    .trim();
  if (!cleaned) return null;

  // Single open-web query — official site lookup. Spec budget: 1-2 max per
  // call. searchOpenWeb is Brave-primary with Google CSE + DDG fallbacks.
  try {
    const items = await searchOpenWeb(`"${cleaned}" official website`, 5);
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
async function verifyEmail(email) {
  const unknown = { status: 'unknown', score: 0, isCatchAll: false, provider: null };
  if (!email || typeof email !== 'string') return unknown;

  const apiKey = process.env.MILLION_VERIFIER || process.env.EMAIL_VERIFY_API_KEY;
  if (!apiKey) {
    console.warn('[emailEnrichment] verifyEmail: no MILLION_VERIFIER / EMAIL_VERIFY_API_KEY set — returning unknown');
    return unknown;
  }

  try {
    const url = `https://api.millionverifier.com/api/v3/?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=10`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(timer);
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
 *   2. Scrape /contact + /about → emails published by the company
 *   3. Generate 8 candidate patterns from name + domain
 *   4. Score candidates against scraped emails (name-match heuristic)
 *      → return first deliverable WITHOUT calling MillionVerifier if
 *        score >= 90 AND scrape confirms exact match (consensus = high
 *        confidence, save the credit)
 *   5. For ambiguous candidates (score 50-89, or scrape empty), verify via
 *      MillionVerifier in priority order, return first deliverable
 *   6. Consensus scoring: 2+ sources agreeing → confidence 80+. Single-source
 *      on catch-all domain → cap confidence 50 + flag isCatchAll
 *
 * Spend: free signals first. MillionVerifier verify only when ambiguous.
 *
 * @param {object} lead — { name, company, domain?, first_name?, last_name? }
 * @returns {Promise<{email, status, confidence, isCatchAll, email_source}|null>}
 */
async function findEmail(lead) {
  if (!lead?.name || !lead?.company) return null;

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
  // without spending a MillionVerifier credit. Two-source consensus.
  const top = scored[0];
  if (top && top.scrapeHit && top.nameScore >= 90) {
    return {
      email: top.email,
      status: 'deliverable',
      confidence: Math.min(top.confidence, 99),
      isCatchAll: false,
      email_source: 'scrape+pattern',
    };
  }

  // If scraped emails contain ANY @domain address that name-matches, surface it
  // even if not in our generated set (covers edge cases like "founder@" or "jacob.f@").
  for (const e of scraped) {
    const ns = scoreEmailNameMatch(e, firstName, lastName);
    if (ns >= 50) {
      return {
        email: e,
        status: 'deliverable',
        confidence: Math.min(ns + 10, 95),
        isCatchAll: false,
        email_source: 'scrape',
      };
    }
  }

  // Step 5: verify ambiguous top candidates via MillionVerifier (paid).
  // Cap to first-3 in GENERATION order (hit-rate priority), NOT name-score
  // order. Name-score over-weights "first.last" patterns that match BOTH
  // name tokens vs. simpler "first@" patterns that match one but are more
  // common in real B2B (Hunter/Apollo stats). Worst case: 3 credits/lead.
  const verifyCandidates = candidates.slice(0, 3);
  for (const email of verifyCandidates) {
    const nameScore = scoreEmailNameMatch(email, firstName, lastName);
    const v = await verifyEmail(email);
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
