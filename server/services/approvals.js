'use strict';

const pool = require('../db/pool');
const { AppError } = require('../utils/errors');
const logsService = require('./logs');
const { enqueueMessage } = require('./sendQueueWorker');
const { trackEvent, upsertDealSummary } = require('./conversionTracker');

// Push approval notification to MyClaw so it doesn't have to poll
async function notifyMyClaw(approvalId, messageId, clientId) {
  const hookUrl = process.env.MYCLAW_WEBHOOK_URL;
  const hookToken = process.env.MYCLAW_HOOK_TOKEN;
  if (!hookUrl || !hookToken) return; // MyClaw not configured — skip silently

  try {
    if (!global.fetch) return; // Node < 18 without polyfill — skip

    await fetch(`${hookUrl}/approval-pending`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${hookToken}`,
      },
      body: JSON.stringify({ approval_id: approvalId, message_id: messageId, client_id: clientId }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    // Non-fatal — MyClaw will pick it up on next poll
    console.warn('[approvals] MyClaw notify failed (non-fatal):', err.message);
  }
}

async function getApprovals(clientId, filters = {}, pagination = {}) {
  const { status = 'pending', excludeLinkedin = false } = filters;
  const { page = 1, perPage = 20 } = pagination;
  const offset = (page - 1) * perPage;

  const linkedinClause = excludeLinkedin ? `AND (a.notes IS NULL OR a.notes != 'linkedin_requested')` : '';

  // Drift guard: when listing pending approvals, only return rows where the
  // underlying message is still in a state that matches the approval row.
  // Without this, approvals get stuck in "Pending" / "Awaiting Accept" forever
  // when a message moves on via paths that bypass the approval flow
  // (manual reject scripts, batch updates, send-orchestration outside this service).
  // notes='linkedin_requested' → must have message.status='linkedin_requested'
  // notes IS NULL or other → must have message.status='pending_approval'
  const driftGuard = status === 'pending'
    ? `AND (
         (a.notes = 'linkedin_requested' AND m.status = 'linkedin_requested')
         OR (a.notes IS DISTINCT FROM 'linkedin_requested' AND m.status = 'pending_approval')
       )`
    : '';

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM approvals a
     JOIN messages m ON m.id = a.message_id
     WHERE a.client_id = $1 AND ($2::text IS NULL OR a.status = $2) ${linkedinClause} ${driftGuard}`,
    [clientId, status || null]
  );

  const result = await pool.query(
    `SELECT a.*, m.subject, m.body, m.channel, m.ranger_score, m.ranger_notes,
            l.name as lead_name, l.company as lead_company, l.email as lead_email,
            l.linkedin_url as lead_linkedin, l.title as lead_title,
            l.metadata->>'data_source' as lead_source
     FROM approvals a
     JOIN messages m ON m.id = a.message_id
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE a.client_id = $1 AND ($2::text IS NULL OR a.status = $2) ${linkedinClause} ${driftGuard}
     ORDER BY a.created_at DESC
     LIMIT $3 OFFSET $4`,
    [clientId, status || null, perPage, offset]
  );

  return {
    data: result.rows,
    meta: { total: parseInt(countResult.rows[0].count, 10), page, perPage },
  };
}

async function createApproval(clientId, { message_id, requested_by }) {
  // Verify message is actually in pending_approval status before creating approval
  const msgCheck = await pool.query(
    `SELECT status FROM messages WHERE id = $1 AND client_id = $2`,
    [message_id, clientId]
  );
  if (msgCheck.rows.length === 0) throw new AppError('Message not found', 404, 'NOT_FOUND');
  if (msgCheck.rows[0].status !== 'pending_approval') {
    throw new AppError(`Cannot create approval: message status is '${msgCheck.rows[0].status}', expected 'pending_approval'`, 400, 'INVALID_STATUS');
  }

  const result = await pool.query(
    `INSERT INTO approvals (client_id, message_id, requested_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [clientId, message_id, requested_by]
  );

  await pool.query(
    `UPDATE messages SET status = 'pending_approval', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
    [message_id, clientId]
  );

  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'approval_requested',
    target_type: 'approval',
    target_id: result.rows[0].id,
    metadata: { message_id, requested_by },
  });

  // Notify MyClaw — fire and forget (non-fatal if MyClaw is down)
  notifyMyClaw(result.rows[0].id, message_id, clientId).catch(() => {});

  return result.rows[0];
}

async function resolveApproval(clientId, approvalId, { status, notes, userId }) {
  const existing = await pool.query(
    `SELECT * FROM approvals WHERE id = $1 AND client_id = $2`,
    [approvalId, clientId]
  );
  if (existing.rows.length === 0) throw new AppError('Approval not found', 404, 'NOT_FOUND');
  if (existing.rows[0].status !== 'pending') throw new AppError('Approval already resolved', 400, 'ALREADY_RESOLVED');

  const result = await pool.query(
    `UPDATE approvals SET status = $1, notes = $2, approved_by = $3, resolved_at = NOW()
     WHERE id = $4 AND client_id = $5 RETURNING *`,
    [status, notes, userId, approvalId, clientId]
  );

  const messageStatus = status === 'approved' ? 'approved' : 'rejected';
  await pool.query(
    `UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
    [messageStatus, existing.rows[0].message_id, clientId]
  );

  // Auto-enqueue approved messages for send (with retry on failure)
  if (status === 'approved') {
    const enqueueResult = await enqueueMessage(clientId, existing.rows[0].message_id).catch(err => {
      console.warn('[approvals] Failed to enqueue message for send:', err.message);
      return { enqueued: false, reason: err.message };
    });

    // For manual-send channels (LinkedIn, Instagram): "Approve (Manual Send)" means
    // the user has already copied + sent the message. Mark as 'sent' and schedule follow-ups.
    if (enqueueResult && !enqueueResult.enqueued && enqueueResult.reason?.startsWith('manual_send_channel')) {
      await pool.query(
        `UPDATE messages SET status = 'sent', sent_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND client_id = $2`,
        [existing.rows[0].message_id, clientId]
      );

      // Schedule follow-ups for this lead (Day 2/5/10/18/30 cadence)
      try {
        const { rows: [msg] } = await pool.query(
          `SELECT lead_id FROM messages WHERE id = $1`, [existing.rows[0].message_id]
        );
        if (msg?.lead_id) {
          const { rows: prevSent } = await pool.query(
            `SELECT COUNT(*) AS cnt FROM messages
             WHERE lead_id = $1 AND client_id = $2 AND status = 'sent'`,
            [msg.lead_id, clientId]
          );
          if (parseInt(prevSent[0].cnt) <= 1) {
            const { scheduleFollowUps } = require('./followupSequence');
            await scheduleFollowUps(clientId, msg.lead_id, new Date());
            console.log(`[approvals] Scheduled follow-ups for manual-send lead ${msg.lead_id}`);
          }
        }
      } catch (err) {
        console.warn('[approvals] Follow-up scheduling failed for manual send:', err.message);
      }
    }
  }

  await logsService.createLog(clientId, {
    agent: 'system',
    action: status === 'approved' ? 'user_approved_message' : 'user_rejected_message',
    target_type: 'approval',
    target_id: approvalId,
    metadata: { status, notes, message_id: existing.rows[0].message_id },
  });

  return result.rows[0];
}

// ─── LinkedIn connection tracking ─────────────────────────────────────────

/**
 * Mark a LinkedIn approval as "connection sent" — the user has sent the
 * connection request on LinkedIn and is now waiting for the prospect to accept.
 * Moves the message from pending_approval → linkedin_requested.
 * Clears it from the pending approval queue but keeps the approval row intact.
 */
async function markConnectionSent(clientId, approvalId, { userId }) {
  const { rows } = await pool.query(
    `SELECT a.*, m.channel, m.id AS message_id FROM approvals a
     JOIN messages m ON m.id = a.message_id
     WHERE a.id = $1 AND a.client_id = $2`,
    [approvalId, clientId]
  );
  if (rows.length === 0) throw new AppError('Approval not found', 404, 'NOT_FOUND');
  const approval = rows[0];
  if (approval.status !== 'pending') throw new AppError('Approval already resolved', 400, 'ALREADY_RESOLVED');
  if (approval.channel !== 'linkedin') throw new AppError('Connection tracking only applies to LinkedIn messages', 400, 'WRONG_CHANNEL');

  // Update approval to a linkedin_requested sub-status (we reuse status='pending' but add a notes marker)
  await pool.query(
    `UPDATE approvals SET notes = 'linkedin_requested', updated_at = NOW()
     WHERE id = $1 AND client_id = $2`,
    [approvalId, clientId]
  );

  // Move message to linkedin_requested
  await pool.query(
    `UPDATE messages SET status = 'linkedin_requested', updated_at = NOW()
     WHERE id = $1 AND client_id = $2`,
    [approval.message_id, clientId]
  );

  await logsService.createLog(clientId, {
    agent: 'system',
    action: 'linkedin_connection_sent',
    target_type: 'approval',
    target_id: approvalId,
    metadata: { message_id: approval.message_id, user_id: userId },
  });

  return { ok: true, message_id: approval.message_id };
}

/**
 * Mark a LinkedIn connection as "accepted" — the prospect accepted the connection
 * request, and the user has sent the Day 0 DM. Marks as sent + schedules follow-ups.
 */
async function markConnectionAccepted(clientId, approvalId, { userId }) {
  const { rows } = await pool.query(
    `SELECT a.*, m.channel, m.id AS message_id, m.lead_id FROM approvals a
     JOIN messages m ON m.id = a.message_id
     WHERE a.id = $1 AND a.client_id = $2`,
    [approvalId, clientId]
  );
  if (rows.length === 0) throw new AppError('Approval not found', 404, 'NOT_FOUND');
  const approval = rows[0];

  // Allow from linkedin_requested messages (notes='linkedin_requested')
  const { rows: msgRows } = await pool.query(
    `SELECT status FROM messages WHERE id = $1 AND client_id = $2`,
    [approval.message_id, clientId]
  );
  if (msgRows[0]?.status !== 'linkedin_requested') {
    throw new AppError(`Message not in linkedin_requested status (currently: ${msgRows[0]?.status})`, 400, 'WRONG_STATUS');
  }

  // Resolve the approval
  await pool.query(
    `UPDATE approvals SET status = 'approved', notes = 'linkedin_accepted', approved_by = $1, resolved_at = NOW()
     WHERE id = $2 AND client_id = $3`,
    [userId, approvalId, clientId]
  );

  // Mark message as sent
  await pool.query(
    `UPDATE messages SET status = 'sent', sent_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND client_id = $2`,
    [approval.message_id, clientId]
  );

  // Update lead to contacted
  if (approval.lead_id) {
    await pool.query(
      `UPDATE leads SET pipeline_stage = 'contacted', first_contacted_at = COALESCE(first_contacted_at, NOW()), updated_at = NOW()
       WHERE id = $1 AND client_id = $2`,
      [approval.lead_id, clientId]
    );
  }

  // Schedule follow-ups
  try {
    if (approval.lead_id) {
      const { rows: prevSent } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM messages
         WHERE lead_id = $1 AND client_id = $2 AND status = 'sent'`,
        [approval.lead_id, clientId]
      );
      if (parseInt(prevSent[0].cnt) <= 1) {
        const { scheduleFollowUps } = require('./followupSequence');
        await scheduleFollowUps(clientId, approval.lead_id, new Date());
        console.log(`[approvals] Scheduled follow-ups for linkedin-accepted lead ${approval.lead_id}`);
      }
    }
  } catch (err) {
    console.warn('[approvals] Follow-up scheduling failed for linkedin-accepted:', err.message);
  }

  // Track message_sent for LinkedIn accepted
  if (approval.lead_id) {
    trackEvent(clientId, {
      lead_id: approval.lead_id, message_id: approval.message_id,
      event_type: 'message_sent', channel: 'linkedin', agent: 'system',
    });
    upsertDealSummary(clientId, approval.lead_id, { first_touch_at: new Date().toISOString() });
  }

  await logsService.createLog(clientId, {
    agent: 'system',
    action: 'linkedin_connection_accepted',
    target_type: 'approval',
    target_id: approvalId,
    metadata: { message_id: approval.message_id, lead_id: approval.lead_id, user_id: userId },
  });

  return { ok: true, message_id: approval.message_id };
}

module.exports = { getApprovals, createApproval, resolveApproval, markConnectionSent, markConnectionAccepted };
