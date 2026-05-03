'use strict';

/**
 * Prompt-variant analysis. Captain's mid/long-term feedback loop on Sales
 * Beaver's drafting prompts.
 *
 * Wave 3 of the goal-hunting refactor (2026-05-03). Every Sales draft is
 * tagged in messages.metadata.prompt_variant. After 4-6 weeks of data this
 * answers: "which prompt variant produces the highest reply rate per channel?"
 * Captain quotes the rollup in the weekly review.
 */

const pool = require('../db/pool');

/**
 * Reply-rate-by-variant rollup over the last N days.
 * Returns: { period_days, by_variant: [{ variant, channel, sent, replied, reply_pct }] }
 *
 * Uses messages.metadata->>'prompt_variant' (string set by salesGenerate).
 * Joins to the same row's reply_detected_at (set by replyDetector).
 */
async function replyRateByVariant(clientId, days = 30) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(metadata->>'prompt_variant', '(untagged)') AS variant,
       channel,
       COUNT(*) FILTER (WHERE status = 'sent') AS sent,
       COUNT(*) FILTER (WHERE reply_detected_at IS NOT NULL) AS replied
     FROM messages
     WHERE client_id = $1
       AND created_at > NOW() - ($2 || ' days')::INTERVAL
       AND channel IS NOT NULL
     GROUP BY 1, 2
     HAVING COUNT(*) FILTER (WHERE status = 'sent') > 0
     ORDER BY variant, channel`,
    [clientId, String(days)]
  );

  return {
    period_days: days,
    by_variant: rows.map(r => ({
      variant:    r.variant,
      channel:    r.channel,
      sent:       Number(r.sent) || 0,
      replied:    Number(r.replied) || 0,
      reply_pct:  Number(r.sent) > 0
        ? Number(((Number(r.replied) / Number(r.sent)) * 100).toFixed(2))
        : 0,
    })),
  };
}

/**
 * Variant volume — useful when checking whether enough data has accumulated
 * to draw a conclusion. Returns count of drafted messages per variant.
 */
async function variantVolume(clientId, days = 30) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(metadata->>'prompt_variant', '(untagged)') AS variant,
       COUNT(*) AS drafted
     FROM messages
     WHERE client_id = $1
       AND created_at > NOW() - ($2 || ' days')::INTERVAL
     GROUP BY 1
     ORDER BY drafted DESC`,
    [clientId, String(days)]
  );
  return rows.map(r => ({ variant: r.variant, drafted: Number(r.drafted) || 0 }));
}

module.exports = { replyRateByVariant, variantVolume };
