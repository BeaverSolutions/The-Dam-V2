'use strict';

const router = require('express').Router();
const pool = require('../db/pool');

/**
 * POST /api/webhooks/agentmail
 *
 * AgentMail fires this endpoint when an email is received in any inbox.
 * Registered via POST /api/integrations/agentmail/register-webhook.
 *
 * This route uses express.raw() because it must capture the raw body.
 * It is registered in index.js BEFORE the global express.json() middleware.
 */
router.post('/agentmail', require('express').raw({ type: '*/*' }), async (req, res) => {
  // Acknowledge immediately — AgentMail expects a fast 200
  res.status(200).json({ received: true });

  try {
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      console.warn('[webhook] Failed to parse AgentMail payload');
      return;
    }

    // Support both snake_case (API) and camelCase field names
    const eventType = payload.event_type || payload.eventType;
    if (eventType !== 'message.received') return;

    const threadId = payload.thread_id || payload.threadId;
    if (!threadId) return;

    const msgPayload = payload.message || {};
    const snippet = (msgPayload.extracted_text || msgPayload.text || '').slice(0, 500);

    // Find the original outbound message with this AgentMail thread ID
    const { rows } = await pool.query(
      `SELECT id, lead_id, client_id
       FROM messages
       WHERE agentmail_thread_id = $1
         AND reply_detected_at IS NULL
         AND status = 'sent'
       LIMIT 1`,
      [threadId]
    );

    if (!rows.length) {
      console.log(`[webhook] No sent message found for agentmail thread: ${threadId}`);
      return;
    }

    const msg = rows[0];

    // Mark reply on the message
    await pool.query(
      `UPDATE messages
       SET reply_detected_at = NOW(), reply_snippet = $1, updated_at = NOW()
       WHERE id = $2`,
      [snippet, msg.id]
    );

    // Advance lead: outreach → qualifying
    await pool.query(
      `UPDATE leads
       SET last_reply_at = NOW(), pipeline_stage = 'qualifying', updated_at = NOW()
       WHERE id = $1 AND client_id = $2 AND pipeline_stage = 'outreach'`,
      [msg.lead_id, msg.client_id]
    );

    // Stop the follow-up sequence — they replied, no more follow-ups needed
    try {
      const { stopSequence } = require('../services/followupSequence');
      await stopSequence(msg.lead_id, 'replied');
    } catch (err) {
      console.warn('[webhook] stopSequence failed:', err.message);
    }

    // Sprint 7C: Detect unsubscribe intent — stop sequence + flag lead
    const UNSUBSCRIBE_KEYWORDS = [
      'unsubscribe', 'remove me', 'stop emailing', 'not interested',
      'please stop', 'do not contact', 'take me off', 'opt out',
      'buang', 'jangan email', 'tak berminat', // Malaysian variants
    ];
    const snippetLower = snippet.toLowerCase();
    const isUnsubscribe = UNSUBSCRIBE_KEYWORDS.some(kw => snippetLower.includes(kw));

    if (isUnsubscribe) {
      await pool.query(
        `UPDATE leads SET sequence_status = 'unsubscribed', updated_at = NOW() WHERE id = $1`,
        [msg.lead_id]
      );
      await pool.query(
        `UPDATE followup_queue SET status = 'cancelled' WHERE lead_id = $1 AND status = 'pending'`,
        [msg.lead_id]
      );
      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
         VALUES ($1, 'system', 'lead_unsubscribed', 'lead', $2, $3)`,
        [msg.client_id, msg.lead_id, JSON.stringify({ snippet: snippet.slice(0, 200) })]
      );
      console.log(`[webhook] Lead ${msg.lead_id} unsubscribed.`);
    }

    // Log the event
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, 'system', 'reply_detected', 'lead', $2, $3)`,
      [
        msg.client_id,
        msg.lead_id,
        JSON.stringify({ message_id: msg.id, thread_id: threadId, snippet: snippet.slice(0, 200), source: 'agentmail_webhook', unsubscribed: isUnsubscribe }),
      ]
    );

    console.log(`[webhook] Reply detected — lead ${msg.lead_id}, thread ${threadId}${isUnsubscribe ? ' [UNSUBSCRIBED]' : ''}`);
  } catch (err) {
    console.error('[webhook] AgentMail processing error:', err.message);
  }
});

module.exports = router;
