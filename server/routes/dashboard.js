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

    const [statsRes, calRes, integrationsResult] = await Promise.all([
      pool.query(`
        WITH
          leads_total AS (
            SELECT COUNT(*) AS total FROM leads WHERE client_id = $1 AND deleted_at IS NULL
          ),
          leads_week AS (
            SELECT COUNT(*) AS total FROM leads
            WHERE client_id = $1 AND deleted_at IS NULL
              AND created_at >= NOW() - INTERVAL '7 days'
          ),
          leads_by_stage AS (
            SELECT pipeline_stage, COUNT(*) AS cnt
            FROM leads WHERE client_id = $1 AND deleted_at IS NULL
            GROUP BY pipeline_stage
          ),
          leads_replied AS (
            SELECT COUNT(DISTINCT lead_id) AS total
            FROM messages WHERE client_id = $1 AND reply_detected_at IS NOT NULL
          ),
          msgs_sent AS (
            SELECT COUNT(*) AS total FROM messages WHERE client_id = $1 AND status = 'sent'
          ),
          msgs_all AS (
            SELECT COUNT(*) AS total FROM messages WHERE client_id = $1
          ),
          msgs_pending AS (
            SELECT COUNT(*) AS total FROM approvals WHERE client_id = $1 AND status = 'pending'
          ),
          activity_today AS (
            SELECT COUNT(*) AS total FROM logs
            WHERE client_id = $1 AND created_at::date = CURRENT_DATE
          ),
          activity_week AS (
            SELECT COUNT(*) AS total FROM logs
            WHERE client_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
          )
        SELECT
          (SELECT total FROM leads_total)   AS total_leads,
          (SELECT total FROM leads_week)    AS leads_this_week,
          (SELECT total FROM leads_replied) AS leads_replied,
          (SELECT total FROM msgs_sent)     AS messages_sent,
          (SELECT total FROM msgs_all)      AS total_messages,
          (SELECT total FROM msgs_pending)  AS pending_approvals,
          (SELECT total FROM activity_today) AS activity_today,
          (SELECT total FROM activity_week)  AS activity_week,
          (SELECT json_object_agg(pipeline_stage, cnt) FROM leads_by_stage) AS leads_by_stage
      `, [clientId]),

      pool.query(
        `SELECT * FROM calendar_events WHERE client_id = $1 AND start_time::date = CURRENT_DATE ORDER BY start_time ASC`,
        [clientId]
      ),

      Promise.all([
        gmailService.isConnected(clientId).catch(() => false),
        gmailService.getConnectedEmail(clientId).catch(() => null),
        apolloService.getApiKey(clientId).then(k => !!k).catch(() => false),
        Promise.resolve(agentmailService.isConnected()),
        agentmailService.getInboxEmail(clientId).catch(() => null),
        hunterService.getApiKey(clientId).then(k => !!k).catch(() => false),
      ]),
    ]);

    const stats = statsRes.rows[0];
    const [gmailConnected, gmailEmail, apolloConnected, agentmailConnected, agentmailEmail, hunterConnected] = integrationsResult;

    const byStage = stats.leads_by_stage || {};

    // Conversion rate: leads that moved past prospecting / total leads
    const totalLeads = parseInt(stats.total_leads, 10);
    const prospecting = parseInt(byStage.prospecting || 0, 10);
    const conversionRate = totalLeads > 0
      ? Math.round(((totalLeads - prospecting) / totalLeads) * 100)
      : 0;

    res.json({
      data: {
        total_leads: totalLeads,
        leads_this_week: parseInt(stats.leads_this_week, 10),
        leads_replied: parseInt(stats.leads_replied, 10),
        messages_sent: parseInt(stats.messages_sent, 10),
        total_messages: parseInt(stats.total_messages, 10),
        pending_approvals: parseInt(stats.pending_approvals, 10),
        activity_today: parseInt(stats.activity_today, 10),
        activity_week: parseInt(stats.activity_week, 10),
        meetings_today: calRes.rows.length,
        today_events: calRes.rows,
        leads_by_stage: byStage,
        conversion_rate: conversionRate,
        integrations: {
          gmail: { connected: gmailConnected, email: gmailEmail },
          agentmail: { connected: agentmailConnected, email: agentmailEmail },
          apollo: { connected: apolloConnected },
          hunter: { connected: hunterConnected },
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

module.exports = router;
