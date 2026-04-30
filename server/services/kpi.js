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

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO daily_kpi (client_id, date) VALUES ($1, $2)
       ON CONFLICT (client_id, date) DO NOTHING`,
      [clientId, today]
    );

    const updateRes = await client.query(
      `UPDATE daily_kpi SET
         outreach_sent = COALESCE((
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND status = 'sent'
             AND DATE(COALESCE(sent_at, updated_at)) = $2
         ), 0),
         outreach_email = COALESCE((
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND status = 'sent' AND channel = 'email'
             AND DATE(COALESCE(sent_at, updated_at)) = $2
         ), 0),
         outreach_linkedin = COALESCE((
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND status = 'sent' AND channel = 'linkedin'
             AND DATE(COALESCE(sent_at, updated_at)) = $2
         ), 0),
         leads_found = COALESCE((
           SELECT COUNT(*) FROM leads
           WHERE client_id = $1
             AND deleted_at IS NULL
             AND DATE(created_at) = $2
         ), 0),
         replies_received = COALESCE((
           SELECT COUNT(*) FROM messages
           WHERE client_id = $1 AND reply_detected_at IS NOT NULL
             AND DATE(reply_detected_at) = $2
         ), 0),
         kpi_met = (
           COALESCE((
             SELECT COUNT(*) FROM messages
             WHERE client_id = $1 AND status = 'sent'
               AND DATE(COALESCE(sent_at, updated_at)) = $2
           ), 0) >= COALESCE((SELECT target FROM daily_kpi WHERE client_id = $1 AND date = $2), 50)
         ),
         updated_at = NOW()
       WHERE client_id = $1 AND date = $2`,
      [clientId, today]
    );

    // Instrumentation: log completion + rowCount so we can see if the UPDATE
    // matched the expected row.
    pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
       VALUES ($1, 'system', 'kpi_recount_completed', 'system', $2, NOW())`,
      [clientId, JSON.stringify({ today, rows_updated: updateRes.rowCount })]
    ).catch(() => {});
  } finally {
    client.release();
  }
}

module.exports = { recountKpi };
