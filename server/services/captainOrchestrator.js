'use strict';

/**
 * Captain Beaver — Main Orchestrator.
 *
 * The team's GM. Reads each beaver's KPIs every morning, composes a
 * conversational-tight brief for MJ, and persists today's plan into
 * agent_memory so the other beavers can read it during their own loops.
 *
 * Agency level: GM-tactical. Captain owns:
 *   - Daily target setting per beaver (within tenant config bounds)
 *   - Strategy switching when one is dry (within tenant's library)
 *   - Voice tuning for Sales Beaver when patterns emerge
 *   - Telegram briefs to MJ
 *   - Escalation routing (which decisions need MJ vs Captain handles)
 *
 * Captain does NOT own: ICP changes, pricing, tenant decisions, product
 * direction. Those flow up to MJ with Captain's recommendation attached.
 *
 * This file is the OPERATIONAL Captain. The chat-tool Captain at
 * services/captainBeaver.js still handles MJ's interactive /commands.
 * Both share state via agent_memory and clients tables.
 */

const pool = require('../db/pool');
const { callAgent } = require('./claude');
const tenantConfig = require('./tenantConfig');

/* ─── KPI snapshot collector ──────────────────────────────────────── */

/**
 * Pull a structured snapshot of the team's last 24h performance for one
 * tenant. Pure read — no side effects. Used by morning brief, EOD brief,
 * and stuck-state monitor.
 *
 * Returns shape:
 * {
 *   tenant: { id, slug, name, daily_quality_lead_floor, vp_threshold_score },
 *   research_beaver: { sourced_24h, scored_avg, top_quality_score, pool_size, strategies_used },
 *   sales_beaver:    { drafts_24h, first_attempt_pass_rate, sent_24h, replies_24h },
 *   enforcer:        { reviews_24h, approve_rate, reject_rate, top_reject_reasons },
 *   pipeline:        { pending_approvals, approved_unsent_linkedin, approved_unsent_email, bounces_7d },
 *   vp:              { credits_used_today, credits_budget, credits_remaining_today },
 * }
 */
async function collectTeamKPIs(clientId) {
  const cfg = await tenantConfig.getTenantConfig(clientId);
  if (!cfg) throw new Error(`No tenant for client_id=${clientId}`);

  const since24h = `NOW() - INTERVAL '24 hours'`;
  const since7d = `NOW() - INTERVAL '7 days'`;

  // ─── Research Beaver ──
  const researchPromise = pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > ${since24h}) AS sourced_24h,
       ROUND(AVG(quality_score) FILTER (WHERE created_at > ${since24h} AND quality_score IS NOT NULL))::int AS scored_avg,
       MAX(quality_score) FILTER (WHERE created_at > ${since24h}) AS top_quality_score,
       COUNT(*) FILTER (WHERE deleted_at IS NULL AND status NOT IN ('contacted', 'meeting_booked', 'closed_won', 'closed_lost') AND status NOT LIKE 'rejected_%') AS pool_size,
       COUNT(DISTINCT source) FILTER (WHERE created_at > ${since24h}) AS strategies_used
     FROM leads
     WHERE client_id = $1`,
    [clientId]
  );

  // ─── Sales Beaver ──
  const salesPromise = pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > ${since24h}) AS drafts_24h,
       COUNT(*) FILTER (WHERE created_at > ${since24h} AND ranger_score >= 75 AND ranger_attempt_count <= 1) AS first_pass,
       COUNT(*) FILTER (WHERE created_at > ${since24h} AND ranger_attempt_count <= 1) AS first_attempt_total,
       COUNT(*) FILTER (WHERE sent_at > ${since24h}) AS sent_24h,
       COUNT(*) FILTER (WHERE reply_detected_at > ${since24h}) AS replies_24h
     FROM messages
     WHERE client_id = $1`,
    [clientId]
  );

  // ─── Enforcer ──
  const enforcerPromise = pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE created_at > ${since24h} AND ranger_score IS NOT NULL) AS reviews_24h,
       COUNT(*) FILTER (WHERE created_at > ${since24h} AND ranger_score >= 75) AS approves_24h,
       COUNT(*) FILTER (WHERE created_at > ${since24h} AND ranger_score < 75) AS rejects_24h
     FROM messages
     WHERE client_id = $1`,
    [clientId]
  );

  // Top reject reasons (last 24h, top 3)
  const rejectReasonsPromise = pool.query(
    `SELECT
       COALESCE(SPLIT_PART(ranger_notes, ':', 1), 'no_note') AS reason,
       COUNT(*) AS n
     FROM messages
     WHERE client_id = $1
       AND created_at > ${since24h}
       AND ranger_score < 75
       AND ranger_notes IS NOT NULL
     GROUP BY reason
     ORDER BY n DESC
     LIMIT 3`,
    [clientId]
  );

  // ─── Pipeline state ──
  const pipelinePromise = pool.query(
    `SELECT
       (SELECT COUNT(*) FROM approvals
          WHERE client_id = $1 AND status IN ('pending', 'pending_approval')) AS pending_approvals,
       (SELECT COUNT(*) FROM messages
          WHERE client_id = $1 AND channel = 'linkedin' AND status IN ('approved', 'linkedin_requested') AND sent_at IS NULL) AS approved_unsent_linkedin,
       (SELECT COUNT(*) FROM messages
          WHERE client_id = $1 AND channel = 'email' AND status = 'approved' AND sent_at IS NULL) AS approved_unsent_email,
       (SELECT COUNT(*) FROM messages
          WHERE client_id = $1 AND status = 'bounced' AND updated_at > ${since7d}) AS bounces_7d`,
    [clientId]
  );

  const [research, sales, enforcer, rejectReasons, pipeline] = await Promise.all([
    researchPromise, salesPromise, enforcerPromise, rejectReasonsPromise, pipelinePromise,
  ]);

  const r = research.rows[0];
  const s = sales.rows[0];
  const e = enforcer.rows[0];
  const p = pipeline.rows[0];

  const passRate = (s.first_attempt_total > 0)
    ? Math.round((s.first_pass / s.first_attempt_total) * 100)
    : null;

  const approveRate = (e.reviews_24h > 0)
    ? Math.round((e.approves_24h / e.reviews_24h) * 100)
    : null;

  return {
    tenant: {
      id: cfg.id,
      slug: cfg.slug,
      name: cfg.name,
      daily_quality_lead_floor: cfg.daily_quality_lead_floor,
      vp_threshold_score: cfg.vp_threshold_score,
    },
    research_beaver: {
      sourced_24h: Number(r.sourced_24h) || 0,
      sourced_floor: cfg.daily_quality_lead_floor,
      scored_avg: r.scored_avg !== null ? Number(r.scored_avg) : null,
      top_quality_score: r.top_quality_score !== null ? Number(r.top_quality_score) : null,
      pool_size: Number(r.pool_size) || 0,
      strategies_used: Number(r.strategies_used) || 0,
      meeting_floor: (Number(r.sourced_24h) || 0) >= cfg.daily_quality_lead_floor,
    },
    sales_beaver: {
      drafts_24h: Number(s.drafts_24h) || 0,
      first_attempt_pass_rate_pct: passRate,
      sent_24h: Number(s.sent_24h) || 0,
      replies_24h: Number(s.replies_24h) || 0,
    },
    enforcer: {
      reviews_24h: Number(e.reviews_24h) || 0,
      approve_rate_pct: approveRate,
      reject_rate_pct: approveRate !== null ? 100 - approveRate : null,
      top_reject_reasons: rejectReasons.rows.map(row => ({ reason: row.reason, n: Number(row.n) })),
    },
    pipeline: {
      pending_approvals: Number(p.pending_approvals) || 0,
      approved_unsent_linkedin: Number(p.approved_unsent_linkedin) || 0,
      approved_unsent_email: Number(p.approved_unsent_email) || 0,
      bounces_7d: Number(p.bounces_7d) || 0,
    },
    vp: {
      credits_used_today: cfg.vp_credits_used_today,
      credits_budget: cfg.vp_daily_budget_credits,
      credits_remaining_today: Math.max(0, cfg.vp_daily_budget_credits - cfg.vp_credits_used_today),
    },
  };
}

/* ─── Morning brief generator ─────────────────────────────────────── */

/**
 * Compose Captain's morning brief in conversational-tight tone using
 * Sonnet. Returns { summary, raw_kpis } where summary is the message
 * MJ reads on Telegram and raw_kpis is the underlying data.
 */
async function generateMorningBrief(clientId) {
  const kpis = await collectTeamKPIs(clientId);

  const userMessage = `Compose this morning's brief for ${kpis.tenant.name}.

KPIs (last 24h):

RESEARCH BEAVER
- Sourced: ${kpis.research_beaver.sourced_24h} of ${kpis.research_beaver.sourced_floor} target ${kpis.research_beaver.meeting_floor ? '✓' : '✗'}
- Avg quality score: ${kpis.research_beaver.scored_avg ?? 'no scores yet'}
- Top scorer today: ${kpis.research_beaver.top_quality_score ?? 'n/a'}
- Pool size now: ${kpis.research_beaver.pool_size}
- Strategies tried: ${kpis.research_beaver.strategies_used}

SALES BEAVER
- Drafts: ${kpis.sales_beaver.drafts_24h}
- First-attempt Enforcer pass rate: ${kpis.sales_beaver.first_attempt_pass_rate_pct ?? 'no data'}%
- Sent: ${kpis.sales_beaver.sent_24h}
- Replies: ${kpis.sales_beaver.replies_24h}

ENFORCER
- Reviews: ${kpis.enforcer.reviews_24h}
- Approve rate: ${kpis.enforcer.approve_rate_pct ?? 'no data'}%
- Top reject reasons: ${kpis.enforcer.top_reject_reasons.map(r => `${r.reason} (${r.n})`).join(', ') || 'none'}

PIPELINE STATE
- Pending approvals on MJ: ${kpis.pipeline.pending_approvals}
- LinkedIn approved-not-sent: ${kpis.pipeline.approved_unsent_linkedin}
- Email approved-not-sent: ${kpis.pipeline.approved_unsent_email}
- Bounces (7d): ${kpis.pipeline.bounces_7d}

VP CREDITS
- Used today: ${kpis.vp.credits_used_today} / ${kpis.vp.credits_budget}
- Remaining today: ${kpis.vp.credits_remaining_today}

Write the brief.`;

  let summary;
  try {
    const result = await callAgent('captain_orchestrator', userMessage, { clientId });
    summary = result?.brief || result?.summary || result?.raw || null;
  } catch (err) {
    console.warn('[captain] brief generation failed:', err.message);
    summary = null;
  }

  // Fallback: if LLM fails, return a structured plain-text brief so MJ
  // never gets a silent morning. Better degraded than missing.
  if (!summary || typeof summary !== 'string') {
    summary = renderPlainBrief(kpis);
  }

  return { summary, raw_kpis: kpis };
}

/**
 * Plain-text fallback brief when the LLM call fails. Same data, no
 * Captain personality. Used so MJ's morning view is never blank.
 */
function renderPlainBrief(k) {
  const lines = [
    `Morning. ${k.tenant.name} pipeline brief — last 24h.`,
    ``,
    `Research: ${k.research_beaver.sourced_24h}/${k.research_beaver.sourced_floor} sourced (${k.research_beaver.meeting_floor ? 'on target' : 'BELOW FLOOR'}). Pool ${k.research_beaver.pool_size}. Avg quality ${k.research_beaver.scored_avg ?? '—'}.`,
    `Sales: ${k.sales_beaver.drafts_24h} drafts, ${k.sales_beaver.first_attempt_pass_rate_pct ?? '—'}% first-pass, ${k.sales_beaver.sent_24h} sent, ${k.sales_beaver.replies_24h} replies.`,
    `Enforcer: ${k.enforcer.approve_rate_pct ?? '—'}% approve rate. Top reject: ${k.enforcer.top_reject_reasons[0]?.reason || 'none'}.`,
    `Queue: ${k.pipeline.pending_approvals} pending you, ${k.pipeline.approved_unsent_linkedin} LinkedIn unsent, ${k.pipeline.approved_unsent_email} email unsent.`,
    `VP: ${k.vp.credits_used_today}/${k.vp.credits_budget} credits used today.`,
  ];
  return lines.join('\n');
}

/* ─── Persistence ─────────────────────────────────────────────────── */

/**
 * Persist today's morning brief to agent_memory so the other beavers
 * can read Captain's directives during their own loops.
 */
async function persistMorningBrief(clientId, brief) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, `morning_brief_${today}`, JSON.stringify(brief)]
  );
}

/* ─── Public entry: full morning brief flow ───────────────────────── */

/**
 * Generate Captain's morning brief, persist it, return the summary text
 * for Telegram dispatch. Drop-in replacement for the legacy
 * services/agents.directorBrief flow.
 */
async function runMorningBrief(clientId) {
  const brief = await generateMorningBrief(clientId);
  await persistMorningBrief(clientId, brief).catch(err => {
    console.warn('[captain] persist brief failed:', err.message);
  });
  return brief;
}

module.exports = {
  collectTeamKPIs,
  generateMorningBrief,
  persistMorningBrief,
  runMorningBrief,
};
