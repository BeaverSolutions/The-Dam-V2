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
const { trackEvent, upsertDealSummary } = require('./conversionTracker');

let callAgent;
try {
  callAgent = require('./claude').callAgent;
} catch (err) {
  console.error('[replyHandler] CRITICAL: Claude module failed to load — reply drafting disabled:', err.message);
}

// ── Failure observability (added 2026-05-22, P0.5 fix) ──────────────
// Every silent early-return in handleReply now writes a `reply_handler_failure`
// log row AND queues a Telegram alert. Telegram is batched via a 5s debounced
// flush so multiple failures from a single replyDetector polling tick collapse
// into ONE message — MJ doesn't want one alert per failure. DB log is always
// per-failure (audit trail; logs table is pulled, not pushed).
//
// Root cause this fixes: Jacob Froats / Tin City Impact replied 2026-05-21
// 12:57 MYT; Anthropic API limit was hit; callAgent('reply_classifier') errored
// or returned null; handleReply exited silently at the classification null
// check; no DB log, no Telegram, no draft. Brain only learned 24h later.

const pendingFailures = [];
let failureFlushTimer = null;

function scheduleFailureFlush() {
  if (failureFlushTimer) clearTimeout(failureFlushTimer);
  failureFlushTimer = setTimeout(flushFailureBatch, 5000);
}

async function flushFailureBatch() {
  failureFlushTimer = null;
  if (pendingFailures.length === 0) return;
  const batch = pendingFailures.splice(0);
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  try {
    const { sendMessage } = require('./telegram');
    const header = `<b>🚨 Reply handler — ${batch.length} failure${batch.length > 1 ? 's' : ''}</b>\n\n`;
    const lines = batch.map((f, i) => {
      const lead = f.leadName ? `${f.leadName}` : `Lead ${f.leadId || '?'}`;
      const detail = f.detail ? `\n   Detail: ${String(f.detail).slice(0, 120)}` : '';
      return `${i + 1}. ${lead}\n   Reason: <code>${f.reason}</code>${detail}`;
    }).join('\n\n');
    const footer = `\n\nReply detected, draft did NOT land in approvals. Manual rescue needed.`;
    await sendMessage(chatId, header + lines + footer);
  } catch (err) {
    console.warn('[replyHandler] Batched failure alert failed:', err.message);
  }
}

// recordFailure: DB log synchronously + queue Telegram for batched flush.
async function recordFailure(clientId, { leadId, leadName, messageId, reason, detail }) {
  try {
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'reply_handler_failure',
      target_type: 'message',
      target_id: messageId,
      metadata: { reason, lead_id: leadId, lead_name: leadName, error_detail: detail ? String(detail).slice(0, 500) : null },
    });
  } catch (logErr) {
    console.error('[replyHandler] DB log write for failure failed:', logErr.message);
  }
  pendingFailures.push({ leadId, leadName, messageId, reason, detail });
  scheduleFailureFlush();
}

/**
 * Handle a single detected reply.
 * Called by replyDetector after marking reply_detected_at.
 */
async function handleReply(clientId, { messageId, leadId, replySnippet }) {
  if (!callAgent) {
    console.warn('[replyHandler] Claude not available — skipping reply intelligence');
    await recordFailure(clientId, { leadId, leadName: null, messageId, reason: 'claude_module_unloaded', detail: 'callAgent unavailable at handler entry' });
    return;
  }

  try {
    // Fetch lead details
    const leadRes = await pool.query(
      `SELECT name, company, title, pipeline_stage, email, metadata FROM leads WHERE id = $1 AND client_id = $2 LIMIT 1`,
      [leadId, clientId]
    );
    const lead = leadRes.rows[0];
    if (!lead) {
      await recordFailure(clientId, { leadId, leadName: null, messageId, reason: 'lead_not_found', detail: `SELECT returned 0 rows for lead_id=${leadId}` });
      return;
    }

    // 2026-05-13: Channel discipline. The reply draft + every downstream
    // trackEvent / feedback_events / message INSERT must use the SOURCE
    // message's channel — not hardcoded email. A LinkedIn reply on a lead
    // with no email previously caused (a) drafts on email channel that the
    // Approvals page blocked with "no email address" and (b) fabricated
    // email addresses invented by the model to fill the gap. See
    // corrections.md 2026-05-13 23:10 MYT.
    const sourceMsgRes = await pool.query(
      `SELECT channel FROM messages WHERE id = $1 AND client_id = $2 LIMIT 1`,
      [messageId, clientId]
    );
    const sourceChannel = sourceMsgRes.rows[0]?.channel || 'email';

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

    // 2026-05-22 P0.5: wrap callAgent so a throw produces a logged failure +
    // batched Telegram, not a silent outer-catch swallow with leadId-as-string.
    // Root cause for Jacob's reply: API limit → callAgent threw/returned null →
    // silent exit. Now: failure is named, MJ alerted within 5s.
    let classification;
    try {
      classification = await callAgent('reply_classifier', classifyPrompt);
    } catch (err) {
      console.error('[replyHandler] Classification call threw for lead', leadId, ':', err.message);
      await recordFailure(clientId, { leadId, leadName: lead.name, messageId, reason: 'classification_call_threw', detail: err.message });
      return;
    }

    if (!classification || !classification.classification) {
      console.warn('[replyHandler] Classification returned null/empty for lead', leadId);
      await recordFailure(clientId, { leadId, leadName: lead.name, messageId, reason: 'classification_returned_null', detail: classification ? JSON.stringify(classification).slice(0, 200) : 'null' });
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

    // Wave 2 (2026-05-03): Impromptu Telegram for high-priority replies.
    // This is the "Captain decides impromptu" channel in MJ's notification policy.
    // A positive reply means a prospect is engaged — every minute of delay
    // matters. Fires once per message (no duplicates on retry).
    if (sentiment === 'positive') {
      try {
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId) {
          const dedupeKey = `reply_alert_${messageId}`;
          const { rows: alreadyAlerted } = await pool.query(
            `SELECT 1 FROM agent_memory
             WHERE client_id = $1 AND agent = 'reply_handler' AND key = $2 LIMIT 1`,
            [clientId, dedupeKey]
          );
          if (alreadyAlerted.length === 0) {
            const { sendMessage } = require('./telegram');
            const snippet = String(replySnippet || '').slice(0, 240);
            await sendMessage(chatId,
              `<b>Positive reply — ${lead.name}</b>\n\n` +
              `${lead.company}${lead.title ? ` · ${lead.title}` : ''}\n` +
              `Reason: ${classification.reason || 'positive intent'}\n\n` +
              `<i>${snippet}${snippet.length === 240 ? '…' : ''}</i>\n\n` +
              `Draft will land in approvals shortly.`
            ).catch(err => console.warn('[replyHandler] Telegram alert failed:', err.message));
            await pool.query(
              `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
               VALUES ($1, 'reply_handler', $2, $3::jsonb, 'config')
               ON CONFLICT (client_id, agent, key) DO NOTHING`,
              [clientId, dedupeKey, JSON.stringify({ message_id: messageId, lead_id: leadId, fired_at: new Date().toISOString() })]
            ).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[replyHandler] Impromptu alert failed (non-fatal):', err.message);
      }
    }

    // Track reply event for conversion data
    const sentimentEventMap = { positive: 'reply_positive', neutral: 'message_replied', objection: 'reply_objection', no_fit: 'reply_negative' };
    trackEvent(clientId, {
      lead_id: leadId,
      message_id: messageId,
      event_type: sentimentEventMap[sentiment] || 'message_replied',
      channel: sourceChannel,
      reply_sentiment: sentiment,
      agent: 'director',
    });
    upsertDealSummary(clientId, leadId, { first_reply_at: new Date().toISOString() });

    // Phase 4 rebuild plan (2026-05-12): feedback_events 'replied' capture.
    // Fire-and-forget. Sentiment becomes a payload field so the consumer cron
    // can weight signals/segments by reply quality, not just reply rate.
    require('./learningEngine').postFeedbackEvent(clientId, {
      leadId,
      messageId,
      eventType: 'replied',
      signalStrengthAtTime: lead.metadata?.buying_signal_strength || null,
      sourceStrategy: lead.metadata?.source_strategy || null,
      segment: lead.metadata?.industry || null,
      channel: sourceChannel,
      notes: typeof replySnippet === 'string' ? replySnippet.slice(0, 300) : null,
      payload: { sentiment, confidence: classification.confidence },
    }).catch(() => {});

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

    // Phase 4 (2026-05-11): record reply outcome to followup_learnings for
    // Captain's next-day angle bias + Enforcer self-calibration. Idempotent
    // on message_id — updates the existing outcome entry created when the
    // message went through Enforcer.
    try {
      const { postFollowUpOutcome } = require('./learningEngine');
      await postFollowUpOutcome(clientId, {
        messageId,
        reply_outcome: sentiment,
        reply_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[replyHandler] followup outcome write failed:', e.message);
    }

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
      trackEvent(clientId, {
        lead_id: leadId, event_type: 'deal_lost', channel: sourceChannel,
        reply_sentiment: 'no_fit', agent: 'director',
        metadata: { reason: classification.reason },
      });
      upsertDealSummary(clientId, leadId, {
        closed_at: new Date().toISOString(), outcome: 'lost',
        loss_reason: 'Reply indicated no fit',
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

    // For positive replies, ask for their WhatsApp number so we can reach out to them
    let whatsappContext = '';
    if (sentiment === 'positive') {
      whatsappContext = `\nWHATSAPP HANDOFF: After confirming interest or suggesting a time, naturally ask for their WhatsApp number. Example: "Happy to sort out the details over WhatsApp if that's easier for you — what's your number?" or "Shall I WhatsApp you to lock in a time?". Keep it casual, one sentence max. The goal is to get THEIR number so we message them, not the other way round.`;
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

    // 2026-05-13: draft on the source channel — NOT hardcoded email.
    // If sourceChannel is linkedin and lead has no email, drafting on email
    // is invalid (Approvals page blocks; model fabricates email addresses).
    const draft = await salesGenerate(clientId, {
      lead_id: leadId,
      channel: sourceChannel,
      context: draftContext,
    });

    if (!draft?.body) {
      console.warn('[replyHandler] Sales Beaver returned no draft for lead', leadId);
      await recordFailure(clientId, {
        leadId,
        leadName: lead.name,
        messageId,
        reason: 'sales_beaver_no_draft',
        detail: `sentiment=${sentiment}; draft=${draft ? JSON.stringify(draft).slice(0, 200) : 'null'}`,
      });
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
    // 2026-05-13: persist on the source channel. Subject only meaningful for
    // email; LinkedIn DMs ignore it at send time but we keep a placeholder
    // for thread continuity in the UI.
    const draftSubject = sourceChannel === 'email'
      ? (draft.subject || `Re: ${history[history.length - 1]?.subject || 'Following up'}`)
      : (draft.subject || null);
    const msgRes = await pool.query(
      `INSERT INTO messages (client_id, lead_id, channel, subject, body, status, ranger_score, ranger_notes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        clientId,
        leadId,
        sourceChannel,
        draftSubject,
        draft.body,
        gatesPassed ? 'pending_approval' : 'ranger_rejected',
        gatesPassed ? 90 : 0,
        gateNotes,
        JSON.stringify({ is_reply: true, reply_to_message_id: messageId, reply_sentiment: sentiment, auto_drafted: true, source_channel: sourceChannel }),
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
    const stageMap = { positive: 'meeting_booked', neutral: 'qualifying', objection: 'qualifying' };
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

    // Track stage transition
    if (newStage === 'meeting_booked') {
      trackEvent(clientId, {
        lead_id: leadId, event_type: 'meeting_booked', channel: 'email',
        reply_sentiment: sentiment, agent: 'director',
      });
      upsertDealSummary(clientId, leadId, { meeting_booked_at: new Date().toISOString() });
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
    // 2026-05-22 P0.5: outer catch was console.error-only — silent from DB +
    // Telegram. Now: record failure with stack so MJ knows within 5s.
    await recordFailure(clientId, {
      leadId,
      leadName: null,
      messageId,
      reason: 'unexpected_exception',
      detail: `${err.message} | ${err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : ''}`,
    }).catch(() => {});
  }
}

module.exports = { handleReply };
