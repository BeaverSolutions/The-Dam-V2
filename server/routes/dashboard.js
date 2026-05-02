'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const gmailService = require('../services/gmail');
const apolloService = require('../services/apollo');
const agentmailService = require('../services/agentmail');
const hunterService = require('../services/hunter');

// GET /api/dashboard/stats
router.get('/stats', async (req, res, next) => {
  try {
    const clientId = req.clientId;

    const googleCalendarService = require('../services/googleCalendar');

    const [statsRes, calRes, integrationsResult] = await Promise.all([
      pool.query(`
        WITH
          leads_by_stage AS (
            SELECT pipeline_stage, COUNT(*) AS cnt
            FROM leads WHERE client_id = $1 AND deleted_at IS NULL
            GROUP BY pipeline_stage
          ),
          msgs_sent_all AS (
            SELECT COUNT(*) AS total FROM messages WHERE client_id = $1 AND status = 'sent'
          ),
          msgs_sent_30d AS (
            SELECT COUNT(*) AS total FROM messages
            WHERE client_id = $1 AND status = 'sent' AND sent_at >= NOW() - INTERVAL '30 days'
          ),
          replies_all AS (
            SELECT COUNT(DISTINCT lead_id) AS total
            FROM messages WHERE client_id = $1 AND reply_detected_at IS NOT NULL
          ),
          replies_30d AS (
            SELECT COUNT(DISTINCT lead_id) AS total
            FROM messages WHERE client_id = $1 AND reply_detected_at IS NOT NULL
              AND reply_detected_at >= NOW() - INTERVAL '30 days'
          ),
          msgs_pending AS (
            SELECT COUNT(*) AS total FROM approvals WHERE client_id = $1 AND status = 'pending'
          ),
          meetings_booked AS (
            SELECT COUNT(*) AS total FROM leads
            WHERE client_id = $1 AND pipeline_stage = 'meeting_booked' AND deleted_at IS NULL
          ),
          pool_health AS (
            SELECT COUNT(*) AS total FROM leads
            WHERE client_id = $1 AND deleted_at IS NULL
              AND pipeline_stage = 'prospecting'
              AND status = 'new'
              AND first_contacted_at IS NULL
          ),
          enforcer_reviewed_7d AS (
            SELECT COUNT(*) AS total FROM logs
            WHERE client_id = $1
              AND agent = 'ranger'
              AND action IN ('message_approved', 'message_rejected')
              AND created_at >= NOW() - INTERVAL '7 days'
          ),
          enforcer_passed_7d AS (
            SELECT COUNT(*) AS total FROM logs
            WHERE client_id = $1
              AND agent = 'ranger'
              AND action = 'message_approved'
              AND created_at >= NOW() - INTERVAL '7 days'
          ),
          sentiment_counts AS (
            SELECT
              COUNT(*) FILTER (WHERE metadata->>'reply_sentiment' = 'positive')  AS positive,
              COUNT(*) FILTER (WHERE metadata->>'reply_sentiment' = 'neutral')   AS neutral,
              COUNT(*) FILTER (WHERE metadata->>'reply_sentiment' = 'objection') AS objection,
              COUNT(*) FILTER (WHERE metadata->>'reply_sentiment' = 'no_fit')    AS no_fit
            FROM messages
            WHERE client_id = $1 AND metadata->>'reply_sentiment' IS NOT NULL
              AND created_at >= NOW() - INTERVAL '30 days'
          ),
          linkedin_awaiting AS (
            SELECT COUNT(*) AS total FROM messages
            WHERE client_id = $1 AND status = 'linkedin_requested'
          ),
          sourced_today AS (
            SELECT COUNT(*) AS total FROM leads
            WHERE client_id = $1 AND deleted_at IS NULL
              AND created_at::date = CURRENT_DATE
          ),
          in_flight AS (
            SELECT COUNT(DISTINCT lead_id) AS total FROM messages
            WHERE client_id = $1 AND status = 'sent' AND reply_detected_at IS NULL
          ),
          meetings_this_week AS (
            SELECT COUNT(*) AS total FROM calendar_events
            WHERE client_id = $1
              AND start_time >= date_trunc('week', CURRENT_DATE)
              AND start_time < date_trunc('week', CURRENT_DATE) + INTERVAL '7 days'
          ),
          meetings_next_7d AS (
            SELECT COUNT(*) AS total FROM calendar_events
            WHERE client_id = $1
              AND start_time >= NOW()
              AND start_time < NOW() + INTERVAL '7 days'
          )
        SELECT
          (SELECT total FROM msgs_sent_all)       AS sent_all_time,
          (SELECT total FROM msgs_sent_30d)        AS sent_30d,
          (SELECT total FROM replies_all)          AS replies_all_time,
          (SELECT total FROM replies_30d)          AS replies_30d,
          (SELECT total FROM msgs_pending)         AS pending_approvals,
          (SELECT total FROM meetings_booked)      AS meetings_booked,
          (SELECT total FROM pool_health)          AS pool_health,
          (SELECT total FROM enforcer_reviewed_7d) AS enforcer_reviewed,
          (SELECT total FROM enforcer_passed_7d)   AS enforcer_passed,
          (SELECT positive  FROM sentiment_counts) AS sentiment_positive,
          (SELECT neutral   FROM sentiment_counts) AS sentiment_neutral,
          (SELECT objection FROM sentiment_counts) AS sentiment_objection,
          (SELECT no_fit    FROM sentiment_counts) AS sentiment_no_fit,
          (SELECT json_object_agg(pipeline_stage, cnt) FROM leads_by_stage) AS leads_by_stage,
          (SELECT total FROM linkedin_awaiting)     AS awaiting_linkedin,
          (SELECT total FROM sourced_today)         AS sourced_today,
          (SELECT total FROM in_flight)             AS in_flight,
          (SELECT total FROM meetings_this_week)    AS meetings_this_week,
          (SELECT total FROM meetings_next_7d)      AS meetings_next_7d
      `, [clientId]),

      pool.query(
        `SELECT * FROM calendar_events WHERE client_id = $1 AND start_time::date = CURRENT_DATE ORDER BY start_time ASC`,
        [clientId]
      ),

      Promise.all([
        gmailService.isConnected(clientId).catch(() => false),
        gmailService.getConnectedEmail(clientId).catch(() => null),
        googleCalendarService.isConnected(clientId).catch(() => false),
        googleCalendarService.getConnectedEmail(clientId).catch(() => null),
        apolloService.getApiKey(clientId).then(k => !!k).catch(() => false),
        Promise.resolve(agentmailService.isConnected()),
        agentmailService.getInboxEmail(clientId).catch(() => null),
        hunterService.getApiKey(clientId).then(k => !!k).catch(() => false),
        googleCalendarService.getCalendlyUrl(clientId).catch(() => null),
      ]),
    ]);

    const stats = statsRes.rows[0];
    const [gmailConnected, gmailEmail, calendarConnected, calendarEmail, apolloConnected, agentmailConnected, agentmailEmail, hunterConnected, calendlyUrl] = integrationsResult;

    const byStage = stats.leads_by_stage || {};

    // Reply rates
    const sentAll = parseInt(stats.sent_all_time, 10) || 0;
    const sent30d = parseInt(stats.sent_30d, 10) || 0;
    const repliesAll = parseInt(stats.replies_all_time, 10) || 0;
    const replies30d = parseInt(stats.replies_30d, 10) || 0;
    const replyRateLifetime = sentAll > 0 ? +((repliesAll / sentAll) * 100).toFixed(1) : 0;
    const replyRate30d = sent30d > 0 ? +((replies30d / sent30d) * 100).toFixed(1) : 0;
    const replyRateTrend = replyRate30d > replyRateLifetime ? 'up' : replyRate30d < replyRateLifetime ? 'down' : 'flat';

    // Enforcer pass rate
    const enforcerReviewed = parseInt(stats.enforcer_reviewed, 10) || 0;
    const enforcerPassed = parseInt(stats.enforcer_passed, 10) || 0;
    const enforcerPassRate = enforcerReviewed > 0 ? Math.round((enforcerPassed / enforcerReviewed) * 100) : null;

    res.json({
      data: {
        // Outcome metrics (primary)
        reply_rate_lifetime: replyRateLifetime,
        reply_rate_30d: replyRate30d,
        reply_rate_trend: replyRateTrend,
        meetings_booked: parseInt(stats.meetings_booked, 10),
        pending_approvals: parseInt(stats.pending_approvals, 10),
        pool_health: parseInt(stats.pool_health, 10),
        awaiting_linkedin: parseInt(stats.awaiting_linkedin, 10) || 0,
        enforcer_pass_rate: enforcerPassRate,

        // Sentiment split (last 30d)
        reply_sentiments: {
          positive:  parseInt(stats.sentiment_positive, 10)  || 0,
          neutral:   parseInt(stats.sentiment_neutral, 10)   || 0,
          objection: parseInt(stats.sentiment_objection, 10) || 0,
          no_fit:    parseInt(stats.sentiment_no_fit, 10)    || 0,
        },

        // Pipeline
        leads_by_stage: byStage,
        meetings_today: calRes.rows.length,
        today_events: calRes.rows,

        // Engine feeds
        sourced_today: parseInt(stats.sourced_today, 10) || 0,
        in_flight: parseInt(stats.in_flight, 10) || 0,
        meetings_this_week: parseInt(stats.meetings_this_week, 10) || 0,
        meetings_next_7d: parseInt(stats.meetings_next_7d, 10) || 0,

        // Legacy fields kept for backward compat
        messages_sent: sentAll,
        leads_replied: repliesAll,

        integrations: {
          gmail:            { connected: gmailConnected,     email: gmailEmail },
          google_calendar:  { connected: calendarConnected,  email: calendarEmail },
          agentmail:        { connected: agentmailConnected, email: agentmailEmail },
          apollo:           { connected: apolloConnected },
          hunter:           { connected: hunterConnected },
          calendly:         { connected: !!calendlyUrl,      url: calendlyUrl },
        },
      },
    });
  } catch (err) { next(err); }
});

// GET /api/dashboard/daily-progress
// Returns today's KPI progress, upserts daily_kpi row
router.get('/daily-progress', async (req, res, next) => {
  try {
    const clientId = req.clientId;
    const today = new Date().toISOString().split('T')[0];

    // Ensure today's row exists
    await pool.query(
      `INSERT INTO daily_kpi (client_id, date) VALUES ($1, $2)
       ON CONFLICT (client_id, date) DO NOTHING`,
      [clientId, today]
    );

    // Count today's sent messages from the messages table
    const { rows: counts } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent' AND DATE(sent_at) = $2) AS email_sent,
         COUNT(*) FILTER (WHERE status = 'sent' AND DATE(sent_at) = $2 AND channel = 'linkedin') AS linkedin_sent
       FROM messages
       WHERE client_id = $1`,
      [clientId, today]
    );

    const emailSent = parseInt(counts[0].email_sent) || 0;
    const linkedinSent = parseInt(counts[0].linkedin_sent) || 0;
    const totalSent = emailSent + linkedinSent;

    await pool.query(
      `UPDATE daily_kpi SET
         outreach_sent = $1,
         outreach_email = $2,
         outreach_linkedin = $3,
         updated_at = NOW()
       WHERE client_id = $4 AND date = $5`,
      [totalSent, emailSent, linkedinSent, clientId, today]
    );

    const { rows: [kpi] } = await pool.query(
      `SELECT * FROM daily_kpi WHERE client_id = $1 AND date = $2`,
      [clientId, today]
    );

    const gap = Math.max(0, kpi.target - totalSent);

    res.json({
      data: {
        date: today,
        target: kpi.target,
        sent: totalSent,
        email: emailSent,
        linkedin: linkedinSent,
        gap,
        kpi_met: kpi.kpi_met,
        percentage: Math.min(100, Math.round((totalSent / kpi.target) * 100)),
      }
    });
  } catch (err) { next(err); }
});

// GET /api/dashboard/weekly-learnings
// Returns the most recent weekly_learnings record for the client
router.get('/weekly-learnings', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM weekly_learnings WHERE client_id = $1
       ORDER BY week_start DESC LIMIT 1`,
      [req.clientId]
    );
    res.json({ data: rows[0] || null });
  } catch (err) { next(err); }
});

// GET /api/dashboard/analytics
// Pipeline funnel metrics: reply rate, meeting conversion, weekly trends, reply sentiments
router.get('/analytics', async (req, res, next) => {
  try {
    const clientId = req.clientId;

    const [funnelRes, weeklyRes, sentimentRes, replyTrendRes] = await Promise.all([
      // Funnel counts
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent')                             AS total_sent,
          COUNT(*) FILTER (WHERE reply_detected_at IS NOT NULL)               AS total_replies,
          COUNT(DISTINCT lead_id) FILTER (WHERE reply_detected_at IS NOT NULL) AS leads_replied,
          COUNT(*) FILTER (WHERE metadata->>'is_reply' = 'true')              AS reply_drafts_generated
        FROM messages WHERE client_id = $1
      `, [clientId]),

      // Last 8 weeks of outreach + replies
      pool.query(`
        SELECT
          DATE_TRUNC('week', sent_at)::date AS week,
          COUNT(*) FILTER (WHERE status = 'sent')                    AS sent,
          COUNT(*) FILTER (WHERE reply_detected_at IS NOT NULL)       AS replies
        FROM messages
        WHERE client_id = $1 AND sent_at IS NOT NULL
          AND sent_at >= NOW() - INTERVAL '8 weeks'
        GROUP BY week ORDER BY week ASC
      `, [clientId]),

      // Reply sentiment breakdown
      pool.query(`
        SELECT
          metadata->>'reply_sentiment' AS sentiment,
          COUNT(*) AS count
        FROM messages
        WHERE client_id = $1
          AND metadata->>'reply_sentiment' IS NOT NULL
        GROUP BY sentiment
      `, [clientId]),

      // Meetings booked
      pool.query(`
        SELECT COUNT(*) AS total
        FROM leads
        WHERE client_id = $1 AND pipeline_stage = 'meeting_booked'
      `, [clientId]),
    ]);

    const funnel = funnelRes.rows[0];
    const totalSent = parseInt(funnel.total_sent, 10) || 0;
    const totalReplies = parseInt(funnel.total_replies, 10) || 0;
    const leadsReplied = parseInt(funnel.leads_replied, 10) || 0;
    const meetingsBooked = parseInt(replyTrendRes.rows[0]?.total || 0, 10);

    const replyRate = totalSent > 0 ? +((totalReplies / totalSent) * 100).toFixed(1) : 0;
    const meetingRate = totalReplies > 0 ? +((meetingsBooked / totalReplies) * 100).toFixed(1) : 0;

    const sentimentMap = {};
    for (const row of sentimentRes.rows) {
      if (row.sentiment) sentimentMap[row.sentiment] = parseInt(row.count, 10);
    }

    res.json({
      data: {
        funnel: {
          sent: totalSent,
          replies: totalReplies,
          leads_replied: leadsReplied,
          meetings_booked: meetingsBooked,
          reply_rate: replyRate,
          meeting_rate: meetingRate,
        },
        reply_sentiments: sentimentMap,
        weekly_trend: weeklyRes.rows.map(r => ({
          week: r.week,
          sent: parseInt(r.sent, 10),
          replies: parseInt(r.replies, 10),
          reply_rate: parseInt(r.sent, 10) > 0
            ? +((parseInt(r.replies, 10) / parseInt(r.sent, 10)) * 100).toFixed(1)
            : 0,
        })),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/dashboard/obsidian-export
// Returns markdown content for the 3 Obsidian learnings files
router.get('/obsidian-export', async (req, res, next) => {
  try {
    const clientId = req.clientId;
    const today = new Date().toISOString().split('T')[0];

    const [rangerLogsRes, weeklyRes, memoryRes, statsRes] = await Promise.all([
      // Last 30 Ranger rejections
      pool.query(
        `SELECT metadata, created_at FROM logs
         WHERE client_id = $1 AND agent = 'ranger' AND action = 'message_rejected'
         ORDER BY created_at DESC LIMIT 30`,
        [clientId]
      ),
      // Most recent weekly learnings
      pool.query(
        `SELECT * FROM weekly_learnings WHERE client_id = $1 ORDER BY week_start DESC LIMIT 1`,
        [clientId]
      ),
      // Agent memory entries
      pool.query(
        `SELECT agent, memory_type, key, content, updated_at FROM agent_memory
         WHERE client_id = $1 ORDER BY updated_at DESC`,
        [clientId]
      ),
      // Quick stats for weekly review
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '7 days') AS sent_week,
           COUNT(*) FILTER (WHERE reply_detected_at IS NOT NULL AND reply_detected_at >= NOW() - INTERVAL '7 days') AS replies_week
         FROM messages WHERE client_id = $1`,
        [clientId]
      ),
    ]);

    const stats = statsRes.rows[0];
    const sentWeek = parseInt(stats.sent_week) || 0;
    const repliesWeek = parseInt(stats.replies_week) || 0;
    const replyRate = sentWeek > 0 ? ((repliesWeek / sentWeek) * 100).toFixed(1) : '0';

    // ── ranger-patterns.md ─────────────────────────────────────
    const rejectionCounts = {};
    for (const row of rangerLogsRes.rows) {
      const reason = row.metadata?.reject_reason || row.metadata?.ranger_notes || 'unknown';
      const gate = reason.split(':')[0].trim();
      rejectionCounts[gate] = (rejectionCounts[gate] || 0) + 1;
    }
    const rangerPatterns = Object.entries(rejectionCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([gate, count]) => `- **${gate}** — ${count} rejection${count !== 1 ? 's' : ''}`)
      .join('\n') || '- No rejections logged yet';

    const rangerMd = `# Ranger Rejection Patterns\n_Last updated: ${today}_\n\n## Top Rejection Gates\n${rangerPatterns}\n\n## What This Means\nSales Beaver needs to focus on these rules before the next batch.\n`;

    // ── what-works.md ───────────────────────────────────────────
    const weekly = weeklyRes.rows[0];
    const whatWorksMd = weekly
      ? `# What Works\n_Week of ${weekly.week_start}_\n\n## Reply Rate\n${replyRate}% (${repliesWeek} replies from ${sentWeek} sent)\n\n## What Worked\n${weekly.what_worked || '_Not yet recorded_'}\n\n## What Didn't\n${weekly.what_didnt || '_Not yet recorded_'}\n\n## Agent Learnings\n${weekly.learnings || '_Not yet recorded_'}\n`
      : `# What Works\n_Last updated: ${today}_\n\n## This Week\n- Sent: ${sentWeek}\n- Replies: ${repliesWeek}\n- Reply rate: ${replyRate}%\n\n_No weekly review recorded yet. Complete one in Director Chat._\n`;

    // ── weekly-review.md ────────────────────────────────────────
    const memEntries = memoryRes.rows
      .filter(r => !['icp', 'client_persona'].includes(r.key))
      .slice(0, 10)
      .map(r => {
        let content = '';
        try {
          const parsed = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
          content = parsed?.text || parsed?.mistake || JSON.stringify(parsed).substring(0, 120);
        } catch { content = String(r.content || '').substring(0, 120); }
        return `- [${r.agent}] ${content}`;
      })
      .join('\n') || '- No memory entries yet';

    const weeklyMd = `# Weekly Review — ${today}\n\n## Numbers\n| Metric | Value |\n|--------|-------|\n| Messages sent (7d) | ${sentWeek} |\n| Replies (7d) | ${repliesWeek} |\n| Reply rate | ${replyRate}% |\n\n## Recent Agent Memory\n${memEntries}\n\n## Notes\n_Add your observations here_\n`;

    res.json({
      data: {
        files: [
          { path: '07 — Learnings/ranger-patterns.md', content: rangerMd },
          { path: '07 — Learnings/what-works.md',      content: whatWorksMd },
          { path: `07 — Learnings/weekly/${today}.md`, content: weeklyMd },
        ],
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/dashboard/llm-usage
// Returns today's LLM spend, budget, and breakdown by agent
router.get('/llm-usage', async (req, res, next) => {
  try {
    const clientId = req.clientId;

    const [spendRes, budgetRes, agentBreakdownRes, last7dRes] = await Promise.all([
      // Today's total spend
      pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS today_spend,
                COUNT(*) AS today_calls,
                COALESCE(SUM(input_tokens), 0) AS total_input,
                COALESCE(SUM(output_tokens), 0) AS total_output
         FROM llm_usage
         WHERE client_id = $1
           AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')`,
        [clientId]
      ),
      // Client's daily budget
      pool.query(
        `SELECT daily_budget_usd FROM clients WHERE id = $1`,
        [clientId]
      ),
      // Breakdown by agent (today)
      pool.query(
        `SELECT agent,
                COUNT(*) AS calls,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM llm_usage
         WHERE client_id = $1
           AND created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
         GROUP BY agent
         ORDER BY cost DESC`,
        [clientId]
      ),
      // Last 7 days daily totals
      pool.query(
        `SELECT created_at::date AS date,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COUNT(*) AS calls
         FROM llm_usage
         WHERE client_id = $1
           AND created_at >= NOW() - INTERVAL '7 days'
         GROUP BY date
         ORDER BY date ASC`,
        [clientId]
      ),
    ]);

    const todaySpend = parseFloat(spendRes.rows[0].today_spend);
    const budget = parseFloat(budgetRes.rows[0]?.daily_budget_usd || 10);
    const percentage = budget > 0 ? Math.min(100, Math.round((todaySpend / budget) * 100)) : 0;

    res.json({
      data: {
        today: {
          spend_usd: todaySpend,
          budget_usd: budget,
          percentage,
          calls: parseInt(spendRes.rows[0].today_calls, 10),
          input_tokens: parseInt(spendRes.rows[0].total_input, 10),
          output_tokens: parseInt(spendRes.rows[0].total_output, 10),
        },
        by_agent: agentBreakdownRes.rows.map(r => ({
          agent: r.agent,
          calls: parseInt(r.calls, 10),
          cost_usd: parseFloat(r.cost),
          input_tokens: parseInt(r.input_tokens, 10),
          output_tokens: parseInt(r.output_tokens, 10),
        })),
        last_7_days: last7dRes.rows.map(r => ({
          date: r.date,
          cost_usd: parseFloat(r.cost),
          calls: parseInt(r.calls, 10),
        })),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
