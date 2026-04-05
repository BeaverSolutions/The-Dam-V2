'use strict';

const { pool } = require('../db/pool');
const logger = require('../utils/logger');

// ─── Model pricing (USD per million tokens) ────────────────────
// Overridable via env vars so Anthropic price changes don't need a redeploy.
// Input/output prices match Anthropic list pricing as of 2026-04-05.
// cache_write is typically 1.25× input; cache_read is typically 0.1× input.
//
// If you add a new model, add an entry here OR set the corresponding env vars.
// Unknown models return cost=0 (fail-open for observability, NOT for billing).
const PRICING = {
  'claude-sonnet-4-20250514': {
    input:       Number(process.env.SONNET_INPUT_PER_M)       || 3.00,
    output:      Number(process.env.SONNET_OUTPUT_PER_M)      || 15.00,
    cache_write: Number(process.env.SONNET_CACHE_WRITE_PER_M) || 3.75,
    cache_read:  Number(process.env.SONNET_CACHE_READ_PER_M)  || 0.30,
  },
  'claude-haiku-4-5': {
    input:       Number(process.env.HAIKU_INPUT_PER_M)        || 0.80,
    output:      Number(process.env.HAIKU_OUTPUT_PER_M)       || 4.00,
    cache_write: Number(process.env.HAIKU_CACHE_WRITE_PER_M)  || 1.00,
    cache_read:  Number(process.env.HAIKU_CACHE_READ_PER_M)   || 0.08,
  },
};

/**
 * Calculate the USD cost of a single Claude call from its usage block.
 * Returns 0 for unknown models (so we don't crash the pipeline on a rename).
 */
function costForUsage(model, usage = {}) {
  const p = PRICING[model];
  if (!p) return 0;
  const cost = (
    (usage.input_tokens || 0)                * p.input +
    (usage.output_tokens || 0)               * p.output +
    (usage.cache_creation_input_tokens || 0) * p.cache_write +
    (usage.cache_read_input_tokens || 0)     * p.cache_read
  ) / 1_000_000;
  // Clamp to 6 decimal places (matches NUMERIC(12,6) in schema)
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Today's spend for a client in USD. Day boundary is UTC midnight to match
 * `created_at::date` indexing. Returns 0 if client has no usage yet.
 */
async function getTodaySpend(clientId) {
  if (!clientId) return 0;
  const res = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS spend
       FROM llm_usage
      WHERE client_id = $1
        AND created_at::date = (NOW() AT TIME ZONE 'UTC')::date`,
    [clientId]
  );
  return res.rows[0]?.spend || 0;
}

/**
 * Client's daily budget in USD. Defaults to $10 if the client row is missing
 * (shouldn't happen, but don't crash the pipeline on a race).
 */
async function getClientBudget(clientId) {
  if (!clientId) return Number.POSITIVE_INFINITY;
  const res = await pool.query(
    `SELECT daily_budget_usd::float AS budget FROM clients WHERE id = $1`,
    [clientId]
  );
  return res.rows[0]?.budget ?? 10;
}

/**
 * Check if a client can make another Claude call today.
 * Returns { allowed, spend, budget, remaining, pct }.
 *
 * Absence of clientId is a no-op that returns allowed=true — used for
 * internal / cron / test calls where attribution doesn't apply.
 */
async function checkBudget(clientId) {
  if (!clientId) {
    return { allowed: true, spend: 0, budget: Number.POSITIVE_INFINITY, remaining: Number.POSITIVE_INFINITY, pct: 0 };
  }
  const [spend, budget] = await Promise.all([
    getTodaySpend(clientId),
    getClientBudget(clientId),
  ]);
  const remaining = Math.max(0, budget - spend);
  const pct = budget > 0 ? (spend / budget) : 0;
  return { allowed: spend < budget, spend, budget, remaining, pct };
}

/**
 * Persist a single call's usage. Fire-and-forget; logging failures never
 * break the caller.
 */
async function logUsage({ clientId, agent, model, usage = {}, elapsedMs = null }) {
  if (!clientId) return; // No attribution = no row. Telemetry still goes to stdout via claude.js.
  const cost = costForUsage(model, usage);
  try {
    await pool.query(
      `INSERT INTO llm_usage
         (client_id, agent, model, input_tokens, output_tokens,
          cache_write_tokens, cache_read_tokens, cost_usd, elapsed_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        clientId,
        agent,
        model,
        usage.input_tokens || 0,
        usage.output_tokens || 0,
        usage.cache_creation_input_tokens || 0,
        usage.cache_read_input_tokens || 0,
        cost,
        elapsedMs,
      ]
    );
  } catch (err) {
    logger.warn({ msg: 'budget.logUsage failed', err: err.message, clientId, agent, model });
  }
  return cost;
}

/**
 * In-process dedupe set so we don't spam Telegram on every blocked call.
 * Keyed by `${clientId}:${yyyy-mm-dd}`. Reset implicitly on process restart,
 * which is fine — a restart is itself a signal worth re-sending on.
 */
const alertedToday = new Set();

function todayKey(clientId) {
  const d = new Date();
  return `${clientId}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Fire a one-per-day Telegram alert when a client hits their budget cap.
 * Never throws — logging and messaging failures are swallowed.
 */
async function notifyBudgetExceeded({ clientId, spend, budget }) {
  const key = todayKey(clientId);
  if (alertedToday.has(key)) return;
  alertedToday.add(key);

  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return;

    // Resolve client slug for a human-readable alert.
    const { rows } = await pool.query(
      `SELECT slug, name FROM clients WHERE id = $1 LIMIT 1`,
      [clientId]
    );
    const slug = rows[0]?.slug || clientId;
    const name = rows[0]?.name || slug;

    const { sendMessage } = require('./telegram');
    await sendMessage(
      chatId,
      `🛑 <b>Budget cap hit — ${name}</b>\n\n` +
      `Spent: <b>$${spend.toFixed(4)}</b> / $${budget.toFixed(2)} USD today.\n` +
      `All Claude calls for <code>${slug}</code> are blocked until UTC midnight.\n\n` +
      `To unblock now: <code>UPDATE clients SET daily_budget_usd = ${(budget * 2).toFixed(2)} WHERE slug = '${slug}'</code>`
    );
  } catch (err) {
    logger.warn({ msg: 'budget.notifyBudgetExceeded failed', err: err.message, clientId });
  }
}

/**
 * Error subclass so callers can distinguish budget rejection from other
 * Claude failures and surface it clearly to the UI / Telegram.
 */
class BudgetExceededError extends Error {
  constructor({ clientId, spend, budget }) {
    super(`Daily Claude budget reached: $${spend.toFixed(4)} / $${budget.toFixed(2)} USD. New calls blocked until UTC midnight. Raise daily_budget_usd on the clients row to unblock.`);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.status = 429;
    this.clientId = clientId;
    this.spend = spend;
    this.budget = budget;
  }
}

module.exports = {
  checkBudget,
  logUsage,
  costForUsage,
  getTodaySpend,
  getClientBudget,
  notifyBudgetExceeded,
  BudgetExceededError,
  PRICING,
};
