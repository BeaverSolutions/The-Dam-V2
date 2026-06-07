'use strict';

/**
 * spendGuard - hard brakes for metered provider calls.
 *
 * Metered providers must pass through this file before any HTTP call that can
 * consume tokens, credits, searches, or verification quota. Fail closed: if the
 * guard cannot prove a call is attributed and under cap, the call is blocked.
 */

const pool = require('../db/pool');

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Defaults stay conservative. Brave gets a small bounded default so manual
// Captain sourcing can work when BRAVE_API_KEY is present but the cap knob is
// missing; higher-volume enrichment/search providers remain opt-in.
const CAPS = {
  vp: envNumber('VP_DAILY_CREDIT_CAP', 60),
  brave: envNumber('BRAVE_DAILY_QUERY_CAP', 70),
  google_cse: envNumber('GOOGLE_CSE_DAILY_QUERY_CAP', 0),
  lusha: envNumber('LUSHA_DAILY_QUERY_CAP', 0),
  snov: envNumber('SNOV_DAILY_QUERY_CAP', 0),
  hunter: envNumber('HUNTER_DAILY_QUERY_CAP', 0),
  millionverifier: envNumber('MILLIONVERIFIER_DAILY_VERIFY_CAP', envNumber('MILLION_VERIFIER_DAILY_CAP', 0)),
  apollo: envNumber('APOLLO_DAILY_QUERY_CAP', 0),
};

const VP_CREDITS_PER_LEAD = envNumber('VP_CREDITS_PER_LEAD', 5);
const klDateExpr = `(NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`;

function allowUnattributedMeteredCalls() {
  return process.env.ALLOW_UNATTRIBUTED_METERED_API === 'true' || process.env.NODE_ENV === 'test';
}

function providerCap(provider) {
  return CAPS[provider] ?? 0;
}

async function logProviderBlocked(provider, { clientId, reason, estimatedUnits = 1, spentToday = 0, cap = 0, remaining = 0 } = {}) {
  if (!clientId || !provider) return;
  try {
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata)
       VALUES ($1, 'system', 'provider_blocked', 'provider', $2)`,
      [clientId, JSON.stringify({ provider, reason, estimatedUnits, spentToday, cap, remaining })]
    );
  } catch (err) {
    console.warn(`[spendGuard] ${provider} block log failed:`, err.message);
  }
}

async function vpSpentToday(clientId = null) {
  try {
    const params = [];
    let clientPredicate = '';
    if (clientId) {
      params.push(clientId);
      clientPredicate = `AND client_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `WITH provider_ledger AS (
         SELECT COALESCE(SUM(COALESCE(NULLIF(metadata->>'units','')::int, 0)), 0)::int AS spent
           FROM logs
          WHERE action = 'provider_usage'
            AND metadata->>'provider' = 'vp'
            ${clientPredicate}
            AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = ${klDateExpr}
       ),
       legacy_ledger AS (
         SELECT COALESCE(SUM(NULLIF(metadata->>'credits_spent','')::int), 0)::int AS spent
           FROM logs
          WHERE action = 'vp_sourcing_complete'
            ${clientPredicate}
            AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = ${klDateExpr}
       )
       SELECT CASE
                WHEN provider_ledger.spent > 0 THEN provider_ledger.spent
                ELSE legacy_ledger.spent
              END AS spent
         FROM provider_ledger, legacy_ledger`,
      params
    );
    return parseInt(rows[0]?.spent || 0, 10);
  } catch (err) {
    console.warn('[spendGuard] vpSpentToday query failed - failing CLOSED:', err.message);
    return CAPS.vp;
  }
}

async function providerUsageToday(provider, clientId = null) {
  const cap = providerCap(provider);
  try {
    const params = [provider];
    let clientPredicate = '';
    if (clientId) {
      params.push(clientId);
      clientPredicate = `AND client_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(NULLIF(metadata->>'units','')::int, 1)), 0) AS spent
         FROM logs
        WHERE action = 'provider_usage'
          AND metadata->>'provider' = $1
          ${clientPredicate}
          AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = ${klDateExpr}`,
      params
    );
    return parseInt(rows[0]?.spent || 0, 10);
  } catch (err) {
    console.warn(`[spendGuard] ${provider} usage query failed - failing CLOSED:`, err.message);
    return cap;
  }
}

async function checkVP(estimatedCredits = 0, { clientId = null } = {}) {
  const cap = CAPS.vp;
  const spentToday = await vpSpentToday(clientId);
  const remaining = Math.max(0, cap - spentToday);
  const affordableLeads = Math.floor(remaining / VP_CREDITS_PER_LEAD);
  const allowed = spentToday + estimatedCredits <= cap;

  if (!allowed) {
    console.warn(
      `[spendGuard] VP BLOCKED - today's spend ${spentToday} + requested ${estimatedCredits} ` +
      `exceeds cap ${cap}. Enrichment skipped.`
    );
  } else if (remaining < cap * 0.2) {
    console.warn(`[spendGuard] VP WARN - only ${remaining}/${cap} credits left under today's cap.`);
  }
  return { allowed, spentToday, cap, remaining, affordableLeads };
}

async function checkProvider(provider, { clientId = null, estimatedUnits = 1 } = {}) {
  if (!provider) {
    return { allowed: false, reason: 'missing_provider', spentToday: 0, cap: 0, remaining: 0 };
  }
  if (!clientId && !allowUnattributedMeteredCalls()) {
    console.warn(`[spendGuard] ${provider} BLOCKED - missing clientId`);
    return { allowed: false, reason: 'missing_client_id', spentToday: 0, cap: providerCap(provider), remaining: 0 };
  }

  if (provider === 'vp') {
    const vp = await checkVP(estimatedUnits, { clientId });
    if (!vp.allowed) {
      await logProviderBlocked(provider, {
        clientId,
        reason: 'daily_cap_reached',
        estimatedUnits,
        spentToday: vp.spentToday,
        cap: vp.cap,
        remaining: vp.remaining,
      });
    }
    return { ...vp, reason: vp.allowed ? null : 'daily_cap_reached' };
  }

  const cap = providerCap(provider);
  if (cap <= 0) {
    console.warn(`[spendGuard] ${provider} BLOCKED - cap is ${cap}. Set provider cap env to allow usage.`);
    await logProviderBlocked(provider, { clientId, reason: 'provider_cap_zero', estimatedUnits, cap, remaining: 0 });
    return { allowed: false, reason: 'provider_cap_zero', spentToday: 0, cap, remaining: 0 };
  }

  const spentToday = await providerUsageToday(provider, clientId);
  const remaining = Math.max(0, cap - spentToday);
  const allowed = spentToday + estimatedUnits <= cap;
  if (!allowed) {
    console.warn(`[spendGuard] ${provider} BLOCKED - spent ${spentToday} + requested ${estimatedUnits} exceeds cap ${cap}`);
    await logProviderBlocked(provider, { clientId, reason: 'daily_cap_reached', estimatedUnits, spentToday, cap, remaining });
  }
  return { allowed, reason: allowed ? null : 'daily_cap_reached', spentToday, cap, remaining };
}

async function logProviderUsage(provider, { clientId, units = 1, metadata = {} } = {}) {
  if (!clientId || !provider) return;
  try {
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata)
       VALUES ($1, 'system', 'provider_usage', 'provider', $2)`,
      [clientId, JSON.stringify({ provider, units, ...metadata })]
    );
  } catch (err) {
    console.warn(`[spendGuard] ${provider} usage log failed:`, err.message);
  }
}

module.exports = {
  checkVP,
  vpSpentToday,
  checkProvider,
  logProviderUsage,
  logProviderBlocked,
  providerUsageToday,
  CAPS,
  VP_CREDITS_PER_LEAD,
};
