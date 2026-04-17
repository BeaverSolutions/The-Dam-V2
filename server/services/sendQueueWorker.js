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

// Safety: max emails per client per day (prevents rogue agent runs from spamming)
const MAX_DAILY_SENDS_PER_CLIENT = parseInt(process.env.MAX_DAILY_SENDS || '200', 10);

// Basic email domain validation — rejects obviously invalid addresses
const EMAIL_DOMAIN_RE = /^[^@]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

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
    const result = await sendFn(client_id, message_id, 'auto');

    // sendMessageById returns { status: 'sent'|'failed'|'simulated' } instead of throwing
    // on expected failures (Gmail 401/429/5xx, bad email, etc.). Without checking the
    // return value, a failed send would incorrectly mark the queue entry as 'sent'.
    if (result && result.status === 'failed') {
      const err = new Error(result.reason || 'Send failed');
      err.failureClass = result.failure_class || 'unknown';
      err.reauthRequired = !!result.reauth_required;
      throw err;
    }

    // Success (or simulated — both are terminal states for the queue entry)
    await pool.query(
      `UPDATE send_queue SET status = 'sent', updated_at = NOW() WHERE id = $1`,
      [id]
    );
    console.log(`[send_queue] Sent message ${message_id} (attempt ${attempt_count + 1})`);

  } catch (err) {
    const newAttemptCount = attempt_count + 1;
    const errMsg = String(err.message || '');
    const errStatus = err.status || 0;
    console.warn(`[send_queue] Send failed for message ${message_id} (attempt ${newAttemptCount}, class=${err.failureClass || 'thrown'}):`, errMsg);

    // Terminal success: message was already sent (HTTP 409 from sendMessageById's
    // FOR UPDATE status check). Happens when attempt 1 actually shipped the email
    // but the queue 'sent' update didn't land (process restart, DB hiccup, etc).
    // Retrying just thrashes — the email is already out the door.
    if (errStatus === 409 || /already sent/i.test(errMsg)) {
      await pool.query(
        `UPDATE send_queue SET status = 'sent', error_reason = 'already_sent_reconciled', updated_at = NOW()
         WHERE id = $1`,
        [id]
      );
      console.log(`[send_queue] Message ${message_id} was already sent — queue reconciled, no retry`);
      return;
    }

    // Other terminal non-retryable states — skip the retry ladder:
    // 404 message not found, 400 wrong status, bad email format. Retrying these
    // just burns attempts; let it fail fast so the operator sees the real reason.
    if (errStatus === 404 || errStatus === 400 ||
        /not found|must be approved|no lead email|invalid.*email/i.test(errMsg)) {
      await pool.query(
        `UPDATE send_queue SET status = 'failed', attempt_count = $1,
         error_reason = $2, updated_at = NOW()
         WHERE id = $3`,
        [newAttemptCount, errMsg, id]
      );
      await logsService.createLog(client_id, {
        agent: 'system',
        action: 'send_failed_permanent',
        target_type: 'message',
        target_id: message_id,
        metadata: { error: errMsg, status: errStatus, reason: 'terminal_state' },
      }).catch(() => {});
      console.warn(`[send_queue] Terminal state — ${message_id} will not be retried: ${errMsg}`);
      return;
    }

    // Reauth-required failures are permanent until the user reconnects their provider.
    // No point burning retries — fail fast and surface the alert so operator reconnects.
    const forcePermanent = err.reauthRequired === true || err.failureClass === 'permanent';

    if (forcePermanent || newAttemptCount >= MAX_ATTEMPTS) {
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
          failure_class: err.failureClass || 'thrown',
          reauth_required: err.reauthRequired === true,
          alert: err.reauthRequired
            ? 'Email provider token expired/revoked — reconnect Gmail in Settings to resume sending'
            : 'Message could not be sent after 3 attempts — manual intervention required',
        },
      }).catch(() => {});

      console.error(`[send_queue] PERMANENT FAILURE — message ${message_id} after ${newAttemptCount} attempts (${err.failureClass || 'thrown'}). Admin action required.`);
    } else {
      // Schedule retry with exponential backoff — rate-limited uses the longer interval up front
      const retryIndex = err.failureClass === 'rate_limited'
        ? Math.min(newAttemptCount, RETRY_INTERVALS.length - 1)
        : newAttemptCount - 1;
      const interval = RETRY_INTERVALS[retryIndex] || '2 hours';
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
 *
 * Channel guard: only EMAIL messages get enqueued. LinkedIn / Instagram
 * messages are manual-send by design (BeavrDam has no Playwright automation
 * per Phase 1 scope) — they live in the Approved tab with a copy button.
 * Returns { enqueued: bool, reason?: string } so callers can log.
 */
async function enqueueMessage(clientId, messageId) {
  // Look up the channel + lead email before enqueuing.
  const { rows } = await pool.query(
    `SELECT m.channel, l.email AS lead_email
     FROM messages m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.id = $1 AND m.client_id = $2 LIMIT 1`,
    [messageId, clientId]
  );
  if (rows.length === 0) {
    console.warn(`[send_queue] enqueueMessage: message ${messageId} not found`);
    return { enqueued: false, reason: 'not_found' };
  }

  const { channel, lead_email } = rows[0];
  if (channel !== 'email') {
    console.log(`[send_queue] Skip enqueue: ${messageId} is ${channel} (manual-send channel)`);
    return { enqueued: false, reason: `manual_send_channel:${channel}` };
  }
  if (!lead_email || lead_email === 'unknown@example.com') {
    console.log(`[send_queue] Skip enqueue: ${messageId} has no lead email`);
    return { enqueued: false, reason: 'no_email' };
  }

  // P0 gate: reject obviously invalid email addresses
  if (!EMAIL_DOMAIN_RE.test(lead_email)) {
    console.warn(`[send_queue] Skip enqueue: ${messageId} — invalid email format`);
    return { enqueued: false, reason: 'invalid_email_format' };
  }

  // P0 gate: enforce daily send cap per client (prevents rogue agent spam)
  const { rows: [{ count: dailyCount }] } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM send_queue
     WHERE client_id = $1 AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    [clientId]
  );
  if (dailyCount >= MAX_DAILY_SENDS_PER_CLIENT) {
    console.warn(`[send_queue] DAILY LIMIT HIT — client ${clientId} has ${dailyCount} sends today (cap: ${MAX_DAILY_SENDS_PER_CLIENT})`);
    return { enqueued: false, reason: 'daily_limit_reached' };
  }

  await pool.query(
    `INSERT INTO send_queue (client_id, message_id, status, next_retry_at)
     VALUES ($1, $2, 'pending', NOW())
     ON CONFLICT (message_id) DO NOTHING`,
    [clientId, messageId]
  );
  return { enqueued: true };
}

module.exports = { processSendQueue, enqueueMessage };
