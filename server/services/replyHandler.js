'use strict';

/**
 * Reply Handler — Phase 2: Conversion Intelligence
 *
 * When a reply is detected, this service:
 * 1. Classifies the reply (positive / neutral / objection / no_fit)
 * 2. Has Sales Beaver draft the appropriate response
 * 3. Sends the draft through Ranger
 * 4. Pushes Ranger-approved drafts to the approval queue
 * 5. Logs everything
 */

const pool = require('../db/pool');
const logsService = require('./logs');

let callAgent;
try {
  callAgent = require('./claude').callAgent;
} catch {
  // Claude not available — handler will skip drafting
}

/**
 * Handle a single detected reply.
 * Called by replyDetector after marking reply_detected_at.
 */
async function handleReply(clientId, { messageId, leadId, replySnippet }) {
  if (!callAgent) {
    console.warn('[replyHandler] Claude not available — skipping reply intelligence');
    return;
  }

  try {
    // Fetch lead details
    const leadRes = await pool.query(
      `SELECT name, company, title, pipeline_stage, metadata FROM leads WHERE id = $1 AND client_id = $2 LIMIT 1`,
      [leadId, clientId]
    );
    const lead = leadRes.rows[0];
    if (!lead) return;

    // Fetch conversation history (last 5 sent messages to this lead)
    const historyRes = await pool.query(
      `SELECT subject, body, created_at FROM messages
       WHERE lead_id = $1 AND client_id = $2 AND status = 'sent'
       ORDER BY created_at DESC LIMIT 5`,
      [leadId, clientId]
    );
    const history = historyRes.rows.reverse();

    // ── Step 1: Classify the reply ──────────────────────────
    const classifyPrompt = `Prospect: ${lead.name} at ${lead.company} (${lead.title || 'N/A'})

Outreach history (oldest to newest):
${history.map((m, i) => `Message ${i + 1}: ${m.body}`).join('\n\n')}

Their reply:
"${replySnippet}"

Classify this reply and tell Sales Beaver exactly what to write next.`;

    const classification = await callAgent('reply_classifier', classifyPrompt);

    if (!classification || !classification.classification) {
      console.warn('[replyHandler] Classification failed for lead', leadId);
      return;
    }

    const sentiment = classification.classification;

    // Store classification on the original message metadata
    await pool.query(
      `UPDATE messages
       SET metadata = COALESCE(metadata, '{}') || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND client_id = $3`,
      [JSON.stringify({ reply_sentiment: sentiment, reply_confidence: classification.confidence, reply_reason: classification.reason }), messageId, clientId]
    );

    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'reply_classified',
      target_type: 'message',
      target_id: messageId,
      metadata: { lead_id: leadId, lead_name: lead.name, sentiment, confidence: classification.confidence, reason: classification.reason },
    });

    // ── Step 2: Stop follow-up sequence on ANY reply ────────
    // A reply (any sentiment) means the lead is engaged — stop automated follow-ups immediately.
    await pool.query(
      `UPDATE leads SET sequence_status = 'replied', updated_at = NOW()
       WHERE id = $1 AND client_id = $2 AND sequence_status = 'active'`,
      [leadId, clientId]
    );
    await pool.query(
      `UPDATE followup_queue SET status = 'cancelled', updated_at = NOW()
       WHERE lead_id = $1 AND client_id = $2 AND status = 'pending'`,
      [leadId, clientId]
    );

    if (sentiment === 'no_fit') {
      await pool.query(
        `UPDATE leads SET pipeline_stage = 'closed', status = 'closed_lost',
         metadata = COALESCE(metadata, '{}') || $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [JSON.stringify({ lost_reason: 'Reply indicated no fit', lost_at: new Date().toISOString() }), leadId, clientId]
      );
      await logsService.createLog(clientId, {
        agent: 'director',
        action: 'lead_disqualified',
        target_type: 'lead',
        target_id: leadId,
        metadata: { reason: classification.reason, auto_disqualified: true },
      });
      console.log(`[replyHandler] Lead ${lead.name} disqualified (no_fit)`);
      return;
    }

    // ── Step 3: Draft response via Sales Beaver ─────────────
    const { salesGenerate } = require('./agents');

    // For positive replies, inject calendar availability so Sales Beaver can suggest a time
    let calendarContext = '';
    if (sentiment === 'positive') {
      try {
        const calendarService = require('./googleCalendar');
        const gcConnected = await calendarService.isConnected(clientId);
        if (gcConnected) {
          const slots = await calendarService.suggestSlots(clientId);
          if (slots.length > 0) {
            calendarContext = `\nAvailable meeting slots (suggest one or two of these, don't list all): ${slots.join(' / ')}`;
          }
        } else {
          const calendlyUrl = await calendarService.getCalendlyUrl(clientId);
          if (calendlyUrl) {
            calendarContext = `\nCalendly booking link: ${calendlyUrl} — include this naturally when suggesting a time to connect`;
          }
        }
      } catch (err) {
        console.warn('[replyHandler] Calendar context fetch failed:', err.message);
      }
    }

    // For positive replies, also inject WhatsApp handoff link
    let whatsappContext = '';
    if (sentiment === 'positive') {
      try {
        const { getMemory } = require('./agents');
        const waConfig = await getMemory(clientId, 'captain', 'whatsapp_number');
        const waNumber = waConfig?.number || process.env.WHATSAPP_NUMBER || null;
        if (waNumber) {
          const cleanNumber = waNumber.replace(/[^0-9]/g, '');
          whatsappContext = `\nWHATSAPP HANDOFF: After suggesting a time or confirming interest, casually offer WhatsApp as an easier channel. Example: "Happy to continue this over WhatsApp if that's easier — wa.me/${cleanNumber}". Keep it natural, don't force it. Only mention once.`;
        }
      } catch (err) {
        console.warn('[replyHandler] WhatsApp config fetch failed:', err.message);
      }
    }

    const draftContext = [
      `Name: ${lead.name}`,
      `Company: ${lead.company}`,
      `Title: ${lead.title || 'N/A'}`,
      `Reply received: "${replySnippet}"`,
      `Reply classification: ${sentiment}`,
      `Director instruction: ${classification.draft_instruction || classification.next_action}`,
      `Previous messages sent: ${history.length}`,
      `IMPORTANT: This is a REPLY message, not a cold outreach. Write a conversational response to their reply. Do not start from scratch — continue the conversation naturally.`,
      calendarContext,
      whatsappContext,
    ].filter(Boolean).join('\n');

    const draft = await salesGenerate(clientId, {
      lead_id: leadId,
      channel: 'email',
      context: draftContext,
    });

    if (!draft?.body) {
      console.warn('[replyHandler] Sales Beaver returned no draft for lead', leadId);
      return;
    }

    // ── Step 4: Server-side hard gates (no AI — replies aren't cold outreach) ──
    // Word count NOT enforced on replies (they can legitimately exceed 80 words).
    // Em dash and bullet checks still apply — house style, not cold-outreach rules.
    const gateFailures = [];
    if (/—/.test(draft.body)) gateFailures.push('Em dash (—) found');
    if (/^[\s\t]*[-*•]/m.test(draft.body)) gateFailures.push('Bullet points found');
    const questionCount = (draft.body.match(/\?/g) || []).length;
    if (questionCount > 2) gateFailures.push(`${questionCount} questions (max 2 for replies)`);

    const gatesPassed = gateFailures.length === 0;
    const gateNotes = gateFailures.length > 0 ? gateFailures.join('; ') : null;

    // ── Step 5: Save draft message ─────────────────────────
    const msgRes = await pool.query(
      `INSERT INTO messages (client_id, lead_id, channel, subject, body, status, ranger_score, ranger_notes, metadata)
       VALUES ($1, $2, 'email', $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        clientId,
        leadId,
        draft.subject || `Re: ${history[history.length - 1]?.subject || 'Following up'}`,
        draft.body,
        gatesPassed ? 'pending_approval' : 'ranger_rejected',
        gatesPassed ? 90 : 0,
        gateNotes,
        JSON.stringify({ is_reply: true, reply_to_message_id: messageId, reply_sentiment: sentiment, auto_drafted: true }),
      ]
    );

    const newMsgId = msgRes.rows[0].id;

    // ── Step 6: Push to approval queue if gates passed ──
    if (gatesPassed) {
      await pool.query(
        `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'director')`,
        [clientId, newMsgId]
      );

      await logsService.createLog(clientId, {
        agent: 'director',
        action: 'reply_draft_queued',
        target_type: 'message',
        target_id: newMsgId,
        metadata: { lead_id: leadId, lead_name: lead.name, sentiment, method: 'server_side_only' },
      });

      console.log(`[replyHandler] Reply draft for ${lead.name} (${sentiment}) queued for approval`);
    } else {
      await logsService.createLog(clientId, {
        agent: 'ranger',
        action: 'reply_draft_rejected',
        target_type: 'message',
        target_id: newMsgId,
        metadata: { lead_id: leadId, gate_failures: gateFailures },
      });
      console.warn(`[replyHandler] Reply draft for ${lead.name} failed gates: ${gateNotes}`);
    }

    // Update lead stage and store sentiment in metadata for UI display
    const stageMap = { positive: 'booked', neutral: 'qualifying', objection: 'qualifying' };
    const newStage = stageMap[sentiment];
    if (newStage) {
      await pool.query(
        `UPDATE leads
         SET pipeline_stage = $1,
             metadata = COALESCE(metadata, '{}') || $2::jsonb,
             updated_at = NOW()
         WHERE id = $3 AND client_id = $4`,
        [
          newStage,
          JSON.stringify({ last_reply_sentiment: sentiment, last_reply_reason: classification.reason }),
          leadId,
          clientId,
        ]
      );
    }

    // Auto-generate call prep + competitive brief when prospect shows interest
    if (sentiment === 'positive') {
      const { generateBrief } = require('./smartActions');
      generateBrief(clientId, leadId, 'call_prep')
        .catch(e => console.warn('[replyHandler] call_prep auto-gen failed:', e.message));
      generateBrief(clientId, leadId, 'competitive_brief')
        .catch(e => console.warn('[replyHandler] competitive_brief auto-gen failed:', e.message));
      console.log(`[replyHandler] Auto-generating call prep + competitive brief for ${lead.name}`);
    }

  } catch (err) {
    console.error('[replyHandler] Error handling reply for lead', leadId, ':', err.message);
  }
}

module.exports = { handleReply };
