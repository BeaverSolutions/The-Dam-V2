'use strict';

/**
 * Tenant-scoped LLM BYOK config (OpenAI / Anthropic per-tenant keys).
 *
 * Why this exists (2026-06-10): LLM keys were global env only, so every
 * external tenant's agent calls billed the platform's provider account —
 * MJ sponsoring every trial. Mirrors the Brave BYOK pattern (brave.js):
 *
 *   1. Tenant `llm_config` secret wins: { provider: 'openai'|'anthropic', key }.
 *   2. Beaver Solutions is the ONLY client allowed to fall back to env keys.
 *   3. External tenant without a key = hard LLM_TENANT_KEY_MISSING block.
 *      Never a silent fallback to the platform key.
 */

// Injectable for tests (repo pattern: agents._test). Production always uses
// the real encrypted agent_memory store.
const defaultSecretsStore = require('./secrets');
let secrets = defaultSecretsStore;

const BEAVER_SOLUTIONS_CLIENT_ID = process.env.BEAVER_SOLUTIONS_CLIENT_ID || 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';
const PROVIDERS = ['openai', 'anthropic'];

function isBeaverClient(clientId) {
  return !!clientId && String(clientId) === BEAVER_SOLUTIONS_CLIENT_ID;
}

function envProvider() {
  const explicit = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (PROVIDERS.includes(explicit)) return explicit;
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'anthropic';
}

function envKeyFor(provider) {
  return provider === 'openai'
    ? (process.env.OPENAI_API_KEY || null)
    : (process.env.ANTHROPIC_API_KEY || null);
}

/**
 * Resolve the platform env-based config. Exported for the adapters'
 * test-mode (ALLOW_UNATTRIBUTED_LLM) path, which has no clientId.
 */
function platformEnvConfig() {
  const provider = envProvider();
  const key = envKeyFor(provider);
  if (!key) return null;
  return { provider, key, tenant_key: false };
}

async function getTenantConfig(clientId) {
  if (!clientId) return null;
  const data = await secrets.getClientSecret(clientId, 'system', 'llm_config');
  if (!data || !PROVIDERS.includes(data.provider) || !data.key) return null;
  return { provider: data.provider, key: data.key, tenant_key: true };
}

async function getConfig(clientId) {
  if (!clientId) return null;

  const tenantConfig = await getTenantConfig(clientId);
  if (tenantConfig) return tenantConfig;

  if (isBeaverClient(clientId)) {
    return platformEnvConfig();
  }

  return null;
}

async function requireConfig(clientId) {
  const config = await getConfig(clientId);
  if (!config) {
    const err = new Error(`LLM call blocked for client ${clientId}: no tenant LLM key configured and platform fallback is Beaver-only`);
    err.code = 'LLM_TENANT_KEY_MISSING';
    err.status = 400;
    throw err;
  }
  return config;
}

async function isConfigured(clientId) {
  return !!(await getConfig(clientId));
}

async function getStatus(clientId) {
  const tenantConfig = await getTenantConfig(clientId);
  const fallback = !tenantConfig && isBeaverClient(clientId) ? platformEnvConfig() : null;
  const active = tenantConfig || fallback;

  return {
    connected: !!active,
    tenant_key: !!tenantConfig,
    platform_fallback: !!fallback,
    provider: active ? active.provider : null,
    label: tenantConfig
      ? `Connected (${tenantConfig.provider})`
      : fallback
        ? `Connected (Beaver platform ${fallback.provider} key)`
        : 'Not configured',
  };
}

async function setConfig(clientId, provider, key) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!PROVIDERS.includes(normalizedProvider)) {
    const err = new Error(`Invalid LLM provider: ${provider}. Must be one of: ${PROVIDERS.join(', ')}`);
    err.code = 'LLM_PROVIDER_INVALID';
    err.status = 400;
    throw err;
  }
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    const err = new Error('LLM API key must be a non-empty string');
    err.code = 'LLM_KEY_INVALID';
    err.status = 400;
    throw err;
  }
  await secrets.setClientSecret(clientId, 'system', 'llm_config', { provider: normalizedProvider, key: normalizedKey });
}

async function deleteConfig(clientId) {
  await secrets.deleteClientSecret(clientId, 'system', 'llm_config');
}

module.exports = {
  BEAVER_SOLUTIONS_CLIENT_ID,
  PROVIDERS,
  deleteConfig,
  getConfig,
  getStatus,
  isBeaverClient,
  isConfigured,
  platformEnvConfig,
  requireConfig,
  setConfig,
  _test: {
    setSecretsStore(store) { secrets = store; },
    resetSecretsStore() { secrets = defaultSecretsStore; },
  },
};
