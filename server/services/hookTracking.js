'use strict';

const pool = require('../db/pool');

/**
 * Record a hook/subject when a message is sent.
 * Upserts into hook_performance — increments times_used if the same
 * hook_text + channel + week already exists for this client.
 */
async function recordHook(clientId, { message_id, lead_id, channel, subject, hook_text }) {
  const text = hook_text || subject || '';
  if (!text) return null;

  // Compute Monday of the current week (UTC)
  const now = new Date();
  const day = now.getUTCDay();
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  const weekStart = monday.toISOString().slice(0, 10);

  const result = await pool.query(
    `INSERT INTO hook_performance (client_id, hook_text, channel, week_start, times_used)
     VALUES ($1, $2, $3, $4::date, 1)
     ON CONFLICT (client_id, hook_text, channel, week_start)
       DO UPDATE SET times_used = hook_performance.times_used + 1,
                     updated_at = NOW()
     RETURNING *`,
    [clientId, text, channel, weekStart]
  );

  // Note: The ON CONFLICT relies on a unique constraint on
  // (client_id, hook_text, channel, week_start). If the table
  // doesn't have one, this INSERT will create a new row each time
  // instead of upserting. A migration adding that constraint may
  // be needed — see note at bottom of this file.

  return result.rows[0] || null;
}

/**
 * Record that a reply was received for a message.
 * Finds the hook_performance row(s) matching the message's hook_text
 * and increments replies + recalculates reply_rate.
 *
 * Since hook_performance doesn't store message_id directly, we look up
 * the message's subject/hook from the messages table, then update the
 * matching hook_performance row for that client + channel + week.
 */
async function recordReply(clientId, { message_id }) {
  if (!message_id) return null;

  // Look up the original message to get its subject and channel
  const msgResult = await pool.query(
    `SELECT subject, channel, created_at FROM messages WHERE id = $1 AND client_id = $2`,
    [message_id, clientId]
  );
  if (!msgResult.rows.length) return null;

  const msg = msgResult.rows[0];
  const hookText = msg.subject;
  if (!hookText) return null;

  // Compute the week_start for when the message was sent
  const sent = new Date(msg.created_at);
  const day = sent.getUTCDay();
  const diff = (day + 6) % 7;
  const monday = new Date(Date.UTC(sent.getUTCFullYear(), sent.getUTCMonth(), sent.getUTCDate() - diff));
  const weekStart = monday.toISOString().slice(0, 10);

  const result = await pool.query(
    `UPDATE hook_performance
     SET replies    = replies + 1,
         reply_rate = ROUND(((replies + 1)::numeric / NULLIF(times_used, 0)) * 100, 2),
         updated_at = NOW()
     WHERE client_id = $1
       AND hook_text = $2
       AND channel   = $3
       AND week_start = $4::date
     RETURNING *`,
    [clientId, hookText, msg.channel, weekStart]
  );

  return result.rows[0] || null;
}

/**
 * Get hook performance leaderboard for a client.
 * Groups by hook_text, sums sent/replies across all weeks,
 * computes reply_rate, ordered by reply_rate DESC.
 */
async function getHookStats(clientId) {
  const result = await pool.query(
    `SELECT hook_text,
            channel,
            SUM(times_used)::int  AS total_sent,
            SUM(replies)::int     AS total_replies,
            CASE WHEN SUM(times_used) > 0
              THEN ROUND((SUM(replies)::numeric / SUM(times_used)) * 100, 2)
              ELSE 0
            END                   AS reply_rate,
            SUM(meetings)::int    AS total_meetings,
            BOOL_OR(is_current)   AS is_current
     FROM hook_performance
     WHERE client_id = $1
     GROUP BY hook_text, channel
     ORDER BY reply_rate DESC, total_sent DESC`,
    [clientId]
  );

  return result.rows;
}

module.exports = { recordHook, recordReply, getHookStats };

/*
 * MIGRATION NOTE:
 * The recordHook upsert relies on a unique constraint:
 *   UNIQUE (client_id, hook_text, channel, week_start)
 * If migration 025 did not create this constraint, a future migration
 * should add:
 *   ALTER TABLE hook_performance
 *     ADD CONSTRAINT uq_hook_perf_client_hook_channel_week
 *     UNIQUE (client_id, hook_text, channel, week_start);
 */
