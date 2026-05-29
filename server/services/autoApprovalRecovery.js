'use strict';

const pool = require('../db/pool');
const logsService = require('./logs');
const { enqueueMessage } = require('./sendQueueWorker');

function autoApprovalEnabled() {
  return process.env.AUTO_APPROVE_ENABLED === 'true';
}

async function gatePendingMessage(row) {
  const score = Number(row.ranger_score) || 0;
  const threshold = row.auto_approve_threshold;
  if (!autoApprovalEnabled()) {
    return { pass: false, reason: 'AUTO_APPROVE_ENABLED not true (manual approval required)' };
  }
  if (threshold === null || threshold === undefined || score < threshold) {
    return { pass: false, reason: 'below_auto_approve_threshold' };
  }
  if (!row.client_is_seasoned) {
    return { pass: false, reason: 'client onboarded <7 days ago' };
  }
  if (Number(row.recent_sent_count) > 0) {
    return { pass: false, reason: `lead messaged within 30 days (${row.recent_sent_count} recent send(s))` };
  }
  if (row.audit_gate_fail) {
    return { pass: false, reason: row.audit_gate_fail };
  }
  if (!['email', 'linkedin'].includes(row.channel)) {
    return { pass: false, reason: `unsupported channel: ${row.channel || 'missing'}` };
  }
  if (row.channel === 'email') {
    const verified = row.email_verified === true || ['hunter', 'vibe_csv', 'apollo_csv', 'vp_chat', 'pattern+verify'].includes(row.email_source);
    if (!row.lead_email) {
      return { pass: false, reason: 'email channel without lead email' };
    }
    if (!verified) {
      return { pass: false, reason: 'email channel without verified email' };
    }
  }
  return { pass: true, reason: null };
}

async function recoverMissedAutoApprovals(clientId, { limit = 25, maxAgeDays = 7, autoApproveThreshold = null, clientCreatedAt = null } = {}) {
  if (!autoApprovalEnabled()) {
    return { recovered: 0, skipped: 0, scanned: 0, disabled: true, details: [] };
  }

  const cap = Math.max(1, Math.min(Number(limit) || 25, 100));
  const ageDays = Math.max(1, Math.min(Number(maxAgeDays) || 7, 30));
  const threshold = autoApproveThreshold === null || autoApproveThreshold === undefined
    ? null
    : Number(autoApproveThreshold);
  const createdAt = clientCreatedAt ? new Date(clientCreatedAt) : null;
  const clientCreatedAtIso = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : null;

  const { rows } = await pool.query(
    `WITH latest_audit AS (
       SELECT DISTINCT ON (message_id)
              message_id, decision, reasons, created_at
         FROM approval_audit
        WHERE client_id = $1
        ORDER BY message_id, created_at DESC
     )
     SELECT m.id AS message_id,
            m.lead_id,
            m.channel,
            m.ranger_score,
            l.email AS lead_email,
            l.email_verified,
            l.email_source,
            l.status AS lead_status,
            l.pipeline_stage,
            l.first_contacted_at,
            $4::int AS auto_approve_threshold,
            (NOW() - $5::timestamptz) > INTERVAL '7 days' AS client_is_seasoned,
            la.decision AS audit_decision,
            la.reasons->>'gate_fail' AS audit_gate_fail,
            COALESCE(sent.recent, 0)::int AS recent_sent_count
       FROM messages m
       JOIN leads l ON l.id = m.lead_id AND l.client_id = m.client_id
       LEFT JOIN latest_audit la ON la.message_id = m.id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS recent
           FROM messages prior
          WHERE prior.client_id = m.client_id
            AND prior.lead_id = m.lead_id
            AND prior.id <> m.id
            AND prior.status = 'sent'
            AND prior.sent_at IS NOT NULL
            AND prior.sent_at > NOW() - INTERVAL '30 days'
       ) sent ON true
      WHERE m.client_id = $1
        AND m.status = 'pending_approval'
        AND m.ranger_score IS NOT NULL
        AND m.created_at >= NOW() - ($2::int * INTERVAL '1 day')
        AND $4::int IS NOT NULL
        AND $5::timestamptz IS NOT NULL
        AND m.ranger_score >= $4::int
        AND COALESCE(la.decision, 'manual_pending') = 'manual_pending'
        AND COALESCE(la.reasons->>'borderline', 'false') <> 'true'
        AND (la.reasons->>'gate_fail' IS NULL OR la.reasons->>'gate_fail' = '')
        AND l.deleted_at IS NULL
        AND l.status = 'new'
        AND l.pipeline_stage = 'prospecting'
        AND l.first_contacted_at IS NULL
        AND m.channel IN ('email', 'linkedin')
      ORDER BY m.ranger_score DESC, m.created_at ASC
      LIMIT $3`,
    [clientId, ageDays, cap, threshold, clientCreatedAtIso]
  );

  let recovered = 0;
  let skipped = 0;
  const details = [];

  for (const row of rows) {
    const gate = await gatePendingMessage(row);
    if (!gate.pass) {
      skipped++;
      details.push({ message_id: row.message_id, skipped: gate.reason });
      continue;
    }

    const nextStatus = row.channel === 'email' ? 'pending_send' : 'linkedin_requested';
    const approvalStatus = row.channel === 'email' ? 'approved' : 'pending';
    const resolvedAt = row.channel === 'email' ? new Date() : null;
    const approvalNotes = row.channel === 'email' ? null : 'linkedin_requested';
    const db = await pool.connect();

    try {
      await db.query('BEGIN');
      const updated = await db.query(
        `UPDATE messages
            SET status = $1,
                ranger_notes = COALESCE(ranger_notes, $2),
                updated_at = NOW()
          WHERE id = $3
            AND client_id = $4
            AND status = 'pending_approval'
          RETURNING id`,
        [nextStatus, `Recovered auto-approval (score ${row.ranger_score})`, row.message_id, clientId]
      );
      if (updated.rowCount !== 1) {
        await db.query('ROLLBACK');
        skipped++;
        details.push({ message_id: row.message_id, skipped: 'message_not_pending_approval' });
        continue;
      }

      await db.query(
        `UPDATE approvals
            SET requested_by = 'auto_approval_recovery',
                status = $1,
                resolved_at = $2,
                notes = $3,
                updated_at = NOW()
          WHERE client_id = $4
            AND message_id = $5
            AND status = 'pending'`,
        [approvalStatus, resolvedAt, approvalNotes, clientId, row.message_id]
      );

      await db.query(
        `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at, notes)
         SELECT $1, $2, 'auto_approval_recovery', $3, $4, $5
         WHERE NOT EXISTS (
           SELECT 1 FROM approvals WHERE client_id = $1 AND message_id = $2
         )`,
        [clientId, row.message_id, approvalStatus, resolvedAt, approvalNotes]
      );

      await db.query(
        `INSERT INTO approval_audit (client_id, message_id, lead_id, decision, score, reasons, model, channel)
         VALUES ($1, $2, $3, 'auto_approved', $4, $5, $6, $7)`,
        [
          clientId,
          row.message_id,
          row.lead_id,
          row.ranger_score,
          JSON.stringify({ method: 'auto_approval_recovery', gate_fail: null, borderline: false }),
          process.env.MODEL_SONNET || 'claude-sonnet-4-20250514',
          row.channel,
        ]
      );
      await db.query('COMMIT');

      let enqueueResult = null;
      if (row.channel === 'email') {
        enqueueResult = await enqueueMessage(clientId, row.message_id)
          .catch(err => ({ enqueued: false, reason: err.message }));
      }

      await logsService.createLog(clientId, {
        agent: 'enforcer_beaver',
        action: 'message_auto_approved',
        target_type: 'message',
        target_id: row.message_id,
        metadata: {
          channel: row.channel,
          score: row.ranger_score,
          method: 'auto_approval_recovery',
          next_status: nextStatus,
          enqueue: enqueueResult,
        },
      }).catch(() => {});

      recovered++;
      details.push({ message_id: row.message_id, recovered: true, next_status: nextStatus });
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      skipped++;
      details.push({ message_id: row.message_id, skipped: err.message });
    } finally {
      db.release();
    }
  }

  if (recovered > 0 || skipped > 0) {
    await logsService.createLog(clientId, {
      agent: 'enforcer_beaver',
      action: 'auto_approval_recovery_sweep',
      target_type: 'system',
      metadata: { recovered, skipped, scanned: rows.length, limit: cap, max_age_days: ageDays, details: details.slice(0, 20) },
    }).catch(() => {});
  }

  return { recovered, skipped, scanned: rows.length, details };
}

module.exports = { recoverMissedAutoApprovals, gatePendingMessage };
