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

function domainFromCompany(company) {
  if (!company) return null;
  return company
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|corp|co|group|holdings|technologies|technology|solutions|services|global)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '') + '.com';
}

/* ─── Find email by name + domain ────────────────────────── */

async function findEmail(clientId, { firstName, lastName, domain, company }) {
  if (!axios) return null;
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return null;

  const targetDomain = domain || domainFromCompany(company);
  if (!targetDomain) return null;

  try {
    const resp = await axios.get(`${BASE}/email-finder`, {
      params: {
        domain: targetDomain,
        first_name: firstName,
        last_name: lastName,
        api_key: apiKey,
      },
      timeout: 10000,
    });

    const data = resp.data?.data;
    if (!data?.email) return null;

    return {
      email: data.email,
      confidence: data.score || 0,
      verified: data.verification?.status === 'valid',
    };
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
    // 404 = no email found — not a real error
    if (status === 404) return null;
    console.warn('[hunter] findEmail error:', err.message);
    return null;
  }
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
      params: { domain: targetDomain, limit, api_key: apiKey },
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
      params: { email, api_key: apiKey },
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
      params: { api_key: apiKey },
      timeout: 8000,
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

module.exports = { getApiKey, findEmail, domainSearch, verifyEmail, testConnection };
