'use strict';

const secrets = require('./secrets');

const BEAVER_SOLUTIONS_CLIENT_ID = process.env.BEAVER_SOLUTIONS_CLIENT_ID || 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';

function isBeaverClient(clientId) {
  return !!clientId && String(clientId) === BEAVER_SOLUTIONS_CLIENT_ID;
}

async function getClientKey(clientId) {
  if (!clientId) return null;
  const data = await secrets.getClientSecret(clientId, 'system', 'brave_api_key');
  return data?.key || null;
}

async function getApiKey(clientId) {
  const clientKey = await getClientKey(clientId);
  if (clientKey) return clientKey;

  if (isBeaverClient(clientId)) {
    return process.env.BRAVE_API_KEY || null;
  }

  return null;
}

async function hasClientApiKey(clientId) {
  return !!(await getClientKey(clientId));
}

async function isConfigured(clientId) {
  return !!(await getApiKey(clientId));
}

async function getStatus(clientId) {
  const hasTenantKey = await hasClientApiKey(clientId);
  const platformFallback = !hasTenantKey && isBeaverClient(clientId) && !!process.env.BRAVE_API_KEY;

  return {
    connected: hasTenantKey || platformFallback,
    tenant_key: hasTenantKey,
    platform_fallback: platformFallback,
    label: hasTenantKey
      ? 'Connected'
      : platformFallback
        ? 'Connected (Beaver platform key)'
        : 'Not configured',
  };
}

async function setApiKey(clientId, apiKey) {
  await secrets.setClientSecret(clientId, 'system', 'brave_api_key', { key: apiKey });
}

async function deleteApiKey(clientId) {
  await secrets.deleteClientSecret(clientId, 'system', 'brave_api_key');
}

module.exports = {
  BEAVER_SOLUTIONS_CLIENT_ID,
  deleteApiKey,
  getApiKey,
  getStatus,
  hasClientApiKey,
  isBeaverClient,
  isConfigured,
  setApiKey,
};
