'use strict';

/**
 * Cost-per-outcome rollup. The real ROI metric: $/sent, $/reply, $/meeting
 * per channel.
 *
 * Built on existing tables:
 *   - agent_outcomes (channel, outcome, lead_id, message_id, occurred_at)
 *   - llm_usage      (client_id, cost_usd, created_at)
 *
 * Wave 2 of the goal-hunting refactor (2026-05-03). After 4-6 weeks of data,
 * this answers: "is email or LinkedIn cheaper per meeting booked?" — which
 * is the input to revisiting the 30/20 channel-mix rule with evidence.
 */

const pool = require('../db/pool');

/**
 * Cost per outcome by channel over the last N days.
 * Returns shape:
 *   {
 *     period_days: 14,
 *     total_llm_spend_usd: 12.34,
 *     by_channel: {
 *       email:    { sent: 84, replied: 5, meetings: 1, cost_usd: 6.10, cpr: 1.22, cpm: 6.10 },
 *       linkedin: { sent: 50, replied: 3, meetings: 0, cost_usd: 6.24, cpr: 2.08, cpm: null },
 *     }
 *   }
 *
 * Note: cost is the ALL-IN llm_spend across the window divided proportionally
 * across channels by drafted-share. Approximate but useful for relative comparison.
 */
async function costPerOutcomeByChannel(clientId, days = 14) {
  const { rows: spendRow } = await pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::numeric(12,4) AS spend
     FROM llm_usage
     WHERE client_id = $1 AND created_at > NOW() - ($2 || ' days')::INTERVAL`,
    [clientId, String(days)]
  );
  const totalSpend = Number(spendRow[0].spend) || 0;

  const { rows: outcomeRows } = await pool.query(
    `SELECT
       COALESCE(channel, 'unknown') AS channel,
       COUNT(*) FILTER (WHERE outcome = 'drafted') AS drafted,
       COUNT(*) FILTER (WHERE outcome = 'sent')    AS sent,
       COUNT(*) FILTER (WHERE outcome = 'replied') AS replied,
       COUNT(*) FILTER (WHERE outcome = 'meeting_booked') AS meetings
     FROM agent_outcomes
     WHERE client_id = $1 AND occurred_at > NOW() - ($2 || ' days')::INTERVAL
     GROUP BY 1`,
    [clientId, String(days)]
  );

  const totalDrafted = outcomeRows.reduce((acc, r) => acc + Number(r.drafted), 0) || 1;

  const byChannel = {};
  for (const r of outcomeRows) {
    const drafted = Number(r.drafted) || 0;
    const channelSpend = totalDrafted > 0 ? totalSpend * (drafted / totalDrafted) : 0;
    const sent     = Number(r.sent) || 0;
    const replied  = Number(r.replied) || 0;
    const meetings = Number(r.meetings) || 0;
    byChannel[r.channel] = {
      drafted,
      sent,
      replied,
      meetings,
      cost_usd: Number(channelSpend.toFixed(4)),
      cost_per_sent:    sent     > 0 ? Number((channelSpend / sent).toFixed(4))    : null,
      cost_per_reply:   replied  > 0 ? Number((channelSpend / replied).toFixed(4)) : null,
      cost_per_meeting: meetings > 0 ? Number((channelSpend / meetings).toFixed(4)) : null,
    };
  }

  return {
    period_days: days,
    total_llm_spend_usd: Number(totalSpend.toFixed(4)),
    by_channel: byChannel,
  };
}

/**
 * One-line summary for the EOD brief. e.g.
 *   "14d ROI — email: $0.07/sent, $1.22/reply, $6.10/meeting · linkedin: $0.12/sent, $2.08/reply, no meetings"
 */
function formatRollupForBrief(rollup) {
  const parts = [];
  for (const [channel, m] of Object.entries(rollup.by_channel)) {
    if (channel === 'unknown') continue;
    const segs = [];
    if (m.cost_per_sent !== null)    segs.push(`$${m.cost_per_sent}/sent`);
    if (m.cost_per_reply !== null)   segs.push(`$${m.cost_per_reply}/reply`);
    if (m.cost_per_meeting !== null) segs.push(`$${m.cost_per_meeting}/meeting`);
    else if (m.sent > 0)             segs.push(`no meetings`);
    parts.push(`${channel}: ${segs.join(', ')}`);
  }
  if (parts.length === 0) return null;
  return `${rollup.period_days}d ROI — ${parts.join(' · ')}`;
}

module.exports = { costPerOutcomeByChannel, formatRollupForBrief };
