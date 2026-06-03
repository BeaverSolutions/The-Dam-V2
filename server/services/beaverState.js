'use strict';

/**
 * Beaver State Service — shared interface for cross-team coordination.
 *
 * All beavers (Research, Sales, Enforcer) use this to:
 *   - Read Captain's morning brief (what's today's focus + voice notes)
 *   - Report their own daily KPIs back to Captain at EOD
 *   - Record learning entries (what worked, what didn't)
 *   - Read other beavers' recent reports (pattern visibility)
 *
 * Storage: agent_memory table, scoped by client_id + agent.
 *
 * This is the wiring layer — Phase 1 of the agentic infrastructure.
 * Behavior is bare-minimum: read/write/append. Closed-loop intelligence
 * (auto-tuning weights from outcomes, weekly teaching notes, market
 * sensing) layers on top in subsequent phases.
 */

const pool = require('../db/pool');
const { todayInMalaysia } = require('../utils/businessDay');

const TODAY = () => todayInMalaysia();

/* ─── Captain's morning brief ─────────────────────────────────────── */

/**
 * Read Captain's morning brief for today. Returns null if no brief
 * was generated yet (e.g. before 09:00 MYT or Captain's cron failed).
 *
 * Beavers should call this at the start of their daily loop and
 * incorporate the directives into their own decisions.
 */
async function readCaptainBrief(clientId) {
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'captain_orchestrator' AND key = $2
     LIMIT 1`,
    [clientId, `morning_brief_${TODAY()}`]
  );
  return rows[0]?.content || null;
}

/**
 * Read the most recent N briefs across the last 7 days. Used by
 * Captain himself when composing today's brief — he sees yesterday's
 * actions taken, decisions queued, etc.
 */
async function readRecentBriefs(clientId, limit = 7) {
  const { rows } = await pool.query(
    `SELECT key, content, updated_at FROM agent_memory
     WHERE client_id = $1 AND agent = 'captain_orchestrator' AND key LIKE 'morning_brief_%'
     ORDER BY updated_at DESC
     LIMIT $2`,
    [clientId, limit]
  );
  return rows.map(r => ({ date: r.key.replace('morning_brief_', ''), brief: r.content, updated_at: r.updated_at }));
}

/* ─── Per-beaver daily KPI reports ────────────────────────────────── */

/**
 * Each beaver writes its own daily KPI snapshot at EOD. Captain reads
 * these the next morning when composing the brief.
 *
 * Shape of `kpis` is beaver-specific. The schema is loose on purpose —
 * each beaver knows its own metrics.
 *
 * @param {string} clientId
 * @param {'research_beaver'|'sales_beaver'|'ranger'} agent
 * @param {object} kpis — beaver-specific metrics
 */
async function reportDailyKPIs(clientId, agent, kpis) {
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, $2, $3, $4::jsonb, 'kpi')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, agent, `daily_kpi_${TODAY()}`, JSON.stringify({ ...kpis, _ts: new Date().toISOString() })]
  );
}

/**
 * Read a beaver's KPI snapshot for a specific date (default today).
 * Used by Captain's KPI collector + EOD brief.
 */
async function readDailyKPIs(clientId, agent, date = TODAY()) {
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = $2 AND key = $3
     LIMIT 1`,
    [clientId, agent, `daily_kpi_${date}`]
  );
  return rows[0]?.content || null;
}

/**
 * Read all beaver daily KPIs for today in one call. Used by Captain's
 * EOD brief generator.
 */
async function readAllBeaversKPIsForToday(clientId) {
  const date = TODAY();
  const [research, sales, ranger] = await Promise.all([
    readDailyKPIs(clientId, 'research_beaver', date),
    readDailyKPIs(clientId, 'sales_beaver', date),
    readDailyKPIs(clientId, 'ranger', date),
  ]);
  return { research_beaver: research, sales_beaver: sales, ranger };
}

/* ─── Learning entries (per-beaver, append-only) ──────────────────── */

/**
 * Each beaver appends learning observations as it works. These are
 * raw observations — the closed-loop intelligence layer (Phase D)
 * mines these to auto-tune weights weekly.
 *
 * Stored as a list under key 'learning_<YYYY-MM-DD>'. Append-only
 * within a day; rotates daily.
 */
async function appendLearning(clientId, agent, observation) {
  const key = `learning_${TODAY()}`;
  // Use Postgres jsonb concat to atomically append
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, $2, $3, $4::jsonb, 'learning')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = agent_memory.content || EXCLUDED.content,
           updated_at = NOW()`,
    [
      clientId, agent, key,
      JSON.stringify([{ ...observation, _ts: new Date().toISOString() }]),
    ]
  );
}

/**
 * Read a beaver's recent learning entries (last N days, flattened).
 */
async function readRecentLearning(clientId, agent, days = 7) {
  const { rows } = await pool.query(
    `SELECT key, content FROM agent_memory
     WHERE client_id = $1 AND agent = $2 AND key LIKE 'learning_%'
       AND updated_at > NOW() - ($3 || ' days')::interval
     ORDER BY updated_at DESC`,
    [clientId, agent, days]
  );
  const flat = [];
  for (const row of rows) {
    if (Array.isArray(row.content)) flat.push(...row.content);
  }
  return flat;
}

/* ─── Captain's actions taken (audit trail) ───────────────────────── */

/**
 * When Captain fires a tactical decision (fireCoachingLoop,
 * switchResearchStrategy, throttleSend, tuneVpThreshold), the action
 * is logged here so tomorrow's brief can surface "actions taken
 * overnight" without needing to recompute.
 */
async function logCaptainAction(clientId, action, details = {}) {
  await pool.query(
    `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
     VALUES ($1, 'captain_orchestrator', $2, 'tenant', $1, $3::jsonb)`,
    [clientId, `captain_action_${action}`, JSON.stringify(details)]
  );
}

/**
 * Read Captain's actions in the last 24h for the brief.
 */
async function readRecentCaptainActions(clientId, hours = 24) {
  const { rows } = await pool.query(
    `SELECT action, metadata, created_at FROM logs
     WHERE client_id = $1 AND agent = 'captain_orchestrator'
       AND action LIKE 'captain_action_%'
       AND created_at > NOW() - ($2 || ' hours')::interval
     ORDER BY created_at DESC`,
    [clientId, hours]
  );
  return rows.map(r => ({
    action: r.action.replace('captain_action_', ''),
    details: r.metadata,
    at: r.created_at,
  }));
}

/* ─── Sales Beaver improvement-after-feedback tracker ─────────────── */

/**
 * When Enforcer rejects a draft, Sales Beaver retries. Did the retry
 * fix the flagged issue? This tracker records the answer for the
 * Sales-improvement-rate KPI.
 */
async function recordImprovementAfterFeedback(clientId, { lead_id, original_message_id, retry_message_id, original_reject_reason, retry_passed }) {
  await pool.query(
    `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
     VALUES ($1, 'ranger', 'sales_improvement_check', 'message', $2, $3::jsonb)`,
    [clientId, retry_message_id, JSON.stringify({ lead_id, original_message_id, original_reject_reason, retry_passed })]
  );
}

/**
 * Compute Sales Beaver's improvement-after-feedback rate over last N days.
 * Used by Enforcer's KPI report + Captain's brief.
 */
async function computeImprovementRate(clientId, days = 7) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE (metadata->>'retry_passed')::boolean = true) AS passed
     FROM logs
     WHERE client_id = $1
       AND agent = 'ranger'
       AND action = 'sales_improvement_check'
       AND created_at > NOW() - ($2 || ' days')::interval`,
    [clientId, days]
  );
  const total = Number(rows[0]?.total || 0);
  const passed = Number(rows[0]?.passed || 0);
  return {
    total,
    passed,
    rate_pct: total > 0 ? Math.round((passed / total) * 100) : null,
  };
}

module.exports = {
  // Captain brief
  readCaptainBrief,
  readRecentBriefs,
  // Daily KPI reports
  reportDailyKPIs,
  readDailyKPIs,
  readAllBeaversKPIsForToday,
  // Learning entries
  appendLearning,
  readRecentLearning,
  // Captain actions audit
  logCaptainAction,
  readRecentCaptainActions,
  // Improvement tracking
  recordImprovementAfterFeedback,
  computeImprovementRate,
};
