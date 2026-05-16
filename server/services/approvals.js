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
            m.metadata as message_metadata, m.follow_up_day,
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

async function resolveApproval(clientId, approvalId, { status, notes, userId, edited_body }) {
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

  // Fix 6: Capture founder feedback for Sales Beaver learning loop.
  // On approve: check if body was edited (original_body snapshot in metadata).
  // On reject: store the rejection reason.
  try {
    const { rows: [msg] } = await pool.query(
      `SELECT id, lead_id, body, channel, metadata FROM messages WHERE id = $1 AND client_id = $2`,
      [existing.rows[0].message_id, clientId]
    );
    if (msg) {
      const originalBody = msg.metadata?.original_body;
      if (status === 'approved' && originalBody && originalBody !== msg.body) {
        // Founder edited the draft before approving — capture the diff
        const { rows: [lead] } = await pool.query(
          `SELECT name, company, title FROM leads WHERE id = $1 AND client_id = $2`,
          [msg.lead_id, clientId]
        );
        await pool.query(
          `INSERT INTO founder_feedback (client_id, message_id, lead_id, feedback_type, original_body, edited_body, channel, lead_context)
           VALUES ($1, $2, $3, 'edit', $4, $5, $6, $7)`,
          [clientId, msg.id, msg.lead_id, originalBody, msg.body, msg.channel,
           JSON.stringify({ name: lead?.name, company: lead?.company, title: lead?.title })]
        );
        // Clean up the snapshot
        await pool.query(
          `UPDATE messages SET metadata = metadata - 'original_body' WHERE id = $1 AND client_id = $2`,
          [msg.id, clientId]
        );
      } else if (status === 'rejected' && (notes || edited_body)) {
        // Founder rejected with a reason — capture for pattern learning
        const { rows: [lead] } = await pool.query(
          `SELECT name, company, title FROM leads WHERE id = $1 AND client_id = $2`,
          [msg.lead_id, clientId]
        );
        await pool.query(
          `INSERT INTO founder_feedback (client_id, message_id, lead_id, feedback_type, original_body, rejection_reason, channel, lead_context)
           VALUES ($1, $2, $3, 'rejection', $4, $5, $6, $7)`,
          [clientId, msg.id, msg.lead_id, msg.body, notes || 'Rejected without reason', msg.channel,
           JSON.stringify({ name: lead?.name, company: lead?.company, title: lead?.title })]
        );
      }
    }
  } catch (feedbackErr) {
    // Non-critical — don't block the approval/rejection flow
    console.warn('[approvals] founder_feedback capture failed:', feedbackErr.message);
  }

  // Phase 4 (2026-05-12): write to feedback_events for the cross-agent learning loop.
  // Fires for both 'approved' (eventually leads to 'sent') and 'rejected' (manual reject).
  // Approved drafts get a 'sent' event later from sendQueueWorker; this captures
  // the rejection path which is otherwise invisible to the new feedback table.
  if (status === 'rejected') {
    try {
      const { postFeedbackEvent } = require('./learningEngine');
      const { rows: [msgF] } = await pool.query(
        `SELECT m.lead_id, m.channel, m.ranger_score, m.metadata,
                l.buying_signal_strength, l.metadata->>'industry' AS industry,
                l.metadata->>'source_strategy' AS source_strategy
         FROM messages m
         LEFT JOIN leads l ON l.id = m.lead_id
         WHERE m.id = $1 AND m.client_id = $2`,
        [existing.rows[0].message_id, clientId]
      );
      if (msgF) {
        await postFeedbackEvent(clientId, {
          leadId: msgF.lead_id,
          messageId: existing.rows[0].message_id,
          eventType: 'manually_rejected',
          signalStrengthAtTime: msgF.buying_signal_strength,
          sourceStrategy: msgF.source_strategy,
          segment: msgF.industry,
          channel: msgF.channel,
          touchNumber: msgF.metadata?.touch_number ?? 0,
          rangerScore: msgF.ranger_score,
          notes: notes || null,
        });
      }
    } catch (eventErr) {
      console.warn('[approvals] feedback_events capture failed:', eventErr.message);
    }
  }

  // Phase 4 (2026-05-11): record MJ's decision to followup_learnings for
  // Enforcer self-calibration. An "override" is when MJ disagrees with what
  // Enforcer decided. Since pending_approval messages all passed Enforcer,
  // a 'rejected' here is a true override. An 'approved' with body edit is
  // a partial override (Enforcer's draft was acceptable but needed tweaking).
  try {
    const { recordMJOverride } = require('./learningEngine');
    const { rows: [msg2] } = await pool.query(
      `SELECT id, body, metadata FROM messages WHERE id = $1 AND client_id = $2`,
      [existing.rows[0].message_id, clientId]
    );
    if (msg2) {
      const wasEdited = msg2.metadata?.original_body && msg2.metadata.original_body !== msg2.body;
      await recordMJOverride(clientId, {
        messageId: existing.rows[0].message_id,
        originalDecision: 'approved', // Enforcer's decision (pending_approval = Enforcer approved)
        mjDecision: status,
        mjEditedBody: wasEdited ? msg2.body : null,
      });
    }
  } catch (overrideErr) {
    // Non-critical — don't block approval flow
    console.warn('[approvals] MJ override capture failed:', overrideErr.message);
  }

  // Auto-enqueue approved messages for send (with retry on failure)
  if (status === 'approved') {
    const enqueueResult = await enqueueMessage(clientId, existing.rows[0].message_id).catch(err => {
      console.warn('[approvals] Failed to enqueue message for send:', err.message);
      return { enqueued: false, reason: err.message };
    });

    // For manual-send channels (LinkedIn, Instagram): content is approved but
    // hasn't been sent yet. LinkedIn routes to linkedin_requested so user can
    // click "DM Sent" after manually sending. Other channels mark sent immediately.
    if (enqueueResult && !enqueueResult.enqueued && enqueueResult.reason?.startsWith('manual_send_channel')) {
      const { rows: [channelCheck] } = await pool.query(
        `SELECT channel FROM messages WHERE id = $1 AND client_id = $2`,
        [existing.rows[0].message_id, clientId]
      );

      if (channelCheck?.channel === 'linkedin') {
        // LinkedIn: revert to pending + linkedin_requested so it appears in
        // "Ready to Send" tab. User clicks "DM Sent" after manual send.
        await pool.query(
          `UPDATE approvals SET status = 'pending', notes = 'linkedin_requested', resolved_at = NULL, updated_at = NOW()
           WHERE id = $1 AND client_id = $2`,
          [approvalId, clientId]
        );
        await pool.query(
          `UPDATE messages SET status = 'linkedin_requested', updated_at = NOW()
           WHERE id = $1 AND client_id = $2`,
          [existing.rows[0].message_id, clientId]
        );
      } else {
        // Other manual-send channels (Instagram, etc.): mark sent immediately
        await pool.query(
          `UPDATE messages SET status = 'sent', sent_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND client_id = $2`,
          [existing.rows[0].message_id, clientId]
        );
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
async function markConnectionAccepted(clientId, approvalId, { userId, finalBody = null }) {
  const { rows } = await pool.query(
    `SELECT a.*, m.channel, m.id AS message_id, m.lead_id, m.body AS draft_body FROM approvals a
     JOIN messages m ON m.id = a.message_id
     WHERE a.id = $1 AND a.client_id = $2`,
    [approvalId, clientId]
  );
  if (rows.length === 0) throw new AppError('Approval not found', 404, 'NOT_FOUND');
  const approval = rows[0];

  // Allow from linkedin_requested OR approved OR pending_approval messages.
  // - linkedin_requested: cold draft routed to Awaiting tab, MJ sent manually
  // - approved: went through resolveApproval but not manually sent yet
  // - pending_approval (2026-05-12): follow-up draft in Follow-ups tab,
  //   MJ chose to approve+send-in-one-click via the inline DM Sent button.
  //   The function below already handles all three: approval row gets resolved,
  //   message marked sent, follow-ups scheduled.
  const { rows: msgRows } = await pool.query(
    `SELECT status FROM messages WHERE id = $1 AND client_id = $2`,
    [approval.message_id, clientId]
  );
  const allowedStatuses = ['linkedin_requested', 'approved', 'pending_approval'];
  if (!allowedStatuses.includes(msgRows[0]?.status)) {
    throw new AppError(`Message not in linkedin_requested/approved/pending_approval status (currently: ${msgRows[0]?.status})`, 400, 'WRONG_STATUS');
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

  // F-02 (2026-05-16): capture founder edits on manual UI LinkedIn sends.
  // If the founder pasted back the text actually sent and it differs from the
  // draft, write a founder_feedback row so the Sales few-shot rebuild learns
  // from real edits. This was the gap that left founder_feedback at 0 rows —
  // only the Cowork /linkedin-mark-sent path captured edits, not the UI button.
  // Non-fatal: never block the mark-sent on a feedback write failure.
  if (finalBody && typeof finalBody === 'string' && approval.draft_body
      && approval.draft_body.trim() !== finalBody.trim()) {
    try {
      await pool.query(
        `INSERT INTO founder_feedback (client_id, lead_id, message_id, original_body, edited_body, feedback_type, channel)
         VALUES ($1, $2, $3, $4, $5, 'manual_ui_send_edit', $6)`,
        [clientId, approval.lead_id, approval.message_id, approval.draft_body, finalBody, approval.channel || 'linkedin']
      );
      console.log(`[approvals] founder_feedback captured (manual UI send edit) for message ${approval.message_id}`);
    } catch (err) {
      console.warn('[approvals] founder_feedback capture failed (non-fatal):', err.message);
    }
  }

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
