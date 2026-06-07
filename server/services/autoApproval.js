'use strict';

// Auto-approval service — autonomous decisions for Sales Beaver drafts.
//
// Runs every 15 min (registered in index.js). For each pending approval:
//   - ranger_score < AUTO_REJECT_THRESHOLD           -> auto-reject (no tenure check)
//   - ranger_score >= clients.auto_approve_threshold -> auto-approve (tenure + duplicate checks)
//   - otherwise                                      -> leave pending for MJ
//
// Skips manual-send channels (linkedin, instagram) — those must be approved by a human
// because the approval click IS the "I sent it" signal.
//
// Kill switch: AUTO_APPROVAL_ENABLED=false disables the service entirely.
// Audit: every decision writes a row to approval_audit.

const pool = require('../db/pool');
const logsService = require('./logs');
const { enqueueMessage } = require('./sendQueueWorker');

const AUTO_REJECT_THRESHOLD = 30;   // ranger scores <30 are junk (broken templates, off-ICP, hallucinations)
const TENURE_MIN_DAYS       = 7;    // auto-approve only for clients onboarded >=7 days ago
const DUPLICATE_LOOKBACK    = 30;   // don't auto-approve if we messaged this lead in last N days
const BATCH_LIMIT           = 200;  // cap per tick — safe throughput for 15min interval
const MANUAL_SEND_CHANNELS  = ['linkedin', 'instagram'];

async function runAutoApprovals() {
  if (process.env.AUTO_APPROVAL_ENABLED === 'false') {
    return { skipped: true, reason: 'AUTO_APPROVAL_ENABLED=false' };
  }

  const { rows: candidates } = await pool.query(
    `SELECT a.id          AS approval_id,
            a.client_id,
            a.message_id,
            m.ranger_score,
            m.lead_id,
            m.channel,
            c.auto_approve_threshold,
            EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 86400 AS client_tenure_days
       FROM approvals a
       JOIN messages  m ON m.id = a.message_id
       JOIN clients   c ON c.id = a.client_id
      WHERE a.status = 'pending'
        AND m.status = 'pending_approval'
        AND m.ranger_score IS NOT NULL
        AND (a.notes IS NULL OR a.notes != 'linkedin_requested')
        AND NOT (m.channel = ANY($1))
      ORDER BY a.created_at ASC
      LIMIT $2`,
    [MANUAL_SEND_CHANNELS, BATCH_LIMIT]
  );

  let approved = 0, rejected = 0, skipped = 0;

  for (const row of candidates) {
    try {
      const decision = await decide(row);
      if (decision.action === 'approve') {
        await autoApprove(row, decision.reason);
        approved++;
      } else if (decision.action === 'reject') {
        await autoReject(row, decision.reason);
        rejected++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.warn('[auto-approval] error on approval', row.approval_id, err.message);
    }
  }

  return { approved, rejected, skipped, total: candidates.length };
}

async function decide(row) {
  if (row.ranger_score < AUTO_REJECT_THRESHOLD) {
    return { action: 'reject', reason: `ranger_score ${row.ranger_score} < ${AUTO_REJECT_THRESHOLD}` };
  }

  if (row.auto_approve_threshold === null || row.auto_approve_threshold === undefined) {
    return { action: 'skip', reason: 'no auto_approve_threshold set for client' };
  }
  if (row.ranger_score < row.auto_approve_threshold) {
    return { action: 'skip', reason: `ranger_score ${row.ranger_score} < threshold ${row.auto_approve_threshold}` };
  }
  if (row.client_tenure_days < TENURE_MIN_DAYS) {
    return { action: 'skip', reason: `client tenure ${Math.floor(row.client_tenure_days)}d < ${TENURE_MIN_DAYS}d` };
  }

  const { rows: dupRows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
       FROM messages
      WHERE lead_id    = $1
        AND client_id  = $2
        AND id         != $3
        AND status IN ('sent', 'approved', 'pending_send', 'sending')
        AND created_at >= NOW() - ($4 || ' days')::INTERVAL`,
    [row.lead_id, row.client_id, row.message_id, DUPLICATE_LOOKBACK]
  );
  if (dupRows[0].cnt > 0) {
    return { action: 'skip', reason: `duplicate send within ${DUPLICATE_LOOKBACK}d` };
  }

  return { action: 'approve', reason: `ranger_score ${row.ranger_score} >= threshold ${row.auto_approve_threshold}` };
}

async function autoApprove(row, reason) {
  await pool.query(
    `UPDATE approvals SET status = 'approved', notes = 'auto_approved', resolved_at = NOW()
      WHERE id = $1 AND client_id = $2`,
    [row.approval_id, row.client_id]
  );
  await pool.query(
    `UPDATE messages SET status = 'approved', updated_at = NOW()
      WHERE id = $1 AND client_id = $2`,
    [row.message_id, row.client_id]
  );

  await enqueueMessage(row.client_id, row.message_id).catch(err => {
    console.warn('[auto-approval] enqueue failed (non-fatal):', err.message);
  });

  await pool.query(
    `INSERT INTO approval_audit (client_id, approval_id, message_id, decision, ranger_score, threshold, reason)
     VALUES ($1, $2, $3, 'approved', $4, $5, $6)`,
    [row.client_id, row.approval_id, row.message_id, row.ranger_score, row.auto_approve_threshold, reason]
  );

  await logsService.createLog(row.client_id, {
    agent: 'auto_approval',
    action: 'auto_approved_message',
    target_type: 'approval',
    target_id: row.approval_id,
    metadata: {
      ranger_score: row.ranger_score,
      threshold:    row.auto_approve_threshold,
      message_id:   row.message_id,
      reason,
    },
  });
}

async function autoReject(row, reason) {
  await pool.query(
    `UPDATE approvals SET status = 'rejected', notes = 'auto_rejected', resolved_at = NOW()
      WHERE id = $1 AND client_id = $2`,
    [row.approval_id, row.client_id]
  );
  await pool.query(
    `UPDATE messages SET status = 'rejected', updated_at = NOW()
      WHERE id = $1 AND client_id = $2`,
    [row.message_id, row.client_id]
  );

  await pool.query(
    `INSERT INTO approval_audit (client_id, approval_id, message_id, decision, ranger_score, threshold, reason)
     VALUES ($1, $2, $3, 'rejected', $4, NULL, $5)`,
    [row.client_id, row.approval_id, row.message_id, row.ranger_score, reason]
  );

  await logsService.createLog(row.client_id, {
    agent: 'auto_approval',
    action: 'auto_rejected_message',
    target_type: 'approval',
    target_id: row.approval_id,
    metadata: {
      ranger_score: row.ranger_score,
      message_id:   row.message_id,
      reason,
    },
  });
}

module.exports = { runAutoApprovals };
