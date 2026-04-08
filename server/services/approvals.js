'use strict';

const pool = require('../db/pool');
const { AppError } = require('../utils/errors');
const logsService = require('./logs');
const { enqueueMessage } = require('./sendQueueWorker');

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
  const { status = 'pending' } = filters;
  const { page = 1, perPage = 20 } = pagination;
  const offset = (page - 1) * perPage;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM approvals WHERE client_id = $1 AND ($2::text IS NULL OR status = $2)`,
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
     WHERE a.client_id = $1 AND ($2::text IS NULL OR a.status = $2)
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
    await enqueueMessage(clientId, existing.rows[0].message_id).catch(err => {
      console.warn('[approvals] Failed to enqueue message for send:', err.message);
    });
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

module.exports = { getApprovals, createApproval, resolveApproval };
