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
const repairPolicy = require('./repairPolicy');

function buildRunSignalPlaybookDirective({
  signal_id,
  source_channel,
  geo = [],
  cap = 6,
} = {}) {
  return {
    directive_type: 'run_signal_playbook',
    target_agent: 'research_beaver',
    payload: {
      signal_id,
      source_channel,
      geo: Array.isArray(geo) ? geo : [geo].filter(Boolean),
      cap: Number(cap) || 6,
    },
  };
}

function buildExecuteApprovedPlatformPlanDirective({
  plan_id,
  plan_hash,
  cap = 5,
  mode = 'proof',
} = {}) {
  return {
    directive_type: 'execute_approved_platform_plan',
    target_agent: 'research_beaver',
    payload: {
      plan_id,
      plan_hash,
      cap: Math.max(1, Number(cap) || 5),
      mode,
      send_allowed: false,
    },
  };
}

function fixSignalCopyInstruction(signalFamily, rejectReason) {
  if (signalFamily === 'hiring_capability_build' && rejectReason === 'generic_message') {
    return 'lead with role hiring implication, not generic company observation';
  }
  if (rejectReason === 'generic_message') {
    return 'lead with the observed buying signal and commercial implication, not a generic company observation';
  }
  return `repair copy pattern for ${rejectReason || 'signal rejection'}`;
}

function buildFixSignalCopyDirective({
  signal_family,
  reject_reason,
  instruction,
} = {}) {
  return {
    directive_type: 'fix_signal_copy',
    target_agent: 'sales_beaver',
    payload: {
      signal_family,
      reject_reason,
      instruction: instruction || fixSignalCopyInstruction(signal_family, reject_reason),
    },
  };
}

function buildRepairSignalPackageDirective({
  leadId = null,
  messageId = null,
  kickoffId = null,
  channel = null,
  pipelinePath = 'unknown',
  failedRule = null,
  reason = null,
  missingFields = [],
  requiredRepair = null,
  repairAttempt = 0,
  maxRepairAttempts = repairPolicy.DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS,
  signalPackage = null,
  sourceUrl = null,
  sourceChannel = null,
  querySetHash = null,
  evidenceDecision = null,
} = {}) {
  return {
    directive_type: 'repair_signal_package',
    target_agent: 'research_beaver',
    payload: repairPolicy.buildResearchRepairPayload({
      leadId,
      messageId,
      kickoffId,
      channel,
      pipelinePath,
      failedRule,
      reason,
      missingFields,
      requiredRepair,
      repairAttempt,
      maxRepairAttempts,
      signalPackage,
      sourceUrl,
      sourceChannel,
      querySetHash,
      evidenceDecision,
    }),
  };
}

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
  buildRunSignalPlaybookDirective,
  buildExecuteApprovedPlatformPlanDirective,
  buildFixSignalCopyDirective,
  buildRepairSignalPackageDirective,
  writeDirective,
  readPendingDirectives,
  markConsumed,
  expireStale,
  recentDirectives,
};
