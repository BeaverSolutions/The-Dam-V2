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

module.exports = router;
