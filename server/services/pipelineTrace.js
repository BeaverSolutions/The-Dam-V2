'use strict';

/**
 * pipelineTrace — Phase 1 of the BeavrDam rebuild (2026-05-08).
 *
 * Every lead emits a row at every stage transition. Silent drops become visible.
 *
 * Stage vocabulary (locked via DB CHECK constraint on pipeline_traces.stage):
 *   enrolled
 *   icp_passed | icp_rejected
 *   readiness_passed | readiness_rejected   (Phase 3 — placeholder until then)
 *   drafted | draft_failed
 *   reviewed
 *   approved | rejected | borderline        (borderline — Phase 5)
 *   repair_routed                            (V2.1 Phase 4)
 *   sent | send_failed
 *   replied | reply_classified              (reply_classified — Phase 8)
 *   meeting_booked                          (Phase 8)
 *   skipped
 *
 * Pattern mirrors services/logs.js:
 *   - Fire-and-forget. Logging errors NEVER crash callers.
 *   - clientId as first arg (logs.js convention).
 *   - Direct pool.query (not withTenant) — traces are append-only and tenant-scoped via client_id column + RLS.
 *
 * Usage:
 *   const pipelineTrace = require('./pipelineTrace');
 *   await pipelineTrace.traceStage(clientId, {
 *     lead_id, message_id, kickoff_id,
 *     stage: 'drafted', status: 'success',
 *     agent: 'sales_beaver', score: 82,
 *     pipeline_path: 'signal_pipeline',
 *     metadata: { ... },
 *   });
 *
 * For Captain morning brief + debug protocol funnel readout, use getKickoffFunnel().
 */

const pool = require('../db/pool');

const STAGE_VOCABULARY = new Set([
  'enrolled',
  'icp_passed', 'icp_rejected',
  'readiness_passed', 'readiness_rejected',
  'drafted', 'draft_failed',
  'reviewed',
  'approved', 'rejected', 'borderline',
  'repair_routed',
  'sent', 'send_failed',
  'replied', 'reply_classified',
  'meeting_booked',
  'skipped',
]);

/**
 * Write one trace row.
 *
 * Required: clientId, stage, status.
 * Recommended: lead_id, kickoff_id, pipeline_path.
 * Optional: message_id, agent, score, reason, metadata.
 */
async function traceStage(clientId, params = {}) {
  const {
    lead_id = null,
    message_id = null,
    kickoff_id = null,
    stage,
    status,
    agent = null,
    score = null,
    reason = null,
    pipeline_path = null,
    metadata = {},
  } = params;

  if (!clientId) {
    console.error('[pipelineTrace] missing clientId — trace skipped');
    return;
  }
  if (!stage || !status) {
    console.error('[pipelineTrace] missing stage or status — trace skipped', { stage, status });
    return;
  }
  if (!STAGE_VOCABULARY.has(stage)) {
    console.error('[pipelineTrace] unknown stage — trace skipped (would crash CHECK constraint)', { stage });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO pipeline_traces
        (client_id, lead_id, message_id, kickoff_id, stage, status, agent, score, reason, pipeline_path, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        clientId,
        lead_id,
        message_id,
        kickoff_id,
        stage,
        status,
        agent,
        score,
        reason,
        pipeline_path,
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (err) {
    // Never let trace-write errors crash the pipeline. Log and continue.
    console.error('[pipelineTrace] write failed:', err.message, { stage, status, lead_id });
  }
}

/**
 * Pull funnel-by-stage counts for a single kickoff.
 * Used by Captain morning brief + Friday debug protocol.
 *
 * Returns: [{ stage, status, cnt, first_seen, last_seen }, ...]
 */
async function getKickoffFunnel(clientId, kickoffId) {
  if (!clientId || !kickoffId) return [];
  try {
    const result = await pool.query(
      `SELECT stage, status, COUNT(*)::int as cnt,
              MIN(created_at) as first_seen, MAX(created_at) as last_seen
       FROM pipeline_traces
       WHERE client_id = $1 AND kickoff_id = $2
       GROUP BY stage, status
       ORDER BY first_seen ASC`,
      [clientId, kickoffId]
    );
    return result.rows;
  } catch (err) {
    console.error('[pipelineTrace] getKickoffFunnel failed:', err.message);
    return [];
  }
}

/**
 * Pull funnel for all kickoffs today (KL timezone).
 * Used by Captain morning brief.
 *
 * Returns: [{ kickoff_id, stage, status, cnt, ... }, ...]
 */
async function getTodayFunnel(clientId) {
  if (!clientId) return [];
  try {
    const result = await pool.query(
      `SELECT kickoff_id, stage, status, COUNT(*)::int as cnt,
              MIN(created_at) as first_seen, MAX(created_at) as last_seen
       FROM pipeline_traces
       WHERE client_id = $1
         AND created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur')
       GROUP BY kickoff_id, stage, status
       ORDER BY kickoff_id, first_seen ASC`,
      [clientId]
    );
    return result.rows;
  } catch (err) {
    console.error('[pipelineTrace] getTodayFunnel failed:', err.message);
    return [];
  }
}

/**
 * Compute stage-to-stage conversion rate for a kickoff.
 * Returns simplified funnel: { enrolled: N, icp_passed: N, drafted: N, reviewed: N, approved: N, sent: N, replied: N }
 * with conversion rates between adjacent stages.
 */
async function getKickoffSurvival(clientId, kickoffId) {
  const rows = await getKickoffFunnel(clientId, kickoffId);
  if (rows.length === 0) return null;

  const counts = {};
  for (const r of rows) {
    counts[r.stage] = (counts[r.stage] || 0) + r.cnt;
  }

  const survival = {
    enrolled: counts.enrolled || 0,
    icp_passed: counts.icp_passed || 0,
    icp_rejected: counts.icp_rejected || 0,
    readiness_passed: counts.readiness_passed || 0,
    drafted: counts.drafted || 0,
    draft_failed: counts.draft_failed || 0,
    reviewed: counts.reviewed || 0,
    approved: counts.approved || 0,
    rejected: counts.rejected || 0,
    borderline: counts.borderline || 0,
    sent: counts.sent || 0,
    send_failed: counts.send_failed || 0,
    replied: counts.replied || 0,
  };

  // Conversion rates (where both stages have data)
  const rate = (numerator, denominator) =>
    denominator > 0 ? Math.round((numerator / denominator) * 100) : null;

  survival.conversion = {
    icp_pass_rate: rate(survival.icp_passed, survival.enrolled),
    draft_success_rate: rate(survival.drafted, survival.icp_passed || survival.readiness_passed || survival.enrolled),
    approve_rate: rate(survival.approved, survival.reviewed),
    send_rate: rate(survival.sent, survival.approved),
    reply_rate: rate(survival.replied, survival.sent),
  };

  return survival;
}

module.exports = {
  traceStage,
  getKickoffFunnel,
  getTodayFunnel,
  getKickoffSurvival,
  STAGE_VOCABULARY,
};
