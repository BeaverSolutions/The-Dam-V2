'use strict';

const secrets = require('./secrets');
const spendGuard = require('./spendGuard');

let axios;
try {
  axios = require('axios');
} catch {
  console.warn('[apollo] axios not installed — Apollo calls will fail');
}

const APOLLO_BASE = 'https://api.apollo.io/v1';

async function getApiKey(clientId) {
  const data = await secrets.getClientSecret(clientId, 'system', 'apollo_api_key');
  // Fall back to system-level key (shared across all clients, stored in Railway env)
  return data?.key || process.env.APOLLO_API_KEY || null;
}

/**
 * Search for people matching a query using Apollo People Search.
 * Returns array of normalized lead objects.
 */
async function searchPeople(clientId, { query, limit = 5 }) {
  if (!axios) throw new Error('axios not installed');

  const apiKey = await getApiKey(clientId);
  if (!apiKey) return null; // caller should fall back to Claude

  const guard = await spendGuard.checkProvider('apollo', { clientId, estimatedUnits: 1 });
  if (!guard.allowed) {
    console.warn(`[apollo] BLOCKED by spendGuard: ${guard.reason}`);
    return null;
  }

  // Parse query into title + keywords
  const titleMatch = query.match(/\b(ceo|cto|coo|cfo|vp|director|manager|founder|head|lead|engineer|developer|sales|marketing)\b/i);
  const title = titleMatch ? titleMatch[0] : undefined;

  const payload = {
    q_keywords: query,
    page: 1,
    per_page: limit,
  };
  if (title) payload.person_titles = [title];

  try {
    const resp = await axios.post(`${APOLLO_BASE}/mixed_people/search`, payload, {
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      timeout: 15000,
    });

    const people = resp.data?.people || [];
    await spendGuard.logProviderUsage('apollo', {
      clientId,
      units: 1,
      metadata: { operation: 'people_search', limit },
    });

    return people.map(p => ({
      name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown',
      email: p.email || '',
      company: p.organization?.name || p.employment_history?.[0]?.organization_name || '',
      title: p.title || '',
      linkedin_url: p.linkedin_url || '',
      location: [p.city, p.state, p.country].filter(Boolean).join(', '),
      score: 50,
      metadata: {
        apollo_person_id: p.id,
        apollo_org_id: p.organization_id,
        phone: p.phone_numbers?.[0]?.sanitized_number || '',
        industry: p.organization?.industry || '',
        employees: p.organization?.estimated_num_employees,
        source: 'apollo',
      },
    }));
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) {
      console.warn('[apollo] Invalid API key');
      return null;
    }
    console.error('[apollo] Search failed:', err.message);
    return null;
  }
}

/**
 * Test if the stored API key works.
 */
async function testConnection(clientId) {
  if (!axios) return false;
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return false;
  const guard = await spendGuard.checkProvider('apollo', { clientId, estimatedUnits: 1 });
  if (!guard.allowed) {
    console.warn(`[apollo] testConnection BLOCKED by spendGuard: ${guard.reason}`);
    return false;
  }
  try {
    const resp = await axios.post(`${APOLLO_BASE}/mixed_people/search`, {
      q_keywords: 'test',
      per_page: 1,
    }, { headers: { 'X-Api-Key': apiKey }, timeout: 10000 });
    if (resp.status === 200) {
      await spendGuard.logProviderUsage('apollo', {
        clientId,
        units: 1,
        metadata: { operation: 'test_connection' },
      });
    }
    return resp.status === 200;
  } catch {
    return false;
  }
}

module.exports = { searchPeople, testConnection, getApiKey };
