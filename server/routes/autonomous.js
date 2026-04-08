'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const { directorExecute } = require('../services/agents');
const { runWithClientContext } = require('../middleware/clientContext');
const logger = require('../utils/logger');

/* ─── Auth helper ─────────────────────────────────────────── */

function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];
  // Explicitly guard against missing env var — if INTERNAL_API_KEY is undefined,
  // both key and process.env.INTERNAL_API_KEY would be undefined and comparison would pass.
  if (!process.env.INTERNAL_API_KEY || !key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_KEY' });
  }
  next();
}

/* ─── POST /api/autonomous/kickoff ───────────────────────── */

router.post('/kickoff', requireInternalKey, async (req, res) => {
  const { client_id } = req.body;
  if (!client_id || (typeof client_id === 'string' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(client_id))) {
    return res.status(400).json({ error: 'Valid client_id (UUID) required', code: 'INVALID_CLIENT_ID' });
  }

  // Respond immediately so scheduler doesn't time out
  res.json({ data: { status: 'kickoff_started', client_id } });

  // Background task — bind clientId into AsyncLocalStorage so every deep
  // `callAgent(...)` inside the kickoff gets budget-checked and usage-logged
  // against the right tenant.
  runWithClientContext(client_id, () =>
    runAutonomousKickoff(client_id).catch(err =>
      console.error(`[Autonomous] Kickoff failed for ${client_id}:`, err.message)
    )
  );
});

/* ─── POST /api/autonomous/kickoff-all ───────────────────── */

router.post('/kickoff-all', requireInternalKey, async (req, res) => {
  const { rows: clients } = await pool.query(
    `SELECT id FROM clients`
  );

  res.json({ data: { status: 'kickoff_started', clients: clients.length } });

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
    const { rows: [approval] } = await pool.query(
      `UPDATE approvals SET status = 'approved', resolved_at = NOW()
       WHERE id = $1 AND client_id = $2 AND status = 'pending'
       RETURNING id, message_id`,
      [approval_id, client_id]
    );
    if (!approval) {
      return res.status(404).json({ error: 'Approval not found or already actioned', code: 'NOT_FOUND' });
    }
    await pool.query(
      `UPDATE messages SET status = 'approved' WHERE id = $1`,
      [approval.message_id]
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
// Called by n8n daily to surface stale leads for re-engagement or nurture.

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
// n8n calls this every 5 minutes to send all approved messages.
// Bridge between approval queue and actual email/LinkedIn send.

router.post('/send-approved', requireInternalKey, async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });

  try {
    const { sendMessageById } = require('./integrations');

    // Get all approved messages ready to send
    const { rows: approved } = await pool.query(
      `SELECT id, channel, lead_id FROM messages
       WHERE client_id = $1 AND status = 'approved'
       ORDER BY created_at ASC
       LIMIT 20`,
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
          // simulated or other — don't count as sent
          logger.info({ msg: `[auto-send] Message ${msg.id} result: ${result.status}`, client_id });
        }
      } catch (err) {
        failed++;
        logger.error({ msg: `[auto-send] Failed to send message ${msg.id}`, err: err.message, client_id });
      }
    }

    return res.json({ data: { sent, failed, total: approved.length } });
  } catch (err) {
    logger.error({ msg: '[auto-send] Batch send failed', err: err.message, client_id });
    return res.status(500).json({ error: err.message, code: 'SEND_FAILED' });
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

  // Update daily_kpi with live count
  await pool.query(
    `UPDATE daily_kpi SET outreach_sent = $1, outreach_email = $1, updated_at = NOW()
     WHERE client_id = $2 AND date = $3`,
    [sent, clientId, today]
  );

  const { rows: [kpiRow] } = await pool.query(
    `SELECT target FROM daily_kpi WHERE client_id = $1 AND date = $2`,
    [clientId, today]
  );
  const target = kpiRow?.target || 80;
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

        const { rows: [savedMsg] } = await pool.query(
          `INSERT INTO messages (client_id, lead_id, subject, body, status, metadata, channel, follow_up_day)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            clientId,
            followUp.lead_id,
            draft.subject || null,
            cleanBody,
            passedGates ? 'pending_approval' : 'ranger_rejected',
            JSON.stringify({ ...draft, is_followup: true, touch_number: followUp.touch_number, gate_failures: gateFailures }),
            originalChannel,
            followUp.touch_number === 2 ? 2 : followUp.touch_number === 3 ? 4 : 7,
          ]
        );

        if (passedGates) {
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system')`,
            [clientId, savedMsg.id]
          );
        }

        await pool.query(
          `UPDATE followup_queue SET status = $1, message_id = $2 WHERE id = $3`,
          [passedGates ? 'sent' : 'skipped', savedMsg.id, followUp.id]
        );

        // Calculate next follow-up date
        const nextTouch = followUp.touch_number + 1;
        const nextDate = nextTouch <= 4
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

  // ── Loop scheduler ────────────────────────────────────────
  // Captain Beaver keeps batching until the daily target is met.
  // Each batch sources up to 10 leads. Recalculates gap after each pass.
  // Safety cap: 8 batches max (~80 leads) to prevent runaway costs.
  const MAX_BATCHES = 8;
  const BATCH_SIZE = 10;

  for (let batch = 1; batch <= MAX_BATCHES; batch++) {
    // Recalculate live gap: count sent + pending_approval today
    const { rows: liveCount } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent'            AND DATE(COALESCE(sent_at, created_at)) = $2) AS sent,
         COUNT(*) FILTER (WHERE status = 'pending_approval' AND DATE(created_at) = $2)                   AS pending
       FROM messages WHERE client_id = $1`,
      [clientId, today]
    );
    const liveSent    = parseInt(liveCount[0].sent)    || 0;
    const livePending = parseInt(liveCount[0].pending) || 0;
    const liveGap     = target - liveSent - livePending;

    if (liveGap <= 0) {
      console.log(`[Autonomous] Client ${clientId} batch ${batch}: target met (${liveSent} sent + ${livePending} pending). Stopping loop.`);
      await logAction(clientId, 'director', 'kpi_target_met', 'system', null, { batch, liveSent, livePending, target });
      break;
    }

    console.log(`[Autonomous] Client ${clientId} batch ${batch}/${MAX_BATCHES}: gap=${liveGap}, sent=${liveSent}, pending=${livePending}`);

    const batchBrief = buildAutonomousBrief({
      gap: Math.min(liveGap, BATCH_SIZE),
      icp, lastLearnings, rejectionPatterns,
      sent: liveSent, target,
    });

    await directorExecute(clientId, { plan_id: uuidv4(), command: batchBrief });

    // Brief pause between batches — avoids hammering Apollo/Serper/Claude
    if (batch < MAX_BATCHES) {
      await new Promise(r => setTimeout(r, 3000));
    }
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

module.exports = router;
