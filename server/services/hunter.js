'use strict';

const secrets = require('./secrets');

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

// Returns [primaryDomain, ...fallbacks] to try in order.
// Covers MY (Sdn Bhd), SG (Pte Ltd), AU (Pty Ltd) + standard US/UK suffixes.
function domainsFromCompany(company) {
  if (!company) return [];
  const cleaned = company
    .toLowerCase()
    // Multi-word suffixes first (order matters)
    .replace(/\bsdn\.?\s*bhd\.?\b/gi, '')
    .replace(/\bpte\.?\s*ltd\.?\b/gi, '')
    .replace(/\bpty\.?\s*ltd\.?\b/gi, '')
    // Single-word suffixes
    .replace(/\b(inc|ltd|llc|corp|co|group|holdings|technologies|technology|solutions|services|global|berhad|bhd|sdn|pte|pty|plc|gmbh|ag|bv|nv|sa)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '');

  if (!cleaned) return [];
  // Try .com first, then .com.my (Malaysian companies often use both)
  return [`${cleaned}.com`, `${cleaned}.com.my`];
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
      const resp = await axios.get(`${BASE}/email-finder`, {
        params: {
          domain: targetDomain,
          first_name: firstName,
          last_name: lastName,
        },
        headers: { 'X-Api-Key': apiKey },
        timeout: 10000,
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
    const resp = await axios.get(`${BASE}/domain-search`, {
      params: { domain: targetDomain, limit },
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000,
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
    const resp = await axios.get(`${BASE}/email-verifier`, {
      params: { email },
      headers: { 'X-Api-Key': apiKey },
      timeout: 10000,
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
