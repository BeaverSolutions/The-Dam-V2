'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const agentsService = require('../services/agents');
const { directorExecute, rangerReview } = agentsService;
const { runWithClientContext } = require('../middleware/clientContext');
const pipelineTrace = require('../services/pipelineTrace');
const logger = require('../utils/logger');
const {
  leadSelectionFeedbackExclusionSql,
  currentSignalPackageEligibilitySql,
} = require('../services/founderFeedbackSignals');
const { checkBudget, isBudgetExceededError } = require('../services/budget');
const autonomyStateService = require('../services/autonomyState');
const { todayInMalaysia } = require('../utils/businessDay');
const { parseRequestedLeadCount } = require('../utils/requestedLeadCount');
const { shouldStopForLowOutput } = require('../utils/campaignLimits');

/* ─── Auth helper ─────────────────────────────────────────── */

// Strict UUID v1-v5 validator — rejects malformed input before it reaches SQL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASIC_OPERATING_SURFACE_V2_1 = Object.freeze({
  mode: 'v2_1_basic',
  safe_channels: Object.freeze([
    'approval_queue',
    'manual_linkedin_queue',
    'email_send_queue',
    'reply_tracking',
    'followup_visibility',
  ]),
  channel_policy: Object.freeze({
    approval_queue: Object.freeze({
      enabled: true,
      mode: 'manual_review_before_send',
    }),
    manual_linkedin_queue: Object.freeze({
      enabled: true,
      mode: 'manual_safe',
      managed_automation: false,
      auto_connect: false,
      accepted_dm_automation: false,
      route: '/api/autonomous/linkedin-queue',
      completion_route: '/api/autonomous/linkedin-mark-sent',
      reply_sync_route: '/api/autonomous/linkedin-sync-replies',
    }),
    email_send_queue: Object.freeze({
      enabled: true,
      mode: 'existing_supported_email_path_only',
      auto_send_channel: 'email',
    }),
    reply_tracking: Object.freeze({
      enabled: true,
      mode: 'gmail_agentmail_and_manual_linkedin_reply_tracking',
    }),
    followup_visibility: Object.freeze({
      enabled: true,
      mode: 'visible_queue_no_marketing_campaigns',
    }),
  }),
  premium_exclusions: Object.freeze([
    'marketing_beaver',
    'email_campaign_system',
    'managed_linkedin_automation',
    'auto_connect',
    'accepted_dm_automation',
  ]),
  external_tenant_activation_gate: Object.freeze([
    'v2_1_basic_path_honest',
    'byok_access_plan_clear',
    'sender_persona_confirmed',
    'voice_examples_or_safe_starter_voice',
    'geo_and_icp_clear',
    'tenant_specific_signal_config',
    'no_fresh_red_blocker',
  ]),
  tin_city_status: 'inactive_until_gate_passes',
});

function parseRequestedLeadLimit(message, defaultLimit = 20) {
  return parseRequestedLeadCount(message, defaultLimit);
}

function boundedChatSignalQueryCap(requestedLimit) {
  const n = Number(requestedLimit);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(3, Math.min(20, (Math.ceil(n) * 3) + 2));
}

function boundedResearchProofQueryCap(requestedCap) {
  const n = Number(requestedCap);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.max(5, Math.min(18, Math.floor(n)));
}

function isChatCampaignIntent(message) {
  const msg = String(message || '').toLowerCase();
  return /\b(kickoff|kick off|start|execute|fire|begin|launch)\b/i.test(msg)
    || /\brun\b[\s\S]{0,80}\b(campaign|outreach|batch)\b/i.test(msg)
    || /\bfind\b[\s\S]{0,120}\b(leads?|prospects?|founders?|ceos?|directors?|agenc(?:y|ies))\b/i.test(msg);
}

function basicOperatingSurfaceForTenant(snapshot = {}) {
  return {
    ...BASIC_OPERATING_SURFACE_V2_1,
    queue_snapshot: snapshot,
  };
}

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

// Resolve the client IDs the autonomous system may fan out to. Honours the
// AUTONOMOUS_ENABLED_CLIENTS slug whitelist (audit A6-1/A6-2: /kickoff-all and
// /weekly-review previously fanned out to EVERY client, ignoring the gate).
// Empty whitelist returns no clients. Single-tenant manual work should use the
// explicit /kickoff client_id route; fanout must be consciously scoped.
async function getEnabledClientIds() {
  const whitelist = (process.env.AUTONOMOUS_ENABLED_CLIENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (whitelist.length > 0) {
    const { rows } = await pool.query('SELECT id FROM clients WHERE slug = ANY($1)', [whitelist]);
    return rows.map(r => r.id);
  }
  logger.warn('[autonomous] AUTONOMOUS_ENABLED_CLIENTS empty — fanout routes resolve to zero clients');
  return [];
}

// Defense-in-depth: apply auth at router level so no future route skips it.
router.use(requireInternalKey);


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
 *   - signal hunt  → gated bounded Research-only signal hunt
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
      const today = todayInMalaysia();
      const { rows: [counts] } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS sent_today,
           COUNT(*) FILTER (WHERE status = 'pending_approval' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)          AS pending,
           COUNT(*) FILTER (WHERE status = 'approved' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)                  AS approved_awaiting_send,
           COUNT(*) FILTER (WHERE status = 'ranger_rejected' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)           AS rejected,
           COUNT(*) FILTER (WHERE status = 'replied')                                       AS total_replied
         FROM messages WHERE client_id = $1`,
        [client_id, today]
      );
      const { rows: [leadCounts] } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS leads_today
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
    else if (isChatCampaignIntent(lowerMsg)) {
      // Calendar gate — must have Google Calendar OR Calendly connected
      const calendarService = require('../services/googleCalendar');
      const hasCalendar = await calendarService.hasAnyCalendar(client_id);
      if (!hasCalendar) {
        return res.status(403).json({
          error: 'Connect Google Calendar or Calendly in Settings before running campaigns',
          code: 'CALENDAR_REQUIRED',
        });
      }
      const { expireStaleRunningExecutions } = require('../services/captainBeaver');
      await expireStaleRunningExecutions(client_id).catch(err => {
        logger.warn({ msg: '[chat] stale execution cleanup failed', client_id, err: err.message });
        return 0;
      });
      const planId = uuidv4();

      // Keep chat-triggered runs bounded. "Find 5" must not fall through to the
      // DB-pool default of 20 before Director sees the command.
      const requestedLimit = parseRequestedLeadLimit(message);
      const explicitRequestedLimit = parseRequestedLeadLimit(message, null);
      const maxPaidSignalQueries = boundedChatSignalQueryCap(explicitRequestedLimit);

      // Phase 2 V2 Step 9 (2026-05-15): no brief is built here. Research is
      // ICP-driven from agent_memory; passing a paragraph as `command` used to
      // pollute Brave's query string. directorExecute reads ICP directly.
      let effectiveCommand = message;

      response.data = { plan_id: planId };

      // DB-first: check if we already have uncontacted leads in the pool
      let usedDbPool = false;
      try {
        const poolLimit = requestedLimit || 20;
        const { rows: poolLeads } = await pool.query(
          `SELECT id, name, company, title, signal_tier, email, linkedin_url
           FROM leads
           WHERE client_id = $1
             AND pipeline_stage = 'prospecting'
             AND status = 'new'
             AND (first_contacted_at IS NULL OR first_contacted_at < NOW() - INTERVAL '14 days')
             AND deleted_at IS NULL
             AND NULLIF(BTRIM(name), '') IS NOT NULL
             AND NULLIF(BTRIM(company), '') IS NOT NULL
             AND LOWER(BTRIM(company)) NOT IN ('unknown', 'unknown company', 'independent', 'self-employed', 'self employed', 'stealth', 'confidential')
             AND (email IS NOT NULL OR linkedin_url IS NOT NULL)
             AND (
               (email IS NOT NULL AND (email_verified IS TRUE OR email_source = 'hunter'))
               OR (
                 linkedin_url IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM messages ml
                    WHERE ml.client_id = leads.client_id
                      AND ml.lead_id = leads.id
                      AND ml.channel = 'linkedin'
                      AND ml.status NOT IN ('deleted')
                 )
               )
             )
             AND (
               SELECT COUNT(*)::int
                 FROM messages mr
                WHERE mr.client_id = leads.client_id
                  AND mr.lead_id = leads.id
                  AND mr.status IN ('rejected', 'ranger_rejected')
             ) < 2
             AND NOT EXISTS (
               SELECT 1 FROM messages m WHERE m.lead_id = leads.id AND m.client_id = leads.client_id
                  AND m.status IN (
                    'pending_ranger', 'pending_approval', 'approved',
                    'pending_send', 'sending', 'sent', 'delivered',
                    'linkedin_requested', 'awaiting_accept'
                  )
             )
             AND NOT EXISTS (
               SELECT 1 FROM pipeline_traces pt
                WHERE pt.client_id = leads.client_id AND pt.lead_id = leads.id
                  AND pt.stage = 'enrolled'
                  AND (pt.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date =
                      (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
             )
             ${leadSelectionFeedbackExclusionSql('leads')}
             ${currentSignalPackageEligibilitySql('leads')}
            ORDER BY
              CASE WHEN signal_tier = 'P1' THEN 1 WHEN signal_tier = 'P2' THEN 2 ELSE 3 END,
              CASE WHEN email IS NOT NULL THEN 0 ELSE 1 END,
             score DESC
           LIMIT $2`,
          [client_id, poolLimit]
        );

        if (poolLeads.length >= poolLimit) {
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
              allowPaidSignal: false,
              sourceMode: 'chat_db_pool',
            }).catch(err => {
              console.error(`[chat] DB pool directorExecute failed:`, err.message);
            })
          );
        } else if (poolLeads.length > 0) {
          await logsService.createLog(client_id, {
            agent: 'captain',
            action: 'chat_db_pool_insufficient',
            metadata: {
              plan_id: planId,
              requested: poolLimit,
              available: poolLeads.length,
              boundary: 'db_pool_must_satisfy_requested_target_before_short_circuit',
            },
          }).catch(() => {});
        }
      } catch (err) {
        console.warn('[chat] DB pool check failed, falling back to research:', err.message);
      }

      // Fallback: cold research if DB pool insufficient
      if (!usedDbPool) {
        response.reply = `Dispatching to the crew. Captain is briefing Research Beaver now. Poll back with "status" in 60s.`;
        response.actions_taken.push('triggered_director_execute');

        runWithClientContext(client_id, () =>
          directorExecute(client_id, {
            plan_id: planId,
            command: effectiveCommand,
            limit: requestedLimit,
            maxPaidSignalQueries,
          }).catch(err => {
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
      const { runSignalHunt, saveSignalLeads, previewSignalHuntPlan } = require('../services/signalHunt');

      // Load ICP for signal hunt
      const { rows: icpRows } = await pool.query(
        `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
        [client_id]
      );
      const icp = icpRows[0]?.content || {};
      const signalLimit = Math.max(1, Math.min(
        Number(req.body?.signal_limit || req.body?.limit || parseRequestedLeadLimit(message, 5)) || 5,
        5
      ));
      const signalPaidQueryCap = boundedChatSignalQueryCap(signalLimit);
      const plan = await previewSignalHuntPlan(client_id, {
        icp,
        maxLeads: signalLimit,
        maxPaidQueries: signalPaidQueryCap,
      });

      if (req.body?.allow_paid_signal_hunt !== true) {
        response.reply = 'Signal Hunt is gated. Review the query plan first, then call again with allow_paid_signal_hunt=true.';
        response.actions_taken.push('signal_hunt_paid_gate_required');
        response.data = {
          mode: 'signal_hunt_preview',
          max_limit: 5,
          required_flag: 'allow_paid_signal_hunt=true',
          query_plan: plan,
        };
        return res.json(response);
      }

      response.reply = `Running bounded signal hunt in the background. Target: ${signalLimit} Research-only lead${signalLimit === 1 ? '' : 's'}. No Sales, Enforcer, approvals, or send queue will be triggered from this chat branch.`;
      response.actions_taken.push('triggered_signal_hunt');
      response.data = {
        mode: 'bounded_signal_hunt_research_only',
        requested_limit: signalLimit,
        paid_query_cap: signalPaidQueryCap,
        query_plan: plan,
      };

      runWithClientContext(client_id, () =>
        (async () => {
          try {
            const leads = await runSignalHunt(client_id, {
              maxLeads: signalLimit,
              icp,
              maxPaidQueries: signalPaidQueryCap,
            });
            if (leads.length > 0) {
              const saved = await saveSignalLeads(client_id, leads);
              console.log(`[chat] Signal hunt saved ${saved.length} leads for ${client_id}`);
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

/* ─── POST /api/autonomous/pool-audit-batch ─────────────────
 * One-shot batch audit of the entire active lead pool against current
 * applyIcpV2Filter. Same logic as the per-kickoff pool audit at L1606+
 * but runs against ALL active leads in one pass instead of the 20-at-a-time
 * sample that each kickoff sees.
 *
 * Use case: clean up historical pool pollution (e.g. Apr 17 → May 5
 * Google CSE fallback dumped 619 leads, many off-persona/off-ICP).
 * Without this, every kickoff audits + soft-deletes the same 12/20 leads
 * repeatedly, wasting tokens and slowing the pipeline. Run once, future
 * kickoffs see only the survivors.
 *
 * Body: { client_id, dry_run? (default true) }
 * Auth: x-internal-key
 *
 * dry_run=true → returns count + sample of rejects, no DB writes.
 * dry_run=false → executes the soft-delete (status='rejected_legacy_audit',
 *                  deleted_at=NOW()), returns count + sample of what was deleted.
 */
router.post('/pool-audit-batch', requireInternalKey, async (req, res) => {
  const { client_id, dry_run } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  const isDryRun = dry_run !== false; // default true — must opt-in to delete

  try {
    const { applyIcpV2Filter } = require('../services/agents');

    // Pull every active lead for the tenant. Bounded by 5000 — large enough for
    // any reasonable tenant pool, small enough to fit in one Postgres response.
    const { rows: leads } = await pool.query(
      `SELECT id, name, company, title, country, score, source, metadata
       FROM leads
       WHERE client_id = $1
         AND deleted_at IS NULL
         AND status NOT IN ('rejected_legacy_audit', 'closed_won', 'closed_lost', 'replied', 'meeting_booked')
       LIMIT 5000`,
      [client_id]
    );

    const rejects = [];
    const passes = [];
    for (const lead of leads) {
      const v2 = applyIcpV2Filter(lead);
      if (v2.pass) {
        passes.push(lead.id);
      } else {
        rejects.push({
          id: lead.id, name: lead.name, company: lead.company,
          title: lead.title, source: lead.source,
          status: v2.status, reason: v2.reason,
        });
      }
    }

    const summary = {
      client_id,
      dry_run: isDryRun,
      total_audited: leads.length,
      passes: passes.length,
      rejects: rejects.length,
      reject_sample: rejects.slice(0, 10),
      reject_by_source: rejects.reduce((acc, r) => {
        acc[r.source || 'null'] = (acc[r.source || 'null'] || 0) + 1;
        return acc;
      }, {}),
      reject_by_status: rejects.reduce((acc, r) => {
        acc[r.status || 'null'] = (acc[r.status || 'null'] || 0) + 1;
        return acc;
      }, {}),
    };

    if (isDryRun || rejects.length === 0) {
      return res.json({ data: summary });
    }

    // Execute soft-delete. Group rejects by their per-lead v2.status so each
    // UPDATE uses a status value the leads_status_check CHECK allows.
    // (Allowed: rejected_persona, rejected_vertical, rejected_size,
    //  rejected_data_integrity, rejected_country, rejected_low_score, etc.)
    // Per-kickoff audit at L1628 used hardcoded 'rejected_legacy_audit' which
    // FAILS this CHECK silently via .catch() — soft-delete never persisted.
    const byStatus = {};
    for (const r of rejects) {
      const s = r.status || 'rejected_data_integrity';
      (byStatus[s] = byStatus[s] || []).push(r.id);
    }
    for (const [statusValue, ids] of Object.entries(byStatus)) {
      await pool.query(
        `UPDATE leads SET status = $1, deleted_at = NOW(),
                          metadata = COALESCE(metadata, '{}'::jsonb)
                                  || jsonb_build_object('legacy_audit_reason', $3::text,
                                                        'batch_audit_run_at', NOW()::text)
         WHERE id = ANY($2::uuid[]) AND client_id = $4 AND deleted_at IS NULL`,
        [statusValue, ids, 'batch_pool_audit_2026_05_14', client_id]
      );
    }

    await logAction(client_id, 'director', 'pool_audit_batch_executed', 'system', null, {
      total_audited: leads.length,
      rejects: rejects.length,
      passes: passes.length,
    });

    return res.json({ data: { ...summary, executed: true } });
  } catch (err) {
    logger.error({ msg: 'pool-audit-batch failed', err: err.message });
    res.status(500).json({ error: 'Pool audit batch failed', code: 'DB_ERROR' });
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
// Disabled by default. Daily autonomy uses the scheduler path, and validation
// must use single-tenant /kickoff so one bad trigger cannot fan out spend.
// Re-enable only for a deliberate multi-tenant maintenance window.

router.post('/kickoff-all', requireInternalKey, async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true' || req.body?.force === true;
  if (process.env.KICKOFF_ALL_ENABLED !== 'true') {
    return res.status(403).json({
      error: 'kickoff-all is disabled',
      code: 'KICKOFF_ALL_DISABLED',
      hint: 'Use POST /api/autonomous/kickoff with one client_id.',
    });
  }

  if (force && process.env.KICKOFF_FORCE_OVERRIDE_ENABLED !== 'true') {
    return res.status(403).json({
      error: 'kickoff force override is disabled',
      code: 'KICKOFF_FORCE_DISABLED',
      hint: 'Wait for the dedupe window or use one approved single-tenant kickoff.',
    });
  }

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
        hint: 'Wait until the run completes or use one approved single-tenant kickoff.',
      });
    }
  }

  const clientIds = await getEnabledClientIds();

  res.json({
    data: {
      status: 'kickoff_started',
      clients: clientIds.length,
      forced: force,
    },
  });

  for (const clientId of clientIds) {
    runWithClientContext(clientId, () =>
      runAutonomousKickoff(clientId).catch(err =>
        console.error(`[Autonomous] Kickoff failed for ${clientId}:`, err.message)
      )
    );
  }
});

/* ─── POST /api/autonomous/weekly-review ─────────────────── */

router.post('/weekly-review', requireInternalKey, async (req, res) => {
  res.json({ data: { status: 'weekly_review_started' } });

  const clientIds = await getEnabledClientIds();

  for (const clientId of clientIds) {
    runWithClientContext(clientId, () =>
      runWeeklyReview(clientId).catch(err =>
        console.error(`[Weekly Review] Failed for ${clientId}:`, err.message)
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
  const { approval_id, client_id, edited_body } = req.body;
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
    const { rows: [msg] } = await pool.query(
      `SELECT status, body, lead_id, channel, metadata FROM messages WHERE id = $1 AND client_id = $2`,
      [approval.message_id, client_id]
    );
    if (!msg || msg.status !== 'pending_approval') {
      return res.status(400).json({ error: `Cannot approve: message status is '${msg?.status || 'missing'}'`, code: 'INVALID_STATUS' });
    }

    // Fix 6: If edited_body provided and differs, capture founder feedback + update message
    if (edited_body && edited_body !== msg.body) {
      try {
        const { rows: [lead] } = await pool.query(
          `SELECT name, company, title FROM leads WHERE id = $1 AND client_id = $2`,
          [msg.lead_id, client_id]
        );
        await pool.query(
          `INSERT INTO founder_feedback (client_id, message_id, lead_id, feedback_type, original_body, edited_body, channel, lead_context)
           VALUES ($1, $2, $3, 'edit', $4, $5, $6, $7)`,
          [client_id, approval.message_id, msg.lead_id, msg.body, edited_body, msg.channel,
           JSON.stringify({ name: lead?.name, company: lead?.company, title: lead?.title })]
        );
        await pool.query(
          `UPDATE messages SET body = $3, status = 'approved' WHERE id = $1 AND client_id = $2`,
          [approval.message_id, client_id, edited_body]
        );
      } catch (fbErr) {
        console.warn('[autonomous] founder_feedback capture failed:', fbErr.message);
        await pool.query(
          `UPDATE messages SET status = 'approved' WHERE id = $1 AND client_id = $2`,
          [approval.message_id, client_id]
        );
      }
    } else {
      await pool.query(
        `UPDATE messages SET status = 'approved' WHERE id = $1 AND client_id = $2`,
        [approval.message_id, client_id]
      );

      // Fix 6: Check if body was edited via UI (original_body in metadata)
      const originalBody = msg.metadata?.original_body;
      if (originalBody && originalBody !== msg.body) {
        try {
          const { rows: [lead] } = await pool.query(
            `SELECT name, company, title FROM leads WHERE id = $1 AND client_id = $2`,
            [msg.lead_id, client_id]
          );
          await pool.query(
            `INSERT INTO founder_feedback (client_id, message_id, lead_id, feedback_type, original_body, edited_body, channel, lead_context)
             VALUES ($1, $2, $3, 'edit', $4, $5, $6, $7)`,
            [client_id, approval.message_id, msg.lead_id, originalBody, msg.body, msg.channel,
             JSON.stringify({ name: lead?.name, company: lead?.company, title: lead?.title })]
          );
          await pool.query(
            `UPDATE messages SET metadata = metadata - 'original_body' WHERE id = $1 AND client_id = $2`,
            [approval.message_id, client_id]
          );
        } catch (fbErr) {
          console.warn('[autonomous] founder_feedback (UI edit) capture failed:', fbErr.message);
        }
      }
    }

    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, 'claw', 'message_approved', 'message', $2, $3)`,
      [client_id, approval.message_id, JSON.stringify({ approval_id, source: 'telegram_claw', had_edit: !!(edited_body || msg.metadata?.original_body) })]
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

    // Fix 6: Capture rejection reason as founder feedback
    try {
      const { rows: [msg] } = await pool.query(
        `SELECT body, lead_id, channel FROM messages WHERE id = $1 AND client_id = $2`,
        [approval.message_id, client_id]
      );
      if (msg && reason) {
        const { rows: [lead] } = await pool.query(
          `SELECT name, company, title FROM leads WHERE id = $1 AND client_id = $2`,
          [msg.lead_id, client_id]
        );
        await pool.query(
          `INSERT INTO founder_feedback (client_id, message_id, lead_id, feedback_type, original_body, rejection_reason, channel, lead_context)
           VALUES ($1, $2, $3, 'rejection', $4, $5, $6, $7)`,
          [client_id, approval.message_id, msg.lead_id, msg.body, reason, msg.channel,
           JSON.stringify({ name: lead?.name, company: lead?.company, title: lead?.title })]
        );
      }
    } catch (fbErr) {
      console.warn('[autonomous] founder_feedback (rejection) capture failed:', fbErr.message);
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
  const today = todayInMalaysia();

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

/* ─── POST /api/autonomous/v2-1/research-proof ─────────────
 * Bounded V2.1 validation trigger. This proves fresh Research can create
 * signal_package-backed leads without handing them to Sales, Enforcer, or send.
 *
 * Body: { client_id }
 * Auth: x-internal-key
 */
router.post('/v2-1/research-proof', requireInternalKey, async (req, res) => {
  const clientId = req.body?.client_id;
  if (!clientId) {
    return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  }

  const proofLimit = 5;
  const proofPaidQueryCap = boundedResearchProofQueryCap(req.body?.max_paid_queries);
  const proofCounts = async () => {
    const { rows: [row] } = await pool.query(
      `WITH bounds AS (
         SELECT
           (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') AS start_at,
           ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') + INTERVAL '1 day') AS end_at
       )
       SELECT
         (SELECT COUNT(*)::int FROM leads
           WHERE client_id = $1 AND deleted_at IS NULL) AS leads_total,
         (SELECT COUNT(*)::int FROM leads l, bounds b
           WHERE l.client_id = $1 AND l.deleted_at IS NULL
             AND l.created_at >= b.start_at AND l.created_at < b.end_at) AS leads_created_today,
         (SELECT COUNT(*)::int FROM leads l, bounds b
           WHERE l.client_id = $1 AND l.deleted_at IS NULL
             AND l.created_at >= b.start_at AND l.created_at < b.end_at
             AND COALESCE(l.metadata, '{}'::jsonb) ? 'signal_package') AS packaged_leads_created_today,
         (SELECT COUNT(*)::int FROM messages
           WHERE client_id = $1) AS messages_total,
         (SELECT COUNT(*)::int FROM approvals
           WHERE client_id = $1) AS approvals_total,
         (SELECT COUNT(*)::int FROM send_queue
           WHERE client_id = $1) AS send_queue_total`,
      [clientId]
    );
    return row || {};
  };
  const n = value => Number(value) || 0;

  try {
    const { rows: icpRows } = await pool.query(
      `SELECT content FROM agent_memory
        WHERE client_id = $1 AND agent = 'director' AND key = 'icp'
        LIMIT 1`,
      [clientId]
    );
    const fallbackIcp = icpRows[0]?.content || null;
    const { getLegacyIcpForClient } = require('../services/tenantContext');
    const icp = await getLegacyIcpForClient(clientId, { source: 'http', fallback: fallbackIcp }) || {};
    if (icp.blocked) {
      return res.status(409).json({
        error: 'tenant profile blocked',
        code: 'TENANT_PROFILE_BLOCKED',
        data: { blocker: icp.blocker || icp.reason || 'tenant_profile_blocked', icp },
      });
    }
    const before = await proofCounts();
    const { runSignalHunt, saveSignalLeads, previewSignalHuntPlan } = require('../services/signalHunt');
    const queryPlan = await previewSignalHuntPlan(clientId, {
      icp,
      maxPaidQueries: proofPaidQueryCap,
    });
    const confirmHash = String(req.body?.confirm_query_plan_hash || '').trim();
    const dryRun = req.body?.dry_run === true;

    if (dryRun || !confirmHash) {
      return res.status(dryRun ? 200 : 409).json({
        data: {
          client_id: clientId,
          mode: 'v2_1_research_proof_query_plan',
          dry_run: true,
          requested_limit: proofLimit,
          paid_query_cap: proofPaidQueryCap,
          before,
          query_plan: queryPlan,
          required_confirmation: 'Inspect query_plan.executable_queries, then rerun with confirm_query_plan_hash equal to query_plan.query_set_hash.',
        },
      });
    }
    if (confirmHash !== queryPlan.query_set_hash) {
      return res.status(409).json({
        error: 'query plan hash mismatch',
        code: 'QUERY_PLAN_CONFIRMATION_MISMATCH',
        data: {
          expected_hash: queryPlan.query_set_hash,
          received_hash: confirmHash,
          query_plan: queryPlan,
        },
      });
    }
    if (queryPlan.repeated_zero_blocked) {
      return res.status(409).json({
        error: 'query plan already produced zero output today',
        code: 'REPEATED_ZERO_QUERY_SET',
        data: { query_plan: queryPlan },
      });
    }
    const leads = await runWithClientContext(clientId, () => runSignalHunt(clientId, {
      maxLeads: proofLimit,
      icp,
      maxPaidQueries: proofPaidQueryCap,
    }));
    const saved = await saveSignalLeads(clientId, leads);
    const after = await proofCounts();

    return res.json({
      data: {
        client_id: clientId,
        mode: 'v2_1_research_proof',
        requested_limit: proofLimit,
        paid_query_cap: proofPaidQueryCap,
        query_plan: queryPlan,
        candidates: Array.isArray(leads) ? leads.length : 0,
        saved: saved.length,
        saved_leads: saved.map(l => ({
          id: l.id,
          name: l.name,
          company: l.company,
          signal_tier: l.signal_tier,
          has_signal_package: !!l.metadata?.signal_package,
        })),
        before,
        after,
        deltas: {
          leads_delta: n(after.leads_total) - n(before.leads_total),
          leads_created_today_delta: n(after.leads_created_today) - n(before.leads_created_today),
          packaged_leads_created_today_delta: n(after.packaged_leads_created_today) - n(before.packaged_leads_created_today),
          messages_delta: n(after.messages_total) - n(before.messages_total),
          approvals_delta: n(after.approvals_total) - n(before.approvals_total),
          send_queue_delta: n(after.send_queue_total) - n(before.send_queue_total),
        },
      },
    });
  } catch (err) {
    logger.error({ msg: 'v2-1 research proof failed', client_id: clientId, err: err.message });
    return res.status(500).json({ error: err.message, code: 'V2_1_RESEARCH_PROOF_FAILED' });
  }
});

/* ─── GET /api/autonomous/vp-schema — Explorium tool catalog (diagnostic) ── */
router.get('/vp-schema', requireInternalKey, async (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  try {
    const vp = require('../services/vibeProspecting');
    const result = await vp.listTools(client_id);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ─── Core: Autonomous kickoff logic ─────────────────────── */

async function runAutonomousKickoff(clientId) {
  if (_runningKickoffs.has(clientId)) {
    console.log(`[Autonomous] Client ${clientId} kickoff already running — skipping concurrent trigger`);
    return;
  }
  const kickoffRunStartedAt = new Date();
  _runningKickoffs.add(clientId);
  try {
    return await _runAutonomousKickoffInner(clientId, { kickoffRunStartedAt });
  } catch (err) {
    logger.error({ msg: '[kickoff] uncaught kickoff failure before normal verification', clientId, err: err?.message });
    await logAction(clientId, 'director', 'autonomous_kickoff_failed', 'system', null, {
      error: err?.message || 'unknown_error',
      run_started_at: kickoffRunStartedAt,
      boundary: 'verify_after_uncaught_kickoff_error',
    }).catch(() => {});
    await verifyKickoffOutput(clientId, 20, { runStartedAt: kickoffRunStartedAt });
    throw err;
  } finally {
    _runningKickoffs.delete(clientId);
  }
}

async function _runAutonomousKickoffInner(clientId, options = {}) {
  const kickoffRunStartedAt = options.kickoffRunStartedAt || new Date();
  const today = todayInMalaysia();
  const HARD_CEILING = 15;
  const PENDING_CEILING = 30;
  const CHANNEL_ESCALATION_DAILY_CAP = Number(process.env.CHANNEL_ESCALATION_DAILY_CAP) || 5;
  const DAILY_WEB_LINKEDIN_SIGNAL_CAP = Math.max(0, Number(process.env.DAILY_WEB_LINKEDIN_SIGNAL_CAP || 6));

  const budgetState = await checkBudget(clientId).catch(err => ({
    allowed: false,
    error: err.message,
    spend: null,
    budget: null,
    period: 'unknown',
  }));
  if (!budgetState.allowed) {
    await logAction(clientId, 'director', 'kickoff_blocked_budget', 'system', null, {
      reason: 'budget_guard_preflight',
      spend: budgetState.spend,
      budget: budgetState.budget,
      period: budgetState.period,
      error: budgetState.error || null,
    });
    logger.warn({ msg: '[kickoff] blocked before run by budget guard', clientId, budgetState });
    return {
      blocked: true,
      reason: 'budget_guard_preflight',
      spend: budgetState.spend,
      budget: budgetState.budget,
      period: budgetState.period,
    };
  }

  // Ensure today's KPI row exists
  await pool.query(
    `INSERT INTO daily_kpi (client_id, date) VALUES ($1, $2)
     ON CONFLICT (client_id, date) DO NOTHING`,
    [clientId, today]
  );

  // Count today's sent
  const { rows: counts } = await pool.query(
    `SELECT COUNT(*) FILTER (
       WHERE status = 'sent'
         AND sent_at IS NOT NULL
         AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
     ) AS total_sent
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

    // Funnel observability: this follow-up path previously emitted ZERO pipeline_traces,
    // so follow-ups (the bulk of daily output) were invisible to the kickoff funnel and
    // the validation skill. Fire-and-forget; kickoff_id null (a follow-up is not a cold kickoff).
    const fuTrace = (leadId, messageId, stage, status, extra = {}) =>
      pipelineTrace.traceStage(clientId, {
        lead_id: leadId, message_id: messageId, stage, status,
        agent: 'sales_beaver', pipeline_path: 'followup_pipeline', ...extra,
      }).catch(() => {});

    for (const followUp of dueFollowUps) {
      try {
        // Get previous messages for this lead (so follow-up uses different angle)
        const { rows: prevMessages } = await pool.query(
          `SELECT subject, body, metadata, channel FROM messages
           WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved', 'delivered', 'linkedin_requested', 'awaiting_accept')
           ORDER BY created_at ASC`,
          [followUp.lead_id, clientId]
        );

        // Determine channel from first message (follow-ups stay on same channel)
        const originalChannel = prevMessages[0]?.channel || 'email';

        const draft = await draftFollowUp(followUp, followUp.touch_number, prevMessages);
        if (draft?.status === 'needs_more_research') {
          console.warn(`[FollowUp] Thin-context guard: lead ${followUp.lead_id} touch ${followUp.touch_number} — ${draft.reason}`);
          await pool.query(`UPDATE followup_queue SET status = 'skipped' WHERE id = $1`, [followUp.id]);
          await fuTrace(followUp.lead_id, null, 'skipped', 'thin_context', { reason: draft.reason || 'needs_more_research', metadata: { touch_number: followUp.touch_number } });
          continue;
        }
        if (!draft?.body) {
          console.warn(`[FollowUp] No draft body for lead ${followUp.lead_id} touch ${followUp.touch_number}`);
          await fuTrace(followUp.lead_id, null, 'draft_failed', 'no_body', { metadata: { touch_number: followUp.touch_number } });
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
          await fuTrace(followUp.lead_id, savedMsg.id, 'drafted', 'gate_failed', { metadata: { touch_number: followUp.touch_number } });
          await fuTrace(followUp.lead_id, savedMsg.id, 'rejected', 'gate_failed', { reason: gateFailures.join(', '), metadata: { touch_number: followUp.touch_number } });
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

        await fuTrace(followUp.lead_id, savedMsg.id, 'drafted', 'success', { metadata: { touch_number: followUp.touch_number, channel: originalChannel } });

        let enforcerApproved = false;
        try {
          const rangerResult = await rangerReview(clientId, {
            message_id: savedMsg.id, message_body: cleanBody,
            lead_context: {
              touch_number: followUp.touch_number, is_followup: true, name: followUp.name, channel: originalChannel,
              company: followUp.company, title: followUp.title, signal: followUp.metadata?.signal, angle: followUp.metadata?.angle, why_now: followUp.metadata?.why_now,
            },
          });
          enforcerApproved = !!rangerResult?.approved;
          const newStatus = enforcerApproved ? 'pending_approval' : 'ranger_rejected';
          await pool.query(
            `UPDATE messages SET status = $1, ranger_score = $2, ranger_notes = $3, updated_at = NOW() WHERE id = $4 AND client_id = $5`,
            [newStatus, rangerResult?.score || 0, rangerResult?.notes || rangerResult?.reject_reason || 'Enforcer review', savedMsg.id, clientId]
          );
          await fuTrace(followUp.lead_id, savedMsg.id, 'reviewed', enforcerApproved ? 'pass' : 'fail', { score: rangerResult?.score || 0 });
          if (!enforcerApproved) await fuTrace(followUp.lead_id, savedMsg.id, 'rejected', 'enforcer_rejected', { score: rangerResult?.score || 0 });
        } catch (err) {
          console.error('[FollowUp] AI Enforcer unavailable, blocking follow-up (fail-closed):', err.message);
          await pool.query(
            `UPDATE messages SET status = 'ranger_rejected', ranger_notes = 'AI Enforcer unavailable — blocked', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
            [savedMsg.id, clientId]
          );
          await fuTrace(followUp.lead_id, savedMsg.id, 'rejected', 'enforcer_unavailable');
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
              if (originalChannel === 'email') {
                await pool.query(`UPDATE messages SET status = 'pending_send', updated_at = NOW() WHERE id = $1 AND client_id = $2`, [savedMsg.id, clientId]);
              } else {
                await pool.query(`UPDATE messages SET status = 'linkedin_requested', updated_at = NOW() WHERE id = $1 AND client_id = $2`, [savedMsg.id, clientId]);
              }
              await fuTrace(followUp.lead_id, savedMsg.id, 'approved', 'auto_approved', { score: rangerScore, metadata: { channel: originalChannel } });
            }
          } catch (err) {
            console.warn('[FollowUp] Auto-approve threshold check failed:', err.message);
          }

          if (autoApproved && originalChannel !== 'email') {
            await pool.query(
              `INSERT INTO approvals (client_id, message_id, requested_by, status, notes) VALUES ($1, $2, 'auto_approval', 'pending', 'linkedin_requested')`,
              [clientId, savedMsg.id]
            );
          } else {
            await pool.query(
              `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at)
               VALUES ($1, $2, $3, $4, $5)`,
              [clientId, savedMsg.id,
               autoApproved ? 'auto_approval' : 'system',
               autoApproved ? 'approved' : 'pending',
               autoApproved ? new Date() : null]
            );
          }

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
      const { rows: [channelEscalationQueue] } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending_approval' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS pending,
           COUNT(*) FILTER (WHERE status = 'approved' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS approved_awaiting_send,
           COUNT(*) FILTER (
             WHERE metadata->>'is_channel_escalation' = 'true'
               AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
           ) AS drafted_today
         FROM messages
         WHERE client_id = $1`,
        [clientId, today]
      );
      const livePending = parseInt(channelEscalationQueue?.pending, 10) || 0;
      const liveApproved = parseInt(channelEscalationQueue?.approved_awaiting_send, 10) || 0;
      const channelEscalationsDraftedToday = parseInt(channelEscalationQueue?.drafted_today, 10) || 0;
      const channelEscalationHeadroom = Math.max(0, PENDING_CEILING - livePending - liveApproved);
      const channelEscalationRemaining = Math.max(0, CHANNEL_ESCALATION_DAILY_CAP - channelEscalationsDraftedToday);
      const channelEscalationLimit = Math.min(channelEscalationHeadroom, channelEscalationRemaining);

      if (channelEscalationLimit <= 0) {
        await logAction(clientId, 'director', 'approval_queue_swamped', 'system', null, {
          mode: 'channel_escalation',
          livePending,
          liveApproved,
          channelEscalationsDraftedToday,
          channelEscalationHeadroom,
          channelEscalationRemaining,
          cap: CHANNEL_ESCALATION_DAILY_CAP,
          message: 'channel escalation paused before drafting',
        });
      }

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
           )
         LIMIT $2`,
        [clientId, channelEscalationLimit]
      );

      for (const { lead_id } of escalationCandidates) {
        try {
          const escalation = await escalateChannel(clientId, lead_id);
          if (!escalation) continue;

          console.log(`[ChannelEscalation] ${escalation.lead_name}: ${escalation.original_channel} → ${escalation.new_channel}`);

          // Draft message on new channel via Sales Beaver
          const { rows: prevMessages } = await pool.query(
            `SELECT subject, body, metadata, channel FROM messages
             WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved', 'delivered', 'linkedin_requested', 'awaiting_accept')
             ORDER BY created_at ASC`,
            [lead_id, clientId]
          );

          const escalationFirstName = escalation.lead_name?.split(' ')[0] || 'there';
          const channelInstructions = escalation.new_channel === 'email'
            ? `FORMAT (email — new channel intro): Hi ${escalationFirstName}, {body — max 60 words}. Regards, {sender}. This is the FIRST email to this person (previous outreach was on ${escalation.original_channel}). Reference that you've reached out before but keep it natural, not desperate.`
            : escalation.new_channel === 'linkedin'
              ? `FORMAT (LinkedIn DM — new channel intro): Hi ${escalationFirstName}, saw you {specific signal or observable context}. {body — max 40 words total, end with one diagnostic question. No sign-off.} This is a NEW channel (previous was ${escalation.original_channel}). Keep it fresh, not a copy of the ${escalation.original_channel} messages.`
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
          const draft = await callAgent('sales_beaver', prompt, {
            clientId,
            channel: escalation.new_channel,
            mode: 'channel_escalation',
          });
          if (!draft?.body) continue;

          const cleanBody = draft.body.replace(/\s*\u2014\s*/g, ', ').replace(/\u2014/g, ' ');

          // Insert as pending_ranger with channel escalation flag
          const { rows: [savedMsg] } = await pool.query(
            `INSERT INTO messages (client_id, lead_id, subject, body, status, channel, metadata, follow_up_day)
             VALUES ($1, $2, $3, $4, 'pending_ranger', $5, $6, NULL)
             RETURNING id`,
            [clientId, lead_id, draft.subject || null, cleanBody, escalation.new_channel,
             JSON.stringify({ is_channel_escalation: true, original_channel: escalation.original_channel, new_channel: escalation.new_channel })]
          );
          pipelineTrace.traceStage(clientId, {
            lead_id,
            message_id: savedMsg.id,
            stage: 'drafted',
            status: 'channel_escalation',
            agent: 'sales_beaver',
            pipeline_path: 'channel_escalation',
            metadata: {
              original_channel: escalation.original_channel,
              new_channel: escalation.new_channel,
            },
          }).catch(() => {});

          // Run through Enforcer
          let enforcerApproved = false;
          try {
            const rangerResult = await rangerReview(clientId, {
              message_id: savedMsg.id, message_body: cleanBody,
              lead_context: {
                name: escalation.lead_name, company: escalation.lead_company, title: escalation.lead?.title,
                is_channel_escalation: true, original_channel: escalation.original_channel, new_channel: escalation.new_channel,
              },
            });
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
    const today = todayInMalaysia();
    const { rows: patterns } = await pool.query(
      `SELECT metadata->>'reject_reason' AS reason, COUNT(*) AS count
       FROM logs
       WHERE client_id = $1
         AND action IN ('message_rejected', 'ranger_review')
         AND metadata->>'decision' = 'reject'
         AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
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

  // ── Staleness TTL: approved LinkedIn messages > 7 days unsent = dead weight ─
  // These pile up because LinkedIn needs connection acceptance before send.
  // Sweep them out of the active pipeline so they stop inflating the queue
  // and blocking new drafts via PENDING_CEILING.
  try {
    const { rows: staleMessages } = await pool.query(
      `UPDATE messages
       SET status = 'stale_unsent',
           metadata = COALESCE(metadata, '{}'::jsonb) || '{"stale_reason": "approved_linkedin_7d_no_send"}'::jsonb,
           updated_at = NOW()
       WHERE client_id = $1
         AND channel = 'linkedin'
         AND status = 'approved'
         AND sent_at IS NULL
         AND created_at < NOW() - INTERVAL '7 days'
       RETURNING id, lead_id`,
      [clientId]
    );
    if (staleMessages.length > 0) {
      console.log(`[Autonomous] Staleness TTL: moved ${staleMessages.length} LinkedIn approved-but-unsent (>7d) to stale_unsent`);
      await logAction(clientId, 'director', 'stale_linkedin_sweep', 'system', null, {
        count: staleMessages.length,
        lead_ids: staleMessages.map(m => m.lead_id).slice(0, 10),
      });
    }
  } catch (err) {
    console.warn('[Autonomous] Staleness sweep error (non-fatal):', err.message);
  }

  // Re-check gap after processing follow-ups
  const { rows: refreshCounts } = await pool.query(
    `SELECT COUNT(*) FILTER (
       WHERE status = 'sent'
         AND sent_at IS NOT NULL
         AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
     ) AS total_sent
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

  // ── Phase C: optional signal prefill ─────────────────────────────────
  // Default OFF for daily kickoff: DB pool must execute before paid Signal
  // Hunt. Enable DAILY_KICKOFF_SIGNAL_PREFILL_ENABLED only when intentionally
  // testing signal-first spend with explicit capacity and output monitoring.
  if (process.env.DAILY_KICKOFF_SIGNAL_PREFILL_ENABLED === 'true') {
    try {
      const { runSignalHunt, saveSignalLeads } = require('../services/signalHunt');
      const signalTarget = Math.min(remainingGap, 30); // don't exceed daily gap
      console.log(`[Autonomous] Phase C: Running signal hunt for up to ${signalTarget} P1/P2 leads`);

      const signalLeads = await runSignalHunt(clientId, {
        maxLeads: signalTarget,
        icp,
        maxPaidQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
      });
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
              allowPaidSignal: false,
              sourceMode: 'daily_signal_prefill_saved_leads',
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
  } else {
    console.log('[Autonomous] Daily signal prefill disabled — DB pool executes first; Research Beaver top-up runs via DB Builder.');
    await logAction(clientId, 'director', 'daily_signal_prefill_skipped', 'system', null, {
      reason: 'DAILY_KICKOFF_SIGNAL_PREFILL_ENABLED not true',
      boundary: 'db_pool_before_paid_signal_hunt',
    }).catch(() => {});
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
  //   - webLinkedinTopupAttempted: one capped paid web/LinkedIn sourcing attempt
  //     per kickoff; directorExecute also dedupes this per MYT day.
  const BATCH_SIZE = 20; // raised from 10 — auto-fix means more drafts survive
  let webLinkedinTopupAttempted = false;

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

  let poolDryResearchAttempts = 0;
  const MAX_POOL_DRY_RESEARCH = 2;

  for (let batch = 1; batch <= HARD_CEILING; batch++) {
    // Recalculate live counts — now per-channel so we can honour the 30/20 split
    const { rows: liveCount } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS sent,
         COUNT(*) FILTER (WHERE status = 'pending_approval' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)          AS pending,
         COUNT(*) FILTER (WHERE status = 'approved' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)                  AS approved_awaiting_send,
         COUNT(*) FILTER (WHERE channel = 'email' AND status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS email_sent_today,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS linkedin_sent_today,
         COUNT(*) FILTER (WHERE channel = 'email' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date AND status NOT IN ('ranger_rejected','blocked_no_email','deleted')) AS email_drafted_today,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date AND status NOT IN ('ranger_rejected','blocked_no_email','deleted')) AS linkedin_drafted_today
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

    // Circuit breaker: if approval queue + unsent approved are swamped, stop drafting.
    // Approved LinkedIn messages pile up because they need manual send + connection acceptance.
    // Drafting more into a queue that never drains is pure cost burn.
    if ((livePending + liveApproved) >= PENDING_CEILING) {
      console.warn(`[Autonomous] Client ${clientId} batch ${batch}: queue swamped (${livePending} pending + ${liveApproved} approved unsent). Stopping drafts.`);
      await logAction(clientId, 'director', 'approval_queue_swamped', 'system', null, {
        batch, livePending, liveApproved, liveSent, target,
        message: `${livePending} pending + ${liveApproved} approved unsent — stop drafting until queue drains`,
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
         AND deleted_at IS NULL
         ${leadSelectionFeedbackExclusionSql('leads')}
         ${currentSignalPackageEligibilitySql('leads')}`,
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
      // Pool dry — trigger Research Beaver on-demand instead of giving up
      console.warn(`[Autonomous] Client ${clientId} batch ${batch}: pool dry on needed channel (email_gap=${emailGap}, linkedin_gap=${linkedinGap}, pool_email=${poolEmailReady}, pool_linkedin=${poolLinkedinOnly})`);
      await logAction(clientId, 'director', 'pool_dry_for_channel_target', 'system', null, {
        batch, emailGap, linkedinGap, poolEmailReady, poolLinkedinOnly,
      });

      // 2026-05-29 no-burn boundary (Phase 2c): generic on-demand scraping is
      // the low-yield path that produced off-ICP / null-company corpses. When
      // GENERIC_SOURCING_ENABLED is off, the autonomous loop relies on signal
      // hunt + the enriched pool + Vibe CSV, and never burns generic paid
      // scraping for output it cannot use. This unifies the no-burn boundary
      // with directorExecute's signal_first_terminal_block so enabling daily
      // kickoff cannot generically burn.
      if (process.env.GENERIC_SOURCING_ENABLED !== 'true') {
        console.warn(`[Autonomous] Client ${clientId} batch ${batch}: pool dry + GENERIC_SOURCING_ENABLED off — not burning generic scraping. Stopping (rely on signal hunt + enriched pool + Vibe CSV).`);
        await logAction(clientId, 'director', 'generic_sourcing_disabled_skip', 'system', null, {
          batch, emailGap, linkedinGap, poolEmailReady, poolLinkedinOnly,
          context: 'pool_dry_on_demand_research', boundary: 'no_generic_paid_fallback',
        });
        if (!webLinkedinTopupAttempted && DAILY_WEB_LINKEDIN_SIGNAL_CAP > 0) {
          webLinkedinTopupAttempted = true;
          await logAction(clientId, 'director', 'web_linkedin_topup_attempted', 'system', null, {
            batch,
            cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
            context: 'pool_dry_channel_target',
          });
          let topupResult = null;
          try {
            const { sourceLeadsOnDemand } = require('../services/dbBuilder');
            topupResult = await sourceLeadsOnDemand(clientId, {
              neededChannel: emailGap > 0 ? 'email' : 'linkedin',
              batchSize: Math.min(Math.max(emailGap, linkedinGap), BATCH_SIZE),
              maxPaidQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
            });
          } catch (err) {
            console.warn('[Autonomous] Daily web/LinkedIn top-up failed before output verification:', err.message);
            await logAction(clientId, 'director', 'daily_web_linkedin_topup_failed', 'system', null, {
              batch,
              cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
              context: 'pool_dry_channel_target',
              error: err.message,
              boundary: 'verify_even_after_topup_failure',
            });
          }
          const topupSaved = Number(topupResult?.saved || topupResult?.leads_found || topupResult?.summary?.leads_found || 0);
          if (topupSaved === 0) {
            await logAction(clientId, 'director', 'daily_web_linkedin_topup_empty', 'system', null, {
              batch,
              cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
              reason: topupResult?.reason || topupResult?.summary?.blocker || topupResult?.summary?.reason || topupResult?.status || 'topup_failed_or_no_results',
              boundary: 'no_burn_zero_raw_stop',
            });
          } else {
            await logAction(clientId, 'director', 'daily_web_linkedin_topup_success', 'system', null, {
              batch,
              cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
              saved: topupSaved,
              health: topupResult?.health || null,
              reason: topupResult?.reason || topupResult?.status || 'topup_saved',
              boundary: 'topup_saved_retry_same_kickoff',
            });
            continue;
          }
        }
        break;
      }

      if (poolDryResearchAttempts >= MAX_POOL_DRY_RESEARCH) {
        console.warn(`[Autonomous] Already attempted ${MAX_POOL_DRY_RESEARCH} on-demand research runs this kickoff. Stopping.`);
        await logAction(clientId, 'director', 'on_demand_research_exhausted', 'system', null, {
          batch, attempts: poolDryResearchAttempts,
        });
        break;
      }

      poolDryResearchAttempts++;
      const neededChannel = emailGap > 0 ? 'email' : 'linkedin';
      console.log(`[Autonomous] Triggering on-demand Research Beaver (attempt ${poolDryResearchAttempts}/${MAX_POOL_DRY_RESEARCH}, channel=${neededChannel})`);
      await logAction(clientId, 'director', 'pool_dry_triggering_research', 'system', null, {
        batch, neededChannel, attempt: poolDryResearchAttempts,
      });

      try {
        const { sourceLeadsOnDemand } = require('../services/dbBuilder');
        const result = await sourceLeadsOnDemand(clientId, {
          neededChannel,
          batchSize: BATCH_SIZE,
          maxPaidQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
        });

        if (result.saved === 0) {
          console.warn(`[Autonomous] On-demand research yielded 0 usable leads (reason: ${result.reason}). Stopping.`);
          await logAction(clientId, 'director', 'on_demand_research_empty', 'system', null, {
            batch, reason: result.reason, attempt: poolDryResearchAttempts,
          });
          break;
        }

        console.log(`[Autonomous] On-demand research added ${result.saved} leads (pool email=${result.health?.withEmail}). Retrying batch.`);
        await logAction(clientId, 'director', 'on_demand_research_success', 'system', null, {
          batch, saved: result.saved,
          pool_email: result.health?.withEmail,
          pool_linkedin: result.health?.noEmail,
          attempt: poolDryResearchAttempts,
        });
        continue;
      } catch (err) {
        console.error(`[Autonomous] On-demand research failed:`, err.message);
        await logAction(clientId, 'director', 'on_demand_research_error', 'system', null, {
          batch, error: err.message, attempt: poolDryResearchAttempts,
        });
        break;
      }
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
           ${leadSelectionFeedbackExclusionSql('leads')}
           ${currentSignalPackageEligibilitySql('leads')}
           -- 2026-05-18: never re-draw a lead that already has a message.
           -- processExistingLeadsPipeline does not advance lead state after a
           -- draft, so a drafted lead stays pipeline_stage='prospecting'/
           -- status='new' and was re-drawn every batch + kickoff, then skipped
           -- by the same-day enrolled dedup — a deadlock that produced 15 empty
           -- batches and 0 drafts. A message of ANY non-deleted status means the
           -- lead has been processed; message-existence is the reliable
           -- pool-exit signal (the kickoff's first-touch draw, not follow-ups).
           AND NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.lead_id = leads.id AND m.client_id = leads.client_id
               AND m.status <> 'deleted'
           )
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

      if (poolLeads.length > 0) {
        // 2026-05-06: Re-validate legacy pool leads against current applyIcpV2Filter.
        // Migration 061's permissive backfill grandfathered every linkedin_url lead to
        // Tier B without re-running the gate, so legacy MNC junk (dentsu, IPG Mediabrands,
        // Leo Burnett, GroupM, AirAsia, etc.) leaks straight to draft. Audit each pool lead
        // here; soft-reject failures so they exit the pool permanently instead of looping
        // through draft → ranger_rejected every kickoff.
        const { applyIcpV2Filter } = agentsService;
        const { rows: poolLeadFull } = await pool.query(
          `SELECT id, name, company, title, country, score, metadata FROM leads
           WHERE id = ANY($1::uuid[])`,
          [poolLeads.map(l => l.id)]
        );
        const passingIds = [];
        const auditRejects = [];
        for (const lead of poolLeadFull) {
          const v2 = applyIcpV2Filter(lead);
          if (v2.pass) {
            passingIds.push(lead.id);
          } else {
            auditRejects.push({ id: lead.id, status: v2.status, reason: v2.reason, name: lead.name, company: lead.company });
          }
        }
        if (auditRejects.length > 0) {
          console.warn(`[Autonomous] Pool audit rejected ${auditRejects.length}/${poolLeadFull.length} leads against current ICP gate`);
          await logAction(clientId, 'director', 'pool_audit_rejected', 'system', null, {
            batch, rejected: auditRejects.length, total: poolLeadFull.length, sample: auditRejects.slice(0, 5),
          });
          // Soft-delete so they exit the pool. Group by per-lead v2.status so each
          // UPDATE uses a status value the leads_status_check CHECK allows.
          // 2026-05-14: was hardcoded 'rejected_legacy_audit' which FAILED the CHECK
          // silently via .catch — soft-delete never persisted, audit rejected the
          // same leads kickoff after kickoff. Now matches batch endpoint behavior.
          const auditByStatus = {};
          for (const r of auditRejects) {
            const s = r.status || 'rejected_data_integrity';
            (auditByStatus[s] = auditByStatus[s] || []).push(r.id);
          }
          for (const [statusValue, ids] of Object.entries(auditByStatus)) {
            await pool.query(
              `UPDATE leads SET status = $1, deleted_at = NOW(),
                                metadata = COALESCE(metadata, '{}'::jsonb)
                                        || jsonb_build_object('legacy_audit_reason', $3::text)
               WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL`,
              [statusValue, ids, 'pool_audit_per_kickoff_2026_05_14']
            ).catch(err => console.warn(`[Autonomous] Soft-delete of audit rejects (status=${statusValue}) failed:`, err.message));
          }
        }

        if (passingIds.length > 0) {
          console.log(`[Autonomous] DB pool has ${passingIds.length} ICP-passing leads (after audit) — using pool instead of cold research`);
          await logAction(clientId, 'director', 'db_pool_draw', 'system', null, {
            batch, pool_size: passingIds.length, draft_size: draftSize, audited_out: auditRejects.length,
          });

          const dbResult = await directorExecute(clientId, {
            plan_id: uuidv4(),
            command: `DB-POOL BATCH: Process ${passingIds.length} pre-researched leads from the lead pool. These are already verified and saved. Draft outreach using any signal/angle data in their metadata. Do NOT re-run research.`,
            batchIndex: batch - 1,
            limit: passingIds.length,
            use_existing_leads: passingIds,
            allowPaidSignal: false,
            sourceMode: 'daily_db_pool',
          });
          usedDbPool = true;
          const dbDrafted = Number(dbResult?.summary?.messages_drafted || 0);
          const dbApproved = Number(dbResult?.summary?.approved || 0);
          const dbRejected = Number(dbResult?.summary?.rejected || 0);
          if (dbDrafted + dbApproved + dbRejected === 0) {
            console.warn(`[Autonomous] DB pool batch ${batch} produced zero drafts/rejections — stopping to avoid no-output spend loop.`);
            await logAction(clientId, 'director', 'db_pool_zero_output_stop', 'system', null, {
              batch,
              pool_size: passingIds.length,
              draft_size: draftSize,
              summary: dbResult?.summary || null,
              boundary: 'no_burn_zero_output',
            });
            break;
          }
        } else {
          console.warn(`[Autonomous] After ICP audit, pool dropped below threshold (${passingIds.length} passing). Falling back to cold research.`);
        }
      }
    } catch (err) {
      if (isBudgetExceededError(err)) {
        console.warn(`[Autonomous] DB pool stopped by budget guard: ${err.message}`);
        await logAction(clientId, 'director', 'kickoff_blocked_budget', 'system', null, {
          batch,
          reason: 'budget_exceeded_during_db_pool',
          error: err.message,
        });
        break;
      }
      console.warn(`[Autonomous] DB pool query failed, falling back to cold research:`, err.message);
    }

    // ── Fallback: cold research via directorExecute (ICP-driven) ──
    // Phase 2 V2 Step 9 (2026-05-15): no brief is built. directorExecute reads
    // the ICP from agent_memory and runs Research Beaver's ICP-only query path.
    // The old buildAutonomousBrief paragraph was fed into Brave's q= and returned 0.
    if (!usedDbPool) {
      const beforeSaved = (await pool.query(
        `SELECT COUNT(*) AS c
         FROM leads
         WHERE client_id=$1
           AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=$2::date`,
        [clientId, today]
      )).rows[0].c;

      if (webLinkedinTopupAttempted) {
        await logAction(clientId, 'director', 'daily_web_linkedin_topup_deduped', 'system', null, {
          batch,
          boundary: 'one_topup_attempt_per_kickoff',
        });
        break;
      }
      webLinkedinTopupAttempted = true;
      await logAction(clientId, 'director', 'web_linkedin_topup_attempted', 'system', null, {
        batch,
        cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
        context: 'cold_research_fallback',
      });
      let topupError = null;
      let topupResult = null;
      try {
        const { sourceLeadsOnDemand } = require('../services/dbBuilder');
        topupResult = await sourceLeadsOnDemand(clientId, {
          neededChannel: emailGap > 0 ? 'email' : 'linkedin',
          batchSize: draftSize,
          maxPaidQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
        });
      } catch (err) {
        topupError = err;
        console.warn('[Autonomous] Daily web/LinkedIn top-up failed before output verification:', err.message);
        await logAction(clientId, 'director', 'daily_web_linkedin_topup_failed', 'system', null, {
          batch,
          cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
          context: 'cold_research_fallback',
          error: err.message,
          boundary: 'verify_even_after_topup_failure',
        });
      }

      // No-burn stop: the daily top-up is capped and single-attempt. If it
      // produces no new saved leads, do not escalate into generic paid retries.
      const afterSaved = (await pool.query(
        `SELECT COUNT(*) AS c
         FROM leads
         WHERE client_id=$1
           AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=$2::date`,
        [clientId, today]
      )).rows[0].c;
      if (parseInt(afterSaved) === parseInt(beforeSaved)) {
        console.warn(`[Autonomous] Batch ${batch} added 0 leads after the capped web/LinkedIn top-up. Stopping for no-burn.`);
        await logAction(clientId, 'director', 'daily_web_linkedin_topup_empty', 'system', null, {
          batch,
          cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
          reason: topupError?.message || topupResult?.reason || 'no_new_saved_leads',
          boundary: 'no_burn_zero_raw_stop',
        });
        await logAction(clientId, 'director', 'research_pool_exhausted', 'system', null, { batch, liveSent, target });
        break;
      }
      await logAction(clientId, 'director', 'daily_web_linkedin_topup_success', 'system', null, {
        batch,
        cap: DAILY_WEB_LINKEDIN_SIGNAL_CAP,
        saved: Math.max(0, parseInt(afterSaved) - parseInt(beforeSaved)),
        reason: topupResult?.reason || topupResult?.status || 'topup_saved',
        context: 'cold_research_fallback',
        boundary: 'topup_saved_retry_next_batch',
      });
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
         COUNT(*) FILTER (WHERE channel = 'email' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS email_drafted,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS linkedin_drafted,
         COUNT(*) FILTER (WHERE channel = 'email' AND status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS email_sent,
         COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS linkedin_sent,
         COUNT(*) FILTER (WHERE status = 'blocked_no_email' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS blocked_no_email
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

  // ── Kickoff verification - block follow-on auto-kickoffs on zero/low output ──
  await verifyKickoffOutput(clientId, target, { runStartedAt: kickoffRunStartedAt });
  await require('../services/kpi').recountKpi(clientId).catch(err =>
    logger.warn({ msg: '[kickoff] final kpi recount failed', clientId, err: err?.message })
  );
}

/**
 * Post-kickoff verification: checks if the kickoff actually produced results.
 * Writes a Captain blocker if this run produced zero or <=5/20 usable outputs.
 */
async function writeKickoffBlocker(clientId, blocker) {
  const today = blocker.today || todayInMalaysia();
  const key = `captain_kickoff_blocker_${today}`;
  const content = {
    ...blocker,
    key,
    status: 'blocked',
    next_step: 'MJ must inspect sourcing/ICP/Ranger rejection root cause before another autonomous kickoff',
    created_at: new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
     VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config', NOW())
     ON CONFLICT (client_id, agent, key)
     DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, key, JSON.stringify(content)]
  );

  await pool.query(
    `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
     VALUES ($1, 'captain_orchestrator', 'captain_kickoff_blocker_required', 'system', $2::jsonb, NOW())`,
    [clientId, JSON.stringify(content)]
  );

  const message = `<b>Captain kickoff blocker</b>\n\n${blocker.reason}\n\nDelivered: ${blocker.delivered}/${blocker.requested} usable outputs. Autonomous KPI-gap kickoffs are stopped for today until MJ reviews the root cause.`;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (chatId) {
    try {
      const telegramService = require('../services/telegram');
      telegramService.sendMessage(chatId, message).catch(err =>
        logger.warn({ msg: '[kickoff-blocker] Telegram notify error', err: err.message })
      );
    } catch (err) {
      logger.warn({ msg: '[kickoff-blocker] Telegram notify skipped', err: err.message });
    }
  }
}

async function verifyKickoffOutput(clientId, target, options = {}) {
  try {
    const today = todayInMalaysia();
    const runStartedAt = options.runStartedAt ? new Date(options.runStartedAt) : null;
    const requested = Math.min(Number(target) || 20, 20);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE status = 'sent'
             AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
             AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
         ) AS sent,
         COUNT(*) FILTER (
           WHERE status IN ('pending_approval', 'approved', 'pending_send', 'linkedin_requested')
             AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
             AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
         ) AS approval_ready,
         COUNT(*) FILTER (
           WHERE status = 'pending_ranger'
             AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
             AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
         ) AS drafting,
         COUNT(*) FILTER (
           WHERE status = 'ranger_rejected'
             AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
             AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
         ) AS rejected
       FROM messages WHERE client_id = $1`,
      [clientId, today, runStartedAt]
    );

    const counts = rows[0] || {};
    const sent = parseInt(counts.sent, 10) || 0;
    const approvalReady = parseInt(counts.approval_ready, 10) || 0;
    const drafting = parseInt(counts.drafting, 10) || 0;
    const rejected = parseInt(counts.rejected, 10) || 0;
    const delivered = sent + approvalReady;
    const totalOutput = delivered + drafting;

    if (totalOutput === 0) {
      console.warn(`[Autonomous] ZERO OUTPUT for client ${clientId} - kickoff produced nothing`);
      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
         VALUES ($1, 'system', 'kickoff_zero_output', 'system', $2, NOW())`,
        [clientId, JSON.stringify({ target, sent, approval_ready: approvalReady, drafting, rejected, run_started_at: runStartedAt })]
      );
      await writeKickoffBlocker(clientId, {
        today,
        blocker: 'zero_outputs',
        reason: 'Scheduled kickoff produced zero usable outputs.',
        target,
        requested,
        delivered,
        total_output: totalOutput,
        sent,
        approval_ready: approvalReady,
        drafting,
        rejected,
        run_started_at: runStartedAt,
      });
      return { blocked: true, blocker: 'zero_outputs', delivered, total_output: totalOutput };
    }

    if (shouldStopForLowOutput({ requested, delivered })) {
      console.warn(`[Autonomous] LOW OUTPUT for client ${clientId} - kickoff produced ${delivered}/${requested} usable outputs`);
      await writeKickoffBlocker(clientId, {
        today,
        blocker: 'low_yield_outputs',
        reason: `Scheduled kickoff produced only ${delivered}/${requested} usable outputs, at or below the 5/20 low-yield fallback.`,
        target,
        requested,
        delivered,
        total_output: totalOutput,
        sent,
        approval_ready: approvalReady,
        drafting,
        rejected,
        run_started_at: runStartedAt,
      });
      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
         VALUES ($1, 'system', 'daily_kickoff_low_yield_blocker', 'system', $2::jsonb, NOW())`,
        [clientId, JSON.stringify({ target, requested, delivered, total_output: totalOutput, sent, approval_ready: approvalReady, drafting, rejected, run_started_at: runStartedAt })]
      );
      return { blocked: true, blocker: 'low_yield_outputs', delivered, total_output: totalOutput };
    } else {
      // Success path: log only, no Telegram. Per MJ notification policy
      // (2026-05-03): morning brief / EOD brief / impromptu only. The morning
      // brief reports yesterday's kickoff numbers — no need to ping per-day too.
      console.log(`[Autonomous] Kickoff verified for ${clientId}: ${totalOutput} messages produced (${sent} sent, ${approvalReady} approval-ready, ${drafting} drafting)`);
      return { blocked: false, delivered, total_output: totalOutput, sent, approval_ready: approvalReady, drafting, rejected };
    }
  } catch (err) {
    console.warn('[Autonomous] Kickoff verification failed:', err.message);
    return { blocked: false, error: err.message };
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
// Optional ?client_id=UUID — when supplied, every stat is scoped to that
// tenant (audit A6-3). When omitted, aggregates across all tenants (internal
// MJ-only report). The router-level guard already validates the UUID format.

router.get('/hourly-stats', requireInternalKey, async (req, res) => {
  try {
    const today = todayInMalaysia();
    const clientId = req.query.client_id || null; // null → all tenants

    const [pending, channelStats, aa, ar, failed, leadStats, patternRows] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS c FROM approvals
         WHERE status='pending' AND (notes IS NULL OR notes != 'linkedin_requested')
           AND ($1::uuid IS NULL OR client_id = $1::uuid)`,
        [clientId]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE channel = 'email' AND status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)::int AS email_sent,
           COUNT(*) FILTER (WHERE channel = 'email' AND status IN ('pending_approval','approved','pending_send') AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)::int AS email_pending,
           COUNT(*) FILTER (WHERE channel = 'email' AND status = 'replied')::int AS email_replied,
           COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'sent' AND sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)::int AS li_sent,
           COUNT(*) FILTER (WHERE channel = 'linkedin' AND status IN ('pending_approval','approved','pending_send','linkedin_requested') AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date)::int AS li_pending,
           COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'replied')::int AS li_replied
         FROM messages
         WHERE ($1::uuid IS NULL OR client_id = $1::uuid)`,
        [clientId, today]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM approval_audit
         WHERE decision='approved' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
           AND ($1::uuid IS NULL OR client_id = $1::uuid)`,
        [clientId, today]
      ).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM approval_audit
         WHERE decision='rejected' AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
           AND ($1::uuid IS NULL OR client_id = $1::uuid)`,
        [clientId, today]
      ).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM messages
         WHERE status='failed' AND updated_at > NOW() - INTERVAL '1 hour'
           AND ($1::uuid IS NULL OR client_id = $1::uuid)`,
        [clientId]
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE metadata->>'outreach_route' = 'email')::int AS email_route,
           COUNT(*) FILTER (WHERE metadata->>'outreach_route' = 'linkedin')::int AS linkedin_route
         FROM leads
         WHERE (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
           AND deleted_at IS NULL
           AND ($1::uuid IS NULL OR client_id = $1::uuid)`,
        [clientId, today]
      ),
      pool.query(
        `SELECT content FROM agent_memory
         WHERE agent = 'research_beaver' AND key = 'email_patterns_verified'
           AND ($1::uuid IS NULL OR client_id = $1::uuid)
         LIMIT 1`,
        [clientId]
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
    const { rows: [clock] } = await pool.query(
      `SELECT
         (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS date_kl,
         ((EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::int * 60)
           + EXTRACT(MINUTE FROM NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::int) AS kl_minutes_now`
    );
    const today = clock.date_kl;
    const klMinutesNow = Number(clock.kl_minutes_now) || 0;
    const enabledSlugs = (process.env.AUTONOMOUS_ENABLED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
    const autonomyState = autonomyStateService.getAutonomyState();
    const scheduledAutonomyPaused = autonomyState.scheduled_paused;

    const { rows: clientRows } = await pool.query(
      `SELECT id, slug, name FROM clients
       WHERE slug = ANY($1) AND is_active = true AND onboarding_completed = true`,
      [enabledSlugs.length ? enabledSlugs : ['__none__']]
    );

    const tenants = [];
    for (const c of clientRows) {
      const [kickoffEvidence, kpi, msgs, queue, approvedUnsent, approvalQueue, leadPool, researchLog, integrations, followupHealth] = await Promise.all([
        pool.query(
          `WITH bounds AS (
             SELECT
               (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') AS start_at,
                ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') + INTERVAL '1 day') AS end_at,
                (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today_kl
           )
           SELECT
              (SELECT MAX(created_at)
                 FROM logs l, bounds b
                WHERE l.client_id = $1
                  AND l.agent = 'director'
                  AND l.action = 'autonomous_kickoff'
                  AND l.created_at >= b.start_at AND l.created_at < b.end_at) AS last_start_log_at,
              (SELECT MAX(created_at)
                 FROM logs l, bounds b
                WHERE l.client_id = $1
                  AND l.created_at >= b.start_at AND l.created_at < b.end_at
                  AND l.action IN (
                    'db_pool_draw',
                    'db_pool_zero_output_stop',
                    'pool_audit_rejected',
                    'pool_dry_for_channel_target',
                    'generic_sourcing_disabled_skip',
                    'daily_web_linkedin_topup_failed',
                    'daily_web_linkedin_topup_empty',
                    'daily_web_linkedin_topup_success',
                    'daily_web_linkedin_topup_deduped',
                    'research_pool_exhausted',
                    'kickoff_zero_output',
                    'daily_kickoff_low_yield_blocker',
                    'captain_kickoff_blocker_required',
                    'signal_pipeline_executing',
                    'signal_first_started',
                    'signal_first_failed',
                    'campaign_target_unfulfilled',
                    'paid_signal_disabled_stop',
                    'campaign_target_fulfilled'
                  )) AS last_work_log_at,
             (SELECT COUNT(*)::int
                FROM pipeline_traces pt, bounds b
               WHERE pt.client_id = $1
                 AND pt.pipeline_path IN ('kickoff_pipeline', 'signal_pipeline')
                 AND pt.created_at >= b.start_at AND pt.created_at < b.end_at) AS trace_count,
             EXISTS (
               SELECT 1
                 FROM agent_memory am, bounds b
                WHERE am.client_id = $1
                  AND am.agent = 'captain'
                   AND am.key = 'daily_kickoff_' || b.today_kl::text
             ) AS memory_written`,
          [c.id]
        ),
        pool.query(
          `WITH bounds AS (
             SELECT
               (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') AS start_at,
               ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') + INTERVAL '1 day') AS end_at
           ),
           source_truth AS (
             SELECT
               COUNT(*) FILTER (WHERE m.status = 'sent'
                 AND COALESCE(m.sent_at, m.updated_at, m.created_at) >= b.start_at
                 AND COALESCE(m.sent_at, m.updated_at, m.created_at) < b.end_at)::int AS outreach_sent,
               COUNT(*) FILTER (WHERE m.status = 'sent' AND m.channel = 'email'
                 AND COALESCE(m.sent_at, m.updated_at, m.created_at) >= b.start_at
                 AND COALESCE(m.sent_at, m.updated_at, m.created_at) < b.end_at)::int AS outreach_email,
               COUNT(*) FILTER (WHERE m.status = 'sent' AND m.channel = 'linkedin'
                 AND COALESCE(m.sent_at, m.updated_at, m.created_at) >= b.start_at
                 AND COALESCE(m.sent_at, m.updated_at, m.created_at) < b.end_at)::int AS outreach_linkedin,
               COUNT(*) FILTER (WHERE m.reply_detected_at >= b.start_at AND m.reply_detected_at < b.end_at)::int AS replies_received
             FROM messages m
             CROSS JOIN bounds b
             WHERE m.client_id = $1
           ),
           leads_truth AS (
             SELECT COUNT(*)::int AS leads_found
             FROM leads l, bounds b
             WHERE l.client_id = $1
               AND l.deleted_at IS NULL
               AND l.created_at >= b.start_at AND l.created_at < b.end_at
           )
           SELECT
             COALESCE(dk.target, 50) AS target,
             st.outreach_sent,
             st.outreach_email,
             st.outreach_linkedin,
             lt.leads_found,
             st.replies_received,
             (dk.client_id IS NOT NULL) AS daily_kpi_row_present
           FROM source_truth st
           CROSS JOIN leads_truth lt
           LEFT JOIN daily_kpi dk ON dk.client_id = $1 AND dk.date = $2`,
          [c.id, today]
        ),
        pool.query(
          `WITH bounds AS (
             SELECT
               (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') AS start_at,
               ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur') + INTERVAL '1 day') AS end_at
           )
           SELECT
             COUNT(*) FILTER (WHERE status = 'sent' AND COALESCE(sent_at, created_at) >= (SELECT start_at FROM bounds) AND COALESCE(sent_at, created_at) < (SELECT end_at FROM bounds))::int AS sent_today,
             COUNT(*) FILTER (WHERE status = 'pending_approval' AND created_at >= (SELECT start_at FROM bounds) AND created_at < (SELECT end_at FROM bounds))::int AS pending_today,
             COUNT(*) FILTER (WHERE status = 'ranger_rejected' AND created_at >= (SELECT start_at FROM bounds) AND created_at < (SELECT end_at FROM bounds))::int AS rejected_today,
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
          `SELECT
             COUNT(*) FILTER (WHERE COALESCE(a.notes, '') <> 'linkedin_requested' AND m.status = 'pending_approval')::int AS reviewable,
             COUNT(*) FILTER (WHERE a.notes = 'linkedin_requested' AND m.status = 'linkedin_requested')::int AS linkedin_awaiting_accept,
             COUNT(*) FILTER (WHERE
               (a.notes = 'linkedin_requested' AND m.status <> 'linkedin_requested')
               OR (COALESCE(a.notes, '') <> 'linkedin_requested' AND m.status <> 'pending_approval')
             )::int AS stale_orphan_rows
           FROM approvals a
           JOIN messages m ON m.id = a.message_id AND m.client_id = a.client_id
           WHERE a.client_id = $1 AND a.status IN ('pending', 'pending_approval')`,
          [c.id]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (
               WHERE l.deleted_at IS NULL
                 AND (l.pipeline_stage IS NULL OR l.pipeline_stage NOT IN ('rejected','contacted','outreach','qualifying'))
                 AND (l.status IS NULL OR l.status NOT LIKE 'rejected_%')
             )::int AS raw_available,
             COUNT(*) FILTER (
               WHERE l.deleted_at IS NULL
                 AND l.pipeline_stage = 'prospecting'
                 AND l.status = 'new'
             )::int AS raw_new_prospecting,
             COUNT(*) FILTER (
               WHERE l.deleted_at IS NULL
                 AND l.pipeline_stage = 'prospecting'
                 AND l.status = 'new'
                 AND l.lead_tier = 'A'
                 AND l.email IS NOT NULL
                 AND l.email <> ''
                 ${leadSelectionFeedbackExclusionSql('l')}
                 ${currentSignalPackageEligibilitySql('l')}
                 AND NOT EXISTS (
                   SELECT 1 FROM messages m
                    WHERE m.lead_id = l.id
                      AND m.client_id = l.client_id
                      AND m.status <> 'deleted'
                 )
             )::int AS kickoff_selectable_email,
             COUNT(*) FILTER (
               WHERE l.deleted_at IS NULL
                 AND l.pipeline_stage = 'prospecting'
                 AND l.status = 'new'
                 AND l.lead_tier = 'B'
                 AND l.linkedin_url IS NOT NULL
                 AND l.linkedin_url <> ''
                 ${leadSelectionFeedbackExclusionSql('l')}
                 ${currentSignalPackageEligibilitySql('l')}
                 AND NOT EXISTS (
                   SELECT 1 FROM messages m
                    WHERE m.lead_id = l.id
                      AND m.client_id = l.client_id
                      AND m.status <> 'deleted'
                 )
             )::int AS kickoff_selectable_linkedin,
             (
               COUNT(*) FILTER (
                 WHERE l.deleted_at IS NULL
                   AND l.pipeline_stage = 'prospecting'
                   AND l.status = 'new'
                   AND l.lead_tier = 'A'
                   AND l.email IS NOT NULL
                   AND l.email <> ''
                   ${leadSelectionFeedbackExclusionSql('l')}
                   ${currentSignalPackageEligibilitySql('l')}
                   AND NOT EXISTS (
                     SELECT 1 FROM messages m
                      WHERE m.lead_id = l.id
                        AND m.client_id = l.client_id
                        AND m.status <> 'deleted'
                   )
               )
               +
               COUNT(*) FILTER (
                 WHERE l.deleted_at IS NULL
                   AND l.pipeline_stage = 'prospecting'
                   AND l.status = 'new'
                   AND l.lead_tier = 'B'
                   AND l.linkedin_url IS NOT NULL
                   AND l.linkedin_url <> ''
                   ${leadSelectionFeedbackExclusionSql('l')}
                   ${currentSignalPackageEligibilitySql('l')}
                   AND NOT EXISTS (
                     SELECT 1 FROM messages m
                      WHERE m.lead_id = l.id
                        AND m.client_id = l.client_id
                        AND m.status <> 'deleted'
                   )
               )
             )::int AS kickoff_selectable_total
           FROM leads l
           WHERE l.client_id = $1`,
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
        pool.query(
          `SELECT
             (SELECT COUNT(*) FILTER (WHERE status = 'pending')::int
                FROM followup_queue
               WHERE client_id = $1) AS pending,
             (SELECT COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_for <= (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::int
                FROM followup_queue
               WHERE client_id = $1) AS due_today,
             (SELECT COUNT(*) FILTER (WHERE status = 'sent')::int
                FROM followup_queue
               WHERE client_id = $1) AS sent,
             (SELECT COUNT(*) FILTER (WHERE status = 'cancelled')::int
                FROM followup_queue
               WHERE client_id = $1) AS cancelled,
             (SELECT COUNT(DISTINCT m.lead_id)::int
                FROM messages m
                LEFT JOIN followup_queue fq ON fq.lead_id = m.lead_id AND fq.client_id = m.client_id
               WHERE m.client_id = $1
                 AND m.status = 'sent'
                 AND m.sent_at IS NOT NULL
                 AND fq.id IS NULL) AS orphaned_sent_leads`,
          [c.id]
        ),
      ]);

      const approvedUnsentByChannel = {};
      for (const r of approvedUnsent.rows) approvedUnsentByChannel[r.channel] = r.n;

      const i = integrations.rows[0];
      const evidence = kickoffEvidence.rows[0] || {};
      const kickoffWorkProof = !!(evidence.last_work_log_at || Number(evidence.trace_count) > 0);
      const kickoffStarted = !!(evidence.memory_written || evidence.last_start_log_at);
      const kickoffMemoryOnlyStarted = kickoffStarted && !kickoffWorkProof;
      const kickoffState = scheduledAutonomyPaused
        ? 'disabled'
        : process.env.CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true'
        ? 'disabled'
        : kickoffWorkProof
          ? 'fired'
          : kickoffMemoryOnlyStarted
            ? 'started'
            : klMinutesNow < (9 * 60 + 30)
              ? 'waiting'
              : klMinutesNow > (9 * 60 + 40)
                ? 'missed'
                : 'window_open';
      tenants.push({
        client_id: c.id,
        slug: c.slug,
        name: c.name,
        kickoff_today: {
          fired: kickoffWorkProof,
          state: kickoffState,
          at: evidence.last_work_log_at || evidence.last_start_log_at || null,
          start_at: evidence.last_start_log_at || null,
          work_at: evidence.last_work_log_at || null,
          memory_written: !!evidence.memory_written,
          memory_only_started: kickoffMemoryOnlyStarted,
          trace_count: Number(evidence.trace_count) || 0,
        },
        kpi: kpi.rows[0] || null,
        messages: msgs.rows[0],
        send_queue: queue.rows[0],
        approved_unsent: approvedUnsentByChannel,
        approval_queue: approvalQueue.rows[0],
        followup_queue: followupHealth.rows[0],
        basic_operating_surface: basicOperatingSurfaceForTenant({
          approval_queue: approvalQueue.rows[0],
          manual_linkedin_queue: { approved_unsent: approvedUnsentByChannel.linkedin || 0 },
          email_send_queue: queue.rows[0],
          reply_tracking: { replies_today: kpi.rows[0]?.replies_received || 0 },
          followup_visibility: followupHealth.rows[0],
        }),
        lead_pool_remaining: Number(leadPool.rows[0].kickoff_selectable_total) || 0,
        lead_pool: {
          raw_available: Number(leadPool.rows[0].raw_available) || 0,
          raw_new_prospecting: Number(leadPool.rows[0].raw_new_prospecting) || 0,
          kickoff_selectable_total: Number(leadPool.rows[0].kickoff_selectable_total) || 0,
          kickoff_selectable_email: Number(leadPool.rows[0].kickoff_selectable_email) || 0,
          kickoff_selectable_linkedin: Number(leadPool.rows[0].kickoff_selectable_linkedin) || 0,
        },
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
        timezone: 'Asia/Kuala_Lumpur',
        kl_minutes_now: klMinutesNow,
        enabled_slugs: enabledSlugs,
        scheduled_autonomy_paused: scheduledAutonomyPaused,
        autonomy_state: autonomyState,
        captain_daily_kickoff_enabled: !scheduledAutonomyPaused && process.env.CAPTAIN_DAILY_KICKOFF_ENABLED === 'true',
        captain_kpi_gap_kickoff_enabled: !scheduledAutonomyPaused && process.env.CAPTAIN_KPI_GAP_KICKOFF_ENABLED === 'true',
        market_sensing_enabled: !scheduledAutonomyPaused && process.env.MARKET_SENSING_ENABLED === 'true',
        basic_operating_surface: basicOperatingSurfaceForTenant({
          tenants: tenants.length,
          scheduled_autonomy_paused: scheduledAutonomyPaused,
        }),
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
        basic_operating_surface: {
          channel: 'manual_linkedin_queue',
          manual_safe: true,
          managed_automation: false,
          auto_connect: false,
          accepted_dm_automation: false,
          completion_route: '/api/autonomous/linkedin-mark-sent',
        },
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
         RETURNING id, lead_id, sent_at, body`,
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

      // 2026-05-13: Phase 4 capture for manual Chrome sends. If Cowork passes the final sent
      // body and it differs from the original draft, write a founder_feedback row so the
      // weekly Sales few-shot rebuild sees MJ's manual edits. Backward-compatible:
      // pre-existing Cowork calls without final_body still succeed, just no diff captured.
      const { final_body } = req.body || {};
      if (final_body && typeof final_body === 'string' && updated.body && updated.body.trim() !== final_body.trim()) {
        try {
          await pool.query(
            `INSERT INTO founder_feedback (client_id, lead_id, message_id, original_body, edited_body, feedback_type, channel)
             VALUES ($1, $2, $3, $4, $5, 'manual_chrome_send_edit', 'linkedin')`,
            [client_id, updated.lead_id, message_id, updated.body, final_body]
          );
        } catch (err) {
          logger.warn({ msg: '[linkedin-mark-sent] founder_feedback capture failed (non-fatal)', err: err.message, message_id });
        }
      }

      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
         VALUES ($1, 'system', 'linkedin_sent_via_cowork', 'message', $2, $3)`,
        [client_id, message_id, JSON.stringify({ notes: notes || null, lead_id: updated.lead_id, body_edited: !!(final_body && updated.body && updated.body.trim() !== final_body.trim()) })]
      );
      // Phase 1 (2026-05-08): pipeline_traces sent (LinkedIn manual via Cowork — was the silent backbone)
      pipelineTrace.traceStage(client_id, {
        lead_id: updated.lead_id,
        message_id,
        stage: 'sent',
        status: 'manual_chrome_cowork',
        agent: 'system',
        pipeline_path: 'linkedin_mark_sent',
        metadata: { channel: 'linkedin', notes: notes || null },
      }).catch(() => {});

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

      return res.json({
        data: {
          message_id,
          status: 'sent',
          sent_at: updated.sent_at,
          basic_operating_surface: {
            channel: 'manual_linkedin_queue',
            manual_safe: true,
            managed_automation: false,
            auto_connect: false,
            accepted_dm_automation: false,
          },
        },
      });
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
      // Phase 1 (2026-05-08): pipeline_traces — connection request is a "skipped" send waiting for accept
      pipelineTrace.traceStage(client_id, {
        lead_id: updated.lead_id,
        message_id,
        stage: 'skipped',
        status: 'connection_requested',
        agent: 'system',
        pipeline_path: 'linkedin_mark_sent',
        metadata: { channel: 'linkedin', notes: notes || null, awaiting: 'connection_accept' },
      }).catch(() => {});

      return res.json({
        data: {
          message_id,
          status: 'linkedin_requested',
          basic_operating_surface: {
            channel: 'manual_linkedin_queue',
            manual_safe: true,
            managed_automation: false,
            auto_connect: false,
            accepted_dm_automation: false,
          },
        },
      });
    }

    // action === 'failed' → just log; status stays 'approved' so it surfaces again
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, 'system', 'linkedin_send_failed_via_cowork', 'message', $2, $3)`,
      [client_id, message_id, JSON.stringify({ notes: notes || null })]
    );
    // Phase 1 (2026-05-08): pipeline_traces send_failed (LinkedIn Cowork attempt)
    pipelineTrace.traceStage(client_id, {
      message_id,
      stage: 'send_failed',
      status: 'cowork_failed',
      agent: 'system',
      reason: notes || null,
      pipeline_path: 'linkedin_mark_sent',
      metadata: { channel: 'linkedin' },
    }).catch(() => {});
    return res.json({
      data: {
        message_id,
        status: 'failed_will_retry',
        basic_operating_surface: {
          channel: 'manual_linkedin_queue',
          manual_safe: true,
          managed_automation: false,
          auto_connect: false,
          accepted_dm_automation: false,
        },
      },
    });
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

        // 2. Advance lead. CASE guard mirrors commit 3bb476c (mark-replied):
        // advance to 'qualifying' ONLY when current stage is earlier in the funnel.
        // Leads already past qualifying (booked / closed*) keep their stage so a
        // batch sync-replies pass cannot regress a booked deal.
        await pool.query(
          `UPDATE leads
             SET last_reply_at = NOW(),
                 pipeline_stage = CASE
                   WHEN pipeline_stage IN ('prospecting', 'researched', 'contacted', 'outreach')
                     THEN 'qualifying'
                   ELSE pipeline_stage
                 END,
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
            basic_operating_surface: 'reply_tracking',
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
        basic_operating_surface: {
          channel: 'manual_linkedin_queue',
          surface: 'reply_tracking',
          managed_automation: false,
          accepted_dm_automation: false,
        },
        details,
      },
    });
  } catch (err) {
    logger.error({ msg: 'linkedin-sync-replies failed', err: err.message });
    res.status(500).json({ error: 'Failed to sync LinkedIn replies', code: 'DB_ERROR' });
  }
});

/* ─── POST /api/autonomous/linkedin-sync-connections ───────────
 * Closes the LinkedIn-connections blindspot. Every prospect MJ accepts/sends
 * on LinkedIn is invisible to BeavrDam unless manually added. This endpoint
 * accepts a batch from the local Chrome-CDP scraper
 * (scripts/sync-linkedin-connections-to-beavrdam.mjs in MJxClaude) and:
 *   1. Normalizes linkedin slug, dedupes against existing leads.linkedin_url
 *   2. Enriches email via emailEnrichment (Brave primary, Hunter fallback)
 *   3. Creates lead with source='linkedin_connection_sync', signal_tier='P3',
 *      pipeline_stage='prospecting', buying_signal_strength='lite'
 *
 * Body: {
 *   client_id,
 *   connections: [
 *     { profile_url, name, title, company, connected_time (ISO, optional) }
 *   ]
 * }
 *
 * Auth: x-internal-key
 */
router.post('/linkedin-sync-connections', requireInternalKey, async (req, res) => {
  const { client_id, connections } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  if (!Array.isArray(connections)) return res.status(400).json({ error: 'connections must be an array', code: 'INVALID_CONNECTIONS' });
  if (connections.length === 0) return res.json({ data: { client_id, received: 0, created: 0, skipped_dup: 0, details: [] } });
  if (connections.length > 500) return res.status(400).json({ error: 'connections batch too large (max 500)', code: 'BATCH_TOO_LARGE' });

  // Normalize incoming connections
  const candidates = [];
  let skippedInvalid = 0;
  for (const c of connections) {
    if (!c || typeof c !== 'object') { skippedInvalid++; continue; }
    const slug = linkedinSlug(c.profile_url);
    if (!slug) { skippedInvalid++; continue; }
    const name = String(c.name || '').trim();
    if (!name) { skippedInvalid++; continue; }
    candidates.push({
      slug,
      profile_url: c.profile_url,
      name,
      title: String(c.title || '').trim().slice(0, 200) || null,
      company: String(c.company || '').trim().slice(0, 200) || null,
      connected_time: c.connected_time || null,
    });
  }

  if (candidates.length === 0) {
    return res.json({
      data: { client_id, received: connections.length, created: 0, skipped_dup: 0, skipped_invalid: skippedInvalid, details: [] },
    });
  }

  try {
    const leadsService = require('../services/leads');
    const { enrichEmail } = require('../services/emailEnrichment');

    // Dedup pass — fetch every linkedin_url for this tenant, normalize via linkedinSlug,
    // build an in-memory Set. Tenant pool is bounded (low thousands) so this is cheap
    // and avoids SQL regex complexity.
    const { rows: existingRows } = await pool.query(
      `SELECT linkedin_url FROM leads
       WHERE client_id = $1 AND deleted_at IS NULL AND linkedin_url IS NOT NULL`,
      [client_id]
    );
    const existingSlugs = new Set();
    for (const row of existingRows) {
      const s = linkedinSlug(row.linkedin_url);
      if (s) existingSlugs.add(s);
    }

    const details = [];
    let created = 0;
    let skippedDup = 0;
    let enrichedBrave = 0;
    let enrichedHunter = 0;
    let noEmail = 0;

    for (const c of candidates) {
      if (existingSlugs.has(c.slug)) {
        skippedDup++;
        details.push({ slug: c.slug, status: 'skipped_dup' });
        continue;
      }

      // Enrich (fire-and-forget catch — never block lead creation on enrichment errors)
      let enrich = null;
      try {
        enrich = await enrichEmail(client_id, { name: c.name, company: c.company });
      } catch (err) {
        logger.warn({ msg: '[linkedin-sync-connections] enrichEmail failed', slug: c.slug, err: err.message });
      }
      if (enrich?.source === 'brave') enrichedBrave++;
      else if (enrich?.source === 'hunter') enrichedHunter++;
      else noEmail++;

      try {
        const lead = await leadsService.createLead(client_id, {
          name: c.name,
          email: enrich?.email || null,
          company: c.company,
          title: c.title,
          linkedin_url: c.profile_url,
          source: 'linkedin_connection_sync',
          signal_tier: 'P3',
          status: 'new',
          pipeline_stage: 'prospecting',
          buying_signal_strength: 'lite',
          metadata: {
            connected_time: c.connected_time,
            enrichment_source: enrich?.source || null,
            enrichment_confidence: enrich?.confidence || null,
          },
        });
        created++;
        // Mark slug as seen so a duplicate within the same batch doesn't re-create.
        existingSlugs.add(c.slug);
        details.push({
          slug: c.slug,
          status: 'created',
          lead_id: lead.id,
          enriched: enrich ? enrich.source : 'none',
        });
      } catch (err) {
        logger.warn({ msg: '[linkedin-sync-connections] createLead failed', slug: c.slug, err: err.message });
        details.push({ slug: c.slug, status: 'create_failed', error: err.message });
      }
    }

    return res.json({
      data: {
        client_id,
        received: connections.length,
        created,
        skipped_dup: skippedDup,
        skipped_invalid: skippedInvalid,
        enriched_brave: enrichedBrave,
        enriched_hunter: enrichedHunter,
        no_email: noEmail,
        details,
      },
    });
  } catch (err) {
    logger.error({ msg: 'linkedin-sync-connections failed', err: err.message });
    res.status(500).json({ error: 'Failed to sync LinkedIn connections', code: 'DB_ERROR' });
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

/* ─── POST /api/autonomous/dry-run-followup-drafts ─────────────
 * Pure validation endpoint. Pulls N pending followup_queue rows for the client,
 * calls draftFollowUp() + rangerReview() for each, RETURNS the drafts as JSON.
 * Does NOT insert into messages, does NOT touch send queue, does NOT mark
 * followup_queue rows as executed. Safe to call repeatedly.
 *
 * Added 2026-05-12 to validate BEAVER_FOLLOWUP_FORMAT.md v1.0 prompt changes
 * against real production leads without risk of sending real outreach.
 *
 * Body: { client_id, count: number (default 3, max 10) }
 * Auth: x-internal-key
 */
router.post('/dry-run-followup-drafts', requireInternalKey, async (req, res) => {
  const { client_id, count = 3 } = req.body || {};
  if (!client_id || !UUID_RE.test(String(client_id))) {
    return res.status(400).json({ error: 'client_id required (UUID)' });
  }
  const n = Math.max(1, Math.min(10, parseInt(count, 10) || 3));
  const today = todayInMalaysia();

  try {
    const { draftFollowUp } = require('../services/followupSequence');

    // Pull N pending followups due today, oldest first
    const { rows: fus } = await pool.query(
      `SELECT fq.id AS fu_id, fq.touch_number, fq.scheduled_for,
              l.id AS lead_id, l.name, l.title, l.company, l.email, l.linkedin_url,
              l.metadata, l.metadata->>'industry' AS industry
       FROM followup_queue fq
       JOIN leads l ON l.id = fq.lead_id
       WHERE fq.client_id = $1
         AND fq.status IN ('pending','skipped')
         AND fq.scheduled_for::date <= $3::date
         AND l.sequence_status = 'active'
         AND l.deleted_at IS NULL
       ORDER BY (fq.status = 'pending') DESC, fq.scheduled_for ASC
       LIMIT $2`,
      [client_id, n, today]
    );

    if (fus.length === 0) {
      return res.json({ data: { count: 0, drafts: [], note: 'no pending followups due today' } });
    }

    const drafts = [];
    for (const fu of fus) {
      // Previous messages for context
      const { rows: prev } = await pool.query(
        `SELECT subject, body, channel, metadata
         FROM messages
         WHERE lead_id = $1 AND client_id = $2
           AND status IN ('sent','pending_send','approved','delivered','linkedin_requested')
         ORDER BY created_at ASC LIMIT 6`,
        [fu.lead_id, client_id]
      );
      const channel = prev[0]?.channel || 'email';

      let draft;
      let drafterr = null;
      try {
        draft = await draftFollowUp(fu, fu.touch_number, prev, null);
      } catch (e) { drafterr = e.message; }

      const body = draft?.body || '';
      const wordCount = body.split(/\s+/).filter(Boolean).length;
      const qCount = (body.match(/\?/g) || []).length;

      // Run Enforcer scoring (read-only)
      let score = null, decision = null, notes = null, enforcerErr = null;
      if (body) {
        try {
          const r = await rangerReview(client_id, {
            message_id: null,
            message_body: body,
            lead_context: {
              touch_number: fu.touch_number, is_followup: true,
              name: fu.name, channel, captain_angle: null,
              company: fu.company, title: fu.title,
              signal: fu.metadata?.signal, angle: fu.metadata?.angle, why_now: fu.metadata?.why_now,
            },
          });
          score = r?.score ?? null;
          decision = r?.approved ? 'approved' : 'rejected';
          notes = (r?.notes || '').substring(0, 400);
        } catch (e) { enforcerErr = e.message; }
      }

      drafts.push({
        lead_name: fu.name,
        company: fu.company,
        title: fu.title,
        touch: fu.touch_number,
        channel,
        subject: draft?.subject || null,
        body,
        thinking_preview: (draft?.thinking || '').substring(0, 500),
        word_count: wordCount,
        q_count: qCount,
        ranger_score: score,
        ranger_decision: decision,
        ranger_notes: notes,
        draft_status: draft?.status || (drafterr ? 'threw' : 'ok'),
        drafterr,
        enforcerErr,
      });
    }

    const summary = {
      count: drafts.length,
      passed_60: drafts.filter(d => (d.ranger_score ?? 0) >= 60).length,
      empty_bodies: drafts.filter(d => !d.body).length,
      avg_score: drafts.filter(d => d.ranger_score != null).reduce((a,d)=>a+d.ranger_score, 0) / Math.max(1, drafts.filter(d => d.ranger_score != null).length),
    };

    return res.json({ data: { summary, drafts } });
  } catch (err) {
    logger.error({ msg: 'dry-run-followup-drafts failed', err: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Failed to run dry-run', code: 'DRY_RUN_ERROR', message: err.message });
  }
});

/* ─── POST /api/autonomous/execute-followup-batch ──────────────
 * Run executeApprovedFollowUp for N pending/skipped follow-ups, with
 * safeMode=true so all approved drafts land in pending_approval (no auto-send,
 * even for email above threshold). Use for validation runs of the v1.0
 * follow-up format against real prod leads.
 *
 * Side effects:
 *  - WRITES rows to messages, approvals, followup_queue
 *  - Marks followup_queue rows as 'sent' (approved) or 'skipped' (rejected)
 *  - Drafts approved by Enforcer land in pending_approval status (MJ reviews in UI)
 *  - NO emails actually sent. NO LinkedIn auto-routing. MJ has full control.
 *
 * Body: { client_id, count: number (default 5, max 20) }
 * Auth: x-internal-key
 */
router.post('/execute-followup-batch', requireInternalKey, async (req, res) => {
  const { client_id, count = 5 } = req.body || {};
  if (!client_id || !UUID_RE.test(String(client_id))) {
    return res.status(400).json({ error: 'client_id required (UUID)' });
  }
  const n = Math.max(1, Math.min(20, parseInt(count, 10) || 5));
  const today = todayInMalaysia();

  try {
    const { executeApprovedFollowUp } = require('../services/followupSequence');

    // Pull N due follow-ups. Include pending OR skipped (skipped ones might
    // have been wrongly skipped under the old broken prompt — give them another shot).
    const { rows: fus } = await pool.query(
      `SELECT fq.id AS fu_id, fq.touch_number, fq.status AS fu_status, l.name, l.company
       FROM followup_queue fq
       JOIN leads l ON l.id = fq.lead_id
       WHERE fq.client_id = $1
         AND fq.status IN ('pending','skipped')
         AND fq.scheduled_for::date <= $3::date
         AND l.sequence_status = 'active'
         AND l.deleted_at IS NULL
       ORDER BY (fq.status = 'pending') DESC, fq.scheduled_for ASC
       LIMIT $2`,
      [client_id, n, today]
    );

    if (fus.length === 0) {
      return res.json({ data: { count: 0, results: [], note: 'no due followups' } });
    }

    // If row was previously skipped, flip back to pending so executeApprovedFollowUp
    // doesn't bail on "already_skipped" status guard
    await pool.query(
      `UPDATE followup_queue SET status='pending' WHERE id = ANY($1::uuid[]) AND client_id=$2 AND status='skipped'`,
      [fus.map(f => f.fu_id), client_id]
    );

    const results = [];
    for (const fu of fus) {
      const r = await executeApprovedFollowUp(client_id, fu.fu_id, null, null, { safeMode: true });
      results.push({ lead_name: fu.name, company: fu.company, touch: fu.touch_number, ...r });
    }

    const summary = {
      count: results.length,
      approved: results.filter(r => r.status === 'approved').length,
      rejected: results.filter(r => r.status === 'rejected').length,
      errored: results.filter(r => r.status === 'error').length,
      skipped: results.filter(r => r.status === 'skipped').length,
    };

    return res.json({ data: { summary, results } });
  } catch (err) {
    logger.error({ msg: 'execute-followup-batch failed', err: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Failed to run batch', code: 'BATCH_ERROR', message: err.message });
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

        // Step 1: Hunter findEmail (verified email — Tier A path)
        let email = null;
        let isVerified = false;
        let emailSource = null;
        let confidence = 0;

        const hunterResult = await hunter.findEmail(client_id, { firstName, lastName, company: lead.company });
        if (hunterResult?.email && (hunterResult.confidence || 0) >= minConfidence) {
          email = hunterResult.email;
          isVerified = !!hunterResult.verified;
          emailSource = 'hunter_backfill';
          confidence = hunterResult.confidence || 0;
        }

        // Step 2: Brave fallback (2026-05-14) — when Hunter misses or returns
        // low-confidence, search Brave for @<domain> emails on the company's
        // inferred domain. Pattern-inferred — NOT verified. Lands as Tier B
        // with email_source='brave_pattern' so downstream knows quality bar.
        if (!email) {
          try {
            const { searchEmailDomain } = require('../services/searchService');
            const { domainsFromCompany, scoreEmailNameMatch } = require('../services/emailEnrichment');
            const domains = domainsFromCompany(lead.company);
            for (const domain of domains) {
              const emails = await searchEmailDomain(domain).catch(() => []);
              if (!emails?.length) continue;
              // Pick the email whose local-part best matches firstName/lastName
              let best = null;
              for (const e of emails) {
                const score = scoreEmailNameMatch(e, firstName, lastName);
                if (!best || score > best.score) best = { email: e, score };
              }
              if (best && best.score >= 50) {
                email = best.email;
                isVerified = false; // Brave pattern — NOT verified
                emailSource = 'brave_pattern';
                confidence = best.score;
                break; // first matching domain wins
              }
            }
          } catch (err) {
            logger.warn({ msg: '[backfill-hunter] brave fallback failed', leadId: lead.id, err: err.message });
          }
        }

        // Step 3: MillionVerifier-backed pattern fallback. Hunter was already
        // tried above, so skip it here to avoid double-spending Hunter credits.
        if (!email) {
          try {
            const { findEmail } = require('../services/emailEnrichment');
            const enriched = await findEmail({
              name: lead.name,
              company: lead.company,
              first_name: firstName,
              last_name: lastName,
              clientId: client_id,
              skipHunter: true,
            });
            if (enriched?.email && (enriched.confidence || 0) >= minConfidence) {
              email = enriched.email;
              isVerified = enriched.status === 'deliverable';
              emailSource = enriched.email_source || 'findemail';
              confidence = enriched.confidence || 0;
            }
          } catch (err) {
            logger.warn({ msg: '[backfill-hunter] verifier fallback failed', leadId: lead.id, err: err.message });
          }
        }

        if (!email) {
          counts.skipped++;
          reasons.no_email_found = (reasons.no_email_found || 0) + 1;
          continue;
        }

        await pool.query(
          `UPDATE leads
              SET email          = $1,
                  email_verified = $2,
                  email_source   = $5,
                  -- promote B->A when a VERIFIED email is found, so the kickoff's
                  -- channelFilter routes the lead to the email channel. Without
                  -- this the lead stays tier B and the B->A path is dead-ended.
                  lead_tier      = CASE WHEN $2 = true THEN 'A' ELSE lead_tier END,
                  updated_at     = NOW()
            WHERE id = $3 AND client_id = $4
              AND (email IS NULL OR email = '')`,
          [email, isVerified, lead.id, client_id, emailSource]
        );
        counts.enriched++;
        if (isVerified) counts.verified++;
        reasons[`source_${emailSource}`] = (reasons[`source_${emailSource}`] || 0) + 1;
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

/* ─── POST /api/autonomous/bulk-redraft ─────────────────────────────
 * Re-draft pending_approval messages with current v1.0 outreach rules.
 * For follow-ups: uses draftFollowUp. For Day 0: uses salesGenerate.
 * Each redraft goes through Enforcer review. Result stays pending_approval.
 */
router.post('/bulk-redraft', requireInternalKey, async (req, res) => {
  const { client_id, dry_run = false, rescore_only = false } = req.body || {};
  if (!client_id) {
    return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  }

  try {
    const { draftFollowUp } = require('../services/followupSequence');
    const { salesGenerate, rangerReview } = agentsService;

    const { rows: pending } = await pool.query(
      `SELECT m.id, m.lead_id, m.channel, m.subject, m.body, m.metadata, m.follow_up_day,
              m.ranger_score AS old_score, m.ranger_notes AS old_notes,
              l.name, l.company, l.title, l.linkedin_url, l.email,
              l.metadata AS lead_metadata
         FROM messages m
         JOIN leads l ON l.id = m.lead_id
        WHERE m.client_id = $1
          AND m.status = 'pending_approval'
        ORDER BY m.created_at ASC`,
      [client_id]
    );

    if (pending.length === 0) {
      return res.json({ ok: true, message: 'No pending_approval messages to redraft', total: 0 });
    }

    // rescore_only: re-run Enforcer v1.0 on existing bodies without redrafting
    if (rescore_only) {
      if (dry_run) {
        return res.json({ ok: true, dry_run: true, rescore_only: true, total: pending.length });
      }
      const stats = { total: pending.length, rescored: 0, passed: 0, failed: 0, errors: 0 };
      for (const msg of pending) {
        try {
          const leadMeta = typeof msg.lead_metadata === 'string' ? JSON.parse(msg.lead_metadata || '{}') : (msg.lead_metadata || {});
          const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata || '{}') : (msg.metadata || {});
          const touchNumber = meta.touch_number || 0;

          const rangerResult = await rangerReview(client_id, {
            message_id: msg.id,
            message_body: msg.body,
            lead_context: {
              name: msg.name, company: msg.company, title: msg.title,
              signal: leadMeta.signal, angle: leadMeta.angle,
              why_now: leadMeta.why_now, touch_number: touchNumber,
            },
          });

          const score = rangerResult?.score || 0;
          const passed = !!rangerResult?.approved;
          if (passed) stats.passed++; else stats.failed++;

          // Fix 5c (2026-05-09): Score-based borderline detection in rescore path
          // Score 60-79 + passed = borderline, regardless of whether Enforcer returned two_thoughts
          const twoThoughts = rangerResult?.two_thoughts;
          const hasTwoThoughts = twoThoughts && Array.isArray(twoThoughts) && twoThoughts.length > 0;
          const isBorderline = passed && score >= 60 && score < 80;

          let rangerNotes;
          if (isBorderline && hasTwoThoughts) {
            const thoughtLines = twoThoughts.map((t, i) =>
              `${i + 1}. ${t.thought}: "${t.current_phrase}" → "${t.suggested_phrase}"`
            ).join('\n');
            rangerNotes = `Borderline (${score}/100) — two suggestions:\n${thoughtLines}`;
          } else if (isBorderline) {
            rangerNotes = `Borderline (${score}/100) — ${rangerResult?.notes || rangerResult?.feedback || rangerResult?.reject_reason || 'Review recommended'}`;
          } else {
            rangerNotes = `v1.0 rescore: ${passed ? 'PASS' : 'FAIL'} (${score}) — ${rangerResult?.notes || rangerResult?.reject_reason || 'reviewed'}`;
          }

          const rescoreMeta = { rescored_at: new Date().toISOString(), old_score: msg.old_score, new_score: score, passed };
          const suggestionsPayload = isBorderline
            ? (hasTwoThoughts ? twoThoughts : [{ thought: rangerResult?.notes || rangerResult?.feedback || 'Review recommended', current_phrase: '', suggested_phrase: '' }])
            : null;

          if (isBorderline) {
            // Persist borderline flag + enforcer_suggestions + rescore metadata
            await pool.query(
              `UPDATE messages SET ranger_score = $1, ranger_notes = $2,
               metadata = jsonb_set(jsonb_set(jsonb_set(COALESCE(metadata, '{}'),
                 '{v1_rescore}', $3::jsonb),
                 '{borderline}', 'true'),
                 '{enforcer_suggestions}', $4::jsonb),
               updated_at = NOW()
               WHERE id = $5 AND client_id = $6`,
              [score, rangerNotes, JSON.stringify(rescoreMeta),
               JSON.stringify(suggestionsPayload), msg.id, client_id]
            );
            if (!stats.borderline) stats.borderline = 0;
            stats.borderline++;
            logger.info({ msg: '[bulk-rescore] BORDERLINE', message_id: msg.id, lead: msg.name, score, hasTwoThoughts });
          } else {
            await pool.query(
              `UPDATE messages SET ranger_score = $1, ranger_notes = $2,
               metadata = jsonb_set(COALESCE(metadata, '{}'), '{v1_rescore}', $3::jsonb),
               updated_at = NOW()
               WHERE id = $4 AND client_id = $5`,
              [score, rangerNotes, JSON.stringify(rescoreMeta), msg.id, client_id]
            );
          }
          stats.rescored++;
          logger.info({ msg: '[bulk-rescore]', message_id: msg.id, lead: msg.name, old_score: msg.old_score, new_score: score, passed, borderline: isBorderline });
        } catch (err) {
          stats.errors++;
          logger.error({ msg: '[bulk-rescore] failed', message_id: msg.id, err: err.message });
        }
      }
      logger.info({ msg: '[bulk-rescore] complete', client_id, ...stats });
      return res.json({ ok: true, rescore_only: true, ...stats });
    }

    if (dry_run) {
      const followups = pending.filter(m => {
        const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata || '{}') : (m.metadata || {});
        return meta.is_followup;
      });
      return res.json({
        ok: true, dry_run: true, total: pending.length,
        followups: followups.length, day0: pending.length - followups.length,
      });
    }

    const stats = { total: pending.length, redrafted: 0, skipped_thin: 0, skipped_no_draft: 0, enforcer_passed: 0, enforcer_failed: 0, errors: 0 };

    for (const msg of pending) {
      try {
        const meta = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata || '{}') : (msg.metadata || {});
        const leadMeta = typeof msg.lead_metadata === 'string' ? JSON.parse(msg.lead_metadata || '{}') : (msg.lead_metadata || {});
        const isFollowup = !!meta.is_followup;
        const touchNumber = meta.touch_number || 0;

        let newBody = null;
        let newSubject = null;

        if (isFollowup && touchNumber >= 2) {
          const prevMsgs = await pool.query(
            `SELECT channel, subject, body, metadata FROM messages
              WHERE client_id = $1 AND lead_id = $2 AND id != $3
                AND status NOT IN ('deleted')
              ORDER BY created_at ASC`,
            [client_id, msg.lead_id, msg.id]
          );

          const lead = {
            id: msg.lead_id, name: msg.name, company: msg.company,
            title: msg.title, industry: leadMeta.industry,
            linkedin_url: msg.linkedin_url, email: msg.email,
            metadata: leadMeta,
          };

          const draft = await draftFollowUp(lead, touchNumber, prevMsgs.rows);
          if (draft?.status === 'needs_more_research') {
            stats.skipped_thin++;
            continue;
          }
          newBody = draft?.body;
          newSubject = draft?.subject || null;
        } else {
          const contextParts = [
            `Name: ${msg.name}`,
            `Company: ${msg.company || 'Unknown'}`,
            `Title: ${msg.title || 'Unknown'}`,
            leadMeta.signal ? `Signal: ${leadMeta.signal}` : '',
            leadMeta.angle ? `Angle: ${leadMeta.angle}` : '',
            leadMeta.friction ? `Friction: ${leadMeta.friction}` : '',
            leadMeta.why_now ? `Why now: ${leadMeta.why_now}` : '',
          ].filter(Boolean).join('\n');

          const salesResult = await salesGenerate(client_id, {
            lead_id: msg.lead_id,
            channel: msg.channel,
            context: contextParts,
          });
          newBody = salesResult?.body;
          newSubject = salesResult?.subject || null;
        }

        if (!newBody) {
          stats.skipped_no_draft++;
          continue;
        }

        const rangerResult = await rangerReview(client_id, {
          message_id: msg.id,
          message_body: newBody,
          lead_context: {
            name: msg.name, company: msg.company, title: msg.title,
            signal: leadMeta.signal, angle: leadMeta.angle,
            why_now: leadMeta.why_now, touch_number: touchNumber,
          },
        });

        const finalBody = rangerResult?.body || newBody;
        const score = rangerResult?.score || 0;
        const passed = !!rangerResult?.approved;

        if (passed) stats.enforcer_passed++;
        else stats.enforcer_failed++;

        await pool.query(
          `UPDATE messages SET body = $1, subject = COALESCE($2, subject),
           ranger_score = $3, ranger_notes = $4,
           metadata = jsonb_set(COALESCE(metadata, '{}'), '{bulk_redraft}', $5::jsonb),
           ranger_attempt_count = COALESCE(ranger_attempt_count, 0) + 1,
           updated_at = NOW()
           WHERE id = $6 AND client_id = $7`,
          [
            finalBody,
            newSubject,
            score,
            `v1.0 redraft: ${passed ? 'PASS' : 'FAIL'} (${score}) — ${rangerResult?.notes || rangerResult?.reject_reason || 'reviewed'}`,
            JSON.stringify({ redrafted_at: new Date().toISOString(), old_score: msg.old_score, new_score: score, passed }),
            msg.id,
            client_id,
          ]
        );

        stats.redrafted++;
        logger.info({ msg: '[bulk-redraft] redrafted', message_id: msg.id, lead: msg.name, old_score: msg.old_score, new_score: score, passed });
      } catch (err) {
        stats.errors++;
        logger.error({ msg: '[bulk-redraft] message failed', message_id: msg.id, err: err.message });
      }
    }

    logger.info({ msg: '[bulk-redraft] complete', client_id, ...stats });
    return res.json({ ok: true, ...stats });
  } catch (err) {
    logger.error({ msg: '[bulk-redraft] failed', err: err.message, stack: err.stack?.split('\n').slice(0, 4) });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─── POST /api/autonomous/enrich-cold-signals ──────────────────────
 * Manual cold-pool buying-signal enrichment (2026-05-19).
 *
 * Research Beaver web-searches signal-less prospecting-stage leads and
 * persists a verified buying signal to lead.metadata.signal — the field
 * Sales Beaver already reads when building draft context. Closes the
 * "fabricate or go generic" failure mode for cold outreach.
 *
 * Manual trigger only — NOT wired to any cron. Spend is bounded: limit
 * is hard-capped 1..25; each lead is <=3 web searches + 1 Haiku call.
 *
 * Body: { client_id, limit? }   Returns: { data: <run summary> }
 */
router.post('/enrich-cold-signals', async (req, res) => {
  const clientId = req.body?.client_id;
  if (!clientId) {
    return res.status(400).json({ error: 'client_id required', code: 'MISSING_CLIENT_ID' });
  }
  const limit = Math.min(Math.max(1, parseInt(req.body?.limit, 10) || 5), 25);
  // origin: 'vp' targets VP-imported leads only (high signal-yield); 'all' = whole cold pool.
  const origin = ['vp', 'all'].includes(req.body?.origin) ? req.body.origin : 'vp';
  try {
    const { runColdPoolSignalEnrichment } = require('../services/researchEnrichment');
    const result = await runWithClientContext(clientId, () => runColdPoolSignalEnrichment(clientId, { limit, origin }));
    logger.info({ msg: '[enrich-cold-signals] complete', client_id: clientId, limit, enriched: result.enriched, processed: result.processed });
    return res.json({ data: result });
  } catch (err) {
    logger.error({ msg: '[enrich-cold-signals] failed', err: err.message });
    return res.status(500).json({ error: err.message, code: 'ENRICH_FAILED' });
  }
});

module.exports = router;
module.exports.runAutonomousKickoff = runAutonomousKickoff;
module.exports._test = { parseRequestedLeadLimit, boundedChatSignalQueryCap, isChatCampaignIntent };
