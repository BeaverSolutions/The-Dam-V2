'use strict';

const pool = require('../db/pool');
const gmailService = require('./gmail');
const agentmailService = require('./agentmail');
const logsService = require('./logs');
const pipelineTrace = require('./pipelineTrace');
const { handleReply } = require('./replyHandler');
const replyClassifier = require('./replyClassifier');

// 2026-05-23 P0.5 (Contract 1): inbound classification BEFORE setting
// reply_detected_at. Six categories (spam deferred to v2). Source of truth:
// MJxClaude/memory/preferences.md 2026-05-21 reply pipeline contracts.
//
// Triggered for Jacob Froats / Tin City Impact case (real reply correctly
// flowed through) AND Bharadwaj/bitquest NDR (was misclassified as reply,
// moved to qualifying, fired Telegram). Pre-classification stops NDRs +
// OOOs + opt-outs from polluting the reply queue and triggering false
// positives in handleReply().
const SOFT_BOUNCE_ESCALATE_THRESHOLD = 3;
const SOFT_BOUNCE_ESCALATE_WINDOW_DAYS = 7;

function extractHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h && h.name && h.name.toLowerCase() === target) return h.value || '';
  }
  return '';
}

// 2026-05-23 P0.5: extract bare email address from a From header value.
// "Mail Delivery Subsystem <mailer-daemon@google.com>" → "mailer-daemon@google.com"
// "jacob@tincityimpact.com" → "jacob@tincityimpact.com"
function extractEmailAddr(headerValue) {
  if (!headerValue) return '';
  const m = String(headerValue).match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : '';
}

// Per-client cache of the connected outbound Gmail address. Refreshed lazily;
// missing/error → empty string (no skip applied, defensive default).
const _outboundEmailCache = new Map();
async function getOutboundEmail(clientId) {
  if (_outboundEmailCache.has(clientId)) return _outboundEmailCache.get(clientId);
  try {
    const addr = (await gmailService.getConnectedEmail(clientId)) || '';
    _outboundEmailCache.set(clientId, addr.toLowerCase());
    return addr.toLowerCase();
  } catch {
    _outboundEmailCache.set(clientId, '');
    return '';
  }
}

/**
 * Check for replies on all sent messages with thread IDs for a given client.
 * Handles both Gmail threads and AgentMail threads.
 * Updates reply_detected_at, reply_snippet, and lead.last_reply_at.
 */
async function checkRepliesForClient(clientId) {
  // Fetch sent messages that have a thread ID (either provider) and no reply yet
  const messagesRes = await pool.query(
    `SELECT id, lead_id, gmail_thread_id, agentmail_thread_id, subject
     FROM messages
     WHERE client_id = $1
       AND status = 'sent'
       AND (gmail_thread_id IS NOT NULL OR agentmail_thread_id IS NOT NULL)
       AND reply_detected_at IS NULL`,
    [clientId]
  );

  if (messagesRes.rows.length === 0) return 0;

  let repliesFound = 0;
  const newReplyIds = [];

  for (const msg of messagesRes.rows) {
    try {
      let snippet = null;
      let inboundFrom = '';
      let inboundSubject = '';

      // --- Gmail path ---
      if (msg.gmail_thread_id) {
        // 2026-05-23 P0.5: request From/Subject headers in addition to default
        // metadata so replyClassifier can match sender + subject patterns
        // (NDR / OOO / unsubscribe). Body not needed — Gmail's snippet is
        // typically the first ~120 chars and includes bounce/OOO markers.
        const thread = await gmailService.getThread(clientId, msg.gmail_thread_id, {
          metadataHeaders: ['From', 'Subject'],
        }).catch(() => null);
        if (thread) {
          const messageCount = thread.messages?.length || 0;
          if (messageCount > 1) {
            const latestMsg = thread.messages[thread.messages.length - 1];
            snippet = latestMsg?.snippet || '';
            const headers = latestMsg?.payload?.headers || [];
            inboundFrom = extractHeader(headers, 'From');
            inboundSubject = extractHeader(headers, 'Subject');
          }
        }
      }

      // --- AgentMail path (only if no Gmail reply found) ---
      if (snippet === null && msg.agentmail_thread_id && agentmailService.isConnected()) {
        const amThread = await agentmailService.getThread(clientId, msg.agentmail_thread_id).catch(() => null);
        if (amThread) {
          const msgs = amThread.messages || amThread.items || [];
          if (msgs.length > 1) {
            const latestMsg = msgs[msgs.length - 1];
            snippet = latestMsg?.text?.slice(0, 200) || latestMsg?.snippet || '';
            // Defensive extraction — AgentMail SDK shape may vary by version.
            inboundFrom = latestMsg?.from || latestMsg?.from_address || latestMsg?.sender || '';
            inboundSubject = latestMsg?.subject || amThread.subject || '';
          }
        }
      }

      // No reply found for this message
      if (snippet === null) continue;

      const threadId = msg.gmail_thread_id || msg.agentmail_thread_id;

      // 2026-05-23 P0.5: skip when the "latest message" is actually MJ's own
      // outbound reply (sent via Gmail manually). Without this, replyDetector
      // misclassifies the founder's outbound as an inbound reply. Surfaced by
      // Jacob replay test 14:12 MYT — MJ had responded manually 2026-05-22
      // and the polling grabbed his outbound as Jacob's "reply", which then
      // got auto-drafted in a useless self-loop.
      const outboundAddr = await getOutboundEmail(clientId);
      const inboundAddr = extractEmailAddr(inboundFrom);
      if (outboundAddr && inboundAddr && inboundAddr === outboundAddr) {
        await logsService.createLog(clientId, {
          agent: 'system',
          action: 'reply_skipped_own_outbound',
          target_type: 'message',
          target_id: msg.id,
          metadata: {
            lead_id: msg.lead_id,
            thread_id: threadId,
            outbound_addr: outboundAddr,
            inbound_addr: inboundAddr,
            snippet: snippet.slice(0, 120),
          },
        }).catch(() => {});
        continue;
      }

      // ── Contract 1: classify inbound BEFORE setting reply_detected_at ──
      const classification = replyClassifier.classify({
        from: inboundFrom,
        subject: inboundSubject,
        body: snippet,
      });

      if (classification.category !== 'real_reply') {
        await handleNonReply(clientId, {
          messageId: msg.id,
          leadId: msg.lead_id,
          threadId,
          provider: msg.gmail_thread_id ? 'gmail' : 'agentmail',
          snippet,
          inboundFrom,
          inboundSubject,
          classification,
        });
        continue;
      }

      // Mark reply on message
      await pool.query(
        `UPDATE messages
         SET reply_detected_at = NOW(), reply_snippet = $2, updated_at = NOW()
         WHERE id = $1`,
        [msg.id, snippet.slice(0, 500)]
      );

      // Advance lead: outreach → qualifying
      if (msg.lead_id) {
        await pool.query(
          `UPDATE leads
           SET last_reply_at = NOW(),
               pipeline_stage = CASE
                 WHEN pipeline_stage IN ('meeting_booked', 'booked', 'closed_won', 'closed_lost')
                 THEN pipeline_stage ELSE 'qualifying' END,
               updated_at = NOW()
           WHERE id = $1 AND client_id = $2`,
          [msg.lead_id, clientId]
        );
      }

      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'reply_detected',
        target_type: 'message',
        target_id: msg.id,
        metadata: {
          thread_id: threadId,
          provider: msg.gmail_thread_id ? 'gmail' : 'agentmail',
          snippet: snippet.slice(0, 200),
          lead_id: msg.lead_id,
          source: 'polling',
        },
      });
      // Phase 1 (2026-05-08): pipeline_traces replied — closes funnel survival path to meeting_booked
      pipelineTrace.traceStage(clientId, {
        lead_id: msg.lead_id,
        message_id: msg.id,
        stage: 'replied',
        status: 'detected',
        agent: 'system',
        pipeline_path: 'replyDetector',
        metadata: {
          provider: msg.gmail_thread_id ? 'gmail' : 'agentmail',
          thread_id: threadId,
          snippet: snippet.slice(0, 200),
        },
      }).catch(() => {});

      // Phase D piece 2 — outcome attribution: replied event (email path)
      try {
        const { rows: [leadRow] } = await pool.query(
          `SELECT id, source, signal_tier, quality_score, metadata FROM leads WHERE id = $1 AND client_id = $2`,
          [msg.lead_id, clientId]
        );
        const { recordOutcome, attributionFromLead } = require('./outcomeTracker');
        recordOutcome(clientId, {
          outcome: 'replied',
          leadId: msg.lead_id,
          messageId: msg.id,
          channel: 'email',
          ...attributionFromLead(leadRow),
          eventData: { provider: msg.gmail_thread_id ? 'gmail' : 'agentmail', source_path: 'polling', snippet: snippet.slice(0, 200) },
        });
      } catch (err) {
        console.warn('[replyDetector] outcome tracker failed:', err.message);
      }

      repliesFound++;
      newReplyIds.push(msg.id);

      // Phase 2: Trigger reply intelligence — classify + auto-draft response
      if (msg.lead_id) {
        handleReply(clientId, {
          messageId: msg.id,
          leadId: msg.lead_id,
          replySnippet: snippet.slice(0, 500),
        }).catch(err => console.warn('[replyDetector] Reply handler error:', err.message));
      }
    } catch (err) {
      const threadId = msg.gmail_thread_id || msg.agentmail_thread_id;
      console.warn(`[replyDetector] Error checking thread ${threadId}:`, err.message);
    }
  }

  if (repliesFound > 0) {
    console.log(`[replyDetector] Found ${repliesFound} new replies for client ${clientId}`);

    // Notify Discord — lazy-require to avoid circular dependency risk.
    // Fire-and-forget: detection result is not blocked by Discord availability.
    const { notifyDiscordNewReplies } = require('./discordBot');
    notifyDiscordNewReplies(clientId, newReplyIds).catch((err) =>
      console.warn('[replyDetector] Discord notify error:', err.message)
    );

    // Notify Telegram — send a short preview so MJ sees replies immediately.
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (chatId) {
      try {
        const telegramService = require('./telegram');
        const appUrl = process.env.FRONTEND_URL || 'https://app.beaver.solutions';

        // Build a compact preview from the leads that replied
        let preview = '';
        if (newReplyIds.length > 0) {
          const { rows } = await pool.query(
            `SELECT l.name, l.company, m.channel
               FROM messages m
               JOIN leads l ON l.id = m.lead_id
              WHERE m.id = ANY($1) AND m.client_id = $2`,
            [newReplyIds, clientId]
          );
          preview = rows.slice(0, 3).map(r => `• ${r.name} (${r.company}) via ${r.channel}`).join('\n');
          if (rows.length > 3) preview += `\n+ ${rows.length - 3} more`;
        }

        const text = `<b>${repliesFound} new repl${repliesFound === 1 ? 'y' : 'ies'}</b>\n\n${preview}\n\n<a href="${appUrl}/approvals">Review replies →</a>`;
        telegramService.sendMessage(chatId, text).catch(err =>
          console.warn('[replyDetector] Telegram notify error:', err.message)
        );
      } catch (err) {
        console.warn('[replyDetector] Telegram notify setup error:', err.message);
      }
    }
  }
  return repliesFound;
}

/**
 * Handle a non-real-reply classification (hard/soft bounce, auto-reply, unsubscribe).
 * Each category writes its own metadata + logs. NO reply_detected_at write.
 * NO handleReply() call. NO Telegram for bounces/auto-replies (existing daily
 * Health Pack carries those volumes). Unsubscribes get a single [info] alert.
 *
 * Source of truth: MJxClaude/memory/preferences.md 2026-05-21 contract.
 */
async function handleNonReply(clientId, ctx) {
  const { messageId, leadId, threadId, provider, snippet, inboundFrom, inboundSubject, classification } = ctx;
  const { category, reason, matched_pattern } = classification;

  const logMetaBase = {
    lead_id: leadId,
    thread_id: threadId,
    provider,
    inbound_from: (inboundFrom || '').slice(0, 200),
    inbound_subject: (inboundSubject || '').slice(0, 200),
    snippet: (snippet || '').slice(0, 200),
    matched_pattern,
    reason,
  };

  try {
    if (category === 'hard_bounce') {
      // Message: mark failed, persist bounce metadata. Do NOT set reply_detected_at.
      await pool.query(
        `UPDATE messages
         SET status = 'failed',
             metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [
          JSON.stringify({
            bounce_type: 'hard_bounce',
            bounce_reason: reason,
            bounce_matched: matched_pattern,
            bounced_at: new Date().toISOString(),
            original_reply_snippet: (snippet || '').slice(0, 300),
          }),
          messageId, clientId,
        ]
      );

      // Lead: invalidate email + downgrade tier if LinkedIn fallback exists.
      if (leadId) {
        await pool.query(
          `UPDATE leads
           SET email_verified = false,
               lead_tier = CASE WHEN linkedin_url IS NOT NULL AND linkedin_url <> '' THEN 'B' ELSE lead_tier END,
               metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
               updated_at = NOW()
           WHERE id = $2 AND client_id = $3`,
          [
            JSON.stringify({
              email_status: 'bounced_hard',
              email_bounced_at: new Date().toISOString(),
            }),
            leadId, clientId,
          ]
        );
      }

      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'bounce_recorded',
        target_type: 'message',
        target_id: messageId,
        metadata: { ...logMetaBase, bounce_type: 'hard_bounce' },
      });
      return;
    }

    if (category === 'soft_bounce') {
      // Read current bounce_attempts to detect escalation. Single query — cheap.
      const cur = await pool.query(
        `SELECT COALESCE((metadata->>'bounce_attempts')::int, 0) AS attempts,
                (metadata->>'first_soft_bounce_at')::timestamptz AS first_at
         FROM messages WHERE id = $1 AND client_id = $2`,
        [messageId, clientId]
      );
      const attempts = (cur.rows[0]?.attempts || 0) + 1;
      const firstAt = cur.rows[0]?.first_at || new Date().toISOString();
      const windowMs = SOFT_BOUNCE_ESCALATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const escalate = attempts >= SOFT_BOUNCE_ESCALATE_THRESHOLD
        && (Date.now() - new Date(firstAt).getTime()) < windowMs;

      if (escalate) {
        // Recurse via the hard-bounce branch — same downstream treatment.
        return handleNonReply(clientId, {
          ...ctx,
          classification: {
            category: 'hard_bounce',
            reason: `escalated from soft_bounce (${attempts} attempts in window)`,
            matched_pattern,
          },
        });
      }

      await pool.query(
        `UPDATE messages
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [
          JSON.stringify({
            bounce_type: 'soft_bounce',
            bounce_attempts: attempts,
            first_soft_bounce_at: firstAt,
            last_soft_bounce_at: new Date().toISOString(),
            soft_bounce_matched: matched_pattern,
          }),
          messageId, clientId,
        ]
      );

      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'soft_bounce_recorded',
        target_type: 'message',
        target_id: messageId,
        metadata: { ...logMetaBase, attempts },
      });
      return;
    }

    if (category === 'auto_reply') {
      // v1: log only. No reply_detected_at, no Telegram, no pipeline_stage
      // change. Re-check scheduling after return-date is deferred to v2.
      await pool.query(
        `UPDATE messages
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [
          JSON.stringify({
            auto_reply: true,
            auto_reply_at: new Date().toISOString(),
            auto_reply_matched: matched_pattern,
            original_reply_snippet: (snippet || '').slice(0, 300),
          }),
          messageId, clientId,
        ]
      );

      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'auto_reply_recorded',
        target_type: 'message',
        target_id: messageId,
        metadata: logMetaBase,
      });
      return;
    }

    if (category === 'unsubscribe') {
      // Lead: stash unsubscribe in metadata (no top-level column per migration 053 deferred-hook comment).
      if (leadId) {
        await pool.query(
          `UPDATE leads
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
               sequence_status = 'replied',
               updated_at = NOW()
           WHERE id = $2 AND client_id = $3`,
          [
            JSON.stringify({
              unsubscribed: true,
              unsubscribed_at: new Date().toISOString(),
              unsubscribe_matched: matched_pattern,
            }),
            leadId, clientId,
          ]
        );

        // Cancel all pending follow-ups for this lead.
        await pool.query(
          `UPDATE followup_queue
           SET status = 'cancelled', updated_at = NOW()
           WHERE lead_id = $1 AND client_id = $2 AND status = 'pending'`,
          [leadId, clientId]
        );
      }

      // Mark the inbound message itself so Approvals UI doesn't show it as a reply.
      await pool.query(
        `UPDATE messages
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [
          JSON.stringify({
            opted_out: true,
            opted_out_at: new Date().toISOString(),
            opt_out_matched: matched_pattern,
            original_reply_snippet: (snippet || '').slice(0, 300),
          }),
          messageId, clientId,
        ]
      );

      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'unsubscribe_recorded',
        target_type: 'message',
        target_id: messageId,
        metadata: logMetaBase,
      });

      // Single info-priority Telegram so MJ knows a lead exited the funnel.
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId && leadId) {
        try {
          const { rows: [leadRow] } = await pool.query(
            `SELECT name, company FROM leads WHERE id = $1 AND client_id = $2`,
            [leadId, clientId]
          );
          if (leadRow) {
            const telegramService = require('./telegram');
            const txt = `<b>[info] unsubscribe</b>\n${leadRow.name || 'unknown'} (${leadRow.company || 'unknown'})\nLead removed from sequence.`;
            telegramService.sendMessage(chatId, txt).catch(err =>
              console.warn('[replyDetector] unsubscribe telegram failed:', err.message)
            );
          }
        } catch (err) {
          console.warn('[replyDetector] unsubscribe telegram lookup failed:', err.message);
        }
      }
      return;
    }
  } catch (err) {
    console.error(`[replyDetector] handleNonReply (${category}) failed for message ${messageId}:`, err.message);
    // Best-effort failure log so silent drops are visible.
    await logsService.createLog(clientId, {
      agent: 'system',
      action: 'classification_handler_failure',
      target_type: 'message',
      target_id: messageId,
      metadata: { ...logMetaBase, error: err.message, category },
    }).catch(() => {});
  }
}

/**
 * Run reply detection for all clients with unreplied sent messages.
 * Singleton guard prevents overlapping runs if a cycle takes >5 minutes.
 */
let _replyCheckRunning = false;

async function checkAllClients() {
  if (_replyCheckRunning) {
    console.log('[replyDetector] Skipping — previous run still active');
    return;
  }
  _replyCheckRunning = true;

  // Lazy-require to avoid circular import between middleware/clientContext
  // and any service that depends on this one.
  const { runWithClientContext } = require('../middleware/clientContext');
  try {
    const clientsRes = await pool.query(
      `SELECT DISTINCT client_id
       FROM messages
       WHERE status = 'sent'
         AND (gmail_thread_id IS NOT NULL OR agentmail_thread_id IS NOT NULL)
         AND reply_detected_at IS NULL`
    );

    for (const row of clientsRes.rows) {
      // Bind tenant context so reply_classifier Claude calls get attributed
      // and budget-gated per client.
      await runWithClientContext(row.client_id, () =>
        checkRepliesForClient(row.client_id)
      );
    }
  } catch (err) {
    console.error('[replyDetector] checkAllClients failed:', err.message);
  } finally {
    _replyCheckRunning = false;
  }
}

module.exports = { checkRepliesForClient, checkAllClients };
