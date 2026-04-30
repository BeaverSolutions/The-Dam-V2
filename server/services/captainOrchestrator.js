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
const jobHealth = require('./jobHealth');

// MJ's monthly meeting target per tenant (set 2026-04-30 with MJ).
// Drives the "on pace for X meetings" projection in the brief.
const MONTHLY_MEETING_TARGET = 10;

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

  // ─── DB + cron health ──
  const dbCheckPromise = pool.query(`SELECT 1 AS ok`).then(() => true).catch(() => false);
  const cronHealthPromise = Promise.resolve(jobHealth.getStatus());

  // ─── $$ spend (today + MTD, all agents this tenant) ──
  const spendTodayPromise = pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS spend
     FROM llm_usage
     WHERE client_id = $1 AND created_at > date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    [clientId]
  );
  const spendMtdPromise = pool.query(
    `SELECT COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS spend
     FROM llm_usage
     WHERE client_id = $1 AND created_at > date_trunc('month', NOW() AT TIME ZONE 'UTC')`,
    [clientId]
  );

  // ─── Meetings — the metric MJ cares about ──
  const meetingsThisWeekPromise = pool.query(
    `SELECT COUNT(*) AS n FROM leads
     WHERE client_id = $1 AND deleted_at IS NULL
       AND meeting_date IS NOT NULL
       AND meeting_date > NOW() - INTERVAL '7 days'`,
    [clientId]
  );
  const meetingsMtdPromise = pool.query(
    `SELECT COUNT(*) AS n FROM leads
     WHERE client_id = $1 AND deleted_at IS NULL
       AND meeting_date IS NOT NULL
       AND meeting_date > date_trunc('month', NOW() AT TIME ZONE 'UTC')`,
    [clientId]
  );

  const [research, sales, enforcer, rejectReasons, pipeline,
         dbOk, cronHealth,
         spendToday, spendMtd, meetingsWeek, meetingsMtd] = await Promise.all([
    researchPromise, salesPromise, enforcerPromise, rejectReasonsPromise, pipelinePromise,
    dbCheckPromise, cronHealthPromise,
    spendTodayPromise, spendMtdPromise, meetingsThisWeekPromise, meetingsMtdPromise,
  ]);

  // Stale jobs derived from cronHealth — jobs in 'stale' state
  const staleJobs = Object.entries(cronHealth || {})
    .filter(([_, v]) => v?.status === 'stale')
    .map(([name]) => name);

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
      credits_used_total: cfg.vp_credits_used_total,
    },
    // ─── DAM HEALTH (the system itself) ──
    dam_health: {
      db_ok: dbOk,
      encryption_key_ok: !!process.env.ENCRYPTION_KEY,
      anthropic_set: !!process.env.ANTHROPIC_API_KEY,
      brave_set: !!process.env.BRAVE_API_KEY,
      vp_set: !!process.env.VIBE_PROSPECTING_API_KEY,
      gmail_oauth_set: !!process.env.GMAIL_CLIENT_ID,
      stale_jobs: staleJobs,
      cron_health: cronHealth,
    },
    // ─── COST (the spend that actually matters) ──
    cost: {
      llm_spend_today_usd: Number(spendToday.rows[0].spend) || 0,
      llm_spend_mtd_usd: Number(spendMtd.rows[0].spend) || 0,
      vp_credits_used_today: cfg.vp_credits_used_today,
      vp_credits_budget_today: cfg.vp_daily_budget_credits,
      daily_budget_usd: cfg.daily_budget_usd,
    },
    // ─── MEETINGS (the metric that defines success) ──
    meetings: {
      this_week: Number(meetingsWeek.rows[0].n) || 0,
      mtd: Number(meetingsMtd.rows[0].n) || 0,
      monthly_target: MONTHLY_MEETING_TARGET,
      mtd_pace_projected: projectMonthEndMeetings(Number(meetingsMtd.rows[0].n) || 0),
      gap_to_target: Math.max(0, MONTHLY_MEETING_TARGET - projectMonthEndMeetings(Number(meetingsMtd.rows[0].n) || 0)),
    },
  };
}

/**
 * Linear-pace projection for end-of-month meetings.
 * (mtd / day-of-month) × days-in-month.
 */
function projectMonthEndMeetings(mtd) {
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  if (dayOfMonth < 2) return mtd; // too early to project
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  return Math.round((mtd / dayOfMonth) * daysInMonth);
}

/* ─── Morning brief generator ─────────────────────────────────────── */

/**
 * Compose Captain's morning brief in conversational-tight tone using
 * Sonnet. Returns { summary, raw_kpis } where summary is the message
 * MJ reads on Telegram and raw_kpis is the underlying data.
 */
async function generateMorningBrief(clientId) {
  const kpis = await collectTeamKPIs(clientId);

  const userMessage = `Compose this morning's brief for ${kpis.tenant.name} in three sections: SYSTEM HEALTH, SITUATION REPORT, ORDERS OF THE DAY. Keep the conversational-tight tone. No royal greetings, no preamble.

═══ SYSTEM HEALTH ═══
- DB: ${kpis.dam_health.db_ok ? 'connected' : 'UNREACHABLE'}
- Encryption key: ${kpis.dam_health.encryption_key_ok ? 'valid' : 'MISSING'}
- API keys: anthropic ${kpis.dam_health.anthropic_set ? 'set' : 'MISSING'}, brave ${kpis.dam_health.brave_set ? 'set' : 'MISSING'}, vp ${kpis.dam_health.vp_set ? 'set' : 'MISSING'}, gmail-oauth ${kpis.dam_health.gmail_oauth_set ? 'set' : 'MISSING'}
- Stale crons: ${kpis.dam_health.stale_jobs.length === 0 ? 'none — all firing on schedule' : kpis.dam_health.stale_jobs.join(', ')}
- LLM spend today: $${kpis.cost.llm_spend_today_usd.toFixed(4)}
- LLM spend MTD: $${kpis.cost.llm_spend_mtd_usd.toFixed(2)}
- Daily LLM budget: $${kpis.cost.daily_budget_usd.toFixed(2)}
- VP credits today: ${kpis.cost.vp_credits_used_today} / ${kpis.cost.vp_credits_budget_today}

═══ SITUATION REPORT (last 24h) ═══

Research Beaver — sourced ${kpis.research_beaver.sourced_24h} of ${kpis.research_beaver.sourced_floor} floor ${kpis.research_beaver.meeting_floor ? '(on target)' : '(BELOW FLOOR)'}, avg quality ${kpis.research_beaver.scored_avg ?? '—'}, top score ${kpis.research_beaver.top_quality_score ?? '—'}, pool ${kpis.research_beaver.pool_size}, ${kpis.research_beaver.strategies_used} strategies in use.

Sales Beaver — ${kpis.sales_beaver.drafts_24h} drafts, ${kpis.sales_beaver.first_attempt_pass_rate_pct ?? '—'}% first-pass on Enforcer, ${kpis.sales_beaver.sent_24h} sent, ${kpis.sales_beaver.replies_24h} replies.

Enforcer Beaver — ${kpis.enforcer.reviews_24h} reviews, ${kpis.enforcer.approve_rate_pct ?? '—'}% approve rate. Top reject reasons: ${kpis.enforcer.top_reject_reasons.map(r => `${r.reason} (${r.n})`).join(', ') || 'none'}.

Pipeline state — ${kpis.pipeline.pending_approvals} pending MJ approval, ${kpis.pipeline.approved_unsent_linkedin} LinkedIn approved-not-sent, ${kpis.pipeline.approved_unsent_email} email approved-not-sent, ${kpis.pipeline.bounces_7d} bounces in last 7 days.

THE NUMBER THAT MATTERS — meetings:
- This week: ${kpis.meetings.this_week}
- MTD: ${kpis.meetings.mtd}
- Monthly target: ${kpis.meetings.monthly_target}
- Linear-pace projection: ${kpis.meetings.mtd_pace_projected} by month-end (gap of ${kpis.meetings.gap_to_target} to target)

═══ ORDERS OF THE DAY ═══

Today's plan — surface what each beaver is working on, what strategy you're betting on this week, and what specifically NEEDS MJ'S DECISION today. Decisions you make autonomously (threshold tunes, strategy switches, coaching loop firing) get listed under "actions taken" — don't ask MJ about those.

Write the brief now. Three sections. Hard-line breaks between sections. Be the GM.`;

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
 * Mirrors the 3-section structure so MJ's mental model stays consistent.
 */
function renderPlainBrief(k) {
  const health = k.dam_health.db_ok && k.dam_health.encryption_key_ok && k.dam_health.stale_jobs.length === 0
    ? 'green'
    : 'degraded';

  const lines = [
    `morning. dam health: ${health}.`,
    ``,
    `═══ system health ═══`,
    `db ${k.dam_health.db_ok ? 'ok' : 'UNREACHABLE'} · enc-key ${k.dam_health.encryption_key_ok ? 'valid' : 'MISSING'} · crons ${k.dam_health.stale_jobs.length === 0 ? 'all firing' : 'STALE: ' + k.dam_health.stale_jobs.join(', ')}`,
    `spend today $${k.cost.llm_spend_today_usd.toFixed(4)} · mtd $${k.cost.llm_spend_mtd_usd.toFixed(2)} · vp credits ${k.cost.vp_credits_used_today}/${k.cost.vp_credits_budget_today} today`,
    ``,
    `═══ situation report ═══`,
    `research beaver: ${k.research_beaver.sourced_24h}/${k.research_beaver.sourced_floor} sourced ${k.research_beaver.meeting_floor ? '(on target)' : '(BELOW FLOOR)'}, avg quality ${k.research_beaver.scored_avg ?? '—'}, pool ${k.research_beaver.pool_size}`,
    `sales beaver: ${k.sales_beaver.drafts_24h} drafts, ${k.sales_beaver.first_attempt_pass_rate_pct ?? '—'}% first-pass, ${k.sales_beaver.sent_24h} sent, ${k.sales_beaver.replies_24h} replies`,
    `enforcer: ${k.enforcer.approve_rate_pct ?? '—'}% approve, top reject: ${k.enforcer.top_reject_reasons[0]?.reason || 'none'}`,
    `pipeline: ${k.pipeline.pending_approvals} pending you, ${k.pipeline.approved_unsent_linkedin} linkedin unsent, ${k.pipeline.approved_unsent_email} email unsent, ${k.pipeline.bounces_7d} bounces 7d`,
    ``,
    `meetings: ${k.meetings.this_week} this week, ${k.meetings.mtd} mtd, projecting ${k.meetings.mtd_pace_projected}/${k.meetings.monthly_target} (gap ${k.meetings.gap_to_target})`,
    ``,
    `═══ orders of the day ═══`,
    `(captain's llm offline — orders not generated. tomorrow's plan: clear ${k.pipeline.pending_approvals} pending approvals, hit ${k.research_beaver.sourced_floor} quality leads, watch bounces.)`,
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

/* ─── EOD Brief ───────────────────────────────────────────────────── */

/**
 * Generate the end-of-day brief. Mirrors morning structure but reports
 * on TODAY (what shipped, what's stuck, tomorrow's plan).
 */
async function generateEodBrief(clientId) {
  const beaverState = require('./beaverState');

  const kpis = await collectTeamKPIs(clientId);
  const beaverReports = await beaverState.readAllBeaversKPIsForToday(clientId).catch(() => ({}));
  const todaysActions = await beaverState.readRecentCaptainActions(clientId, 12).catch(() => []);

  const userMessage = `Compose today's END-OF-DAY brief for ${kpis.tenant.name}. Same conversational-tight tone as morning. Three sections: SYSTEM HEALTH, TODAY'S RESULTS, TOMORROW'S SETUP.

═══ SYSTEM HEALTH (close of day) ═══
DB ${kpis.dam_health.db_ok ? 'ok' : 'UNREACHABLE'} · stale crons: ${kpis.dam_health.stale_jobs.join(', ') || 'none'}
spend today $${kpis.cost.llm_spend_today_usd.toFixed(4)} · mtd $${kpis.cost.llm_spend_mtd_usd.toFixed(2)}
vp credits today ${kpis.cost.vp_credits_used_today} of ${kpis.cost.vp_credits_budget_today}

═══ TODAY'S RESULTS ═══
research beaver self-report: ${JSON.stringify(beaverReports.research_beaver || 'no report submitted').slice(0, 200)}
sales beaver self-report: ${JSON.stringify(beaverReports.sales_beaver || 'no report submitted').slice(0, 200)}
enforcer self-report: ${JSON.stringify(beaverReports.ranger || 'no report submitted').slice(0, 200)}

aggregated 24h: sourced ${kpis.research_beaver.sourced_24h}, drafts ${kpis.sales_beaver.drafts_24h}, sent ${kpis.sales_beaver.sent_24h}, replies ${kpis.sales_beaver.replies_24h}
meetings: ${kpis.meetings.this_week} this week, ${kpis.meetings.mtd} mtd, projecting ${kpis.meetings.mtd_pace_projected} (gap ${kpis.meetings.gap_to_target} to target ${kpis.meetings.monthly_target})

actions you took today: ${todaysActions.length === 0 ? 'none' : todaysActions.map(a => a.action).join(', ')}

═══ TOMORROW'S SETUP ═══
Surface what each beaver is working on tomorrow + any decisions queued for MJ overnight.

Write the brief now. Conversational-tight, lowercase opener, no fluff.`;

  let summary;
  try {
    const result = await callAgent('captain_orchestrator', userMessage, { clientId });
    summary = result?.brief || result?.summary || result?.raw || null;
  } catch (err) {
    console.warn('[captain] EOD brief generation failed:', err.message);
  }

  if (!summary || typeof summary !== 'string') {
    summary = renderPlainEodBrief(kpis, beaverReports, todaysActions);
  }

  return { summary, raw_kpis: kpis, beaver_reports: beaverReports, actions_taken: todaysActions };
}

function renderPlainEodBrief(k, reports, actions) {
  const lines = [
    `eod brief — ${k.tenant.name}.`,
    ``,
    `═══ system health ═══`,
    `db ${k.dam_health.db_ok ? 'ok' : 'UNREACHABLE'} · stale crons: ${k.dam_health.stale_jobs.join(', ') || 'none'}`,
    `spend today $${k.cost.llm_spend_today_usd.toFixed(4)} · mtd $${k.cost.llm_spend_mtd_usd.toFixed(2)}`,
    ``,
    `═══ today's results ═══`,
    `sourced ${k.research_beaver.sourced_24h}/${k.research_beaver.sourced_floor}, drafts ${k.sales_beaver.drafts_24h}, sent ${k.sales_beaver.sent_24h}, replies ${k.sales_beaver.replies_24h}`,
    `meetings: ${k.meetings.this_week} this week, ${k.meetings.mtd} mtd, projecting ${k.meetings.mtd_pace_projected}/${k.meetings.monthly_target}`,
    `captain actions today: ${actions?.length || 0}`,
    ``,
    `═══ tomorrow's setup ═══`,
    `(captain's llm offline — tomorrow plan in raw kpis)`,
  ];
  return lines.join('\n');
}

async function runEodBrief(clientId) {
  const brief = await generateEodBrief(clientId);
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, `eod_brief_${today}`, JSON.stringify(brief)]
  ).catch(err => console.warn('[captain] persist EOD failed:', err.message));
  return brief;
}

/* ─── Stuck-state monitor ─────────────────────────────────────────── */

/**
 * Detect stuck states across the team. Runs every hour during 09-19 MYT.
 * Triggers Captain's autonomous tactical decisions when KPIs slip.
 *
 * Returns an array of detected issues. Each issue includes a recommended
 * action — the executor (Phase 2) calls the appropriate function.
 */
async function detectStuckStates(clientId) {
  const kpis = await collectTeamKPIs(clientId);
  const issues = [];

  // Issue 1: Research Beaver is below floor by mid-day
  const utcHour = new Date().getUTCHours();
  const isMidDay = utcHour >= 4 && utcHour <= 8; // 12-16 MYT
  if (isMidDay && kpis.research_beaver.sourced_24h < kpis.research_beaver.sourced_floor * 0.5) {
    issues.push({
      severity: 'high',
      type: 'research_below_floor_midday',
      detail: `${kpis.research_beaver.sourced_24h}/${kpis.research_beaver.sourced_floor} by midday — likely strategy is dry`,
      recommended_action: 'switchResearchStrategy',
    });
  }

  // Issue 2: Sales Beaver pass-rate collapsed
  if (kpis.sales_beaver.first_attempt_pass_rate_pct !== null && kpis.sales_beaver.first_attempt_pass_rate_pct < 50) {
    issues.push({
      severity: 'high',
      type: 'sales_pass_rate_collapsed',
      detail: `first-pass at ${kpis.sales_beaver.first_attempt_pass_rate_pct}% — Enforcer rejecting heavily`,
      recommended_action: 'fireCoachingLoop',
    });
  }

  // Issue 3: Bounce rate elevated
  if (kpis.pipeline.bounces_7d >= 5) {
    issues.push({
      severity: 'high',
      type: 'bounce_rate_elevated',
      detail: `${kpis.pipeline.bounces_7d} bounces in last 7d — sender reputation at risk`,
      recommended_action: 'throttleSend',
    });
  }

  // Issue 4: VP credits exhausting
  if (kpis.vp.credits_remaining_today < 5 && kpis.vp.credits_used_today > 0) {
    issues.push({
      severity: 'medium',
      type: 'vp_credits_exhausting',
      detail: `${kpis.vp.credits_remaining_today} of ${kpis.vp.credits_budget} VP credits remain today`,
      recommended_action: 'tuneVpThreshold',
    });
  }

  // Issue 5: Stale crons
  if (kpis.dam_health.stale_jobs.length > 0) {
    issues.push({
      severity: 'critical',
      type: 'stale_crons',
      detail: `crons stale: ${kpis.dam_health.stale_jobs.join(', ')}`,
      recommended_action: 'escalateToMJ',
    });
  }

  return { issues, kpis_snapshot: kpis };
}

/* ─── Tactical execution stubs ────────────────────────────────────── */
//
// These are the calls Captain makes autonomously when stuck-state
// monitor surfaces an issue. STUB-LEVEL tonight — they log the
// decision + write to agent_memory so Sales/Research/etc see the
// directive in their next loop. Full execution (e.g. actually
// switching the Research Beaver query queue) lands in Phase 2.

const beaverState = require('./beaverState');

/**
 * Tells Sales Beaver: stop and re-read the recent rejection patterns
 * before next draft. Captain writes a coaching note Sales reads.
 */
async function fireCoachingLoop(clientId, reason) {
  await beaverState.logCaptainAction(clientId, 'fire_coaching_loop', { reason });
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'sales_beaver', $2, $3::jsonb, 'coaching')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, 'coaching_directive_active', JSON.stringify({ reason, fired_at: new Date().toISOString() })]
  );
  return { ok: true, action: 'fire_coaching_loop' };
}

/**
 * Tells Research Beaver: switch to a different strategy bucket.
 * Captain writes the directive; Research reads it on next loop.
 */
async function switchResearchStrategy(clientId, reason, suggested_strategy = null) {
  await beaverState.logCaptainAction(clientId, 'switch_research_strategy', { reason, suggested_strategy });
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'research_beaver', $2, $3::jsonb, 'directive')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, 'strategy_directive_active', JSON.stringify({ reason, suggested_strategy, fired_at: new Date().toISOString() })]
  );
  return { ok: true, action: 'switch_research_strategy' };
}

/**
 * Tightens VP threshold by N points to preserve credits.
 */
async function tuneVpThreshold(clientId, deltaPoints = 5) {
  const cfg = await tenantConfig.getTenantConfig(clientId);
  const newThreshold = Math.min(95, Math.max(50, cfg.vp_threshold_score + deltaPoints));
  await tenantConfig.setVpThreshold(clientId, newThreshold);
  await beaverState.logCaptainAction(clientId, 'tune_vp_threshold', {
    from: cfg.vp_threshold_score, to: newThreshold, delta: deltaPoints,
  });
  return { ok: true, action: 'tune_vp_threshold', from: cfg.vp_threshold_score, to: newThreshold };
}

/**
 * Throttles send pacing on bounce signal. STUB — full implementation
 * would update tenant config or send_queue worker rate limit.
 */
async function throttleSend(clientId, throttle_pct = 30) {
  await beaverState.logCaptainAction(clientId, 'throttle_send', { throttle_pct });
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'sales_beaver', $2, $3::jsonb, 'directive')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, 'send_throttle_directive', JSON.stringify({ throttle_pct, applied_at: new Date().toISOString() })]
  );
  return { ok: true, action: 'throttle_send', throttle_pct };
}

/**
 * Routes a decision to MJ via Telegram. STUB — full version composes
 * the Telegram message using Captain's voice + forced-choice format.
 */
async function escalateToMJ(clientId, decision) {
  await beaverState.logCaptainAction(clientId, 'escalate_to_mj', decision);
  // Future: fire Telegram message immediately, not wait for next brief.
  return { ok: true, action: 'escalate_to_mj' };
}

module.exports = {
  collectTeamKPIs,
  generateMorningBrief,
  persistMorningBrief,
  runMorningBrief,
  // EOD
  generateEodBrief,
  runEodBrief,
  // Stuck-state monitor
  detectStuckStates,
  // Tactical execution stubs
  fireCoachingLoop,
  switchResearchStrategy,
  tuneVpThreshold,
  throttleSend,
  escalateToMJ,
};
