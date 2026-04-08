'use strict';

const pool = require('../db/pool');
const { AppError } = require('../utils/errors');
const logsService = require('./logs');

async function getMessages(clientId, filters = {}, pagination = {}) {
  const { status, lead_id } = filters;
  const { page = 1, perPage = 20 } = pagination;
  const offset = (page - 1) * perPage;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM messages
     WHERE client_id = $1
       AND ($2::text IS NULL OR status = $2)
       AND ($3::uuid IS NULL OR lead_id = $3)`,
    [clientId, status || null, lead_id || null]
  );

  const result = await pool.query(
    `SELECT m.*, l.name as lead_name, l.company as lead_company
     FROM messages m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.client_id = $1
       AND ($2::text IS NULL OR m.status = $2)
       AND ($3::uuid IS NULL OR m.lead_id = $3)
     ORDER BY m.created_at DESC
     LIMIT $4 OFFSET $5`,
    [clientId, status || null, lead_id || null, perPage, offset]
  );

  return {
    data: result.rows,
    meta: { total: parseInt(countResult.rows[0].count, 10), page, perPage },
  };
}

async function getMessage(clientId, messageId) {
  const result = await pool.query(
    `SELECT m.*, l.name as lead_name, l.company as lead_company, l.email as lead_email
     FROM messages m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.id = $1 AND m.client_id = $2`,
    [messageId, clientId]
  );
  if (result.rows.length === 0) throw new AppError('Message not found', 404, 'NOT_FOUND');
  return result.rows[0];
}

async function createMessage(clientId, data) {
  const { lead_id, channel, subject, body } = data;
  // Force status to 'draft' — pipeline controls status transitions, never user input
  const safeStatus = 'draft';
  const result = await pool.query(
    `INSERT INTO messages (client_id, lead_id, channel, subject, body, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [clientId, lead_id, channel, subject, body, safeStatus]
  );
  const message = result.rows[0];

  await logsService.createLog(clientId, {
    agent: 'sales_beaver',
    action: 'message_created',
    target_type: 'message',
    target_id: message.id,
    metadata: { channel, status },
  });

  return message;
}

async function updateMessage(clientId, messageId, data) {
  await getMessage(clientId, messageId);

  const fields = ['subject', 'body', 'status', 'ranger_score', 'ranger_notes', 'revision_count'];
  const updates = [];
  const values = [clientId, messageId];
  let idx = 3;

  for (const field of fields) {
    if (data[field] !== undefined) {
      updates.push(`${field} = $${idx}`);
      values.push(data[field]);
      idx++;
    }
  }
  if (updates.length === 0) return getMessage(clientId, messageId);
  updates.push('updated_at = NOW()');

  const result = await pool.query(
    `UPDATE messages SET ${updates.join(', ')} WHERE client_id = $1 AND id = $2 RETURNING *`,
    values
  );

  await logsService.createLog(clientId, {
    agent: 'system',
    action: 'message_updated',
    target_type: 'message',
    target_id: messageId,
    metadata: { updated_fields: Object.keys(data), new_status: data.status },
  });

  return result.rows[0];
}

module.exports = { getMessages, getMessage, createMessage, updateMessage };
