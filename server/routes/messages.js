'use strict';

const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const messagesService = require('../services/messages');
const pool = require('../db/pool');
const { isLeadSelectionFeedback } = require('../services/founderFeedbackSignals');
const { enqueueMessage } = require('../services/sendQueueWorker');

router.get('/', async (req, res, next) => {
  try {
    const result = await messagesService.getMessages(
      req.clientId,
      { status: req.query.status, lead_id: req.query.lead_id },
      { page: parseInt(req.query.page, 10) || 1, perPage: parseInt(req.query.perPage, 10) || 20 }
    );
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/',
  [
    body('lead_id').isUUID(),
    body('channel').isIn(['email', 'linkedin', 'instagram']),
    body('body').notEmpty(),
    body('subject').optional().isLength({ max: 500 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const message = await messagesService.createMessage(req.clientId, req.body);
      res.status(201).json({ data: message });
    } catch (err) { next(err); }
  }
);

router.get('/:id', [param('id').isUUID(), validate], async (req, res, next) => {
  try {
    const message = await messagesService.getMessage(req.clientId, req.params.id);
    res.json({ data: message });
  } catch (err) { next(err); }
});

router.put('/:id',
  [
    param('id').isUUID(),
    body('status').optional().isIn(['draft', 'pending_ranger', 'ranger_rejected', 'failed']),
    body('body').optional().notEmpty(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const message = await messagesService.updateMessage(req.clientId, req.params.id, req.body);
      res.json({ data: message });
    } catch (err) { next(err); }
  }
);

// ─── Phase 5 borderline action routes (shipped 2026-05-13) ────────────────
// Three endpoints for borderline drafts (Enforcer score 60-79). All three
// resolve the approval and write a founder_feedback row so Sales Beaver's
// weekly self-sharpening loop captures MJ's call. Inline logic — no service
// extraction since these are borderline-specific and not reused.
//
// POST /api/messages/:id/apply-suggestion — MJ accepted a suggested edit
// POST /api/messages/:id/edit-borderline  — MJ manually edited the draft
// POST /api/messages/:id/skip-borderline  — MJ rejected the borderline draft

async function loadBorderlineMessage(clientId, messageId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.lead_id, m.channel, m.body, m.subject, m.status,
            l.name AS lead_name, l.company AS lead_company, l.title AS lead_title
       FROM messages m
       LEFT JOIN leads l ON l.id = m.lead_id AND l.client_id = m.client_id
      WHERE m.id = $1 AND m.client_id = $2`,
    [messageId, clientId]
  );
  return rows[0] || null;
}

async function writeFounderFeedback(clientId, payload, { required = false } = {}) {
  try {
    await pool.query(
      `INSERT INTO founder_feedback
        (client_id, lead_id, message_id, original_body, edited_body, rejection_reason, feedback_type, channel, lead_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        clientId,
        payload.lead_id,
        payload.message_id,
        payload.original_body,
        payload.edited_body || null,
        payload.rejection_reason || null,
        payload.feedback_type,
        payload.channel,
        JSON.stringify(payload.lead_context || {}),
      ]
    );
    return true;
  } catch (err) {
    // Non-fatal — capture is observability, not a blocker for the user action.
    if (required) throw err;
    // Non-fatal for approve/reject flows; explicit Teach notes require capture.
    console.warn(`[messages] founder_feedback capture failed for ${payload.message_id}:`, err.message);
    return false;
  }
}

async function enqueueIfEmailPendingSend(clientId, messageId, nextStatus) {
  if (nextStatus !== 'pending_send') return null;
  const enqueueResult = await enqueueMessage(clientId, messageId);
  if (!enqueueResult?.enqueued && enqueueResult?.reason !== 'already_enqueued') {
    await pool.query(
      `UPDATE messages SET status = 'approved', updated_at = NOW()
       WHERE id = $1 AND client_id = $2 AND status = 'pending_send'`,
      [messageId, clientId]
    );
    const err = new Error(`Email approval could not be queued for send: ${enqueueResult?.reason || 'unknown'}`);
    err.status = 409;
    err.code = 'SEND_QUEUE_BLOCKED';
    throw err;
  }
  return enqueueResult;
}

// Apply-suggestion: MJ clicked Apply on one of the Enforcer's two_thoughts.
// UI passes the resulting body. Server is agnostic to which suggestion was applied.
router.post('/:id/apply-suggestion',
  [
    param('id').isUUID(),
    body('body').notEmpty().isString(),
    body('suggestion').optional().isString(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const msg = await loadBorderlineMessage(req.clientId, req.params.id);
      if (!msg) return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });

      const newBody = req.body.body;
      const nextStatus = (msg.channel === 'email') ? 'pending_send' : 'approved';

      await pool.query(
        `UPDATE messages SET body = $1, status = $2, updated_at = NOW()
         WHERE id = $3 AND client_id = $4`,
        [newBody, nextStatus, msg.id, req.clientId]
      );
      await pool.query(
        `UPDATE approvals SET status = 'approved', resolved_at = NOW(), resolved_by_user_id = $1,
                              notes = COALESCE(notes, '') || $2
         WHERE message_id = $3 AND client_id = $4 AND status = 'pending'`,
        [req.user?.userId || null, `\n[2026-05-13 apply-suggestion]${req.body.suggestion ? ' ' + req.body.suggestion : ''}`, msg.id, req.clientId]
      );

      await writeFounderFeedback(req.clientId, {
        lead_id: msg.lead_id,
        message_id: msg.id,
        original_body: msg.body,
        edited_body: newBody,
        feedback_type: 'borderline_apply_suggestion',
        channel: msg.channel,
        lead_context: { name: msg.lead_name, company: msg.lead_company, title: msg.lead_title },
      });
      await enqueueIfEmailPendingSend(req.clientId, msg.id, nextStatus);

      res.json({ data: { id: msg.id, status: nextStatus } });
    } catch (err) { next(err); }
  }
);

// Edit-borderline: MJ manually edited the draft (didn't use a suggestion).
router.post('/:id/edit-borderline',
  [
    param('id').isUUID(),
    body('body').notEmpty().isString(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const msg = await loadBorderlineMessage(req.clientId, req.params.id);
      if (!msg) return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });

      const newBody = req.body.body;
      const nextStatus = (msg.channel === 'email') ? 'pending_send' : 'approved';

      await pool.query(
        `UPDATE messages SET body = $1, status = $2, updated_at = NOW()
         WHERE id = $3 AND client_id = $4`,
        [newBody, nextStatus, msg.id, req.clientId]
      );
      await pool.query(
        `UPDATE approvals SET status = 'approved', resolved_at = NOW(), resolved_by_user_id = $1,
                              notes = COALESCE(notes, '') || '\n[2026-05-13 edit-borderline]'
         WHERE message_id = $2 AND client_id = $3 AND status = 'pending'`,
        [req.user?.userId || null, msg.id, req.clientId]
      );

      await writeFounderFeedback(req.clientId, {
        lead_id: msg.lead_id,
        message_id: msg.id,
        original_body: msg.body,
        edited_body: newBody,
        feedback_type: 'borderline_edit_apply',
        channel: msg.channel,
        lead_context: { name: msg.lead_name, company: msg.lead_company, title: msg.lead_title },
      });
      await enqueueIfEmailPendingSend(req.clientId, msg.id, nextStatus);

      res.json({ data: { id: msg.id, status: nextStatus } });
    } catch (err) { next(err); }
  }
);

// Skip-borderline: MJ rejected the borderline draft outright.
router.post('/:id/skip-borderline',
  [
    param('id').isUUID(),
    body('reason').optional().isString(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const msg = await loadBorderlineMessage(req.clientId, req.params.id);
      if (!msg) return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });

      const reason = req.body.reason || 'MJ skipped borderline draft';

      await pool.query(
        `UPDATE messages SET status = 'ranger_rejected', ranger_notes = COALESCE(ranger_notes, '') || $1, updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [`\n[2026-05-13 borderline_skip] ${reason}`, msg.id, req.clientId]
      );
      await pool.query(
        `UPDATE approvals SET status = 'rejected', resolved_at = NOW(), resolved_by_user_id = $1, notes = $2
         WHERE message_id = $3 AND client_id = $4 AND status = 'pending'`,
        [req.user?.userId || null, reason, msg.id, req.clientId]
      );

      await writeFounderFeedback(req.clientId, {
        lead_id: msg.lead_id,
        message_id: msg.id,
        original_body: msg.body,
        edited_body: null,
        rejection_reason: reason,
        feedback_type: 'borderline_skip',
        channel: msg.channel,
        lead_context: { name: msg.lead_name, company: msg.lead_company, title: msg.lead_title },
      });

      res.json({ data: { id: msg.id, status: 'ranger_rejected' } });
    } catch (err) { next(err); }
  }
);

// Founder note: the founder leaves an explicit "teach the beaver" instruction
// on a draft — without approving, rejecting, or editing it. Pure feedback
// capture; does NOT change message or approval state. The note text rides in
// the founder_feedback.rejection_reason free-text column (feedback_type tags
// it as 'founder_note'). getFounderFeedback() renders it into Sales Beaver's
// next draft prompt.
router.post('/:id/founder-note',
  [
    param('id').isUUID(),
    body('note').notEmpty().isString().isLength({ max: 2000 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const msg = await loadBorderlineMessage(req.clientId, req.params.id);
      if (!msg) return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });

      const note = req.body.note.trim();
      await writeFounderFeedback(req.clientId, {
        lead_id: msg.lead_id,
        message_id: msg.id,
        original_body: msg.body,
        edited_body: null,
        rejection_reason: note,
        feedback_type: 'founder_note',
        channel: msg.channel,
        lead_context: { name: msg.lead_name, company: msg.lead_company, title: msg.lead_title },
      }, { required: true });

      res.json({ data: { id: msg.id, captured: true, lead_selection_feedback: isLeadSelectionFeedback(note) } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
