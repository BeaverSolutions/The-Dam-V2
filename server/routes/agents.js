'use strict';

const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const agentsService = require('../services/agents');
const pool = require('../db/pool');

// ── MyClaw diagnostic: test connection with detailed error info ──
router.get('/myclaw/status', async (req, res) => {
  const myclaw = require('../services/myclaw');
  const axios = require('axios');
  const configured = myclaw.isConfigured();
  const baseUrl = process.env.MYCLAW_BASE_URL || '';
  const hasToken = !!process.env.MYCLAW_HOOK_TOKEN;

  if (!configured) {
    return res.json({ data: { configured: false, base_url: baseUrl || 'missing', token: hasToken ? 'set' : 'missing' } });
  }

  // Try multiple endpoint paths to find the right one
  const paths = ['/hooks/agent', '/hooks/wake', '/api/hooks/agent', '/api/v1/hooks/agent'];
  const results = {};

  for (const path of paths) {
    try {
      const url = `${baseUrl}${path}`;
      const resp = await axios.post(url,
        { message: 'ping', name: 'The Dam' },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.MYCLAW_HOOK_TOKEN}`,
            'x-openclaw-token': process.env.MYCLAW_HOOK_TOKEN,
          },
          timeout: 10000,
          validateStatus: () => true, // don't throw on 4xx/5xx
        }
      );
      results[path] = { status: resp.status, statusText: resp.statusText, data: typeof resp.data === 'string' ? resp.data.substring(0, 200) : resp.data };
    } catch (err) {
      results[path] = { error: err.code || err.message };
    }
  }

  return res.json({ data: { configured: true, base_url: baseUrl, token: 'set', endpoints_tested: results } });
});

router.post('/research/search',
  [body('query').notEmpty().trim(), validate],
  async (req, res, next) => {
    try {
      const result = await agentsService.researchSearch(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/sales/proposal/:leadId',
  [param('leadId').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await agentsService.salesProposal(req.clientId, req.params.leadId);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/sales/generate',
  [
    body('lead_id').isUUID(),
    body('channel').isIn(['email', 'linkedin', 'instagram']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await agentsService.salesGenerate(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/ranger/review',
  [body('message_id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await agentsService.rangerReview(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

// ── MyClaw chat prefix detection ──────────────────────────────────────────
const MYCLAW_PREFIX_RE = /^(?:@?(?:my)?claw|hey\s+claw|@?lodge(?:\s*master)?)[,:\s]*/i;

function isMyClawMessage(command) {
  return MYCLAW_PREFIX_RE.test(command.trim());
}

function stripMyClawPrefix(command) {
  return command.trim().replace(MYCLAW_PREFIX_RE, '').trim();
}

router.post('/director/plan',
  [body('command').notEmpty().trim(), validate],
  async (req, res, next) => {
    try {
      const { command } = req.body;

      // ── Route MyClaw-directed messages ──────────────────────
      if (isMyClawMessage(command)) {
        const myClawChat = require('../services/myClawChat');
        const result = await myClawChat.handleChat(req.clientId, stripMyClawPrefix(command));
        return res.json({ data: result });
      }

      const result = await agentsService.directorPlan(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.get('/director/brief',
  async (req, res, next) => {
    try {
      const result = await agentsService.directorBrief(req.clientId);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.get('/director/icp',
  async (req, res, next) => {
    try {
      const result = await agentsService.directorGetICP(req.clientId);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.put('/director/icp',
  [
    body('industries').optional().trim(),
    body('company_size').optional().trim(),
    body('geographies').optional().trim(),
    body('job_titles').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await agentsService.directorUpsertICP(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/director/execute',
  [body('plan_id').isUUID(), body('command').optional().trim(), validate],
  async (req, res, next) => {
    try {
      const clientId = req.clientId;
      const { plan_id } = req.body;
      const execKey = `exec_${plan_id}`;

      // Store executing state immediately
      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
         VALUES ($1, 'director', $2, $3::jsonb, 'config')
         ON CONFLICT (client_id, agent, key)
         DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
        [clientId, execKey, JSON.stringify({ status: 'executing', started_at: new Date().toISOString() })]
      );

      // Return immediately — don't block the HTTP request
      res.json({ data: { status: 'executing', plan_id } });

      // Run pipeline in background, store result when done
      agentsService.directorExecute(clientId, req.body)
        .then(result => pool.query(
          `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
           VALUES ($1, 'director', $2, $3::jsonb, 'config')
           ON CONFLICT (client_id, agent, key)
           DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
          [clientId, execKey, JSON.stringify({ status: 'completed', result, completed_at: new Date().toISOString() })]
        ))
        .catch(err => pool.query(
          `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
           VALUES ($1, 'director', $2, $3::jsonb, 'config')
           ON CONFLICT (client_id, agent, key)
           DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
          [clientId, execKey, JSON.stringify({ status: 'failed', error: err.message, failed_at: new Date().toISOString() })]
        ).catch(() => {}));
    } catch (err) { next(err); }
  }
);

// Poll endpoint — frontend calls every 3s to check execution status
router.get('/director/execute/:plan_id',
  [param('plan_id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = $2 LIMIT 1`,
        [req.clientId, `exec_${req.params.plan_id}`]
      );
      if (!result.rows.length) return res.json({ data: { status: 'not_found' } });
      res.json({ data: result.rows[0].content });
    } catch (err) { next(err); }
  }
);

/* ─── Client Persona ─────────────────────────────────────── */

router.get('/persona', async (req, res, next) => {
  try {
    const result = await agentsService.getClientPersona(req.clientId);
    res.json({ data: result });
  } catch (err) { next(err); }
});

router.put('/persona',
  [
    body('company_name').optional().trim(),
    body('company_description').optional().trim(),
    body('value_proposition').optional().trim(),
    body('tone').optional().trim(),
    body('differentiator').optional().trim(),
    body('social_proof').optional().trim(),
    body('cta_preference').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await agentsService.upsertClientPersona(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

/* ─── Smart Actions ──────────────────────────────────────── */

const smartActions = require('../services/smartActions');

// GET /api/agents/smart-actions/:leadId — available actions for this lead's stage
router.get('/smart-actions/:leadId', [param('leadId').isUUID(), validate], async (req, res, next) => {
  try {
    const result = await smartActions.getAvailableActions(req.clientId, req.params.leadId);
    res.json({ data: result });
  } catch (err) { next(err); }
});

// GET /api/agents/smart-actions/:leadId/:briefType — fetch a generated brief
router.get('/smart-actions/:leadId/:briefType', [param('leadId').isUUID(), validate], async (req, res, next) => {
  try {
    const brief = await smartActions.getBrief(req.clientId, req.params.leadId, req.params.briefType);
    if (!brief) return res.status(404).json({ error: 'Brief not generated yet', code: 'NOT_FOUND' });
    res.json({ data: brief });
  } catch (err) { next(err); }
});

// POST /api/agents/smart-actions/:leadId/:briefType — generate a brief
router.post('/smart-actions/:leadId/:briefType',
  [param('leadId').isUUID(), body('notes').optional().trim(), validate],
  async (req, res, next) => {
    try {
      const { leadId, briefType } = req.params;
      const options = req.body.notes ? { notes: req.body.notes } : {};
      const content = await smartActions.generateBrief(req.clientId, leadId, briefType, options);
      res.json({ data: content });
    } catch (err) { next(err); }
  }
);

// PUT /api/agents/leads/:leadId/meeting-date — set meeting date
router.put('/leads/:leadId/meeting-date',
  [param('leadId').isUUID(), body('meeting_date').notEmpty(), validate],
  async (req, res, next) => {
    try {
      const pool2 = require('../db/pool');
      await pool2.query(
        `UPDATE leads SET meeting_date = $1, pipeline_stage = 'meeting_booked', updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [req.body.meeting_date, req.params.leadId, req.clientId]
      );
      // Log meeting_booked event
      const logsService = require('../services/logs');
      await logsService.createLog(req.clientId, {
        agent: 'system',
        action: 'meeting_booked',
        target_type: 'lead',
        target_id: req.params.leadId,
        metadata: { meeting_date: req.body.meeting_date },
      });
      res.json({ data: { updated: true } });
    } catch (err) { next(err); }
  }
);

/* ─── Memory ─────────────────────────────────────────────── */

router.get('/memory', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, agent, memory_type, key, content, updated_at
       FROM agent_memory WHERE client_id = $1
         AND memory_type != 'secret'
       ORDER BY updated_at DESC`,
      [req.clientId]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

router.post('/memory/journal',
  [body('text').notEmpty().trim(), validate],
  async (req, res, next) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const content = JSON.stringify({ text: req.body.text, created_at: new Date().toISOString() });
      const result = await pool.query(
        `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
         VALUES ($1, 'system', 'journal', $2, $3)
         ON CONFLICT (client_id, agent, key)
         DO UPDATE SET content = agent_memory.content || $3::jsonb, updated_at = NOW()
         RETURNING *`,
        [req.clientId, today, content]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

router.delete('/memory/:id', [param('id').isUUID(), validate], async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM agent_memory WHERE id = $1 AND client_id = $2`,
      [req.params.id, req.clientId]
    );
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

/* ─── Win/Loss Capture ──────────────────────────────────── */

router.post('/director/win-loss',
  [
    body('lead_id').isUUID(),
    body('outcome').isIn(['won', 'lost', 'cold']),
    body('notes').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await agentsService.captureWinLoss(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

/* ─── Hook Performance ──────────────────────────────────── */

const hookTracking = require('../services/hookTracking');

// GET /api/agents/hook-stats — hook performance leaderboard
router.get('/hook-stats', async (req, res, next) => {
  try {
    const result = await hookTracking.getHookStats(req.clientId);
    res.json({ data: result });
  } catch (err) { next(err); }
});

/* ─── KPIs ───────────────────────────────────────────────── */

router.get('/kpis', async (req, res, next) => {
  try {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    weekStart.setHours(0, 0, 0, 0);

    const [sent, replies, leads, messages, weekLeads, weekMessages] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM messages WHERE client_id=$1 AND status='sent'`, [req.clientId]),
      pool.query(`SELECT COUNT(*) FROM messages WHERE client_id=$1 AND status='replied'`, [req.clientId]),
      pool.query(`SELECT COUNT(*) FROM leads WHERE client_id=$1 AND deleted_at IS NULL`, [req.clientId]),
      pool.query(`SELECT COUNT(*) FROM messages WHERE client_id=$1`, [req.clientId]),
      pool.query(`SELECT COUNT(*) FROM leads WHERE client_id=$1 AND created_at >= $2 AND deleted_at IS NULL`, [req.clientId, weekStart]),
      pool.query(`SELECT COUNT(*) FROM messages WHERE client_id=$1 AND created_at >= $2`, [req.clientId, weekStart]),
    ]);

    const totalSent = parseInt(sent.rows[0].count);
    const totalReplies = parseInt(replies.rows[0].count);
    const totalLeads = parseInt(leads.rows[0].count);
    const totalMessages = parseInt(messages.rows[0].count);
    const weekLeadsCount = parseInt(weekLeads.rows[0].count);
    const weekMessagesCount = parseInt(weekMessages.rows[0].count);

    // Query actual stats from DB instead of fabricating
    const weekRejected = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE client_id = $1 AND status = 'ranger_rejected' AND created_at >= NOW() - INTERVAL '7 days'`,
      [req.clientId]
    );
    const weekApproved = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE client_id = $1 AND status IN ('approved', 'sent', 'pending_approval') AND created_at >= NOW() - INTERVAL '7 days'`,
      [req.clientId]
    );
    const avgScore = await pool.query(
      `SELECT COALESCE(AVG(ranger_score), 0)::int AS avg FROM messages WHERE client_id = $1 AND ranger_score IS NOT NULL`,
      [req.clientId]
    );
    const weekSent = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE client_id = $1 AND status = 'sent' AND sent_at >= NOW() - INTERVAL '7 days'`,
      [req.clientId]
    );

    const weekRejectedCount = parseInt(weekRejected.rows[0].count);
    const weekApprovedCount = parseInt(weekApproved.rows[0].count);
    const weekSentCount = parseInt(weekSent.rows[0].count);
    const passRate = weekMessagesCount > 0 ? Math.round((weekApprovedCount / weekMessagesCount) * 100) : 0;
    const replyRate = weekSentCount > 0 ? Math.round((totalReplies / Math.max(totalSent, 1)) * 100) : 0;

    res.json({ data: {
      research: {
        week: { found: weekLeadsCount, passed: weekLeadsCount, rejected: 0 },
        lifetime: { total: totalLeads, quality_rate: totalLeads > 0 ? Math.round((totalLeads / Math.max(totalLeads, 1)) * 100) : 0, best_source: 'Apollo' },
      },
      sales: {
        week: { drafted: weekMessagesCount, approved: weekApprovedCount, failed: weekRejectedCount },
        lifetime: { total: totalMessages, pass_rate: passRate, best_channel: 'Email' },
      },
      enforcer: {
        week: { reviewed: weekMessagesCount, rejected: weekRejectedCount, rewrite_rate: weekMessagesCount > 0 ? Math.round((weekRejectedCount / weekMessagesCount) * 100) : 0 },
        lifetime: { total: totalMessages, avg_score: avgScore.rows[0].avg, top_rejection: 'Word count' },
      },
      captain: {
        week: { sent: weekSentCount, replies: totalReplies, reply_rate: replyRate, meetings: 0 },
        lifetime: { total_sent: totalSent, total_meetings: 0, best_hook: 'N/A' },
      },
    }});
  } catch (err) { next(err); }
});

module.exports = router;
