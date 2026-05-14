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

module.exports = { enrichEmail, splitName, domainsFromCompany, scoreEmailNameMatch };
