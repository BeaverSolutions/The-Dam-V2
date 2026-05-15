'use strict';

const secrets = require('./secrets');

const MCP_URL = 'https://mcp.explorium.ai/mcp';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TIMEOUT_MS = 20_000;

// Per-clientId session cache: { sessionId, lastUsedAt }
// Sessions are bound to the API key the server initialised them with, so we
// key by clientId. If a session expires server-side, we re-initialise on the
// next call and retry once.
const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

/* ─── API key resolution (per-tenant, with bootstrap env fallback) ─── */

async function getApiKey(clientId) {
  // Per-tenant via encrypted agent_memory secret (preferred — used post-onboarding)
  const stored = await secrets.getClientSecret(clientId, 'system', 'vibe_prospecting_api_key').catch(() => null);
  if (stored?.key) return stored.key;

  // Bootstrap fallback: a single shared env var. Used only until 6.3
  // onboarding ships per-tenant key capture. Allows the first tenant
  // (Beaver Solutions) to operate without a DB seed step.
  const envKey = process.env.VIBE_PROSPECTING_API_KEY;
  if (envKey) return envKey;

  return null;
}

/* ─── HTTP + SSE transport ─────────────────────────────────────────── */

async function rpc(apiKey, method, params, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now() + Math.floor(Math.random() * 1000),
    method,
    params: params || {},
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(MCP_URL, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  // SSE wrapper: extract JSON from `data:` line. Plain JSON also passes through.
  const sseMatch = text.match(/^data:\s*(.+)$/m);
  const jsonText = sseMatch ? sseMatch[1] : text;
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch { parsed = { __raw: text.slice(0, 500) }; }
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id') || null,
    body: parsed,
  };
}

/* ─── Session lifecycle ────────────────────────────────────────────── */

async function initSession(apiKey) {
  const init = await rpc(apiKey, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'beavrdam', version: '2.0.0' },
  });
  if (init.status !== 200 || init.body?.error) {
    throw new Error(`MCP initialize failed: ${init.status} ${JSON.stringify(init.body).slice(0, 200)}`);
  }
  // Send required initialized notification (fire and forget)
  await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'Mcp-Session-Id': init.sessionId || '',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => {});
  return init.sessionId;
}

async function getSession(clientId, apiKey) {
  const cached = sessions.get(clientId);
  if (cached && (Date.now() - cached.lastUsedAt) < SESSION_TTL_MS) {
    cached.lastUsedAt = Date.now();
    return cached.sessionId;
  }
  const sessionId = await initSession(apiKey);
  sessions.set(clientId, { sessionId, lastUsedAt: Date.now() });
  return sessionId;
}

function dropSession(clientId) {
  sessions.delete(clientId);
}

/* ─── Tool call wrapper with one-time session retry ─────────────────── */

async function callTool(clientId, toolName, args) {
  const apiKey = await getApiKey(clientId);
  if (!apiKey) {
    return { ok: false, error: 'no_api_key', credits: 0 };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionId = await getSession(clientId, apiKey);
    const result = await rpc(apiKey, 'tools/call', { name: toolName, arguments: args }, sessionId);

    // Session expired or invalid — drop + retry once
    if (result.status === 401 || result.status === 404 || result.body?.error?.code === -32600) {
      dropSession(clientId);
      if (attempt === 0) continue;
    }

    if (result.status !== 200 || result.body?.error) {
      return { ok: false, error: `mcp_error_${result.status}`, raw: result.body, credits: 0 };
    }

    const content = result.body?.result?.content?.[0];
    if (!content || content.type !== 'text') {
      return { ok: false, error: 'no_content', credits: 0 };
    }
    if (result.body?.result?.isError) {
      return { ok: false, error: 'tool_error', message: content.text?.slice(0, 300), credits: 0 };
    }

    let payload;
    try { payload = JSON.parse(content.text); }
    catch { return { ok: false, error: 'parse_error', raw: content.text?.slice(0, 300), credits: 0 }; }

    const credits = payload?.credit_usage?.total_credits ?? 0;
    return { ok: true, payload, credits };
  }
  return { ok: false, error: 'session_retry_exhausted', credits: 0 };
}

/* ─── Tool catalog probe ────────────────────────────────────────────── */

/** List every tool the Explorium MCP exposes, with input schemas. FREE. */
async function listTools(clientId) {
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessionId = await getSession(clientId, apiKey);
    const result = await rpc(apiKey, 'tools/list', {}, sessionId);
    if (result.status === 401 || result.status === 404) {
      dropSession(clientId);
      if (attempt === 0) continue;
    }
    if (result.status !== 200 || result.body?.error) {
      return { ok: false, error: `mcp_error_${result.status}`, raw: result.body };
    }
    const tools = (result.body?.result?.tools || []).map(t => ({
      name: t.name,
      description: (t.description || '').slice(0, 120),
      input_keys: Object.keys(t.inputSchema?.properties || {}),
    }));
    return { ok: true, tools };
  }
  return { ok: false, error: 'session_retry_exhausted' };
}

/* ─── Public API ────────────────────────────────────────────────────── */

/** Match a company (FREE) → returns business_id or null */
async function matchBusiness(clientId, { name, domain }) {
  if (!name && !domain) return null;
  const result = await callTool(clientId, 'match-business', {
    businesses_to_match: [{ name: name || null, domain: domain || null }],
    tool_reasoning: 'BeavrDam Research Beaver: enrich lead with verified email',
  });
  if (!result.ok) return null;
  return result.payload?.matched_businesses?.[0]?.business_id || null;
}

/** Match a prospect (FREE) → returns prospect_id or null */
async function matchProspect(clientId, { full_name, company_name, business_id, email, linkedin }) {
  const result = await callTool(clientId, 'match-prospects', {
    prospects_to_match: [{
      full_name: full_name || null,
      company_name: company_name || null,
      business_id: business_id || null,
      email: email || null,
      linkedin: linkedin || null,
    }],
    tool_reasoning: 'BeavrDam Research Beaver: enrich lead with verified email',
  });
  if (!result.ok) return null;
  return result.payload?.matched_prospects?.[0]?.prospect_id || null;
}

/** Enrich contact data (PAID — ~5 credits) → returns { email, email_verified, phone } or null */
async function enrichProspectContacts(clientId, prospect_id) {
  const result = await callTool(clientId, 'enrich-prospects', {
    prospect_ids: [prospect_id],
    enrichments: ['contacts'],
  });
  if (!result.ok) return { ok: false, error: result.error, credits: 0 };

  // Outer payload structure: { enrichment_results: { contacts: <stringified inner JSON> }, credit_usage_breakdown }
  const innerText = result.payload?.enrichment_results?.contacts;
  let inner;
  try { inner = typeof innerText === 'string' ? JSON.parse(innerText) : innerText; }
  catch { inner = null; }

  const data = inner?.data?.[0]?.data;
  const credits = result.payload?.credit_usage_breakdown
    ?.filter(c => c.operation_type === 'Contacts')
    ?.reduce((sum, c) => sum + (c.total_credits || 0), 0) ?? 0;

  if (!data) return { ok: true, email: null, credits };
  return {
    ok: true,
    email: data.professions_email || data.emails?.find(e => e.type === 'current_professional')?.address || null,
    email_verified: data.professional_email_status === 'valid',
    email_status: data.professional_email_status || null,
    all_emails: data.emails || [],
    phone: data.mobile_phone || data.phone_numbers?.[0]?.phone_number || null,
    credits,
  };
}

/** Enrich profile data (PAID) → returns { linkedin_url } or null. Used by 6.6 LinkedIn fallback. */
async function enrichProspectProfile(clientId, prospect_id) {
  const result = await callTool(clientId, 'enrich-prospects', {
    prospect_ids: [prospect_id],
    enrichments: ['profiles'],
  });
  if (!result.ok) return { ok: false, error: result.error, credits: 0 };
  const innerText = result.payload?.enrichment_results?.profiles;
  let inner;
  try { inner = typeof innerText === 'string' ? JSON.parse(innerText) : innerText; }
  catch { inner = null; }
  const data = inner?.data?.[0]?.data;
  const credits = result.payload?.credit_usage_breakdown
    ?.filter(c => c.operation_type === 'Profiles')
    ?.reduce((sum, c) => sum + (c.total_credits || 0), 0) ?? 0;
  return {
    ok: true,
    linkedin_url: data?.linkedin_url || data?.linkedin || null,
    credits,
    raw: data,
  };
}

/** Enrich business firmographics (PAID) → returns { company_size, industry, country } or null. ICP gate input. */
async function enrichBusinessFirmographics(clientId, business_id) {
  const result = await callTool(clientId, 'enrich-business', {
    business_ids: [business_id],
    enrichments: ['firmographics'],
  });
  if (!result.ok) return { ok: false, error: result.error, credits: 0 };
  const innerText = result.payload?.enrichment_results?.firmographics;
  let inner;
  try { inner = typeof innerText === 'string' ? JSON.parse(innerText) : innerText; }
  catch { inner = null; }
  const data = inner?.data?.[0]?.data;
  const credits = result.payload?.credit_usage_breakdown
    ?.filter(c => c.operation_type === 'Firmographics')
    ?.reduce((sum, c) => sum + (c.total_credits || 0), 0) ?? 0;
  return {
    ok: true,
    company_size: data?.number_of_employees_range || data?.number_of_employees || null,
    industry: data?.industry || null,
    country: data?.country || data?.country_code || null,
    raw: data,
    credits,
  };
}

/** End-to-end orchestrator: lead → verified email. Returns null if the chain fails at any stage. */
async function findVerifiedEmail(clientId, { firstName, lastName, fullName, company, domain }) {
  const name = fullName || [firstName, lastName].filter(Boolean).join(' ');
  if (!name || !company) return null;

  const business_id = await matchBusiness(clientId, { name: company, domain });
  if (!business_id) return { ok: false, error: 'no_business_match', credits: 0 };

  const prospect_id = await matchProspect(clientId, { full_name: name, company_name: company, business_id });
  if (!prospect_id) return { ok: false, error: 'no_prospect_match', business_id, credits: 0 };

  const contacts = await enrichProspectContacts(clientId, prospect_id);
  if (!contacts.ok) return { ok: false, error: contacts.error, business_id, prospect_id, credits: 0 };

  return {
    ok: true,
    business_id,
    prospect_id,
    email: contacts.email,
    email_verified: contacts.email_verified,
    email_status: contacts.email_status,
    phone: contacts.phone,
    credits: contacts.credits,
  };
}

/** Connectivity sanity check: cheap match-business call (FREE). */
async function testConnection(clientId) {
  const apiKey = await getApiKey(clientId);
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  try {
    const id = await matchBusiness(clientId, { name: 'Microsoft', domain: 'microsoft.com' });
    return { ok: !!id, business_id: id || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getApiKey,
  listTools,
  callTool,
  matchBusiness,
  matchProspect,
  enrichProspectContacts,
  enrichProspectProfile,
  enrichBusinessFirmographics,
  findVerifiedEmail,
  testConnection,
};
