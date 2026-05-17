'use strict';

const pool = require('../db/pool');
const logger = require('../utils/logger');

// ─── Model pricing (USD per million tokens) ────────────────────
// Overridable via env vars so Anthropic price changes don't need a redeploy.
// Input/output prices match Anthropic list pricing as of 2026-04-05.
// cache_write is typically 1.25× input; cache_read is typically 0.1× input.
//
// If you add a new model, add an entry here OR set the corresponding env vars.
// Unknown models return cost=0 (fail-open for observability, NOT for billing).
// Pricing block. Model IDs may include version dates OR short aliases.
// List ALL known IDs so costForUsage never falls through to the $0.05 default.
const SONNET_PRICING = {
  input:       Number(process.env.SONNET_INPUT_PER_M)       || 3.00,
  output:      Number(process.env.SONNET_OUTPUT_PER_M)      || 15.00,
  cache_write: Number(process.env.SONNET_CACHE_WRITE_PER_M) || 3.75,
  cache_read:  Number(process.env.SONNET_CACHE_READ_PER_M)  || 0.30,
};
const HAIKU_PRICING = {
  input:       Number(process.env.HAIKU_INPUT_PER_M)        || 0.80,
  output:      Number(process.env.HAIKU_OUTPUT_PER_M)       || 4.00,
  cache_write: Number(process.env.HAIKU_CACHE_WRITE_PER_M)  || 1.00,
  cache_read:  Number(process.env.HAIKU_CACHE_READ_PER_M)   || 0.08,
};
const PRICING = {
  // Sonnet variants (all same pricing)
  'claude-sonnet-4-6':          SONNET_PRICING,
  'claude-sonnet-4-5-20250929': SONNET_PRICING,
  'claude-sonnet-4-20250514':   SONNET_PRICING,
  // Haiku variants (all same pricing)
  'claude-haiku-4-5-20251001':  HAIKU_PRICING,
  'claude-haiku-4-5':           HAIKU_PRICING,
};

// ─── Monthly LLM spend cap ──────────────────────────────────────
// MJ's budget is a MONTHLY figure. The per-client `daily_budget_usd` only
// caps a single day — 30 normal days still blow past a tight monthly target,
// and a runaway day (e.g. 2026-05-14: 2,202 research_beaver calls, $12.86)
// sits under a $20/day cap while torching a month's budget. This is the
// month-horizon ceiling, env-overridable. Default $60 reflects the realistic
// autonomous run rate (~$2-4/day); set LLM_MONTHLY_BUDGET_USD in Railway to
// tune. NOTE: a $20 value will halt the pipeline ~10 days into a month.
const LLM_MONTHLY_BUDGET_USD = Number(process.env.LLM_MONTHLY_BUDGET_USD) || 60;
function getMonthlyBudget() { return LLM_MONTHLY_BUDGET_USD; }

/**
 * Calculate the USD cost of a single Claude call from its usage block.
 * Returns 0 for unknown models (so we don't crash the pipeline on a rename).
 */
function costForUsage(model, usage = {}) {
  const p = PRICING[model];
  if (!p) {
    logger.error({ msg: 'Unknown model for billing — applying conservative default cost', model });
    return 0.05; // Conservative default per call to prevent silent budget bypass
  }
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
 * Today's spend for a client in USD. Day boundary is UTC midnight.
 * Range predicate on created_at lets Postgres use the
 * idx_llm_usage_client_date btree index via a range scan.
 */
async function getTodaySpend(clientId) {
  if (!clientId) return 0;
  const res = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS spend
       FROM llm_usage
      WHERE client_id = $1
        AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    [clientId]
  );
  return res.rows[0]?.spend || 0;
}

/**
 * Month-to-date spend for a client in USD. Month boundary is UTC midnight on
 * the 1st. Uses the same idx_llm_usage_client_date index as getTodaySpend.
 */
async function getMonthSpend(clientId) {
  if (!clientId) return 0;
  const res = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::float AS spend
       FROM llm_usage
      WHERE client_id = $1
        AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')`,
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
 * Check if a client can make another Claude call. Enforces BOTH caps:
 *   - daily   — clients.daily_budget_usd
 *   - monthly — LLM_MONTHLY_BUDGET_USD (the budget MJ actually set)
 *
 * Returns { allowed, spend, budget, remaining, pct, period, ... }. The
 * spend/budget/pct/period fields describe the BINDING window — the blocked
 * one, or whichever is closest to its cap — so a caller's error message and
 * Telegram alert name the right window and reset time. Per-window raw values
 * (daySpend/dayBudget/monthSpend/monthBudget) are also returned.
 *
 * Absence of clientId is a no-op that returns allowed=true — used for
 * internal / cron / test calls where attribution doesn't apply.
 */
async function checkBudget(clientId) {
  if (!clientId) {
    return {
      allowed: true, spend: 0, budget: Number.POSITIVE_INFINITY,
      remaining: Number.POSITIVE_INFINITY, pct: 0, period: 'day',
      daySpend: 0, dayBudget: Number.POSITIVE_INFINITY,
      monthSpend: 0, monthBudget: Number.POSITIVE_INFINITY,
    };
  }
  const [daySpend, dayBudget, monthSpend] = await Promise.all([
    getTodaySpend(clientId),
    getClientBudget(clientId),
    getMonthSpend(clientId),
  ]);
  const monthBudget = LLM_MONTHLY_BUDGET_USD;

  const dayOk = daySpend < dayBudget;
  const monthOk = monthSpend < monthBudget;
  const allowed = dayOk && monthOk;

  const dayPct = dayBudget > 0 ? daySpend / dayBudget : 0;
  const monthPct = monthBudget > 0 ? monthSpend / monthBudget : 0;

  // Binding window: the blocked one; if both or neither, whichever sits
  // closer to its cap. Month wins ties — it's the longer-horizon ceiling.
  let period;
  if (!dayOk && monthOk) period = 'day';
  else if (!monthOk && dayOk) period = 'month';
  else period = monthPct >= dayPct ? 'month' : 'day';

  const spend  = period === 'month' ? monthSpend  : daySpend;
  const budget = period === 'month' ? monthBudget : dayBudget;
  const pct    = period === 'month' ? monthPct    : dayPct;
  const remaining = Math.max(0, budget - spend);

  return {
    allowed, spend, budget, remaining, pct, period,
    daySpend, dayBudget, monthSpend, monthBudget,
  };
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

function todayKey(clientId, period = 'day') {
  const d = new Date();
  return `${clientId}:${period}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Fire a one-per-day Telegram alert when a client hits a budget cap. The
 * `period` ('day' | 'month') names which cap and its reset window. Deduped
 * once-per-day-per-period so the daily and monthly alerts can both fire.
 * Never throws — logging and messaging failures are swallowed.
 */
async function notifyBudgetExceeded({ clientId, spend, budget, period = 'day' }) {
  const key = todayKey(clientId, period);
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

    const window = period === 'month' ? 'Monthly' : 'Daily';
    const reset = period === 'month' ? 'the 1st of next month (UTC)' : 'UTC midnight';
    const knob = period === 'month'
      ? `<code>LLM_MONTHLY_BUDGET_USD</code> in Railway`
      : `<code>daily_budget_usd</code> for client <code>${name}</code> in Railway DB or admin panel`;

    const { sendMessage } = require('./telegram');
    await sendMessage(
      chatId,
      `🛑 <b>${window} budget cap hit — ${name}</b>\n\n` +
      `Spent: <b>$${spend.toFixed(4)}</b> / $${budget.toFixed(2)} USD.\n` +
      `All Claude calls for <code>${slug}</code> are blocked until ${reset}.\n\n` +
      `To unblock: raise ${knob}.`
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
  constructor({ clientId, spend, budget, period = 'day' }) {
    const window = period === 'month' ? 'monthly' : 'daily';
    const reset = period === 'month' ? 'the 1st of next month (UTC)' : 'UTC midnight';
    const knob = period === 'month'
      ? 'LLM_MONTHLY_BUDGET_USD env var'
      : 'daily_budget_usd on the clients row';
    super(`Claude ${window} budget reached: $${spend.toFixed(4)} / $${budget.toFixed(2)} USD. New calls blocked until ${reset}. Raise ${knob} to unblock.`);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.status = 429;
    this.clientId = clientId;
    this.spend = spend;
    this.budget = budget;
    this.period = period;
  }
}

module.exports = {
  checkBudget,
  logUsage,
  costForUsage,
  getTodaySpend,
  getMonthSpend,
  getClientBudget,
  getMonthlyBudget,
  notifyBudgetExceeded,
  BudgetExceededError,
  PRICING,
};
