'use strict';

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const validate = require('../middleware/validate');
const leadsService = require('../services/leads');
const { getLeadSequence, pauseSequence, resumeSequence, stopSequence } = require('../services/followupSequence');
const pool = require('../db/pool');
const logsService = require('../services/logs');
const logger = require('../utils/logger');

// UUID validation middleware for :id param
const validateId = [param('id').isUUID(), validate];

// GET /api/leads
router.get('/', async (req, res, next) => {
  try {
    const result = await leadsService.getLeads(
      req.clientId,
      {
        status: req.query.status,
        signal_tier: req.query.signal_tier,
        source: req.query.source,
        pipeline_stage: req.query.pipeline_stage,
        search: req.query.search,
      },
      { page: parseInt(req.query.page, 10) || 1, perPage: parseInt(req.query.perPage, 10) || 20 }
    );
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/leads
router.post('/',
  [
    body('name').trim().isLength({ min: 1, max: 200 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('company').optional().trim().isLength({ max: 200 }),
    body('signal_tier').optional().isIn(['P1', 'P2', 'P3']),
    body('status').optional().isIn(['new', 'contacted', 'replied', 'meeting_booked', 'closed_won', 'closed_lost']),
    body('pipeline_stage').optional().isIn(leadsService.PIPELINE_STAGE_INPUTS),
    validate,
  ],
  async (req, res, next) => {
    try {
      const lead = await leadsService.createLead(req.clientId, req.body);
      res.status(201).json({ data: lead });
    } catch (err) { next(err); }
  }
);

// GET /api/leads/:id
router.get('/:id', validateId, async (req, res, next) => {
  try {
    const lead = await leadsService.getLead(req.clientId, req.params.id);
    res.json({ data: lead });
  } catch (err) { next(err); }
});

// PUT /api/leads/:id
router.put('/:id',
  [
    body('name').optional().trim().isLength({ min: 1, max: 200 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('signal_tier').optional().isIn(['P1', 'P2', 'P3']),
    body('status').optional().isIn(['new', 'contacted', 'replied', 'meeting_booked', 'closed_won', 'closed_lost']),
    body('pipeline_stage').optional().isIn(leadsService.PIPELINE_STAGE_INPUTS),
    body('next_action').optional().trim().isLength({ min: 1, max: 500 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const lead = await leadsService.updateLead(req.clientId, req.params.id, req.body);
      res.json({ data: lead });
    } catch (err) { next(err); }
  }
);

// DELETE /api/leads/:id
router.delete('/:id', validateId, async (req, res, next) => {
  try {
    await leadsService.deleteLead(req.clientId, req.params.id);
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

// GET /api/leads/:id/sequence
router.get('/:id/sequence', [param('id').isUUID(), validate], async (req, res, next) => {
  try {
    const sequence = await getLeadSequence(req.clientId, req.params.id);
    res.json({ data: sequence });
  } catch (err) { next(err); }
});

// PUT /api/leads/:id/sequence
router.put('/:id/sequence',
  [body('action').isIn(['pause', 'resume', 'stop']), validate],
  async (req, res, next) => {
    try {
      const { action } = req.body;
      if (action === 'pause') await pauseSequence(req.params.id, req.clientId);
      else if (action === 'resume') await resumeSequence(req.params.id, req.clientId);
      else if (action === 'stop') await stopSequence(req.params.id, 'completed', req.clientId);
      res.json({ data: { action, lead_id: req.params.id } });
    } catch (err) { next(err); }
  }
);

// POST /api/leads/:id/mark-replied — canonical manual reply registration.
// Mirrors the side effects of POST /api/autonomous/linkedin-sync-replies for a
// single lead. UI calls this when MJ marks a LinkedIn lead as replied (no
// automated detection for that channel today).
//
// Side effects (all best-effort except the lead update):
//   1. UPDATE most recent unrepliedsent message: reply_detected_at, reply_snippet
//   2. UPDATE lead: status='replied', pipeline_stage='qualifying', last_reply_at
//   3. stopSequence — cancels pending follow-ups
//   4. Audit log (reply_detected, source='manual_ui')
//   5. Outcome tracker recordOutcome('replied')
//   6. Reply intelligence handleReply (fire-and-forget classify + draft)
//   7. Telegram notify (compact preview, fire-and-forget)
router.post('/:id/mark-replied',
  [
    param('id').isUUID(),
    body('reply_text').optional().isString().isLength({ max: 500 }),
    validate,
  ],
  async (req, res, next) => {
    const clientId = req.clientId;
    const leadId = req.params.id;
    const replyText = (req.body.reply_text || '').slice(0, 500);

    try {
      // 1. Find most recent sent linkedin message (regardless of reply_detected_at).
      // 2026-05-13: back-and-forth support. Every new reply in a conversation should
      // re-fire reply intelligence against the most recent sent message. The original
      // first-reply timestamp is preserved by COALESCE in the update below.
      const { rows: msgRows } = await pool.query(
        `SELECT id, sent_at, reply_detected_at FROM messages
         WHERE client_id = $1 AND lead_id = $2 AND channel = 'linkedin'
           AND status = 'sent'
         ORDER BY sent_at DESC LIMIT 1`,
        [clientId, leadId]
      );
      const msg = msgRows[0] || null;

      // 2. Update lead (canonical state) — always runs even if no message match.
      // 2026-05-13: pipeline_stage advances to 'qualifying' ONLY when current stage
      // is earlier in the funnel (prospecting/researched/contacted/outreach). Leads
      // already past qualifying (qualifying / booked / closed*) keep their stage —
      // marking a reply on a booked lead must not regress it to qualifying.
      const { rows: leadRows } = await pool.query(
        `UPDATE leads
           SET status = 'replied',
               pipeline_stage = CASE
                 WHEN pipeline_stage IN ('prospecting', 'researched', 'contacted', 'outreach')
                   THEN 'qualifying'
                 ELSE pipeline_stage
               END,
               last_reply_at = NOW(),
               updated_at = NOW()
         WHERE id = $1 AND client_id = $2
         RETURNING id, name, company, status, pipeline_stage, last_reply_at`,
        [leadId, clientId]
      );
      if (leadRows.length === 0) {
        return res.status(404).json({ error: 'Lead not found', code: 'NOT_FOUND' });
      }
      const lead = leadRows[0];

      // 3. If we found a sent message, record this reply.
      // 2026-05-13: COALESCE preserves the original first-reply timestamp on
      // repeat clicks (back-and-forth conversations). reply_snippet always
      // updates to the latest text so we have the most recent reply on file.
      if (msg) {
        await pool.query(
          `UPDATE messages
             SET reply_detected_at = COALESCE(reply_detected_at, NOW()),
                 reply_snippet = $2,
                 updated_at = NOW()
           WHERE id = $1`,
          [msg.id, replyText]
        );
      }

      // 4. Cancel pending follow-ups.
      try {
        await stopSequence(leadId, 'replied_manual_ui', clientId);
      } catch (err) {
        logger.warn({ msg: '[mark-replied] stopSequence failed', lead_id: leadId, err: err.message });
      }

      // 5. Audit log.
      try {
        await logsService.createLog(clientId, {
          agent: 'system',
          action: 'reply_detected',
          target_type: msg ? 'message' : 'lead',
          target_id: msg ? msg.id : leadId,
          metadata: {
            channel: 'linkedin',
            source: 'manual_ui',
            lead_id: leadId,
            snippet: replyText.slice(0, 200) || null,
          },
        });
      } catch (err) {
        logger.warn({ msg: '[mark-replied] audit log failed', err: err.message });
      }

      // 6. Outcome tracker (fire-and-forget).
      try {
        const { rows: [leadFull] } = await pool.query(
          `SELECT id, source, signal_tier, quality_score, metadata FROM leads WHERE id = $1 AND client_id = $2`,
          [leadId, clientId]
        );
        const { recordOutcome, attributionFromLead } = require('../services/outcomeTracker');
        recordOutcome(clientId, {
          outcome: 'replied',
          leadId,
          messageId: msg ? msg.id : null,
          channel: 'linkedin',
          ...attributionFromLead(leadFull),
          eventData: { source_path: 'manual_ui', snippet: replyText.slice(0, 200) || null },
        });
      } catch (err) {
        logger.warn({ msg: '[mark-replied] outcome tracker failed', err: err.message });
      }

      // 7. Reply intelligence (fire-and-forget) — same path as automated detection.
      if (msg && replyText) {
        try {
          const { handleReply } = require('../services/replyHandler');
          handleReply(clientId, {
            messageId: msg.id,
            leadId,
            replySnippet: replyText,
          }).catch(err => logger.warn({ msg: '[mark-replied] handleReply failed', err: err.message }));
        } catch (err) {
          logger.warn({ msg: '[mark-replied] handleReply setup failed', err: err.message });
        }
      }

      // 8. Telegram notify (fire-and-forget, compact).
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        try {
          const telegramService = require('../services/telegram');
          const appUrl = process.env.FRONTEND_URL || 'https://app.beaver.solutions';
          const text = `<b>Manual reply marked</b>\n\n• ${lead.name} (${lead.company}) via linkedin\n\n<a href="${appUrl}/approvals">Review →</a>`;
          telegramService.sendMessage(chatId, text).catch(err =>
            logger.warn({ msg: '[mark-replied] Telegram notify error', err: err.message })
          );
        } catch (err) {
          logger.warn({ msg: '[mark-replied] Telegram setup error', err: err.message });
        }
      }

      res.json({
        data: {
          lead_id: lead.id,
          status: lead.status,
          pipeline_stage: lead.pipeline_stage,
          last_reply_at: lead.last_reply_at,
          message_marked: msg ? msg.id : null,
          source: 'manual_ui',
        },
      });
    } catch (err) {
      logger.error({ msg: '/leads/:id/mark-replied failed', lead_id: leadId, err: err.message });
      next(err);
    }
  }
);

// POST /api/leads/:id/book-meeting — canonical meeting-booked transition.
// Jules F-08: generic PUT /:id bypasses follow-up cancellation + outcome/
// conversion tracking. This endpoint does all side effects atomically.
// Side effects (all best-effort except the lead update):
//   1. UPDATE lead: status + pipeline_stage = 'meeting_booked', metadata merge
//   2. stopSequence — a booked meeting means stop chasing
//   3. Audit log  4. recordOutcome('meeting_booked')  5. trackEvent
//   6. Telegram notify
router.post('/:id/book-meeting',
  [
    param('id').isUUID(),
    body('notes').optional().isString().isLength({ max: 500 }),
    body('meeting_at').optional().isString().isLength({ max: 64 }),
    validate,
  ],
  async (req, res, next) => {
    const clientId = req.clientId;
    const leadId = req.params.id;
    const notes = (req.body.notes || '').slice(0, 500);
    const meetingAt = req.body.meeting_at || null;

    try {
      const { rows: leadRows } = await pool.query(
        `UPDATE leads
           SET status = 'meeting_booked',
               pipeline_stage = 'meeting_booked',
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = NOW()
         WHERE id = $1 AND client_id = $2
         RETURNING id, name, company, status, pipeline_stage`,
        [leadId, clientId, JSON.stringify({
          meeting: { booked_at: new Date().toISOString(), meeting_at: meetingAt, notes: notes || null },
        })]
      );
      if (leadRows.length === 0) {
        return res.status(404).json({ error: 'Lead not found', code: 'NOT_FOUND' });
      }
      const lead = leadRows[0];

      try {
        await stopSequence(leadId, 'meeting_booked_manual_ui', clientId);
      } catch (err) {
        logger.warn({ msg: '[book-meeting] stopSequence failed', lead_id: leadId, err: err.message });
      }

      try {
        await logsService.createLog(clientId, {
          agent: 'system', action: 'meeting_booked', target_type: 'lead', target_id: leadId,
          metadata: { source: 'manual_ui', meeting_at: meetingAt, notes: notes || null },
        });
      } catch (err) {
        logger.warn({ msg: '[book-meeting] audit log failed', err: err.message });
      }

      try {
        const { rows: [leadFull] } = await pool.query(
          `SELECT id, source, signal_tier, quality_score, metadata FROM leads WHERE id = $1 AND client_id = $2`,
          [leadId, clientId]
        );
        const { recordOutcome, attributionFromLead } = require('../services/outcomeTracker');
        recordOutcome(clientId, {
          outcome: 'meeting_booked', leadId, messageId: null, channel: 'linkedin',
          ...attributionFromLead(leadFull),
          eventData: { source_path: 'manual_ui', meeting_at: meetingAt },
        });
        const { trackEvent } = require('../services/conversionTracker');
        trackEvent(clientId, { lead_id: leadId, event_type: 'meeting_booked', channel: 'linkedin', agent: 'system' });
      } catch (err) {
        logger.warn({ msg: '[book-meeting] tracking failed', err: err.message });
      }

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        try {
          const telegramService = require('../services/telegram');
          const appUrl = process.env.FRONTEND_URL || 'https://app.beaver.solutions';
          telegramService.sendMessage(chatId,
            `<b>Meeting booked</b>\n\n• ${lead.name} (${lead.company})${meetingAt ? `\n• ${meetingAt}` : ''}\n\n<a href="${appUrl}/pipeline">View →</a>`
          ).catch(err => logger.warn({ msg: '[book-meeting] Telegram error', err: err.message }));
        } catch (err) {
          logger.warn({ msg: '[book-meeting] Telegram setup error', err: err.message });
        }
      }

      res.json({ data: { lead_id: lead.id, status: lead.status, pipeline_stage: lead.pipeline_stage, source: 'manual_ui' } });
    } catch (err) {
      logger.error({ msg: '/leads/:id/book-meeting failed', lead_id: leadId, err: err.message });
      next(err);
    }
  }
);

// POST /api/leads/:id/close-deal — canonical closed_won / closed_lost transition.
// Jules F-08. Body: result ('won'|'lost') required; deal_value + notes optional.
router.post('/:id/close-deal',
  [
    param('id').isUUID(),
    body('result').isIn(['won', 'lost']),
    body('deal_value').optional().isNumeric(),
    body('notes').optional().isString().isLength({ max: 500 }),
    validate,
  ],
  async (req, res, next) => {
    const clientId = req.clientId;
    const leadId = req.params.id;
    const won = req.body.result === 'won';
    const status = won ? 'closed_won' : 'closed_lost';
    const dealValue = won && req.body.deal_value != null ? Number(req.body.deal_value) : null;
    const notes = (req.body.notes || '').slice(0, 500);

    try {
      const { rows: leadRows } = await pool.query(
        `UPDATE leads
           SET status = $4,
               pipeline_stage = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = NOW()
         WHERE id = $1 AND client_id = $2
         RETURNING id, name, company, status, pipeline_stage`,
        [leadId, clientId, JSON.stringify({
          deal: { result: req.body.result, value: dealValue, closed_at: new Date().toISOString(), notes: notes || null },
        }), status]
      );
      if (leadRows.length === 0) {
        return res.status(404).json({ error: 'Lead not found', code: 'NOT_FOUND' });
      }
      const lead = leadRows[0];

      try {
        await stopSequence(leadId, `${status}_manual_ui`, clientId);
      } catch (err) {
        logger.warn({ msg: '[close-deal] stopSequence failed', lead_id: leadId, err: err.message });
      }

      try {
        await logsService.createLog(clientId, {
          agent: 'system', action: 'deal_closed', target_type: 'lead', target_id: leadId,
          metadata: { source: 'manual_ui', result: req.body.result, deal_value: dealValue, notes: notes || null },
        });
      } catch (err) {
        logger.warn({ msg: '[close-deal] audit log failed', err: err.message });
      }

      try {
        const { rows: [leadFull] } = await pool.query(
          `SELECT id, source, signal_tier, quality_score, metadata FROM leads WHERE id = $1 AND client_id = $2`,
          [leadId, clientId]
        );
        const { recordOutcome, attributionFromLead } = require('../services/outcomeTracker');
        recordOutcome(clientId, {
          outcome: status, leadId, messageId: null, channel: 'linkedin',
          ...attributionFromLead(leadFull),
          eventData: { source_path: 'manual_ui', deal_value: dealValue },
        });
        const { trackEvent } = require('../services/conversionTracker');
        trackEvent(clientId, {
          lead_id: leadId, event_type: won ? 'deal_won' : 'deal_lost',
          channel: 'linkedin', agent: 'system', deal_value: dealValue,
        });
      } catch (err) {
        logger.warn({ msg: '[close-deal] tracking failed', err: err.message });
      }

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        try {
          const telegramService = require('../services/telegram');
          const appUrl = process.env.FRONTEND_URL || 'https://app.beaver.solutions';
          const head = won ? 'Deal WON' : 'Deal lost';
          telegramService.sendMessage(chatId,
            `<b>${head}</b>\n\n• ${lead.name} (${lead.company})${dealValue ? `\n• Value: ${dealValue}` : ''}\n\n<a href="${appUrl}/pipeline">View →</a>`
          ).catch(err => logger.warn({ msg: '[close-deal] Telegram error', err: err.message }));
        } catch (err) {
          logger.warn({ msg: '[close-deal] Telegram setup error', err: err.message });
        }
      }

      res.json({ data: { lead_id: lead.id, status: lead.status, pipeline_stage: lead.pipeline_stage, source: 'manual_ui' } });
    } catch (err) {
      logger.error({ msg: '/leads/:id/close-deal failed', lead_id: leadId, err: err.message });
      next(err);
    }
  }
);

module.exports = router;
