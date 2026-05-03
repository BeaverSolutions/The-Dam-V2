'use strict';

/**
 * Captain ↔ Beaver coordination bus.
 *
 * Captain calls writeDirective() based on KPI gaps. Each beaver calls
 * readPendingDirectives() at the start of its run, applies what's
 * relevant, then markConsumed() once acted on.
 *
 * Wave 1 of the goal-hunting refactor (2026-05-03).
 */

const pool = require('../db/pool');

/**
 * Captain writes a directive for a beaver. UPSERT semantics: only one
 * pending directive per (client, beaver, type) per UTC day — re-issuing
 * the same type updates the existing row instead of stacking duplicates.
 *
 * @param {string} clientId
 * @param {string} targetAgent — 'research_beaver' | 'sales_beaver' | 'db_builder' | 'signal_hunt' | 'kickoff' | 'reply_handler'
 * @param {string} directiveType — short canonical key, e.g. 'channel_focus', 'apply_rejection_patterns'
 * @param {object} payload — beaver-specific structured data
 * @param {object} [options]
 * @param {string} [options.reason] — short human-readable reason for the morning brief
 * @param {'low'|'normal'|'high'|'critical'} [options.severity='normal']
 * @param {number} [options.expiresInHours=24]
 */
async function writeDirective(clientId, targetAgent, directiveType, payload, options = {}) {
  const { reason = null, severity = 'normal', expiresInHours = 24 } = options;
  const { rows } = await pool.query(
    `INSERT INTO agent_directives
       (client_id, target_agent, directive_type, payload, reason, severity, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW() + ($7 || ' hours')::INTERVAL)
     ON CONFLICT (client_id, target_agent, directive_type, effective_date)
       WHERE status = 'pending'
       DO UPDATE SET
         payload     = EXCLUDED.payload,
         reason      = EXCLUDED.reason,
         severity    = EXCLUDED.severity,
         expires_at  = EXCLUDED.expires_at,
         created_at  = NOW()
     RETURNING id, status, created_at`,
    [clientId, targetAgent, directiveType, JSON.stringify(payload), reason, severity, String(expiresInHours)]
  );
  return rows[0];
}

/**
 * Beavers call this at the start of every run to pull pending
 * directives addressed to them. Returns array (possibly empty).
 * Does NOT mark consumed — caller does that explicitly via markConsumed()
 * once the directive has been applied (so a crash mid-run leaves the
 * directive pending for the next run to pick up).
 */
async function readPendingDirectives(clientId, targetAgent) {
  const { rows } = await pool.query(
    `SELECT id, directive_type, payload, reason, severity, created_at, expires_at
     FROM agent_directives
     WHERE client_id = $1
       AND target_agent = $2
       AND status = 'pending'
       AND expires_at > NOW()
     ORDER BY
       CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
       created_at ASC`,
    [clientId, targetAgent]
  );
  return rows;
}

/**
 * Beaver marks one or more directives as consumed once it has acted on them.
 * Pass an array of directive IDs.
 */
async function markConsumed(clientId, directiveIds) {
  if (!Array.isArray(directiveIds) || directiveIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE agent_directives
     SET status = 'consumed', consumed_at = NOW()
     WHERE client_id = $1 AND id = ANY($2::uuid[]) AND status = 'pending'`,
    [clientId, directiveIds]
  );
  return rowCount;
}

/**
 * Sweep job — marks expired pending directives as 'expired'. Cheap.
 * Wired into the existing 10-min cron in index.js.
 */
async function expireStale() {
  const { rowCount } = await pool.query(
    `UPDATE agent_directives
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= NOW()`
  );
  return rowCount;
}

/**
 * Convenience for the morning / EOD brief — Captain quotes recent directives
 * and whether they were acted on.
 */
async function recentDirectives(clientId, hours = 24) {
  const { rows } = await pool.query(
    `SELECT target_agent, directive_type, payload, reason, severity, status,
            created_at, consumed_at
     FROM agent_directives
     WHERE client_id = $1 AND created_at >= NOW() - ($2 || ' hours')::INTERVAL
     ORDER BY created_at DESC`,
    [clientId, String(hours)]
  );
  return rows;
}

module.exports = {
  writeDirective,
  readPendingDirectives,
  markConsumed,
  expireStale,
  recentDirectives,
};
