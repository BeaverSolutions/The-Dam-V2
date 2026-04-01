'use strict';

const pool = require('../db/pool');
const gmailService = require('./gmail');
const agentmailService = require('./agentmail');
const logsService = require('./logs');

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

  for (const msg of messagesRes.rows) {
    try {
      let snippet = null;

      // --- Gmail path ---
      if (msg.gmail_thread_id) {
        const thread = await gmailService.getThread(clientId, msg.gmail_thread_id).catch(() => null);
        if (thread) {
          const messageCount = thread.messages?.length || 0;
          if (messageCount > 1) {
            const latestMsg = thread.messages[thread.messages.length - 1];
            snippet = latestMsg?.snippet || '';
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
          }
        }
      }

      // No reply found for this message
      if (snippet === null) continue;

      const threadId = msg.gmail_thread_id || msg.agentmail_thread_id;

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
           SET last_reply_at = NOW(), pipeline_stage = 'qualifying', updated_at = NOW()
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

      repliesFound++;
    } catch (err) {
      const threadId = msg.gmail_thread_id || msg.agentmail_thread_id;
      console.warn(`[replyDetector] Error checking thread ${threadId}:`, err.message);
    }
  }

  if (repliesFound > 0) {
    console.log(`[replyDetector] Found ${repliesFound} new replies for client ${clientId}`);
  }
  return repliesFound;
}

/**
 * Run reply detection for all clients with unreplied sent messages.
 */
async function checkAllClients() {
  try {
    const clientsRes = await pool.query(
      `SELECT DISTINCT client_id
       FROM messages
       WHERE status = 'sent'
         AND (gmail_thread_id IS NOT NULL OR agentmail_thread_id IS NOT NULL)
         AND reply_detected_at IS NULL`
    );

    for (const row of clientsRes.rows) {
      await checkRepliesForClient(row.client_id);
    }
  } catch (err) {
    console.error('[replyDetector] checkAllClients failed:', err.message);
  }
}

module.exports = { checkRepliesForClient, checkAllClients };
