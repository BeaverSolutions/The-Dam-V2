'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const agentsService = require('../services/agents');
const { directorExecute, rangerReview } = agentsService;
const { runWithClientContext } = require('../middleware/clientContext');
const logger = require('../utils/logger');

/* ─── Auth helper ─────────────────────────────────────────── */

// Strict UUID v1-v5 validator — rejects malformed input before it reaches SQL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function requireInternalKey(req, res, next) {
  const { safeCompare } = require('../utils/crypto');
  const key = req.headers['x-internal-key'];
  if (!process.env.INTERNAL_API_KEY || !safeCompare(key, process.env.INTERNAL_API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_KEY' });
  }

  // Validate client_id format if supplied — reject bad UUIDs before any DB query
  // so we don't log or trace untrusted input through the system.
  const clientId = req.body?.client_id || req.query?.client_id;
  if (clientId && !UUID_RE.test(String(clientId))) {
    return res.status(400).json({ error: 'Invalid client_id format', code: 'INVALID_CLIENT_ID' });
  }

  // Gate by client whitelist (env: AUTONOMOUS_ENABLED_CLIENTS=beaver-solutions,trl)
  const whitelist = (process.env.AUTONOMOUS_ENABLED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (whitelist.length > 0) {
    if (clientId) {
      const { rows } = await pool.query('SELECT slug FROM clients WHERE id = $1', [clientId]);
      const slug = rows[0]?.slug;
      if (!slug || !whitelist.includes(slug)) {
        logger.warn(`[autonomous] Blocked client ${slug || clientId} — not in AUTONOMOUS_ENABLED_CLIENTS`);
        return res.status(403).json({ error: 'Autonomous pipeline disabled for this client', code: 'CLIENT_NOT_ENABLED' });
      }
    }
  }

  next();
}

/* ─── POST /api/autonomous/chat ───────────────────────────
 * Claw ↔ Dam conversational bot endpoint.
 * Mounted here (not under /api/myclaw) so Claw's existing DAM_INTERNAL_KEY
 * works — no new secret to manage.
 *
 * Body: { client_id, message, thread_id?, context? }
 * Returns: { data: { reply, actions_taken, data, thread_id } }
 *
 * Intents:
 *   - status/kpi   → live DB query, returns sent/pending/leads_today
 *   - kickoff/run  → fires directorExecute in background, returns plan_id
 *   - approvals    → lists pending approvals with ranger scores
 *   - signal hunt  → fires runSignalHunt in background
 *   - research     → fires Research Beaver only with custom brief
 *   - pause/resume → pauses send queue or specific leads
 *   - fallback     → help text
 */
router.post('/chat', requireInternalKey, async (req, res, next) => {
  try {
    const { client_id, message, thread_id = null, context = {} } = req.body;
    if (!client_id || !message) {
      return res.status(400).json({ error: 'client_id and message required', code: 'MISSING_FIELDS' });
    }

    const logsService = require('../services/logs');
    await logsService.createLog(client_id, {
      agent: 'captain',
      action: 'chat_inbound',
      metadata: { message: message.substring(0, 500), thread_id, source: 'claw_chat' },
    });

    const lowerMsg = message.toLowerCase().trim();
    const response = {
      reply: '',
      actions_taken: [],
      data: {},
      thread_id: thread_id || `thread_${Date.now()}`,
    };

    // ── Intent 1: KPI / STATUS ───────────────────────────────────────
    if (/\b(kpi|status|progress|sent today|how (many|much)|dashboard|stats|telemetry)\b/i.test(lowerMsg)) {
      const today = new Date().toISOString().split('T')[0];
      const { rows: [counts] } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'sent' AND DATE(sent_at) = $2)                   AS sent_today,
           COUNT(*) FILTER (WHERE status = 'pending_approval' AND DATE(created_at) = $2)    AS pending,
           COUNT(*) FILTER (WHERE status = 'approved' AND DATE(created_at) = $2)            AS approved_awaiting_send,
           COUNT(*) FILTER (WHERE status = 'ranger_rejected' AND DATE(created_at) = $2)     AS rejected,
           COUNT(*) FILTER (WHERE status = 'replied')                                       AS total_replied
         FROM messages WHERE client_id = $1`,
        [client_id, today]
      );
      const { rows: [leadCounts] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE DATE(created_at) = $2) AS leads_today
         FROM leads WHERE client_id = $1 AND deleted_at IS NULL`,
        [client_id, today]
      );
      const { rows: [kpiRow] } = await pool.query(
        `SELECT target FROM daily_kpi WHERE client_id = $1 AND date = $2`,
        [client_id, today]
      );
      const target = kpiRow?.target || 50;

      response.data = {
        date: today,
        target,
        sent_today: parseInt(counts.sent_today) || 0,
        pending_approval: parseInt(counts.pending) || 0,
        approved_awaiting_send: parseInt(counts.approved_awaiting_send) || 0,
        rejected_today: parseInt(counts.rejected) || 0,
        leads_today: parseInt(leadCounts.leads_today) || 0,
        total_replied_lifetime: parseInt(counts.total_replied) || 0,
      };
      response.reply = `Status for ${today}: ${response.data.sent_today}/${target} sent. ${response.data.pending_approval} pending approval. ${response.data.leads_today} leads sourced today. ${response.data.rejected_today} rejected.`;
      response.actions_taken.push('queried_daily_stats');
    }

    // ── Intent 2: KICKOFF / EXECUTE ──────────────────────────────────
    else if (/\b(kickoff|kick off|start|execute|fire|begin|find.*(lead|founder|ceo|director|agency|agencies))\b/i.test(lowerMsg)) {
      // Calendar gate — must have Google Calendar OR Calendly connected
      const calendarService = require('../services/googleCalendar');
      const hasCalendar = await calendarService.hasAnyCalendar(client_id);
      if (!hasCalendar) {
        return res.status(403).json({
          error: 'Connect Google Calendar or Calendly in Settings before running campaigns',
          code: 'CALENDAR_REQUIRED',
        });
      }
      const planId = uuidv4();

      // If command has a number (e.g. "find 20 leads"), directorExecute parses it.
      // If bare "kickoff" with no number, default to 20 leads instead of 5.
      const hasNumber = /\b\d+\b/.test(message);
      const effectiveLimit = hasNumber ? undefined : 20;

      // Build an ICP-rich brief (same as autonomous kickoff) so Research Beaver
      // gets real context instead of the bare word "KICKOFF".
      let effectiveCommand = message;
      const isBareKickoff = /^(kickoff|kick\s*off|start|execute|fire|begin)[\s!.]*$/i.test(message.trim());
      if (isBareKickoff) {
        try {
          const icp = await agentsService.directorGetICP(client_id);
          const gap = effectiveLimit || 20;
          effectiveCommand = buildAutonomousBrief({
            gap,
            icp,
            lastLearnings: null,
            rejectionPatterns: null,
            sent: 0,
            target: gap,
          });
          console.log(`[chat] Bare kickoff → built ICP brief (${effectiveCommand.length} chars)`);
        } catch (err) {
          console.warn('[chat] Failed to build ICP brief, using raw command:', err.message);
        }
      }

      response.data = { plan_id: planId };

      // DB-first: check if we already have uncontacted leads in the pool
      let usedDbPool = false;
      try {
        const poolLimit = effectiveLimit || 20;
        const { rows: poolLeads } = await pool.query(
          `SELECT id, name, company, title, signal_tier, email, linkedin_url
           FROM leads
           WHERE client_id = $1
             AND pipeline_stage = 'prospecting'
             AND status = 'new'
             AND (first_contacted_at IS NULL OR first_contacted_at < NOW() - INTERVAL '14 days')
             AND deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.lead_id = leads.id AND m.client_id = leads.client_id
                 AND m.status IN ('pending_ranger', 'pending_approval', 'approved', 'pending_send', 'sending', 'sent')
             )
           ORDER BY
             CASE WHEN signal_tier = 'P1' THEN 1 WHEN signal_tier = 'P2' THEN 2 ELSE 3 END,
             CASE WHEN email IS NOT NULL THEN 0 ELSE 1 END,
             score DESC
           LIMIT $2`,
          [client_id, poolLimit]
        );

        if (poolLeads.length >= 5) {
          usedDbPool = true;
          console.log(`[chat] DB pool has ${poolLeads.length} leads — using pool instead of fresh research`);
          response.reply = `Found ${poolLeads.length} leads in the database. Processing through Sales → Enforcer now. No fresh research needed.`;
          response.actions_taken.push('db_pool_draw');

          runWithClientContext(client_id, () =>
            directorExecute(client_id, {
              plan_id: planId,
              command: `DB-POOL BATCH: Process ${poolLeads.length} pre-researched leads from the lead pool. Draft outreach using any signal/angle data in their metadata.`,
              use_existing_leads: poolLeads.map(l => l.id),
              limit: poolLeads.length,
            }).catch(err => {
              console.error(`[chat] DB pool directorExecute failed:`, err.message);
            })
          );
        }
      } catch (err) {
        console.warn('[chat] DB pool check failed, falling back to research:', err.message);
      }

      // Fallback: cold research if DB pool insufficient
      if (!usedDbPool) {
        response.reply = `Dispatching to the crew. Captain is briefing Research Beaver now. Poll back with "status" in 60s.`;
        response.actions_taken.push('triggered_director_execute');

        runWithClientContext(client_id, () =>
          directorExecute(client_id, { plan_id: planId, command: effectiveCommand, limit: effectiveLimit }).catch(err => {
            console.error(`[chat] directorExecute failed for plan ${planId}:`, err.message);
          })
        );
      }
    }

    // ── Intent 3: APPROVALS query ────────────────────────────────────
    else if (/\b(approval|pending|awaiting|queue)\b/i.test(lowerMsg)) {
      const { rows } = await pool.query(
        `SELECT a.id, m.subject, m.body, l.name AS lead_name, l.company, m.ranger_score
         FROM approvals a
         JOIN messages m ON m.id = a.message_id
         JOIN leads l ON l.id = m.lead_id
         WHERE a.client_id = $1 AND a.status = 'pending'
         ORDER BY a.created_at DESC LIMIT 10`,
        [client_id]
      );
      response.data = { approvals: rows, count: rows.length };
      response.reply = `${rows.length} messages waiting for approval.`;
      response.actions_taken.push('listed_pending_approvals');
    }

    // ── Intent 4: SIGNAL HUNT ────────────────────────────────────────
    else if (/\b(signal|hunt|hiring|funding|trigger|buying)\b/i.test(lowerMsg)) {
      const { runSignalHunt, saveSignalLeads } = require('../services/signalHunt');

      // Load ICP for signal hunt
      const { rows: icpRows } = await pool.query(
        `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
        [client_id]
      );
      const icp = icpRows[0]?.content || {};

      response.reply = `Running signal hunt in the background — scanning news + LinkedIn jobs for buying triggers. Target: 20 P1/P2 leads. Check back with "status" in 2-3 minutes.`;
      response.actions_taken.push('triggered_signal_hunt');

      runWithClientContext(client_id, () =>
        (async () => {
          try {
            const leads = await runSignalHunt(client_id, { maxLeads: 20, icp });
            if (leads.length > 0) {
              const saved = await saveSignalLeads(client_id, leads);
              console.log(`[chat] Signal hunt saved ${saved.length} leads for ${client_id}`);

              // Auto-trigger outreach on signal-sourced leads
              if (saved.length > 0) {
                await directorExecute(client_id, {
                  plan_id: uuidv4(),
                  command: `SIGNAL-SOURCED BATCH: Process ${saved.length} pre-qualified leads already saved with P1/P2 signals.`,
                  use_existing_leads: saved.map(l => l.id),
                });
              }
            }
          } catch (err) {
            console.error('[chat] Signal hunt background failed:', err.message);
          }
        })()
      );
    }

    // ── Intent 5: RECENT REPLIES ─────────────────────────────────────
    else if (/\b(repl(y|ies|ied)|respond(ed)?|answer(ed)?)\b/i.test(lowerMsg)) {
      const { rows } = await pool.query(
        `SELECT l.name AS lead_name, l.company, m.body AS reply_body, m.created_at,
                m.metadata->>'classification' AS classification
         FROM messages m
         JOIN leads l ON l.id = m.lead_id
         WHERE m.client_id = $1 AND m.status = 'replied'
           AND m.created_at >= NOW() - INTERVAL '48 hours'
         ORDER BY m.created_at DESC LIMIT 10`,
        [client_id]
      );
      response.data = { replies: rows, count: rows.length };
      response.reply = `${rows.length} replies in the last 48 hours.`;
      response.actions_taken.push('listed_recent_replies');
    }

    // ── Intent 6: MEMORY read ────────────────────────────────────────
    else if (/\b(icp|memory|config|learnings|what.*targeting)\b/i.test(lowerMsg)) {
      const { rows } = await pool.query(
        `SELECT agent, key, content, updated_at FROM agent_memory
         WHERE client_id = $1 AND memory_type != 'secret'
         ORDER BY updated_at DESC LIMIT 20`,
        [client_id]
      );
      response.data = { memory: rows };
      response.reply = `${rows.length} memory entries. Most recent: ${rows.slice(0, 3).map(r => `${r.agent}/${r.key}`).join(', ')}.`;
      response.actions_taken.push('read_agent_memory');
    }

    // ── Fallback: help text ──────────────────────────────────────────
    else {
      response.reply = `Captain Beaver here. I understand: "status" (daily KPIs), "kickoff" or "find X founders in Y" (fire pipeline), "approvals" (pending queue), "signal hunt" (find buying triggers), "replies" (recent inbound), "memory" or "icp" (read config). What do you need?`;
      response.actions_taken.push('returned_help_text');
    }

    await logsService.createLog(client_id, {
      agent: 'captain',
      action: 'chat_reply',
      metadata: { actions: response.actions_taken, thread_id: response.thread_id },
    });

    res.json({ data: response });
  } catch (err) {
    console.error('[autonomous/chat] Error:', err.message);
    next(err);
  }
});

/* ─── POST /api/autonomous/kickoff ───────────────────────── */

router.post('/kickoff', requireInternalKey, async (req, res) => {
  const { client_id } = req.body;
  if (!client_id || (typeof client_id === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(client_id))) {
    return res.status(400).json({ error: 'Valid client_id (UUID) required', code: 'INVALID_CLIENT_ID' });
  }

  // Calendar gate — must have Google Calendar OR Calendly connected
  const calendarService = require('../services/googleCalendar');
  const hasCalendar = await calendarService.hasAnyCalendar(client_id);
  if (!hasCalendar) {
    return res.status(403).json({
      error: 'Connect Google Calendar or Calendly in Settings before running campaigns',
      code: 'CALENDAR_REQUIRED',
    });
  }

  // Respond immediately so scheduler doesn't time out
  res.json({ data: { status: 'kickoff_started', client_id } });

  // Background task — bind clientId into AsyncLocalStorage so every deep
  // `callAgent(...)` inside the kickoff gets budget-checked and usage-logged
  // against the right tenant.
  runWithClientContext(client_id, () =>
    runAutonomousKickoff(client_id).catch(err => {
      console.error(`[Autonomous] Kickoff failed for ${client_id}:`, err.message);
      // Alert on kickoff crash
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        const { sendMessage } = require('../services/telegram');
        sendMessage(chatId,
          `<b>Pipeline Alert: Kickoff Crashed</b>\n\nClient: ${client_id}\nError: ${err.message}`
        ).catch(() => {});
      }
    })
  );
});

/* ─── POST /api/autonomous/kickoff-all ───────────────────── */
// 1-hour dedupe gate: rejects if any tenant has already kicked off in the
// last 60 minutes. Prevents the failure mode where multiple manual triggers
// (GitHub Actions workflow_dispatch, curl, etc.) burn through Brave/LLM
// budget by fanning out repeated kickoffs across all tenants.
//
// Override with ?force=1 (or { force: true } in body) for legitimate
// out-of-window runs (e.g. validating a fresh deploy).

router.post('/kickoff-all', requireInternalKey, async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true' || req.body?.force === true;

  if (!force) {
    const { rows: recent } = await pool.query(
      `SELECT MAX(created_at) AS last_at, COUNT(DISTINCT client_id) AS tenants
         FROM logs
        WHERE agent = 'director'
          AND action = 'autonomous_kickoff'
          AND created_at >= NOW() - INTERVAL '60 minutes'`
    );
    const lastAt = recent[0]?.last_at;
    if (lastAt) {
      const minsAgo = Math.round((Date.now() - new Date(lastAt).getTime()) / 60000);
      return res.status(429).json({
        error: 'Kickoff already fired within the last 60 minutes',
        code: 'KICKOFF_DEDUPE',
        last_at: lastAt,
        minutes_ago: minsAgo,
        tenants_affected: parseInt(recent[0].tenants, 10) || 0,
        hint: 'Wait until the run completes, or pass ?force=1 to override.',
      });
    }
  }

  const { rows: clients } = await pool.query(
    `SELECT id FROM clients`
  );

  res.json({
    data: {
      status: 'kickoff_started',
      clients: clients.length,
      forced: force,
    },
  });

  for (const client of clients) {
    runWithClientContext(client.id, () =>
      runAutonomousKickoff(client.id).catch(err =>
        console.error(`[Autonomous] Kickoff failed for ${client.id}:`, err.message)
      )
    );
  }
});

/* ─── POST /api/autonomous/weekly-review ─────────────────── */

router.post('/weekly-review', requireInternalKey, async (req, res) => {
  res.json({ data: { status: 'weekly_review_started' } });

  const { rows: clients } = await pool.query(
    `SELECT id FROM clients`
  );

  for (const client of clients) {
    runWithClientContext(client.id, () =>
      runWeeklyReview(client.id).catch(err =>
        console.error(`[Weekly Review] Failed for ${client.id}:`, err.message)
      )
    );
  }
});

/* ─── GET /api/autonomous/pending-approvals ──────────────── */
// Requires ?client_id=UUID — no cross-tenant queries allowed.

router.get('/pending-approvals', requireInternalKey, async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id query param required', code: 'MISSING_CLIENT_ID' });
    const { rows } = await pool.query(
      `SELECT
         a.id            AS approval_id,
         a.client_id,
         a.status,
         a.created_at,
         m.id            AS message_id,
         m.subject,
         m.body,
         m.channel,
         m.metadata      AS message_meta,
         l.name          AS lead_name,
         l.company       AS lead_company,
         l.title         AS lead_title,
         l.email         AS lead_email,
         l.linkedin_url  AS lead_linkedin,
         l.metadata->>'industry' AS lead_industry,
         l.metadata->>'source'   AS lead_source,
         l.metadata->>'signal'   AS lead_signal
       FROM approvals a
       JOIN messages m ON m.id = a.message_id
       JOIN leads   l ON l.id = m.lead_id
       WHERE a.status = 'pending'
         AND a.client_id = $1::uuid
       ORDER BY a.created_at DESC
       LIMIT 20`,
      [clientId]
    );
    res.json({ data: rows, meta: { total: rows.length } });
  } catch (err) {
    logger.error({ msg: 'pending-approvals query failed', err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to fetch pending approvals', code: 'DB_ERROR' });
  }
});

/* ─── POST /api/autonomous/approve ──────────────────────── */

router.post('/approve', requireInternalKey, async (req, res) => {
  const { approval_id, client_id } = req.body;
  if (!approval_id || !client_id) {
    return res.status(400).json({ error: 'approval_id and client_id required' });
  }
  try {
    // Verify message is actually in pending_approval status before approving
    const { rows: [approval] } = await pool.query(
      `UPDATE approvals SET status = 'approved', resolved_at = NOW()
       WHERE id = $1 AND client_id = $2 AND status = 'pending'
       RETURNING id, message_id`,
      [approval_id, client_id]
    );
    if (!approval) {
      return res.status(404).json({ error: 'Approval not found or already actioned', code: 'NOT_FOUND' });
    }
    const { rows: [msg] } = await pool.query(`SELECT status FROM messages WHERE id = $1 AND client_id = $2`, [approval.message_id, client_id]);
    if (!msg || msg.status !== 'pending_approval') {
      return res.status(400).json({ error: `Cannot approve: message status is '${msg?.status || 'missing'}'`, code: 'INVALID_STATUS' });
    }
    await pool.query(
      `UPDATE messages SET status = 'approved' WHERE id = $1 AND client_id = $2`,
      [approval.message_id, client_id]
    );
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, 'claw', 'message_approved', 'message', $2, $3)`,
      [client_id, approval.message_id, JSON.stringify({ approval_id, source: 'telegram_claw' })]
    );
    res.json({ data: { approval_id, message_id: approval.message_id, status: 'approved' } });
  } catch (err) {
    logger.error({ msg: 'autonomous approve failed', err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to approve message', code: 'DB_ERROR' });
  }
});

/* ─── POST /api/autonomous/reject ───────────────────────── */

router.post('/reject', requireInternalKey, async (req, res) => {
  const { approval_id, client_id, reason } = req.body;
  if (!approval_id || !client_id) {
    return res.status(400).json({ error: 'approval_id and client_id required' });
  }
  try {
    const { rows: [approval] } = await pool.query(
      `UPDATE approvals SET status = 'rejected', resolved_at = NOW()
       WHERE id = $1 AND client_id = $2 AND status = 'pending'
       RETURNING id, message_id`,
      [approval_id, client_id]
    );
    if (!approval) {
      return res.status(404).json({ error: 'Approval not found or already actioned', code: 'NOT_FOUND' });
    }
    await pool.query(
      `UPDATE messages SET status = 'rejected' WHERE id = $1`,
      [approval.message_id]
    );
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, 'claw', 'message_rejected', 'message', $2, $3)`,
      [client_id, approval.message_id, JSON.stringify({ approval_id, reason: reason || 'rejected_via_telegram', source: 'telegram_claw' })]
    );
    res.json({ data: { approval_id, message_id: approval.message_id, status: 'rejected' } });
  } catch (err) {
    logger.error({ msg: 'autonomous reject failed', err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to reject message', code: 'DB_ERROR' });
  }
});

/* ─── GET /api/autonomous/recent-replies ─────────────────── */
// Returns leads that replied in the last N hours (default 24).

router.get('/recent-replies', requireInternalKey, async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id query param required', code: 'MISSING_CLIENT_ID' });
    const hours = Math.min(parseInt(req.query.hours) || 24, 168); // cap at 7 days
    const { rows } = await pool.query(
      `SELECT
         l.id            AS lead_id,
         l.name          AS lead_name,
         l.company       AS lead_company,
         l.title         AS lead_title,
         l.email         AS lead_email,
         l.status        AS lead_status,
         m.id            AS message_id,
         m.body          AS reply_body,
         m.created_at    AS replied_at,
         m.metadata->>'classification' AS classification
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.status = 'replied'
         AND m.client_id = $1::uuid
         AND m.created_at >= NOW() - make_interval(hours => $2::int)
       ORDER BY m.created_at DESC
       LIMIT 50`,
      [clientId, hours]
    );
    res.json({ data: rows, meta: { total: rows.length, hours } });
  } catch (err) {
    logger.error({ msg: 'recent-replies query failed', err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to fetch recent replies', code: 'DB_ERROR' });
  }
});

/* ─── GET /api/autonomous/agent-status ───────────────────── */
// Returns last action per agent in the last 30 minutes.
// Frontend polls this to show live agent activity.

router.get('/agent-status', requireInternalKey, async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id query param required', code: 'MISSING_CLIENT_ID' });
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (agent)
         agent, action, created_at, metadata
       FROM logs
       WHERE client_id = $1::uuid
         AND created_at >= NOW() - INTERVAL '30 minutes'
         AND agent IN ('director', 'research_beaver', 'sales_beaver', 'ranger')
       ORDER BY agent, created_at DESC`,
      [clientId]
    );

    const agents = ['director', 'research_beaver', 'sales_beaver', 'ranger'];
    const status = agents.map(agent => {
      const log = rows.find(r => r.agent === agent);
      return {
        agent,
        status: log ? 'active' : 'standby',
        last_action: log?.action || null,
        last_active: log?.created_at || null,
      };
    });

    res.json({ data: status });
  } catch (err) {
    logger.error({ msg: 'agent-status query failed', err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to fetch agent status', code: 'DB_ERROR' });
  }
});

/* ─── GET /api/autonomous/stale-leads ───────────────────── */
// Returns leads with active sequences, no reply, contacted > 5 days ago.
// Called daily by internal scheduler to surface stale leads for re-engagement or nurture.

router.get('/stale-leads', requireInternalKey, async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id query param required', code: 'MISSING_CLIENT_ID' });
    const { getStaleLeads } = require('../services/followupSequence');
    const rows = await getStaleLeads(clientId);
    res.json({ data: rows, meta: { total: rows.length } });
  } catch (err) {
    logger.error({ msg: 'stale-leads query failed', err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Failed to fetch stale leads', code: 'DB_ERROR' });
  }
});

/* ─── POST /api/autonomous/send-approved ─────────────────── */
// Internal send queue worker calls this every 60s to send all approved messages.
// Bridge between approval queue and actual email/LinkedIn send.

router.post('/send-approved', requireInternalKey, async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });

  try {
    const { sendMessageById } = require('./integrations');

    // Atomically claim approved EMAIL messages only — LinkedIn/Instagram are manual-send.
    // Without the channel filter, this endpoint grabs LinkedIn messages every 5 min,
    // fails with "No email", reverts to approved, and loops forever.
    const { rows: approved } = await pool.query(
      `UPDATE messages SET status = 'sending', updated_at = NOW()
       WHERE id IN (
         SELECT m.id FROM messages m
         JOIN leads l ON l.id = m.lead_id
         WHERE m.client_id = $1
           AND m.status = 'approved'
           AND m.channel = 'email'
           AND l.email IS NOT NULL
           AND l.email != 'unknown@example.com'
         ORDER BY m.created_at ASC
         LIMIT 20
       )
       RETURNING id, channel, lead_id`,
      [client_id]
    );

    if (approved.length === 0) {
      return res.json({ data: { sent: 0, failed: 0, total: 0 } });
    }

    let sent = 0, failed = 0;

    for (const msg of approved) {
      try {
        const result = await sendMessageById(client_id, msg.id, 'auto');
        if (result.status === 'sent') {
          sent++;
          logger.info({ msg: `[auto-send] Sent message ${msg.id} (${msg.channel})`, client_id });
        } else {
          logger.info({ msg: `[auto-send] Message ${msg.id} result: ${result.status}`, client_id });
        }
      } catch (err) {
        failed++;
        // Revert to approved so it can be retried
        await pool.query(`UPDATE messages SET status = 'approved', updated_at = NOW() WHERE id = $1 AND client_id = $2`, [msg.id, client_id]);
        logger.error({ msg: `[auto-send] Failed to send message ${msg.id}`, err: err.message, client_id });
      }
    }

    return res.json({ data: { sent, failed, total: approved.length } });
  } catch (err) {
    logger.error({ msg: '[auto-send] Batch send failed', err: err.message, client_id });
    return res.status(500).json({ error: err.message, code: 'SEND_FAILED' });
  }
});

/* ─── POST /api/autonomous/morning-kickoff ──────────────── */
// Daily sales kickoff: selects qualified leads for today's outreach batch.
// Captain Beaver picks up to 16 leads, marks them outreach_ready, logs selection.

router.post('/morning-kickoff', requireInternalKey, async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) {
    return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  }

  const DAILY_BATCH_LIMIT = 16;
  const today = new Date().toISOString().split('T')[0];

  try {
    // 1. Count total available qualified leads (not yet contacted)
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*) AS total
       FROM leads
       WHERE client_id = $1
         AND pipeline_stage = 'qualified'
         AND deleted_at IS NULL
         AND first_contacted_at IS NULL`,
      [client_id]
    );
    const leadsAvailable = parseInt(countRow.total) || 0;

    // 2. Fetch top candidates ordered by signal_tier ASC (P1 first), created_at DESC
    const { rows: candidates } = await pool.query(
      `SELECT id, name, company, title, email, linkedin_url, signal_tier, metadata
       FROM leads
       WHERE client_id = $1
         AND pipeline_stage = 'qualified'
         AND deleted_at IS NULL
         AND first_contacted_at IS NULL
       ORDER BY signal_tier ASC, created_at DESC
       LIMIT $2`,
      [client_id, DAILY_BATCH_LIMIT]
    );

    if (candidates.length === 0) {
      return res.json({
        data: {
          date: today,
          client_id,
          batch_size: 0,
          leads_selected: [],
          leads_available: leadsAvailable,
          message: 'No qualified leads available for outreach.',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // 3. Update each lead to outreach_ready + log selection
    const selectedIds = candidates.map(c => c.id);

    await pool.query(
      `UPDATE leads
       SET pipeline_stage = 'outreach_ready', updated_at = NOW()
       WHERE client_id = $1 AND id = ANY($2::uuid[])`,
      [client_id, selectedIds]
    );

    // Batch-insert log entries
    const logValues = [];
    const logParams = [client_id];
    let paramIdx = 2;

    for (const lead of candidates) {
      logValues.push(
        `($1, 'captain_beaver', 'daily_batch_selected', 'lead', $${paramIdx}, $${paramIdx + 1})`
      );
      logParams.push(lead.id);
      logParams.push(JSON.stringify({
        date: today,
        signal_tier: lead.signal_tier,
        company: lead.company,
      }));
      paramIdx += 2;
    }

    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ${logValues.join(', ')}`,
      logParams
    );

    // 4. Build tier summary
    const tierCounts = { P1: 0, P2: 0, P3: 0 };
    for (const lead of candidates) {
      const tier = lead.signal_tier || 'P3';
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }
    const tierSummary = Object.entries(tierCounts)
      .filter(([, count]) => count > 0)
      .map(([tier, count]) => `${tier}: ${count}`)
      .join(', ');

    // 5. Build response with full lead context
    const leadsSelected = candidates.map(c => ({
      id: c.id,
      name: c.name,
      company: c.company,
      title: c.title,
      email: c.email,
      linkedin_url: c.linkedin_url,
      signal_tier: c.signal_tier,
      signal: c.metadata?.signal || null,
      angle: c.metadata?.angle || null,
      friction: c.metadata?.friction || null,
    }));

    res.json({
      data: {
        date: today,
        client_id,
        batch_size: candidates.length,
        leads_selected: leadsSelected,
        leads_available: leadsAvailable,
        message: `${candidates.length} leads ready for outreach. ${tierSummary}`,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    logger.error({ msg: 'morning-kickoff failed', err: err.message, stack: err.stack });
    res.status(500).json({ error: 'Morning kickoff failed', code: 'KICKOFF_ERROR' });
  }
});

/* ─── Concurrent-run lock (prevents overlapping kickoffs per client) ─── */
const _runningKickoffs = new Set();

/* ─── GET /api/autonomous/running ────────────────────────── */
// MyClaw polls this before firing a kickoff to avoid duplicate runs.
router.get('/running', requireInternalKey, (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id query param required', code: 'MISSING_CLIENT_ID' });
  return res.json({ data: { running: _runningKickoffs.has(client_id), client_id } });
});

/* ─── Core: Autonomous kickoff logic ─────────────────────── */

async function runAutonomousKickoff(clientId) {
  if (_runningKickoffs.has(clientId)) {
    console.log(`[Autonomous] Client ${clientId} kickoff already running — skipping concurrent trigger`);
    return;
  }
  _runningKickoffs.add(clientId);
  try {
    return await _runAutonomousKickoffInner(clientId);
  } finally {
    _runningKickoffs.delete(clientId);
  }
}

async function _runAutonomousKickoffInner(clientId) {
  const today = new Date().toISOString().split('T')[0];

  // Ensure today's KPI row exists
  await pool.query(
    `INSERT INTO daily_kpi (client_id, date) VALUES ($1, $2)
     ON CONFLICT (client_id, date) DO NOTHING`,
    [clientId, today]
  );

  // Count today's sent
  const { rows: counts } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'sent' AND DATE(sent_at) = $2) AS total_sent
     FROM messages WHERE client_id = $1`,
    [clientId, today]
  );
  const sent = parseInt(counts[0].total_sent) || 0;

  // Recompute all daily_kpi counters from source-of-truth tables
  // (replaces the previous outreach_sent-only inline UPDATE that lost the
  // outreach_linkedin / leads_found / replies_received counters).
  await require('../services/kpi').recountKpi(clientId, today).catch(err =>
    logger.warn({ msg: '[kickoff] kpi recount failed', clientId, err: err?.message, stack: err?.stack?.split('\n')[0] })
  );

  const { rows: [kpiRow] } = await pool.query(
    `SELECT target FROM daily_kpi WHERE client_id = $1 AND date = $2`,
    [clientId, today]
  );
  const target = kpiRow?.target || 50;
  const gap = target - sent;

  if (gap <= 0) {
    console.log(`[Autonomous] Client ${clientId} already hit KPI (${sent}/${target}). No action needed.`);
    await logAction(clientId, 'director', 'kpi_already_met', 'system', null, { sent, target });
    return;
  }

  console.log(`[Autonomous] Client ${clientId}: ${sent}/${target} sent. Gap: ${gap}. Starting run.`);

  // Process due follow-ups first (before new outreach)
  try {
    const { getDueFollowUps, draftFollowUp } = require('../services/followupSequence');

    const dueFollowUps = await getDueFollowUps(clientId);
    console.log(`[FollowUp] ${dueFollowUps.length} follow-ups due for client ${clientId}`);

    for (const followUp of dueFollowUps) {
      try {
        // Get previous messages for this lead (so follow-up uses different angle)
        const { rows: prevMessages } = await pool.query(
          `SELECT subject, body, metadata, channel FROM messages
           WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved')
           ORDER BY created_at ASC`,
          [followUp.lead_id, clientId]
        );

        // Determine channel from first message (follow-ups stay on same channel)
        const originalChannel = prevMessages[0]?.channel || 'email';

        const draft = await draftFollowUp(followUp, followUp.touch_number, prevMessages);
        if (!draft?.body) {
          console.warn(`[FollowUp] No draft body for lead ${followUp.lead_id} touch ${followUp.touch_number}`);
          continue;
        }

        // Strip em dashes from follow-up body
        const cleanBody = draft.body.replace(/\s*\u2014\s*/g, ', ').replace(/\u2014/g, ' ');

        // Server-side hard gates only (no AI Enforcer)
        const gateFailures = [];
        const bodyText = cleanBody.replace(/^Hi\s+\w+,?\s*/i, '').replace(/\s*Regards,?\s*.*/is, '');
        const wordCount = bodyText.trim().split(/\s+/).length;
        if (originalChannel === 'email' && wordCount > 80) gateFailures.push(`Word count ${wordCount}`);
        const questionCount = (cleanBody.match(/\?/g) || []).length;
        if (questionCount > 1) gateFailures.push(`${questionCount} questions`);
        if (/\u2014/.test(cleanBody)) gateFailures.push('Em dash');
        if (/^[\s]*[-\u2022*]\s/m.test(cleanBody)) gateFailures.push('Bullets');

        const passedGates = gateFailures.length === 0;

        // If server gates failed, insert as rejected immediately
        if (!passedGates) {
          const { rows: [savedMsg] } = await pool.query(
            `INSERT INTO messages (client_id, lead_id, subject, body, status, metadata, channel, follow_up_day)
             VALUES ($1, $2, $3, $4, 'ranger_rejected', $5, $6, $7)
             RETURNING id`,
            [
              clientId, followUp.lead_id, draft.subject || null, cleanBody,
              JSON.stringify({ ...draft, is_followup: true, touch_number: followUp.touch_number, gate_failures: gateFailures }),
              originalChannel,
              followUp.touch_number === 2 ? 2
                : followUp.touch_number === 3 ? 5
                : followUp.touch_number === 4 ? 10
                : followUp.touch_number === 5 ? 18
                : followUp.touch_number === 6 ? 30 : 7,
            ]
          );
          await pool.query(`UPDATE followup_queue SET status = 'skipped', message_id = $1 WHERE id = $2`, [savedMsg.id, followUp.id]);
          continue;
        }

        // Server gates passed — insert as pending_ranger, then run AI Enforcer (fail-closed)
        const { rows: [savedMsg] } = await pool.query(
          `INSERT INTO messages (client_id, lead_id, subject, body, status, metadata, channel, follow_up_day)
           VALUES ($1, $2, $3, $4, 'pending_ranger', $5, $6, $7)
           RETURNING id`,
          [
            clientId, followUp.lead_id, draft.subject || null, cleanBody,
            JSON.stringify({ ...draft, is_followup: true, touch_number: followUp.touch_number }),
            originalChannel,
            followUp.touch_number === 2 ? 2
              : followUp.touch_number === 3 ? 5
              : followUp.touch_number === 4 ? 10
              : followUp.touch_number === 5 ? 18
              : followUp.touch_number === 6 ? 30 : 7,
          ]
        );

        let enforcerApproved = false;
        try {
          const rangerResult = await rangerReview(clientId, { message_id: savedMsg.id, message_body: cleanBody });
          enforcerApproved = !!rangerResult?.approved;
          const newStatus = enforcerApproved ? 'pending_approval' : 'ranger_rejected';
          await pool.query(
            `UPDATE messages SET status = $1, ranger_score = $2, ranger_notes = $3, updated_at = NOW() WHERE id = $4 AND client_id = $5`,
            [newStatus, rangerResult?.score || 0, rangerResult?.notes || rangerResult?.reject_reason || 'Enforcer review', savedMsg.id, clientId]
          );
        } catch (err) {
          console.error('[FollowUp] AI Enforcer unavailable, blocking follow-up (fail-closed):', err.message);
          await pool.query(
            `UPDATE messages SET status = 'ranger_rejected', ranger_notes = 'AI Enforcer unavailable — blocked', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
            [savedMsg.id, clientId]
          );
        }

        if (enforcerApproved) {
          // Auto-approve follow-ups if score meets threshold (same as initial outreach)
          let autoApproved = false;
          try {
            const { rows: [clientRow] } = await pool.query(
              `SELECT auto_approve_threshold FROM clients WHERE id = $1 LIMIT 1`,
              [clientId]
            );
            const rangerScore = (await pool.query(`SELECT ranger_score FROM messages WHERE id = $1`, [savedMsg.id])).rows[0]?.ranger_score || 0;
            const threshold = clientRow?.auto_approve_threshold;
            if (threshold !== null && threshold !== undefined && rangerScore >= threshold) {
              autoApproved = true;
              const sendStatus = (originalChannel === 'email') ? 'pending_send' : 'approved';
              await pool.query(
                `UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
                [sendStatus, savedMsg.id, clientId]
              );
            }
          } catch (err) {
            console.warn('[FollowUp] Auto-approve threshold check failed:', err.message);
          }

          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [clientId, savedMsg.id,
             autoApproved ? 'auto_approval' : 'system',
             autoApproved ? 'approved' : 'pending',
             autoApproved ? new Date() : null]
          );

          // Auto-enqueue email follow-ups for send queue
          if (autoApproved && originalChannel === 'email') {
            try {
              const { enqueueMessage } = require('../services/sendQueueWorker');
              await enqueueMessage(clientId, savedMsg.id);
              console.log(`[FollowUp] Auto-approved + enqueued touch ${followUp.touch_number} for ${followUp.name}`);
            } catch (err) {
              console.warn(`[FollowUp] enqueueMessage failed for ${savedMsg.id}:`, err.message);
            }
          }
        }

        await pool.query(
          `UPDATE followup_queue SET status = $1, message_id = $2 WHERE id = $3`,
          [enforcerApproved ? 'sent' : 'skipped', savedMsg.id, followUp.id]
        );

        // Calculate next follow-up date (extended to touch 6 per Phase D)
        const nextTouch = followUp.touch_number + 1;
        const nextDate = nextTouch <= 6
          ? (await pool.query(`SELECT scheduled_for FROM followup_queue WHERE lead_id=$1 AND touch_number=$2 AND client_id=$3`, [followUp.lead_id, nextTouch, clientId])).rows[0]?.scheduled_for
          : null;

        await pool.query(
          `UPDATE leads SET sequence_touch = $1, next_followup_at = $2 WHERE id = $3 AND client_id = $4`,
          [followUp.touch_number, nextDate || null, followUp.lead_id, clientId]
        );

        await logAction(clientId, 'sales_beaver', 'followup_drafted', 'lead', followUp.lead_id, {
          touch: followUp.touch_number, channel: originalChannel, passed_gates: passedGates,
          gate_failures: gateFailures.length > 0 ? gateFailures : undefined,
        });

        console.log(`[FollowUp] Touch ${followUp.touch_number} for ${followUp.name} (${originalChannel}): ${passedGates ? 'approved' : 'rejected: ' + gateFailures.join(', ')}`);
      } catch (err) {
        console.error(`[FollowUp] Error drafting follow-up for lead ${followUp.lead_id}:`, err.message);
      }
    }

    // ── Channel escalation: after touch 3+, try alternate channel ──
    // If a lead has had 3+ touches on one channel with no reply,
    // auto-draft a message on a different channel for approval.
    try {
      const { escalateChannel } = require('../services/followupSequence');
      const { rows: escalationCandidates } = await pool.query(
        `SELECT DISTINCT l.id AS lead_id FROM leads l
         WHERE l.client_id = $1
           AND l.sequence_status = 'active'
           AND l.sequence_touch >= 3
           AND l.last_reply_at IS NULL
           AND l.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.lead_id = l.id AND m.client_id = $1
               AND m.metadata->>'is_channel_escalation' = 'true'
           )`,
        [clientId]
      );

      for (const { lead_id } of escalationCandidates) {
        try {
          const escalation = await escalateChannel(clientId, lead_id);
          if (!escalation) continue;

          console.log(`[ChannelEscalation] ${escalation.lead_name}: ${escalation.original_channel} → ${escalation.new_channel}`);

          // Draft message on new channel via Sales Beaver
          const { rows: prevMessages } = await pool.query(
            `SELECT subject, body, metadata, channel FROM messages
             WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved')
             ORDER BY created_at ASC`,
            [lead_id, clientId]
          );

          const channelInstructions = escalation.new_channel === 'email'
            ? `FORMAT (email — new channel intro): Hi ${escalation.lead_name?.split(' ')[0]}, {body — max 60 words}. Regards, {sender}. This is the FIRST email to this person (previous outreach was on ${escalation.original_channel}). Reference that you've reached out before but keep it natural, not desperate.`
            : `FORMAT (${escalation.new_channel} DM — new channel intro): {body — max 40 words. No greeting, no sign-off.} This is a NEW channel (previous was ${escalation.original_channel}). Keep it fresh, not a copy of the ${escalation.original_channel} messages.`;

          const previousSummary = prevMessages.map((m, i) =>
            `Message ${i + 1} (${m.channel}): ${(m.body || '').substring(0, 120)}`
          ).join('\n');

          const prompt = `You are Sales Beaver writing a channel escalation message on ${escalation.new_channel}.

CONTEXT: Lead was contacted ${prevMessages.length}x on ${escalation.original_channel} with no reply. Now trying ${escalation.new_channel}.

LEAD: ${escalation.lead_name} - ${escalation.lead?.title || 'Unknown'} at ${escalation.lead_company}

PREVIOUS MESSAGES (different channel — do NOT copy these, use a fresh angle):
${previousSummary}

${channelInstructions}

HARD RULES: No em dashes. Max 1 question mark. No bullets. No fabricated details.

Return JSON: {"subject":${escalation.new_channel === 'email' ? '"..."' : 'null'},"body":"..."}`;

          const { callAgent } = require('../services/claude');
          const draft = await callAgent('sales_beaver', prompt);
          if (!draft?.body) continue;

          const cleanBody = draft.body.replace(/\s*\u2014\s*/g, ', ').replace(/\u2014/g, ' ');

          // Insert as pending_ranger with channel escalation flag
          const { rows: [savedMsg] } = await pool.query(
            `INSERT INTO messages (client_id, lead_id, subject, body, status, channel, metadata)
             VALUES ($1, $2, $3, $4, 'pending_ranger', $5, $6)
             RETURNING id`,
            [clientId, lead_id, draft.subject || null, cleanBody, escalation.new_channel,
             JSON.stringify({ is_channel_escalation: true, original_channel: escalation.original_channel, new_channel: escalation.new_channel })]
          );

          // Run through Enforcer
          let enforcerApproved = false;
          try {
            const rangerResult = await rangerReview(clientId, { message_id: savedMsg.id, message_body: cleanBody });
            enforcerApproved = !!rangerResult?.approved;
            await pool.query(
              `UPDATE messages SET status = $1, ranger_score = $2, ranger_notes = $3, updated_at = NOW() WHERE id = $4`,
              [enforcerApproved ? 'pending_approval' : 'ranger_rejected', rangerResult?.score || 0, rangerResult?.notes || 'Channel escalation review', savedMsg.id]
            );
          } catch (err) {
            await pool.query(`UPDATE messages SET status = 'ranger_rejected', ranger_notes = 'Enforcer unavailable', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
          }

          if (enforcerApproved) {
            await pool.query(
              `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'channel_escalation')`,
              [clientId, savedMsg.id]
            );
          }

          await logAction(clientId, 'sales_beaver', 'channel_escalation_drafted', 'lead', lead_id, {
            original_channel: escalation.original_channel,
            new_channel: escalation.new_channel,
            approved: enforcerApproved,
          });

          console.log(`[ChannelEscalation] Drafted ${escalation.new_channel} message for ${escalation.lead_name}: ${enforcerApproved ? 'approved' : 'rejected'}`);
        } catch (err) {
          console.error(`[ChannelEscalation] Error for lead ${lead_id}:`, err.message);
        }
      }
    } catch (err) {
      console.warn('[ChannelEscalation] Channel escalation phase skipped:', err.message);
    }
  } catch (err) {
    console.warn('[Autonomous] Follow-up processing skipped:', err.message);
  }

  // Sprint 7D: Ranger rejection pattern detection
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows: patterns } = await pool.query(
      `SELECT metadata->>'reject_reason' AS reason, COUNT(*) AS count
       FROM logs
       WHERE client_id = $1
         AND action IN ('message_rejected', 'ranger_review')
         AND metadata->>'decision' = 'reject'
         AND DATE(created_at) = $2
       GROUP BY reason
       HAVING COUNT(*) >= 3`,
      [clientId, today]
    );

    if (patterns.length > 0) {
      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
         VALUES ($1, 'ranger', 'pattern', 'daily_rejection_patterns', $2)
         ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $2, updated_at = NOW()`,
        [clientId, JSON.stringify({ date: today, patterns })]
      );
      console.log(`[Autonomous] Ranger pattern alert stored for client ${clientId}: ${patterns.length} repeated rejection reason(s)`);
    }
  } catch (err) {
    console.warn('[Autonomous] Ranger feedback loop error:', err.message);
  }

  // Re-check gap after processing follow-ups
  const { rows: refreshCounts } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'sent' AND DATE(sent_at) = $2) AS total_sent
     FROM messages WHERE client_id = $1`,
    [clientId, today]
  );
  const sentAfterFollowUps = parseInt(refreshCounts[0].total_sent) || 0;
  const remainingGap = target - sentAfterFollowUps;

  if (remainingGap <= 0) {
    console.log(`[Autonomous] Client ${clientId} hit KPI after follow-ups. Done.`);
    return;
  }

  // Load ICP from memory
  const { rows: icpRows } = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
    [clientId]
  );
  const icp = icpRows[0]?.content || {};

  // Load last week's learnings
  const { rows: learnings } = await pool.query(
    `SELECT * FROM weekly_learnings WHERE client_id = $1 ORDER BY week_start DESC LIMIT 1`,
    [clientId]
  );
  const lastLearnings = learnings[0] || null;

  // Load today's Ranger rejection patterns (Sprint 7D)
  const { rows: rangerPatterns } = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'ranger' AND key = 'daily_rejection_patterns' LIMIT 1`,
    [clientId]
  );
  const rejectionPatterns = rangerPatterns[0]?.content || null;

  const brief = buildAutonomousBrief({ gap: remainingGap, icp, lastLearnings, rejectionPatterns, sent: sentAfterFollowUps, target });

  await logAction(clientId, 'director', 'autonomous_kickoff', 'system', null, {
    gap: remainingGap, sent: sentAfterFollowUps, target, brief: brief.substring(0, 200),
  });

  // ── Phase C: Signal-first pass (runs BEFORE cold research) ──────────
  // Signal is the input, not a filter. Run signal hunt first and feed the
  // results straight into Sales/Enforcer. Whatever gap remains after signal
  // is filled by the cold research loop below.
  try {
    const { runSignalHunt, saveSignalLeads } = require('../services/signalHunt');
    const signalTarget = Math.min(remainingGap, 30); // don't exceed daily gap
    console.log(`[Autonomous] Phase C: Running signal hunt for up to ${signalTarget} P1/P2 leads`);

    const signalLeads = await runSignalHunt(clientId, { maxLeads: signalTarget, icp });
    if (signalLeads.length > 0) {
      const saved = await saveSignalLeads(clientId, signalLeads);
      console.log(`[Autonomous] Signal hunt saved ${saved.length} pre-qualified leads (P1=${saved.filter(l => l.signal_tier === 'P1').length})`);

      // Trigger directorExecute with signal-sourced leads already in the DB.
      // The command is a signal-specific brief so Captain gates are naturally
      // bypassed (leads were pre-qualified by signal detection).
      if (saved.length > 0) {
        const signalBrief = `SIGNAL-SOURCED BATCH: Process ${saved.length} pre-qualified leads already saved with P1/P2 signals. These are not cold — they have real buying triggers (hiring, funding, expansion). Draft outreach that references the specific signal for each lead. Do NOT re-run research, use the leads already saved today.`;
        try {
          await directorExecute(clientId, {
            plan_id: uuidv4(),
            command: signalBrief,
            batchIndex: 0,
            limit: saved.length,
            use_existing_leads: saved.map(l => l.id), // NEW: hint to directorExecute
          });
        } catch (err) {
          console.warn('[Autonomous] Signal batch directorExecute failed:', err.message);
        }
      }
    } else {
      console.log('[Autonomous] Signal hunt returned 0 leads — falling through to cold research');
    }
  } catch (err) {
    console.warn('[Autonomous] Signal hunt phase failed, continuing with cold research:', err.message);
  }

  // ── Loop scheduler (Phase B1 fix) ────────────────────────────
  // Gap is SENT-based, not sent+pending. If messages stack up in pending_approval
  // we either auto-approve high-score messages OR alert MJ — we do NOT treat
  // pending as "done". Target: 80 actually-sent messages per day.
  //
  // Ceiling is a circuit breaker, not a target:
  //   - PENDING_CEILING: if > PENDING_CEILING messages waiting approval, alert and stop
  //     (MJ is the bottleneck, more drafting won't help)
  //   - HARD_CEILING: absolute max batches to cap API spend
  //   - ZERO_STREAK: 3 consecutive batches with zero new leads → stop (pool exhausted)
  const HARD_CEILING = 15;
  const PENDING_CEILING = 30;
  const BATCH_SIZE = 20; // raised from 10 — auto-fix means more drafts survive
  let zeroStreak = 0;

  // ── Channel-mix policy (Wave 1, MJ direction 2026-05-03) ──────────────
  // 30 email + 20 linkedin = 50/day. The kickoff loop biases lead selection
  // toward whichever channel still has gap. Targets come from daily_kpi
  // (override per client); Captain may also write a 'channel_focus' directive
  // with refined targets — that wins when present.
  const directivesSvc = require('../services/directives');
  const kickoffDirectives = await directivesSvc.readPendingDirectives(clientId, 'kickoff').catch(() => []);
  const channelFocus = kickoffDirectives.find(d => d.directive_type === 'channel_focus');
  const directiveIdsToConsume = kickoffDirectives.map(d => d.id);

  const { rows: kpiTargetRow } = await pool.query(
    `SELECT COALESCE(target_email_sent, 30) AS te,
            COALESCE(target_linkedin_sent, 20) AS tl
     FROM daily_kpi WHERE client_id = $1 AND date = $2 LIMIT 1`,
    [clientId, today]
  );
  const TARGET_EMAIL_SENT    = channelFocus?.payload?.email?.target    ?? Number(kpiTargetRow[0]?.te) ?? 30;
  const TARGET_LINKEDIN_SENT = channelFocus?.payload?.linkedin?.target ?? Number(kpiTargetRow[0]?.tl) ?? 20;
  // Option C: LinkedIn may overrun its cap if (and only if) the email pool
  // is genuinely dry. Captain's directive sets this; default true.
  const LINKEDIN_OVERRUN_OK  = channelFocus?.payload?.linkedin_overrun_allowed_if_email_pool_dry ?? true;

  for (let batch = 1; batch <= HARD_CEILING; batch++) {
    // Recalculate live counts — now per-channel so we can honour the 30/20 split
    const { rows: liveCount } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent'             AND DATE(COALESCE(sent_at, created_at)) = $2) AS sent,
         COUNT(*) FILTER (WHERE status = 'pending_approval' AND DATE(created_at) = $2)                     AS pending,
         COUNT(*) FILTER (WHERE status = 'approved'         AND DATE(created_at) = $2)                     AS approved_awaiting_send,
         COUNT(*) FILTER (WHERE channel = 'email'    AND status = 'sent' AND DATE(COALESCE(sent_at, created_at)) = $2) AS email_sent_today,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'sent' AND DATE(COALESCE(sent_at, created_at)) = $2) AS linkedin_sent_today,
         COUNT(*) FILTER (WHERE channel = 'email'    AND DATE(created_at) = $2 AND status NOT IN ('ranger_rejected','blocked_no_email','deleted')) AS email_drafted_today,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND DATE(created_at) = $2 AND status NOT IN ('ranger_rejected','blocked_no_email','deleted')) AS linkedin_drafted_today
       FROM messages WHERE client_id = $1`,
      [clientId, today]
    );
    const liveSent      = parseInt(liveCount[0].sent) || 0;
    const livePending   = parseInt(liveCount[0].pending) || 0;
    const liveApproved  = parseInt(liveCount[0].approved_awaiting_send) || 0;
    const inFlight      = livePending + liveApproved;  // count as "in the queue, not yet sent"
    const liveGap       = target - liveSent;           // ← SENT-based gap

    // Per-channel SENT gaps. We chase email first; LinkedIn fills only what's left.
    const emailSentToday    = parseInt(liveCount[0].email_sent_today) || 0;
    const linkedinSentToday = parseInt(liveCount[0].linkedin_sent_today) || 0;
    const emailDraftedToday    = parseInt(liveCount[0].email_drafted_today) || 0;
    const linkedinDraftedToday = parseInt(liveCount[0].linkedin_drafted_today) || 0;
    // Drafted+pending counts toward the gap because each one will eventually
    // become a send. Avoids over-drafting on the same channel while drafts queue.
    const emailGap    = Math.max(0, TARGET_EMAIL_SENT    - emailDraftedToday);
    const linkedinGap = Math.max(0, TARGET_LINKEDIN_SENT - linkedinDraftedToday);

    if (liveGap <= 0) {
      console.log(`[Autonomous] Client ${clientId} batch ${batch}: SENT target met (${liveSent}/${target}). Stopping.`);
      await logAction(clientId, 'director', 'kpi_target_met', 'system', null, { batch, liveSent, target });
      break;
    }

    // Circuit breaker: if approval queue is swamped, stop drafting and alert
    if (livePending >= PENDING_CEILING) {
      console.warn(`[Autonomous] Client ${clientId} batch ${batch}: approval queue swamped (${livePending} pending). Alerting + stopping drafts.`);
      await logAction(clientId, 'director', 'approval_queue_swamped', 'system', null, {
        batch, livePending, liveApproved, liveSent, target,
        message: `${livePending} messages waiting for MJ approval — stop drafting, clear the queue`,
      });
      // Alert via Discord bot (sendTelegramAlert not available in this codebase)
      try {
        const { postDiscordAlert } = require('../services/discordBot');
        if (postDiscordAlert) {
          await postDiscordAlert('approval queue swamped', `${livePending} messages waiting approval for client ${clientId}. Pipeline paused.`).catch(() => {});
        }
      } catch {}
      break;
    }

    console.log(`[Autonomous] Client ${clientId} batch ${batch}/${HARD_CEILING}: sent=${liveSent}/${target}, pending=${livePending}, approved=${liveApproved}, gap=${liveGap}`);

    // Draft size = min(batch size, gap, remaining queue headroom)
    const queueHeadroom = PENDING_CEILING - livePending;
    const draftSize = Math.min(liveGap, BATCH_SIZE, queueHeadroom);

    // ── Channel-mix-aware lead pick (Wave 1, 2026-05-03) ─────────────────
    // Decide whether THIS batch should be email-channel or linkedin-channel
    // leads, given the per-channel gap. Drafting follows the lead's channel
    // (email-having lead → email draft, linkedin-only lead → linkedin draft).
    //
    // Decision tree:
    //   email_gap > 0 AND email-ready leads in pool → pick email-having leads
    //   email_gap > 0 AND email pool dry             → Option C: allow linkedin overrun
    //   email_gap = 0 AND linkedin_gap > 0           → pick linkedin-only leads
    //   email_gap = 0 AND linkedin_gap = 0           → liveGap > 0 path takes over
    // Tiered pool counts (migration 061, 2026-05-05).
    // Tier A = drafted-ready (provider-verified email); Tier B = linkedin-only
    // pending Hunter retry. Pre-tiering leads (NULL) treated as Tier B if they
    // have linkedin and Tier-A-eligible if they have a non-pattern_unknown email
    // — strict tier filter keeps the picker honest even if backfill missed a row.
    const { rows: poolCounts } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE lead_tier = 'A' AND email IS NOT NULL AND email <> '') AS email_ready,
         COUNT(*) FILTER (WHERE lead_tier = 'B' AND linkedin_url IS NOT NULL AND linkedin_url <> '') AS linkedin_only
       FROM leads
       WHERE client_id = $1
         AND pipeline_stage = 'prospecting'
         AND status = 'new'
         AND deleted_at IS NULL`,
      [clientId]
    );
    const poolEmailReady   = parseInt(poolCounts[0].email_ready) || 0;
    const poolLinkedinOnly = parseInt(poolCounts[0].linkedin_only) || 0;

    let chosenChannel = null; // 'email' | 'linkedin' | null (no constraint)
    let channelReason = '';
    if (emailGap > 0 && poolEmailReady > 0) {
      chosenChannel = 'email';
      channelReason = `email_gap=${emailGap}, pool_email_ready=${poolEmailReady}`;
    } else if (emailGap > 0 && poolEmailReady === 0 && LINKEDIN_OVERRUN_OK && poolLinkedinOnly > 0) {
      chosenChannel = 'linkedin';
      channelReason = `email pool dry, Option C overrun on linkedin (linkedin sent ${linkedinSentToday}/${TARGET_LINKEDIN_SENT})`;
      console.warn(`[Autonomous] Client ${clientId} batch ${batch}: email pool dry, allowing linkedin overrun (Option C)`);
    } else if (emailGap === 0 && linkedinGap > 0 && poolLinkedinOnly > 0) {
      chosenChannel = 'linkedin';
      channelReason = `email target met, linkedin_gap=${linkedinGap}, pool_linkedin_only=${poolLinkedinOnly}`;
    } else if (emailGap === 0 && linkedinGap === 0) {
      console.log(`[Autonomous] Client ${clientId} batch ${batch}: both channels at target. Stopping.`);
      await logAction(clientId, 'director', 'channel_targets_met', 'system', null, {
        batch, emailDraftedToday, linkedinDraftedToday, TARGET_EMAIL_SENT, TARGET_LINKEDIN_SENT,
      });
      break;
    } else {
      // Pool dry on the channel we needed and overrun not allowed → escalate
      console.warn(`[Autonomous] Client ${clientId} batch ${batch}: pool dry on needed channel (email_gap=${emailGap}, linkedin_gap=${linkedinGap}, pool_email=${poolEmailReady}, pool_linkedin=${poolLinkedinOnly})`);
      await logAction(clientId, 'director', 'pool_dry_for_channel_target', 'system', null, {
        batch, emailGap, linkedinGap, poolEmailReady, poolLinkedinOnly,
      });
      break;
    }

    // ── DB-first: pull uncontacted leads from pool before cold research ──
    // The DB Builder keeps this pool healthy in the background. Kickoff
    // draws from it, avoiding expensive real-time research when possible.
    let usedDbPool = false;
    try {
      // Channel-aware filter: WHERE-clause matches chosenChannel.
      // Tiered (migration 061): email channel pulls Tier A only (provider-verified email);
      // linkedin channel pulls Tier B only (linkedin-only, awaiting enrichment).
      const channelFilter = chosenChannel === 'email'
        ? `AND lead_tier = 'A' AND email IS NOT NULL AND email <> ''`
        : `AND lead_tier = 'B' AND linkedin_url IS NOT NULL AND linkedin_url <> ''`;

      const { rows: poolLeads } = await pool.query(
        `SELECT id FROM leads
         WHERE client_id = $1
           AND pipeline_stage = 'prospecting'
           AND status = 'new'
           AND deleted_at IS NULL
           ${channelFilter}
         ORDER BY
           CASE WHEN signal_tier = 'P1' THEN 1
                WHEN signal_tier = 'P2' THEN 2
                ELSE 3 END,
           score DESC,
           created_at ASC
         LIMIT $2`,
        [clientId, draftSize]
      );

      if (poolLeads.length >= Math.min(draftSize, 5)) {
        console.log(`[Autonomous] DB pool has ${poolLeads.length} leads — using pool instead of cold research`);
        await logAction(clientId, 'director', 'db_pool_draw', 'system', null, {
          batch, pool_size: poolLeads.length, draft_size: draftSize,
        });

        await directorExecute(clientId, {
          plan_id: uuidv4(),
          command: `DB-POOL BATCH: Process ${poolLeads.length} pre-researched leads from the lead pool. These are already verified and saved. Draft outreach using any signal/angle data in their metadata. Do NOT re-run research.`,
          batchIndex: batch - 1,
          limit: draftSize,
          use_existing_leads: poolLeads.map(l => l.id),
        });
        usedDbPool = true;
      }
    } catch (err) {
      console.warn(`[Autonomous] DB pool query failed, falling back to cold research:`, err.message);
    }

    // ── Fallback: cold research via directorExecute (original path) ──
    if (!usedDbPool) {
      const batchBrief = buildAutonomousBrief({
        gap: draftSize, icp, lastLearnings, rejectionPatterns,
        sent: liveSent, target,
      });

      const beforeSaved = (await pool.query(
        `SELECT COUNT(*) AS c FROM leads WHERE client_id=$1 AND DATE(created_at)=$2`,
        [clientId, today]
      )).rows[0].c;

      await directorExecute(clientId, {
        plan_id: uuidv4(),
        command: batchBrief,
        batchIndex: batch - 1,
        limit: draftSize,
      });

      // Zero-streak detection — stop if research yields nothing new
      const afterSaved = (await pool.query(
        `SELECT COUNT(*) AS c FROM leads WHERE client_id=$1 AND DATE(created_at)=$2`,
        [clientId, today]
      )).rows[0].c;
      if (parseInt(afterSaved) === parseInt(beforeSaved)) {
        zeroStreak++;
        console.warn(`[Autonomous] Batch ${batch} added 0 leads (zero streak: ${zeroStreak}/3)`);
        if (zeroStreak >= 3) {
          console.warn(`[Autonomous] 3 consecutive zero-lead batches — stopping. Pool exhausted.`);
          await logAction(clientId, 'director', 'research_pool_exhausted', 'system', null, { batch, liveSent, target });
          break;
        }
      } else {
        zeroStreak = 0;
      }
    }

    if (batch < HARD_CEILING) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Mark all kickoff directives consumed (they applied for THIS run).
  if (directiveIdsToConsume.length > 0) {
    await directivesSvc.markConsumed(clientId, directiveIdsToConsume).catch(err =>
      console.warn('[Autonomous] markConsumed failed:', err.message)
    );
  }

  // Wave 2 (2026-05-03): kickoff writes its self-report. Captain quotes this
  // verbatim in morning + EOD briefs so MJ sees what the kickoff thinks it did,
  // not just raw counters.
  try {
    const introspection = require('../services/introspection');
    const { rows: finalCounts } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE channel = 'email'    AND DATE(created_at) = $2) AS email_drafted,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND DATE(created_at) = $2) AS linkedin_drafted,
         COUNT(*) FILTER (WHERE channel = 'email'    AND status = 'sent' AND DATE(COALESCE(sent_at, created_at)) = $2) AS email_sent,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'sent' AND DATE(COALESCE(sent_at, created_at)) = $2) AS linkedin_sent,
         COUNT(*) FILTER (WHERE status = 'blocked_no_email' AND DATE(created_at) = $2) AS blocked_no_email
       FROM messages WHERE client_id = $1`,
      [clientId, today]
    );
    const fc = finalCounts[0];
    const summary = `Kickoff produced ${fc.email_drafted} email + ${fc.linkedin_drafted} linkedin drafts. Sent so far: ${fc.email_sent}/${TARGET_EMAIL_SENT} email · ${fc.linkedin_sent}/${TARGET_LINKEDIN_SENT} linkedin. Blocked no_email: ${fc.blocked_no_email}.`;
    const blockers = fc.blocked_no_email > 0
      ? `${fc.blocked_no_email} drafts blocked at email gate (pool starved of email-ready leads).`
      : null;
    await introspection.writeReport(clientId, 'kickoff', {
      runStartedAt: new Date(Date.now() - 30 * 60 * 1000), // ~30 min window
      metrics: {
        target_email_sent: TARGET_EMAIL_SENT,
        target_linkedin_sent: TARGET_LINKEDIN_SENT,
        email_drafted:    Number(fc.email_drafted) || 0,
        linkedin_drafted: Number(fc.linkedin_drafted) || 0,
        email_sent:       Number(fc.email_sent) || 0,
        linkedin_sent:    Number(fc.linkedin_sent) || 0,
        blocked_no_email: Number(fc.blocked_no_email) || 0,
      },
      summary,
      blockers,
      actedOnDirectives: directiveIdsToConsume,
    }).catch(err => console.warn('[Autonomous] introspection write failed:', err.message));
  } catch (err) {
    console.warn('[Autonomous] introspection skipped:', err.message);
  }

  // ── Kickoff verification — alert if zero output produced ──
  await verifyKickoffOutput(clientId, target);
}

/**
 * Post-kickoff verification: checks if the kickoff actually produced results.
 * Fires a Telegram alert to MJ if zero outreach was generated today.
 */
async function verifyKickoffOutput(clientId, target) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent'             AND DATE(COALESCE(sent_at, created_at)) = $2) AS sent,
         COUNT(*) FILTER (WHERE status = 'pending_approval'  AND DATE(created_at) = $2) AS pending,
         COUNT(*) FILTER (WHERE status = 'pending_ranger'    AND DATE(created_at) = $2) AS drafting,
         COUNT(*) FILTER (WHERE status = 'ranger_rejected'   AND DATE(created_at) = $2) AS rejected
       FROM messages WHERE client_id = $1`,
      [clientId, today]
    );

    const { sent, pending, drafting, rejected } = rows[0];
    const totalOutput = parseInt(sent) + parseInt(pending) + parseInt(drafting);

    if (totalOutput === 0) {
      console.warn(`[Autonomous] ZERO OUTPUT for client ${clientId} — kickoff produced nothing`);

      // Get client name for alert
      const { rows: clientRows } = await pool.query(`SELECT name FROM clients WHERE id = $1`, [clientId]);
      const clientName = clientRows[0]?.name || clientId;

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        const { sendMessage } = require('../services/telegram');
        await sendMessage(chatId,
          `<b>Pipeline Alert: Zero Output</b>\n\n` +
          `Client: ${clientName}\n` +
          `Target: ${target}\n` +
          `Sent: ${sent} | Pending: ${pending} | Rejected: ${rejected}\n\n` +
          `Kickoff completed but produced nothing. Check Railway logs.`
        ).catch(err => console.warn('[telegram] Alert failed:', err.message));
      }

      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
         VALUES ($1, 'system', 'kickoff_zero_output', 'system', $2, NOW())`,
        [clientId, JSON.stringify({ target, sent, pending, rejected })]
      );
    } else {
      // Success path: log only, no Telegram. Per MJ notification policy
      // (2026-05-03): morning brief / EOD brief / impromptu only. The morning
      // brief reports yesterday's kickoff numbers — no need to ping per-day too.
      console.log(`[Autonomous] Kickoff verified for ${clientId}: ${totalOutput} messages produced (${sent} sent, ${pending} pending, ${drafting} drafting)`);
    }
  } catch (err) {
    console.warn('[Autonomous] Kickoff verification failed:', err.message);
  }
}

function buildAutonomousBrief({ gap, icp, lastLearnings, rejectionPatterns, sent, target }) {
  let brief = `AUTONOMOUS DAILY RUN — ${new Date().toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' })}

Daily KPI: ${target} outreach. Sent so far today: ${sent}. Gap remaining: ${gap}.

ICP:
- Target: ${icp.who || icp.job_titles || 'Founder-led B2B companies, 5–20 employees, Klang Valley'}
- Industries: ${icp.industries || 'B2B services — consulting, agency, SaaS, training, professional services'}
- Pain: ${icp.pain_points || 'Inconsistent pipeline, founder doing all sales'}
- Tone: ${icp.tone || 'Warm, conversational, Malaysian English'}

`;

  if (lastLearnings) {
    brief += `LEARNINGS FROM LAST WEEK (apply these to improve quality):
- Best hooks: ${JSON.stringify(lastLearnings.best_hooks)}
- Best subject lines: ${JSON.stringify(lastLearnings.best_subject_lines)}
- Best industries: ${JSON.stringify(lastLearnings.best_industries)}
- Worst industries: ${JSON.stringify(lastLearnings.worst_industries)}
- What Ranger rejected most: ${JSON.stringify(lastLearnings.ranger_top_rejections)}
- Director notes: ${lastLearnings.director_notes || 'None'}

`;
  }

  if (rejectionPatterns?.patterns?.length > 0) {
    brief += `TODAY'S RANGER REJECTION PATTERNS (AVOID THESE):
${rejectionPatterns.patterns.map(p => `- "${p.reason}" — rejected ${p.count}x today already`).join('\n')}
Do NOT use any messaging approach matching these patterns.

`;
  }

  brief += `TASK:
Find ${gap} new B2B founder/CEO leads in Klang Valley and generate personalised outreach.
Apply the learnings above to improve quality — use proven hooks and avoid rejected approaches.
Prioritise industries and angles that worked last week.`;

  return brief;
}

/* ─── Core: Weekly review logic ──────────────────────────── */

async function runWeeklyReview(clientId) {
  const today = new Date();
  const weekEnd = today.toISOString().split('T')[0];
  const weekStart = new Date(today - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  console.log(`[Weekly Review] Running for client ${clientId}, week ${weekStart} → ${weekEnd}`);

  const { rows: [stats] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE action = 'email_sent') AS total_outreach,
       COUNT(*) FILTER (WHERE action = 'reply_detected') AS total_replies,
       COUNT(*) FILTER (WHERE action = 'meeting_booked') AS total_meetings
     FROM logs
     WHERE client_id = $1 AND created_at >= $2 AND created_at <= $3`,
    [clientId, weekStart, weekEnd]
  );

  const { rows: rejections } = await pool.query(
    `SELECT metadata->>'reject_reason' AS reason, COUNT(*) AS count
     FROM logs
     WHERE client_id = $1
       AND action = 'ranger_review'
       AND metadata->>'decision' = 'reject'
       AND created_at >= $2
     GROUP BY reason
     ORDER BY count DESC
     LIMIT 5`,
    [clientId, weekStart]
  );

  const { rows: successfulMessages } = await pool.query(
    `SELECT m.subject, m.body, m.metadata
     FROM messages m
     WHERE m.client_id = $1
       AND m.reply_detected_at IS NOT NULL
       AND m.sent_at >= $2
     ORDER BY m.reply_detected_at ASC
     LIMIT 10`,
    [clientId, weekStart]
  );

  const totalOutreach = parseInt(stats.total_outreach) || 0;
  const totalReplies = parseInt(stats.total_replies) || 0;
  const replyRate = totalOutreach > 0 ? ((totalReplies / totalOutreach) * 100).toFixed(2) : 0;

  let learnings = {
    best_hooks: [],
    best_subject_lines: [],
    best_industries: [],
    worst_industries: [],
    director_notes: `Week of ${weekStart}: ${totalOutreach} outreach, ${totalReplies} replies (${replyRate}% reply rate).`,
  };

  try {
    const { callAgent } = require('../services/claude');
    const reviewPrompt = `You are The Director at Beaver Solutions. Review this week's outreach performance.

WEEK: ${weekStart} to ${weekEnd}
STATS:
- Total outreach sent: ${totalOutreach}
- Total replies received: ${totalReplies}
- Reply rate: ${replyRate}%
- Meetings booked: ${stats.total_meetings}

TOP RANGER REJECTION REASONS:
${rejections.map(r => `- "${r.reason}" (${r.count}x)`).join('\n') || 'No rejections logged'}

MESSAGES THAT GOT REPLIES:
${successfulMessages.slice(0, 5).map(m => `Subject: ${m.subject}\nBody: ${m.body?.substring(0, 150)}`).join('\n---\n') || 'No replies this week'}

Return JSON only — no other text:
{"best_hooks":["top 3 opening lines that got replies"],"best_subject_lines":["top 3 subject lines"],"best_industries":["industries with best response"],"worst_industries":["industries with zero response"],"director_notes":"2-3 sentences: what worked, what didn't, one specific change to make next week"}`;

    const analysis = await callAgent('director', reviewPrompt);
    if (analysis && typeof analysis === 'object') {
      Object.assign(learnings, analysis);
    }
  } catch (err) {
    console.error('[Weekly Review] Director analysis failed:', err.message);
  }

  await pool.query(
    `INSERT INTO weekly_learnings
       (client_id, week_start, week_end, total_outreach, total_replies, total_meetings,
        reply_rate, best_hooks, best_subject_lines, best_industries, worst_industries, director_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (client_id, week_start) DO UPDATE SET
       total_outreach = EXCLUDED.total_outreach,
       total_replies = EXCLUDED.total_replies,
       total_meetings = EXCLUDED.total_meetings,
       reply_rate = EXCLUDED.reply_rate,
       best_hooks = EXCLUDED.best_hooks,
       best_subject_lines = EXCLUDED.best_subject_lines,
       best_industries = EXCLUDED.best_industries,
       worst_industries = EXCLUDED.worst_industries,
       director_notes = EXCLUDED.director_notes`,
    [
      clientId, weekStart, weekEnd,
      totalOutreach, totalReplies, stats.total_meetings,
      replyRate,
      JSON.stringify(learnings.best_hooks),
      JSON.stringify(learnings.best_subject_lines),
      JSON.stringify(learnings.best_industries),
      JSON.stringify(learnings.worst_industries),
      learnings.director_notes,
    ]
  );

  await logAction(clientId, 'director', 'weekly_review_complete', 'system', null, {
    week: weekStart, reply_rate: replyRate, total_outreach: totalOutreach,
  });

  console.log(`[Weekly Review] Complete for ${clientId}. Reply rate: ${replyRate}%`);
}

/* ─── Shared log helper ───────────────────────────────────── */

async function logAction(clientId, agent, action, targetType, targetId, metadata) {
  try {
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [clientId, agent, action, targetType, targetId, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('[Autonomous] Log error:', err.message);
  }
}


/* ─── GET /api/autonomous/hourly-stats ──────────────────── */
// Returns aggregated pipeline stats for the hourly Telegram report.
// No client_id required — aggregates across all tenants (internal tool).

router.get('/hourly-stats', requireInternalKey, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [pending, channelStats, aa, ar, failed, leadStats, patternRows] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS c FROM approvals WHERE status='pending' AND (notes IS NULL OR notes != 'linkedin_requested')`
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE channel = 'email' AND status IN ('sent','approved','pending_send') AND created_at::date = CURRENT_DATE)::int AS email_sent,
           COUNT(*) FILTER (WHERE channel = 'email' AND status IN ('pending_approval') AND created_at::date = CURRENT_DATE)::int AS email_pending,
           COUNT(*) FILTER (WHERE channel = 'email' AND status = 'replied')::int AS email_replied,
           COUNT(*) FILTER (WHERE channel = 'linkedin' AND status IN ('sent','approved','pending_send') AND created_at::date = CURRENT_DATE)::int AS li_sent,
           COUNT(*) FILTER (WHERE channel = 'linkedin' AND status IN ('pending_approval','linkedin_requested') AND created_at::date = CURRENT_DATE)::int AS li_pending,
           COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'replied')::int AS li_replied
         FROM messages`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM approval_audit WHERE decision='approved' AND created_at::date = CURRENT_DATE`
      ).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM approval_audit WHERE decision='rejected' AND created_at::date = CURRENT_DATE`
      ).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM messages WHERE status='failed' AND updated_at > NOW() - INTERVAL '1 hour'`
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE metadata->>'outreach_route' = 'email')::int AS email_route,
           COUNT(*) FILTER (WHERE metadata->>'outreach_route' = 'linkedin')::int AS linkedin_route
         FROM leads WHERE created_at::date = CURRENT_DATE AND deleted_at IS NULL`
      ),
      pool.query(
        `SELECT content FROM agent_memory WHERE agent = 'research_beaver' AND key = 'email_patterns_verified' LIMIT 1`
      ).catch(() => ({ rows: [] })),
    ]);

    const cs = channelStats.rows[0];
    const ls = leadStats.rows[0];
    const rawPatterns = patternRows.rows[0]?.content;
    // Pattern memory has two possible shapes:
    //   1. { patterns: [{company, domain, pattern, ...}, ...], ... }  ← cowork-written
    //   2. { domain1: pattern1, domain2: pattern2, ... }              ← legacy dbBuilder
    let patternN = 0;
    if (rawPatterns) {
      const parsed = typeof rawPatterns === 'string' ? JSON.parse(rawPatterns) : rawPatterns;
      if (Array.isArray(parsed?.patterns)) {
        patternN = parsed.patterns.length;
      } else if (parsed && typeof parsed === 'object') {
        // Legacy shape: top-level keys are domains. Filter out non-domain keys
        // like 'last_updated' that may have leaked in.
        patternN = Object.keys(parsed).filter(k => !['last_updated','doc','source'].includes(k)).length;
      }
    }

    res.json({
      data: {
        pending_approval: pending.rows[0].c,
        email_sent:       cs.email_sent,
        email_pending:    cs.email_pending,
        email_replied:    cs.email_replied,
        li_sent:          cs.li_sent,
        li_pending:       cs.li_pending,
        li_replied:       cs.li_replied,
        auto_approved:    aa.rows[0].c,
        auto_rejected:    ar.rows[0].c,
        failed_1h:        failed.rows[0].c,
        leads_today:      ls.total,
        leads_email_route:   ls.email_route,
        leads_linkedin_route: ls.linkedin_route,
        pattern_count:    patternN,
        date:             today,
      },
    });
  } catch (err) {
    logger.error({ msg: 'hourly-stats query failed', err: err.message });
    res.status(500).json({ error: 'Failed to fetch hourly stats', code: 'DB_ERROR' });
  }
});
/* ─── GET /api/autonomous/system-health ─────────────────── */
// Returns end-to-end pipeline health for cloud-cron watchdogs (Health Pack +
// kickoff watchdog). Internal API, no client_id — aggregates the active tenant.
// Safe to call frequently; all queries are indexed.

router.get('/system-health', requireInternalKey, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const enabledSlugs = (process.env.AUTONOMOUS_ENABLED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean);

    const { rows: clientRows } = await pool.query(
      `SELECT id, slug, name FROM clients
       WHERE slug = ANY($1) AND is_active = true AND onboarding_completed = true`,
      [enabledSlugs.length ? enabledSlugs : ['__none__']]
    );

    const tenants = [];
    for (const c of clientRows) {
      const [kickoffLog, kpi, msgs, queue, approvedUnsent, leadPool, researchLog, integrations] = await Promise.all([
        pool.query(
          `SELECT created_at FROM logs
           WHERE client_id = $1 AND agent = 'director' AND action = 'autonomous_kickoff'
             AND created_at::date = CURRENT_DATE
           ORDER BY created_at DESC LIMIT 1`,
          [c.id]
        ),
        pool.query(
          `SELECT target, outreach_sent, outreach_email, outreach_linkedin, leads_found, replies_received
           FROM daily_kpi WHERE client_id = $1 AND date = $2`,
          [c.id, today]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'sent' AND DATE(COALESCE(sent_at, created_at)) = CURRENT_DATE)::int AS sent_today,
             COUNT(*) FILTER (WHERE status = 'pending_approval' AND created_at::date = CURRENT_DATE)::int AS pending_today,
             COUNT(*) FILTER (WHERE status = 'ranger_rejected' AND created_at::date = CURRENT_DATE)::int AS rejected_today,
             COUNT(*) FILTER (WHERE status = 'approved' AND sent_at IS NULL)::int AS approved_unsent_total
           FROM messages WHERE client_id = $1`,
          [c.id]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'pending')::int AS sq_pending,
             COUNT(*) FILTER (WHERE status = 'pending' AND last_attempted_at < NOW() - INTERVAL '1 hour')::int AS sq_stuck,
             COUNT(*) FILTER (WHERE status = 'failed')::int AS sq_failed
           FROM send_queue WHERE client_id = $1`,
          [c.id]
        ),
        pool.query(
          `SELECT channel, COUNT(*)::int AS n
           FROM messages WHERE client_id = $1 AND status = 'approved' AND sent_at IS NULL
           GROUP BY channel`,
          [c.id]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM leads
           WHERE client_id = $1 AND deleted_at IS NULL
             AND (pipeline_stage IS NULL OR pipeline_stage NOT IN ('rejected','contacted','outreach','qualifying'))
             AND (status IS NULL OR status NOT LIKE 'rejected_%')`,
          [c.id]
        ),
        pool.query(
          `SELECT
             MAX(created_at) AS last_run,
             COUNT(*) FILTER (WHERE action = 'leads_saved' AND created_at >= NOW() - INTERVAL '24 hours')::int AS leads_saved_24h,
             COUNT(*) FILTER (WHERE action = 'research_no_results' AND created_at >= NOW() - INTERVAL '24 hours')::int AS no_results_24h
           FROM logs WHERE client_id = $1 AND agent = 'research_beaver'`,
          [c.id]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE key = 'gmail_tokens')::int AS gmail_connected,
             COUNT(*) FILTER (WHERE key = 'agentmail_inbox')::int AS agentmail_provisioned,
             COUNT(*) FILTER (WHERE key = 'calendar_tokens')::int AS calendar_connected,
             COUNT(*) FILTER (WHERE key = 'hunter_api_key')::int AS hunter_configured
           FROM agent_memory WHERE client_id = $1 AND memory_type = 'secret'`,
          [c.id]
        ),
      ]);

      const approvedUnsentByChannel = {};
      for (const r of approvedUnsent.rows) approvedUnsentByChannel[r.channel] = r.n;

      const i = integrations.rows[0];
      tenants.push({
        slug: c.slug,
        name: c.name,
        kickoff_today: {
          fired: kickoffLog.rows.length > 0,
          at: kickoffLog.rows[0]?.created_at || null,
        },
        kpi: kpi.rows[0] || null,
        messages: msgs.rows[0],
        send_queue: queue.rows[0],
        approved_unsent: approvedUnsentByChannel,
        lead_pool_remaining: leadPool.rows[0].n,
        research_beaver: researchLog.rows[0],
        integrations: {
          gmail_connected: !!i.gmail_connected,
          agentmail_provisioned: !!i.agentmail_provisioned,
          calendar_connected: !!i.calendar_connected,
          hunter_configured: !!i.hunter_configured,
        },
      });
    }

    res.json({
      data: {
        date: today,
        enabled_slugs: enabledSlugs,
        telegram_chat_id_present: !!process.env.TELEGRAM_CHAT_ID,
        telegram_bot_token_present: !!process.env.TELEGRAM_BOT_TOKEN,
        agentmail_configured: !!process.env.AGENTMAIL_API_KEY,
        gmail_oauth_configured: !!process.env.GOOGLE_CLIENT_ID,
        tenants,
      },
    });
  } catch (err) {
    logger.error({ msg: 'system-health query failed', err: err.message });
    res.status(500).json({ error: 'Failed to fetch system health', code: 'DB_ERROR' });
  }
});

/* ─── GET /api/autonomous/linkedin-queue ─────────────────── */
// Returns LinkedIn messages MJ has approved but that haven't shipped yet,
// in the order Cowork should send them (oldest first). Cowork drives the
// actual send via Chrome MCP; this endpoint is the data source.
//
// Query: ?client_id=...&limit=50 (max 100)
// Auth: x-internal-key

router.get('/linkedin-queue', requireInternalKey, async (req, res) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id query param required', code: 'MISSING_CLIENT_ID' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const { rows } = await pool.query(
      `SELECT
         m.id           AS message_id,
         m.subject,
         m.body,
         m.metadata     AS message_meta,
         m.channel,
         m.created_at,
         EXTRACT(EPOCH FROM (NOW() - m.created_at))::int AS age_seconds,
         l.id           AS lead_id,
         l.name         AS lead_name,
         l.company      AS lead_company,
         l.title        AS lead_title,
         l.linkedin_url AS lead_linkedin_url,
         l.country      AS lead_country,
         l.signal_tier  AS lead_signal_tier,
         l.metadata     AS lead_metadata
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.client_id = $1
         AND m.channel = 'linkedin'
         AND m.status = 'approved'
         AND m.sent_at IS NULL
       ORDER BY m.created_at ASC
       LIMIT $2`,
      [clientId, limit]
    );

    res.json({
      data: {
        client_id: clientId,
        count: rows.length,
        queue: rows,
      },
    });
  } catch (err) {
    logger.error({ msg: 'linkedin-queue query failed', err: err.message });
    res.status(500).json({ error: 'Failed to fetch LinkedIn queue', code: 'DB_ERROR' });
  }
});

/* ─── POST /api/autonomous/linkedin-mark-sent ───────────── */
// Cowork calls this after Chrome MCP confirms a LinkedIn action.
//
// Body: { client_id, message_id, action: 'sent' | 'connection_requested' | 'failed', notes? }
//
// 'sent' → message.status='sent' + sent_at=NOW + schedule follow-up + recount KPI
// 'connection_requested' → message.status='linkedin_requested' (waiting for accept; touch 1 not yet sendable)
// 'failed' → status reverts to 'approved' so the queue surfaces it again; log the reason

router.post('/linkedin-mark-sent', requireInternalKey, async (req, res) => {
  const { client_id, message_id, action, notes } = req.body || {};
  if (!client_id || !message_id || !action) {
    return res.status(400).json({ error: 'client_id, message_id, action required', code: 'MISSING_PARAMS' });
  }
  if (!['sent', 'connection_requested', 'failed'].includes(action)) {
    return res.status(400).json({ error: 'action must be one of: sent, connection_requested, failed', code: 'INVALID_ACTION' });
  }

  try {
    if (action === 'sent') {
      const { rows: [updated] } = await pool.query(
        `UPDATE messages SET status = 'sent', sent_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND client_id = $2 AND channel = 'linkedin' AND status = 'approved'
         RETURNING id, lead_id, sent_at`,
        [message_id, client_id]
      );
      if (!updated) {
        return res.status(404).json({ error: 'Message not found or not in approved state', code: 'NOT_FOUND' });
      }

      // Move lead pipeline_stage forward
      await pool.query(
        `UPDATE leads SET pipeline_stage = 'outreach', updated_at = NOW()
         WHERE id = $1 AND client_id = $2 AND pipeline_stage IN ('prospecting', 'researched')`,
        [updated.lead_id, client_id]
      );

      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
         VALUES ($1, 'system', 'linkedin_sent_via_cowork', 'message', $2, $3)`,
        [client_id, message_id, JSON.stringify({ notes: notes || null, lead_id: updated.lead_id })]
      );

      // Phase D piece 2 — outcome attribution: sent event (LinkedIn-via-Cowork)
      try {
        const { rows: [leadRow] } = await pool.query(
          `SELECT id, source, signal_tier, quality_score, metadata FROM leads WHERE id = $1 AND client_id = $2`,
          [updated.lead_id, client_id]
        );
        const { recordOutcome, attributionFromLead } = require('../services/outcomeTracker');
        recordOutcome(client_id, {
          outcome: 'sent',
          leadId: updated.lead_id,
          messageId: message_id,
          channel: 'linkedin',
          ...attributionFromLead(leadRow),
          eventData: { source_path: 'cowork', notes: notes || null },
        });
      } catch (err) {
        logger.warn({ msg: '[linkedin-mark-sent] outcome tracker failed', err: err.message });
      }

      // Schedule follow-up sequence (Day 2/5/10/18/30)
      try {
        const { scheduleFollowUps } = require('../services/followupSequence');
        await scheduleFollowUps(client_id, updated.lead_id, new Date());
      } catch (err) {
        logger.warn({ msg: 'scheduleFollowUps failed after linkedin send', err: err.message, message_id });
      }

      // Recompute daily KPI counters
      require('../services/kpi').recountKpi(client_id).catch(err =>
        logger.warn({ msg: '[linkedin-mark-sent] kpi recount failed', client_id, err: err?.message })
      );

      return res.json({ data: { message_id, status: 'sent', sent_at: updated.sent_at } });
    }

    if (action === 'connection_requested') {
      const { rows: [updated] } = await pool.query(
        `UPDATE messages SET status = 'linkedin_requested', updated_at = NOW()
         WHERE id = $1 AND client_id = $2 AND channel = 'linkedin' AND status = 'approved'
         RETURNING id, lead_id`,
        [message_id, client_id]
      );
      if (!updated) {
        return res.status(404).json({ error: 'Message not found or not in approved state', code: 'NOT_FOUND' });
      }

      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
         VALUES ($1, 'system', 'linkedin_connection_requested_via_cowork', 'message', $2, $3)`,
        [client_id, message_id, JSON.stringify({ notes: notes || null, lead_id: updated.lead_id })]
      );

      return res.json({ data: { message_id, status: 'linkedin_requested' } });
    }

    // action === 'failed' → just log; status stays 'approved' so it surfaces again
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, 'system', 'linkedin_send_failed_via_cowork', 'message', $2, $3)`,
      [client_id, message_id, JSON.stringify({ notes: notes || null })]
    );
    return res.json({ data: { message_id, status: 'failed_will_retry' } });
  } catch (err) {
    logger.error({ msg: 'linkedin-mark-sent failed', err: err.message });
    res.status(500).json({ error: 'Failed to mark sent', code: 'DB_ERROR' });
  }
});

/* ─── POST /api/autonomous/linkedin-sync-replies ───────────────
 * Closes the LinkedIn-replies blindspot. Reply detector is structurally
 * email-only (Gmail / AgentMail thread IDs). LinkedIn replies are invisible
 * unless ingested out-of-band. This endpoint accepts a batch from the local
 * Chrome-CDP sync script (scripts/sync-linkedin-replies-to-beavrdam.mjs in
 * MJxClaude) and matches inbound DMs against sent LinkedIn messages.
 *
 * For each match:
 *   - messages.reply_detected_at = NOW(), reply_snippet = last_msg_text
 *   - leads.last_reply_at + advance pipeline_stage to qualifying
 *   - stopSequence to cancel pending follow-ups (avoid noise on active threads)
 *   - handleReply for reply intelligence (auto-classify + draft response)
 *   - Audit log + Telegram notify
 *
 * Body: {
 *   client_id,
 *   replies: [
 *     { profile_url, last_msg_text, last_msg_at (ISO), last_msg_from_me (bool) }
 *   ]
 * }
 *
 * Auth: x-internal-key
 */

// Normalize a LinkedIn profile URL to a comparable slug.
// Handles: www./my./regional subdomains, /in/<slug>, trailing slash, query params.
// Returns lowercase slug or null.
function linkedinSlug(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

router.post('/linkedin-sync-replies', requireInternalKey, async (req, res) => {
  const { client_id, replies } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  if (!Array.isArray(replies)) return res.status(400).json({ error: 'replies must be an array', code: 'INVALID_REPLIES' });
  if (replies.length === 0) return res.json({ data: { client_id, received: 0, new_replies: 0, details: [] } });
  if (replies.length > 500) return res.status(400).json({ error: 'replies batch too large (max 500)', code: 'BATCH_TOO_LARGE' });

  // Normalize incoming + filter to inbound-only (last message NOT from MJ)
  const inbound = [];
  let skippedOutboundOnly = 0;
  for (const r of replies) {
    if (!r || typeof r !== 'object') continue;
    if (r.last_msg_from_me === true) { skippedOutboundOnly++; continue; }
    const slug = linkedinSlug(r.profile_url);
    if (!slug) continue;
    const lastMsgAt = r.last_msg_at ? new Date(r.last_msg_at) : null;
    if (!lastMsgAt || isNaN(lastMsgAt.getTime())) continue;
    inbound.push({
      slug,
      profile_url: r.profile_url,
      last_msg_text: String(r.last_msg_text || '').slice(0, 500),
      last_msg_at: lastMsgAt,
    });
  }

  if (inbound.length === 0) {
    return res.json({
      data: { client_id, received: replies.length, matched_leads: 0, new_replies: 0, skipped_outbound_only: skippedOutboundOnly, skipped_no_match: 0, skipped_stale: 0, details: [] },
    });
  }

  try {
    const slugs = [...new Set(inbound.map(r => r.slug))];

    // Pull all candidate sent LinkedIn messages with no reply yet, plus the
    // lead's normalized slug. Done in one query with regex extraction so we
    // don't N+1 the DB on the batch.
    const { rows: candidates } = await pool.query(
      `SELECT
         m.id            AS message_id,
         m.lead_id,
         m.sent_at,
         l.linkedin_url,
         lower(substring(l.linkedin_url FROM 'linkedin\\.com/in/([^/?#]+)')) AS slug
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.client_id = $1
         AND m.channel = 'linkedin'
         AND m.status = 'sent'
         AND m.reply_detected_at IS NULL
         AND m.sent_at IS NOT NULL
         AND l.linkedin_url IS NOT NULL
         AND lower(substring(l.linkedin_url FROM 'linkedin\\.com/in/([^/?#]+)')) = ANY($2)`,
      [client_id, slugs]
    );

    // Index candidates by slug → most recent unrepliedsent message per slug
    const bySlug = new Map();
    for (const c of candidates) {
      if (!c.slug) continue;
      const existing = bySlug.get(c.slug);
      if (!existing || new Date(c.sent_at) > new Date(existing.sent_at)) {
        bySlug.set(c.slug, c);
      }
    }

    const { stopSequence } = require('../services/followupSequence');
    const { handleReply } = require('../services/replyHandler');
    const logsService = require('../services/logs');

    const details = [];
    const newReplyMessageIds = [];
    let matchedLeads = 0;
    let skippedNoMatch = 0;
    let skippedStale = 0;

    // Dedup inbound by slug — keep the most recent inbound per slug
    const latestInbound = new Map();
    for (const r of inbound) {
      const existing = latestInbound.get(r.slug);
      if (!existing || r.last_msg_at > existing.last_msg_at) {
        latestInbound.set(r.slug, r);
      }
    }

    for (const r of latestInbound.values()) {
      const candidate = bySlug.get(r.slug);
      if (!candidate) {
        skippedNoMatch++;
        details.push({ profile_url: r.profile_url, slug: r.slug, result: 'no_match' });
        continue;
      }

      // Guard: inbound DM must be after our sent message (else it's an old
      // reply we already saw or a chronology mismatch).
      if (new Date(r.last_msg_at) <= new Date(candidate.sent_at)) {
        skippedStale++;
        details.push({ profile_url: r.profile_url, slug: r.slug, message_id: candidate.message_id, result: 'stale_pre_send' });
        continue;
      }

      try {
        // 1. Mark message replied
        await pool.query(
          `UPDATE messages
             SET reply_detected_at = NOW(),
                 reply_snippet = $2,
                 updated_at = NOW()
           WHERE id = $1
             AND reply_detected_at IS NULL`,
          [candidate.message_id, r.last_msg_text]
        );

        // 2. Advance lead
        await pool.query(
          `UPDATE leads
             SET last_reply_at = NOW(),
                 pipeline_stage = 'qualifying',
                 updated_at = NOW()
           WHERE id = $1 AND client_id = $2`,
          [candidate.lead_id, client_id]
        );

        // 3. Cancel pending follow-ups so we don't keep DM-ing someone mid-conversation
        try {
          await stopSequence(candidate.lead_id, 'replied_linkedin', client_id);
        } catch (err) {
          logger.warn({ msg: '[linkedin-sync-replies] stopSequence failed', lead_id: candidate.lead_id, err: err.message });
        }

        // 4. Audit log
        await logsService.createLog(client_id, {
          agent: 'system',
          action: 'reply_detected',
          target_type: 'message',
          target_id: candidate.message_id,
          metadata: {
            channel: 'linkedin',
            source: 'sync_endpoint',
            profile_url: r.profile_url,
            snippet: r.last_msg_text.slice(0, 200),
            lead_id: candidate.lead_id,
          },
        });

        // Phase D piece 2 — outcome attribution: replied event (LinkedIn path)
        try {
          const { rows: [leadRow] } = await pool.query(
            `SELECT id, source, signal_tier, quality_score, metadata FROM leads WHERE id = $1 AND client_id = $2`,
            [candidate.lead_id, client_id]
          );
          const { recordOutcome, attributionFromLead } = require('../services/outcomeTracker');
          recordOutcome(client_id, {
            outcome: 'replied',
            leadId: candidate.lead_id,
            messageId: candidate.message_id,
            channel: 'linkedin',
            ...attributionFromLead(leadRow),
            eventData: { source_path: 'sync_endpoint', profile_url: r.profile_url, snippet: r.last_msg_text.slice(0, 200) },
          });
        } catch (err) {
          logger.warn({ msg: '[linkedin-sync-replies] outcome tracker failed', err: err.message });
        }

        // 5. Reply intelligence (fire-and-forget) — re-uses the same path as
        // email replies so classify + auto-draft response works for LinkedIn too.
        handleReply(client_id, {
          messageId: candidate.message_id,
          leadId: candidate.lead_id,
          replySnippet: r.last_msg_text,
        }).catch(err => logger.warn({ msg: '[linkedin-sync-replies] handleReply failed', err: err.message }));

        matchedLeads++;
        newReplyMessageIds.push(candidate.message_id);
        details.push({
          profile_url: r.profile_url,
          slug: r.slug,
          lead_id: candidate.lead_id,
          message_id: candidate.message_id,
          result: 'marked_replied',
        });
      } catch (err) {
        logger.warn({ msg: '[linkedin-sync-replies] per-message error', message_id: candidate.message_id, err: err.message });
        details.push({ profile_url: r.profile_url, slug: r.slug, message_id: candidate.message_id, result: 'error', error: err.message });
      }
    }

    // Telegram notify (compact preview, fire-and-forget) — mirrors replyDetector behavior
    if (newReplyMessageIds.length > 0) {
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (chatId) {
        try {
          const telegramService = require('../services/telegram');
          const appUrl = process.env.FRONTEND_URL || 'https://app.beaver.solutions';
          const { rows: previewRows } = await pool.query(
            `SELECT l.name, l.company
               FROM messages m JOIN leads l ON l.id = m.lead_id
              WHERE m.id = ANY($1) AND m.client_id = $2`,
            [newReplyMessageIds, client_id]
          );
          let preview = previewRows.slice(0, 3).map(r => `• ${r.name} (${r.company}) via linkedin`).join('\n');
          if (previewRows.length > 3) preview += `\n+ ${previewRows.length - 3} more`;
          const text = `<b>${matchedLeads} new LinkedIn repl${matchedLeads === 1 ? 'y' : 'ies'}</b>\n\n${preview}\n\n<a href="${appUrl}/approvals">Review replies →</a>`;
          telegramService.sendMessage(chatId, text).catch(err =>
            logger.warn({ msg: '[linkedin-sync-replies] Telegram notify error', err: err.message })
          );
        } catch (err) {
          logger.warn({ msg: '[linkedin-sync-replies] Telegram setup error', err: err.message });
        }
      }
    }

    return res.json({
      data: {
        client_id,
        received: replies.length,
        matched_leads: matchedLeads,
        new_replies: newReplyMessageIds.length,
        skipped_outbound_only: skippedOutboundOnly,
        skipped_no_match: skippedNoMatch,
        skipped_stale: skippedStale,
        details,
      },
    });
  } catch (err) {
    logger.error({ msg: 'linkedin-sync-replies failed', err: err.message });
    res.status(500).json({ error: 'Failed to sync LinkedIn replies', code: 'DB_ERROR' });
  }
});

/* ─── POST /api/autonomous/trigger-morning-brief ───────────────
 * Manual trigger for the Captain morning brief. Bypasses the cron
 * time-gate (01:00-01:10 UTC) so we can validate format/content
 * changes without waiting for the next natural fire.
 *
 * Sends to Telegram in the same format as the daily cron path.
 *
 * Body: { client_id }
 * Auth: x-internal-key
 */
router.post('/trigger-morning-brief', requireInternalKey, async (req, res) => {
  const { client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });

  try {
    const captain = require('../services/captainOrchestrator');
    const brief = await captain.runMorningBrief(client_id);
    const text = brief?.summary || 'No summary generated.';

    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (chatId) {
      const telegramService = require('../services/telegram');
      await telegramService.sendMessage(chatId, `<b>Morning brief (manual)</b>\n\n${text}`);
    }

    return res.json({
      data: {
        client_id,
        text_length: text.length,
        text_preview: text.slice(0, 500),
        telegram_sent: !!chatId,
      },
    });
  } catch (err) {
    logger.error({ msg: 'trigger-morning-brief failed', err: err.message });
    return res.status(500).json({ error: 'Failed to trigger morning brief', code: 'BRIEF_ERROR', message: err.message });
  }
});

/* ─── POST /api/autonomous/trigger-quality-tune ───────────────
 * Manual trigger for the Phase D piece 3 weekly auto-tuner. Bypasses
 * the Sunday 09:00-09:10 UTC cron time-gate so we can validate the
 * algorithm without waiting for the next Sunday.
 *
 * Body: { client_id, dry_run?: bool }
 *   dry_run: report what WOULD change without writing
 *
 * Auth: x-internal-key
 */
router.post('/trigger-quality-tune', requireInternalKey, async (req, res) => {
  const { client_id, dry_run = false } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });

  try {
    const { runQualityTune } = require('../services/qualityTuner');
    const result = await runQualityTune(client_id, { dryRun: !!dry_run });
    return res.json({ data: result });
  } catch (err) {
    logger.error({ msg: 'trigger-quality-tune failed', err: err.message });
    return res.status(500).json({ error: 'Failed to run quality tuner', code: 'TUNER_ERROR', message: err.message });
  }
});

/* ─── POST /api/autonomous/trigger-market-sensing ─────────────
 * Manual trigger for the Phase E market-sensing run. Bypasses the
 * 00:30-00:40 UTC cron time-gate so we can validate the source set
 * + LLM extraction without waiting until tomorrow morning.
 *
 * Body: { client_id }
 * Auth: x-internal-key
 */
router.post('/trigger-market-sensing', requireInternalKey, async (req, res) => {
  const { client_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });

  try {
    const { runMarketSensing } = require('../services/marketSensing');
    const payload = await runMarketSensing(client_id);

    return res.json({
      data: {
        client_id,
        date: payload.date,
        sources_queried: payload.sources_queried,
        raw_results_count: payload.raw_results_count,
        opportunities_count: payload.opportunities.length,
        opportunities: payload.opportunities.slice(0, 5),  // preview only
        raw_sample: payload.raw_sample,  // visibility into what Brave returned
      },
    });
  } catch (err) {
    logger.error({ msg: 'trigger-market-sensing failed', err: err.message });
    return res.status(500).json({ error: 'Failed to run market sensing', code: 'SENSING_ERROR', message: err.message });
  }
});

/* ─── POST /api/autonomous/vibe-prospecting/test ──────────────
 * Sentinel probe for the Vibe Prospecting (Explorium) integration.
 * Runs the full chain on a known business+prospect (Microsoft / Satya Nadella):
 *   match-business (FREE) → match-prospects (FREE) → enrich-prospects ['contacts'] (~5 credits)
 * Returns the verified email, status, and credits spent.
 * Hits 5 credits per call. Use sparingly. Removable once 6.3 onboarding ships.
 *
 * Body: { client_id }
 */
router.post('/vibe-prospecting/test', requireInternalKey, async (req, res) => {
  const { client_id } = req.body || {};
  if (!client_id || !UUID_RE.test(String(client_id))) {
    return res.status(400).json({ error: 'client_id required (UUID)' });
  }
  try {
    const vp = require('../services/vibeProspecting');
    const apiKey = await vp.getApiKey(client_id);
    if (!apiKey) {
      return res.status(400).json({
        ok: false,
        error: 'no_api_key',
        hint: 'Set VIBE_PROSPECTING_API_KEY env var (bootstrap) or seed via secrets.setClientSecret(clientId, "system", "vibe_prospecting_api_key", { key })',
      });
    }
    const result = await vp.findVerifiedEmail(client_id, {
      fullName: 'Satya Nadella',
      company: 'Microsoft',
      domain: 'microsoft.com',
    });
    return res.json({
      ok: result?.ok === true,
      // Mask the email value so the response itself is not a leak vector when shared
      email_masked: result?.email ? result.email.replace(/^(.).*(@.*)$/, '$1***$2') : null,
      email_verified: result?.email_verified || false,
      email_status: result?.email_status || null,
      business_id: result?.business_id || null,
      prospect_id: result?.prospect_id || null,
      credits_used: result?.credits ?? 0,
      error: result?.error || null,
    });
  } catch (err) {
    logger.error({ msg: 'vp-test failed', err: err.message, stack: err.stack?.split('\n').slice(0, 3) });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─── POST /api/autonomous/backfill-hunter-emails ─────────
 * One-shot bulk Hunter enrichment for leads in the prospecting pool
 * with no email. Calls existing enrichLeadsWithHunter helper.
 *
 * Auth: x-internal-key
 * Body: { client_id (uuid), limit?: 200, min_confidence?: 70 }
 * Returns: { picked, enriched, verified, skipped, errors, reasons }
 *
 * Idempotent: only touches rows where email IS NULL or '' (untouched leads).
 */
router.post('/backfill-hunter-emails', requireInternalKey, async (req, res) => {
  const { client_id } = req.body || {};
  const limit = Math.min(parseInt(req.body?.limit, 10) || 200, 500);
  const minConfidence = parseInt(req.body?.min_confidence, 10) || 70;

  if (!client_id) {
    return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  }

  try {
    const hunter = require('../services/hunter');
    const apiKey = await hunter.getApiKey(client_id);
    if (!apiKey) {
      return res.status(412).json({ error: 'Hunter API key not configured for this client', code: 'NO_HUNTER_KEY' });
    }

    const { rows: leads } = await pool.query(
      `SELECT id, name, company
         FROM leads
        WHERE client_id = $1
          AND deleted_at IS NULL
          AND pipeline_stage = 'prospecting'
          AND status = 'new'
          AND (email IS NULL OR email = '')
          AND company IS NOT NULL AND company <> ''
          AND name    IS NOT NULL AND name    <> ''
        ORDER BY created_at DESC
        LIMIT $2`,
      [client_id, limit]
    );

    const counts = { picked: leads.length, enriched: 0, verified: 0, skipped: 0, errors: 0 };
    const reasons = {};

    for (const lead of leads) {
      try {
        const parts = (lead.name || '').trim().split(/\s+/);
        const firstName = parts[0] || '';
        const lastName  = parts.slice(1).join(' ') || '';
        if (!firstName || !lastName) {
          counts.skipped++;
          reasons.name_unsplittable = (reasons.name_unsplittable || 0) + 1;
          continue;
        }

        const result = await hunter.findEmail(client_id, { firstName, lastName, company: lead.company });
        if (!result?.email) {
          counts.skipped++;
          reasons.no_email_found = (reasons.no_email_found || 0) + 1;
          continue;
        }
        if ((result.confidence || 0) < minConfidence) {
          counts.skipped++;
          const k = `low_confidence_${result.confidence}`;
          reasons[k] = (reasons[k] || 0) + 1;
          continue;
        }

        await pool.query(
          `UPDATE leads
              SET email          = $1,
                  email_verified = $2,
                  email_source   = 'hunter_backfill',
                  updated_at     = NOW()
            WHERE id = $3 AND client_id = $4
              AND (email IS NULL OR email = '')`,
          [result.email, !!result.verified, lead.id, client_id]
        );
        counts.enriched++;
        if (result.verified) counts.verified++;
      } catch (err) {
        counts.errors++;
        logger.warn({ msg: '[backfill-hunter] lead error', leadId: lead.id, err: err.message });
      }
      // gentle pacing — Hunter has a per-second rate limit
      await new Promise(r => setTimeout(r, 150));
    }

    logger.info({ msg: '[backfill-hunter] complete', client_id, ...counts });
    return res.json({ ok: true, ...counts, skip_reasons: reasons });
  } catch (err) {
    logger.error({ msg: '[backfill-hunter] failed', err: err.message, stack: err.stack?.split('\n').slice(0, 4) });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports.runAutonomousKickoff = runAutonomousKickoff;
