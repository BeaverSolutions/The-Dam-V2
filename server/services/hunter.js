'use strict';

const secrets = require('./secrets');
const spendGuard = require('./spendGuard');

let axios;
try {
  axios = require('axios');
} catch {
  console.warn('[hunter] axios not installed');
}

const BASE = 'https://api.hunter.io/v2';

/* ─── API key helpers ────────────────────────────────────── */

async function getApiKey(clientId) {
  const data = await secrets.getClientSecret(clientId, 'system', 'hunter_api_key');
  return data?.key || null;
}

/* ─── Domain guesser (fallback) ─────────────────────────── */

// Returns array of candidate domains to try in order. Multi-candidate inference
// handles compound names ("X - Y - Z"), slash-separated ("A / B"), and
// descriptor-laden names ("X Digital Marketing Agency"). Geographic suffixes
// stripped so "PHD Malaysia" → "phd" stem (which the MNC blacklist can match).
// 2026-05-14: expanded from 2-domain to multi-candidate per MJ direction —
// hit rate on the May 5 backfill was 9% because of poor domain inference.
function domainsFromCompany(company) {
  if (!company) return [];

  const stem = (s) => (s || '')
    .toLowerCase()
    // Geographic suffixes (added 2026-05-14)
    .replace(/\b(malaysia|singapore|indonesia|philippines|thailand|vietnam|klang\s+valley|kuala\s+lumpur|\bkl\b|asean)\b/gi, '')
    // Multi-word legal suffixes
    .replace(/\bsdn\.?\s*bhd\.?\b/gi, '')
    .replace(/\bpte\.?\s*ltd\.?\b/gi, '')
    .replace(/\bpty\.?\s*ltd\.?\b/gi, '')
    // Single-word suffixes
    .replace(/\b(inc|ltd|llc|corp|co|group|holdings|technologies|technology|solutions|services|global|berhad|bhd|sdn|pte|pty|plc|gmbh|ag|bv|nv|sa)\b/gi, '')
    // Descriptor phrases (added 2026-05-14)
    .replace(/\b(digital\s+marketing\s+agency|marketing\s+agency|advertising\s+agency|creative\s+agency|pr\s+agency|communications\s+agency|consulting\s+firm|law\s+firm|ai\s+company|tech\s+company|software\s+company|software\s+house|design\s+studio|design\s+agency)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, '');

  const candidates = new Set();
  // Candidate 1: full cleaned
  const full = stem(company);
  if (full) candidates.add(full);
  // Candidate 2: slash split ("A / B" → both halves are candidates)
  if (company.includes('/')) {
    for (const part of company.split('/')) {
      const s = stem(part);
      if (s) candidates.add(s);
    }
  }
  // Candidate 3: dash split ("X - Descriptor" → take first half, usually the brand)
  const dashParts = company.split(/\s+[-–]\s+/);
  if (dashParts.length > 1) {
    const s = stem(dashParts[0]);
    if (s) candidates.add(s);
  }
  // Candidate 4: first 2 words (heuristic for compound brand + descriptor)
  const words = company.split(/\s+/).filter(Boolean);
  if (words.length > 2) {
    const s = stem(words.slice(0, 2).join(' '));
    if (s) candidates.add(s);
  }

  if (candidates.size === 0) return [];
  // TLDs in priority order: .com (US-default), .com.my (MY SMBs), .my, .io (tech), .ai (tech)
  // Keep small — each is an API call. 4 TLDs × 4 candidates max = 16 attempts/lead worst case.
  const tlds = ['com', 'com.my', 'my', 'io'];
  const domains = [];
  for (const c of candidates) {
    for (const tld of tlds) {
      domains.push(`${c}.${tld}`);
    }
  }
  return domains;
}

// Keep legacy single-return for domainSearch callers
function domainFromCompany(company) {
  return domainsFromCompany(company)[0] || null;
}

/* ─── Find email by name + domain ────────────────────────── */

async function findEmail(clientId, { firstName, lastName, domain, company }) {
  if (!axios) return null;
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return null;

  const domainsToTry = domain ? [domain] : domainsFromCompany(company);
  if (!domainsToTry.length) return null;

  for (const targetDomain of domainsToTry) {
    try {
      const guard = await spendGuard.checkProvider('hunter', { clientId, estimatedUnits: 1 });
      if (!guard.allowed) {
        console.warn(`[hunter] findEmail blocked by spend guard: ${guard.reason}`);
        return null;
      }
      const resp = await axios.get(`${BASE}/email-finder`, {
        params: {
          domain: targetDomain,
          first_name: firstName,
          last_name: lastName,
        },
        headers: { 'X-Api-Key': apiKey },
        timeout: 10000,
      });
      await spendGuard.logProviderUsage('hunter', {
        clientId,
        units: 1,
        metadata: { operation: 'email-finder', domain: targetDomain },
      });

      const data = resp.data?.data;
      if (data?.email) {
        return {
          email: data.email,
          confidence: data.score || 0,
          verified: data.verification?.status === 'valid',
        };
      }
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        console.warn('[hunter] Invalid API key');
        return null;
      }
      if (status === 429) {
        console.warn('[hunter] Rate limit hit');
        return null;
      }
      // 404 = no email found for this domain — try next
      if (status === 404) continue;
      console.warn('[hunter] findEmail error:', err.message);
      return null;
    }
  }
  return null;
}

/* ─── Domain search (fallback: find anyone at company) ────── */

async function domainSearch(clientId, { domain, company, limit = 5 }) {
  if (!axios) return [];
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return [];

  const targetDomain = domain || domainFromCompany(company);
  if (!targetDomain) return [];

  try {
    const guard = await spendGuard.checkProvider('hunter', { clientId, estimatedUnits: 1 });
    if (!guard.allowed) {
      console.warn(`[hunter] domainSearch blocked by spend guard: ${guard.reason}`);
      return [];
    }
    const resp = await axios.get(`${BASE}/domain-search`, {
      params: { domain: targetDomain, limit },
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000,
    });
    await spendGuard.logProviderUsage('hunter', {
      clientId,
      units: 1,
      metadata: { operation: 'domain-search', domain: targetDomain, limit },
    });

    const emails = resp.data?.data?.emails || [];
    return emails.map(e => ({
      email: e.value,
      firstName: e.first_name,
      lastName: e.last_name,
      title: e.position,
      confidence: e.confidence,
      linkedin_url: e.linkedin || '',
    }));
  } catch (err) {
    if (err.response?.status === 404) return [];
    console.warn('[hunter] domainSearch error:', err.message);
    return [];
  }
}

/* ─── Verify email ───────────────────────────────────────── */

async function verifyEmail(clientId, email) {
  if (!axios) return null;
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return null;

  try {
    const guard = await spendGuard.checkProvider('hunter', { clientId, estimatedUnits: 1 });
    if (!guard.allowed) {
      console.warn(`[hunter] verifyEmail blocked by spend guard: ${guard.reason}`);
      return null;
    }
    const resp = await axios.get(`${BASE}/email-verifier`, {
      params: { email },
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000,
    });
    await spendGuard.logProviderUsage('hunter', {
      clientId,
      units: 1,
      metadata: { operation: 'email-verifier', email_domain: String(email || '').split('@')[1] || null },
    });
    return resp.data?.data?.status || null; // 'valid', 'invalid', 'accept_all', 'unknown'
  } catch {
    return null;
  }
}

/* ─── Test connection ────────────────────────────────────── */

async function testConnection(clientId) {
  if (!axios) return false;
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return false;
  try {
    const resp = await axios.get(`${BASE}/account`, {
      headers: { 'X-Api-Key': apiKey },
      timeout: 8000,
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

module.exports = { getApiKey, findEmail, domainSearch, verifyEmail, testConnection };
