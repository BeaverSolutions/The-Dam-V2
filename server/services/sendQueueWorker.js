'use strict';

// ─── Send Queue Worker ─────────────────────────────────────────────────────
// Polls send_queue every 60 seconds for pending messages and sends them.
// Retries on failure: 5 min → 30 min → 2 hours. Alerts after 3 failed attempts.
// Eliminates silent send failures and manual "click send" workflow.

const pool = require('../db/pool');
const logsService = require('./logs');

// Retry intervals (exponential backoff)
const RETRY_INTERVALS = ['5 minutes', '30 minutes', '2 hours'];
const MAX_ATTEMPTS = 3;

// Lazy-load sendMessageById to avoid circular deps
let _sendMessageById = null;
function getSendFn() {
  if (!_sendMessageById) {
    _sendMessageById = require('../routes/integrations').sendMessageById;
  }
  return _sendMessageById;
}

/**
 * Process all pending send_queue entries that are ready to run.
 * Called every 60 seconds from server/index.js.
 */
async function processSendQueue() {
  // Find up to 20 pending jobs ready to run now
  const res = await pool.query(
    `SELECT sq.id, sq.client_id, sq.message_id, sq.attempt_count
     FROM send_queue sq
     WHERE sq.status = 'pending'
       AND sq.next_retry_at <= NOW()
     ORDER BY sq.next_retry_at ASC
     LIMIT 20`
  );

  if (res.rows.length === 0) return;

  console.log(`[send_queue] Processing ${res.rows.length} pending message(s)`);

  for (const job of res.rows) {
    await processJob(job);
  }
}

async function processJob(job) {
  const { id, client_id, message_id, attempt_count } = job;

  // Mark as 'sending' (lock against concurrent workers)
  const lock = await pool.query(
    `UPDATE send_queue SET status = 'sending', last_attempted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id`,
    [id]
  );
  if (lock.rows.length === 0) return; // Another worker grabbed it

  try {
    const sendFn = getSendFn();
    await sendFn(client_id, message_id, 'auto');

    // Success
    await pool.query(
      `UPDATE send_queue SET status = 'sent', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    console.log(`[send_queue] Sent message ${message_id} (attempt ${attempt_count + 1})`);

  } catch (err) {
    const newAttemptCount = attempt_count + 1;
    console.warn(`[send_queue] Send failed for message ${message_id} (attempt ${newAttemptCount}):`, err.message);

    if (newAttemptCount >= MAX_ATTEMPTS) {
      // Final failure — mark dead, alert
      await pool.query(
        `UPDATE send_queue SET status = 'failed', attempt_count = $1,
         error_reason = $2, updated_at = NOW()
         WHERE id = $3`,
        [newAttemptCount, err.message, id]
      );

      // Log to activity log so admin sees it
      await logsService.createLog(client_id, {
        agent: 'system',
        action: 'send_failed_permanent',
        target_type: 'message',
        target_id: message_id,
        metadata: {
          attempts: newAttemptCount,
          error: err.message,
          alert: 'Message could not be sent after 3 attempts — manual intervention required',
        },
      }).catch(() => {});

      console.error(`[send_queue] PERMANENT FAILURE — message ${message_id} after ${newAttemptCount} attempts. Admin action required.`);
    } else {
      // Schedule retry with exponential backoff
      const interval = RETRY_INTERVALS[newAttemptCount - 1] || '2 hours';
      await pool.query(
        `UPDATE send_queue SET status = 'pending', attempt_count = $1,
         next_retry_at = NOW() + INTERVAL '${interval}',
         error_reason = $2, updated_at = NOW()
         WHERE id = $3`,
        [newAttemptCount, err.message, id]
      );
      console.log(`[send_queue] Retry scheduled in ${interval} for message ${message_id}`);
    }
  }
}

/**
 * Enqueue an approved message for auto-send.
 * Called from the approvals route when a message is approved.
 */
async function enqueueMessage(clientId, messageId) {
  await pool.query(
    `INSERT INTO send_queue (client_id, message_id, status, next_retry_at)
     VALUES ($1, $2, 'pending', NOW())
     ON CONFLICT (message_id) DO NOTHING`,
    [clientId, messageId]
  );
}

module.exports = { processSendQueue, enqueueMessage };
