'use strict';

const { AsyncLocalStorage } = require('async_hooks');

// Request-scoped store carrying { clientId } so deep-stack callers
// (services/claude.js callAgent) can attribute work to the right tenant
// without threading clientId through 14+ call sites.
const store = new AsyncLocalStorage();

/**
 * Express middleware. Must be mounted AFTER `tenantScope` so `req.clientId`
 * is populated. All downstream handler code runs inside an ALS context;
 * async descendants (promises, setTimeout, awaits) inherit it automatically.
 */
function clientContext(req, res, next) {
  const clientId = req.clientId || null;
  store.run({ clientId }, () => next());
}

/**
 * Returns the clientId for the currently-executing async stack, or null
 * if we're outside a tenant context (startup task, cron, seed script).
 */
function getCurrentClientId() {
  return store.getStore()?.clientId || null;
}

/**
 * Run an arbitrary async function inside an explicit client context.
 * Used by background/autonomous tasks that don't originate from a request
 * (autonomous kickoff, reply detector, follow-up cron, Telegram webhook).
 */
function runWithClientContext(clientId, fn) {
  return store.run({ clientId: clientId || null }, fn);
}

module.exports = { clientContext, getCurrentClientId, runWithClientContext };
