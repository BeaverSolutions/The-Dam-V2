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

const pool = require('../db/pool');

/**
 * Recompute counters in daily_kpi for a given client + date.
 * Default date: today (UTC). Pass YYYY-MM-DD to backfill history.
 * Errors are swallowed by callers (use .catch(() => {})) — this is a counter
 * sync, not load-bearing logic.
 */
async function recountKpi(clientId, date = null) {
  const today = date || new Date().toISOString().split('T')[0];

  // Ensure today's row exists so the UPDATE has a target.
  await pool.query(
    `INSERT INTO daily_kpi (client_id, date) VALUES ($1, $2)
     ON CONFLICT (client_id, date) DO NOTHING`,
    [clientId, today]
  );

  await pool.query(
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
}

module.exports = { recountKpi };
