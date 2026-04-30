'use strict';
// KPI counter recompute helper.
// Single source of truth for daily_kpi counter values — recomputes from the
// messages + leads tables on demand. Idempotent. Safe to call after every
// send, lead insert, or kickoff cycle.
//
// Why a recompute helper instead of incremental UPDATEs:
// - Multiple code paths produce sends (send_queue worker, manual approve route,
//   LinkedIn manual mark-sent, follow-up scheduler). Wiring an increment to
//   each one is fragile — miss one, counters drift.
// - Recompute is O(few rows per day per client), so cost is negligible.
// - Counters always match the underlying truth in messages + leads.
//
// Why a dedicated client (not pool.query): autonomous kickoff chains many
// queries; pool.query takes a fresh connection per call which can hit pool
// limits or race with concurrent transactions. Dedicated client + explicit
// release + instrumentation logs make the recount auditable in the logs table.

const pool = require('../db/pool');

async function recountKpi(clientId, date = null) {
  const today = date || new Date().toISOString().split('T')[0];

  // Instrumentation: log entry so we can verify the function is being hit
  // (separate connection so it works even if the main pool path is blocked)
  pool.query(
    `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
     VALUES ($1, 'system', 'kpi_recount_started', 'system', $2, NOW())`,
    [clientId, JSON.stringify({ today, source: 'kpi.js' })]
  ).catch(() => {});

  let client;
  let step = 'connect';
  try {
    client = await pool.connect();
    step = 'insert';
    await client.query(
      `INSERT INTO daily_kpi (client_id, date) VALUES ($1, $2)
       ON CONFLICT (client_id, date) DO NOTHING`,
      [clientId, today]
    );
    step = 'update';
    // kpi_met is a GENERATED column (outreach_sent >= target) — DO NOT update it.
    // Postgres rejects with "column kpi_met can only be updated to DEFAULT" otherwise.
    const updateRes = await client.query(
      `UPDATE daily_kpi SET
         outreach_sent = (
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND status = 'sent'
             AND DATE(COALESCE(sent_at, updated_at)) = $2
         ),
         outreach_email = (
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND status = 'sent' AND channel = 'email'
             AND DATE(COALESCE(sent_at, updated_at)) = $2
         ),
         outreach_linkedin = (
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND status = 'sent' AND channel = 'linkedin'
             AND DATE(COALESCE(sent_at, updated_at)) = $2
         ),
         leads_found = (
           SELECT COUNT(*) FROM leads
           WHERE client_id = $1
             AND deleted_at IS NULL
             AND DATE(created_at) = $2
         ),
         replies_received = (
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND reply_detected_at IS NOT NULL
             AND DATE(reply_detected_at) = $2
         ),
         updated_at = NOW()
       WHERE client_id = $1 AND date = $2`,
      [clientId, today]
    );

    pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
       VALUES ($1, 'system', 'kpi_recount_completed', 'system', $2, NOW())`,
      [clientId, JSON.stringify({ today, rows_updated: updateRes.rowCount })]
    ).catch(() => {});
  } catch (err) {
    // Capture the actual error to logs so we can debug remotely.
    pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
       VALUES ($1, 'system', 'kpi_recount_failed', 'system', $2, NOW())`,
      [clientId, JSON.stringify({
        today,
        step,
        err_message: String(err?.message || err).slice(0, 500),
        err_code: err?.code || null,
      })]
    ).catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
  }
}

module.exports = { recountKpi };
