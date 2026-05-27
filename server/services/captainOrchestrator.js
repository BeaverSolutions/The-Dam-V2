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
const { getMonthlyBudget } = require('./budget');
const tenantConfig = require('./tenantConfig');
const jobHealth = require('./jobHealth');
const pipelineTrace = require('./pipelineTrace');

function getLLMHealth() {
  const explicitProvider = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  const anthropicSet = !!process.env.ANTHROPIC_API_KEY;
  const openaiSet = !!process.env.OPENAI_API_KEY;
  const provider = explicitProvider || (openaiSet ? 'openai' : 'anthropic');

  return {
    provider,
    anthropic_set: anthropicSet,
    openai_set: openaiSet,
    selected_key_set: provider === 'openai' ? openaiSet : anthropicSet,
  };
}

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
       (SELECT COUNT(*)
          FROM approvals a
          JOIN messages m ON m.id = a.message_id AND m.client_id = a.client_id
          WHERE a.client_id = $1
            AND a.status IN ('pending', 'pending_approval')
            AND (
              (a.notes = 'linkedin_requested' AND m.status = 'linkedin_requested')
              OR (COALESCE(a.notes, '') <> 'linkedin_requested' AND m.status = 'pending_approval')
            )) AS pending_approvals,
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
  // Worst single-day spend this month — surfaces a runaway day (e.g. the
  // 2026-05-14 research_beaver loop, 2,202 calls / $12.86) in the brief.
  const spendMaxDayPromise = pool.query(
    `SELECT COALESCE(MAX(day_spend), 0)::numeric(10,4) AS max_day
       FROM (
         SELECT SUM(cost_usd) AS day_spend
           FROM llm_usage
          WHERE client_id = $1 AND created_at > date_trunc('month', NOW() AT TIME ZONE 'UTC')
          GROUP BY (created_at AT TIME ZONE 'UTC')::date
       ) d`,
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

  // ─── Channel-mix today (Wave 1: 30 email / 20 linkedin policy) ──
  // Splits drafted/approved/sent per channel and pairs them with the
  // per-channel targets stored on daily_kpi. This is what runDirectiveSweep
  // and the channel_mix_imbalance stuck-state check read.
  const channelMixPromise = pool.query(
    `WITH today_msgs AS (
       SELECT channel,
              COUNT(*) FILTER (WHERE created_at::date = (NOW() AT TIME ZONE 'UTC')::date) AS drafted,
              COUNT(*) FILTER (WHERE status = 'pending_approval' AND created_at::date = (NOW() AT TIME ZONE 'UTC')::date) AS pending_approval,
              COUNT(*) FILTER (WHERE status = 'approved'         AND sent_at IS NULL) AS approved_unsent,
              COUNT(*) FILTER (WHERE status = 'sent' AND COALESCE(sent_at, created_at)::date = (NOW() AT TIME ZONE 'UTC')::date) AS sent
       FROM messages
       WHERE client_id = $1
         AND created_at >= (NOW() AT TIME ZONE 'UTC')::date - INTERVAL '1 day'
       GROUP BY channel
     ),
     pool_email AS (
       SELECT COUNT(*) AS n FROM leads
       WHERE client_id = $1 AND deleted_at IS NULL
         AND pipeline_stage = 'prospecting' AND status = 'new'
         AND email IS NOT NULL
     ),
     pool_linkedin AS (
       SELECT COUNT(*) AS n FROM leads
       WHERE client_id = $1 AND deleted_at IS NULL
         AND pipeline_stage = 'prospecting' AND status = 'new'
         AND email IS NULL AND linkedin_url IS NOT NULL
     ),
     stale_approvals AS (
       SELECT
         COUNT(*) AS pending_n,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 3600.0 AS oldest_hours
       FROM approvals
       WHERE client_id = $1 AND status = 'pending'
     )
     SELECT
       COALESCE((SELECT drafted          FROM today_msgs WHERE channel = 'email'), 0)    AS email_drafted,
       COALESCE((SELECT pending_approval FROM today_msgs WHERE channel = 'email'), 0)    AS email_pending_approval,
       COALESCE((SELECT approved_unsent  FROM today_msgs WHERE channel = 'email'), 0)    AS email_approved_unsent,
       COALESCE((SELECT sent             FROM today_msgs WHERE channel = 'email'), 0)    AS email_sent,
       COALESCE((SELECT drafted          FROM today_msgs WHERE channel = 'linkedin'), 0) AS linkedin_drafted,
       COALESCE((SELECT pending_approval FROM today_msgs WHERE channel = 'linkedin'), 0) AS linkedin_pending_approval,
       COALESCE((SELECT approved_unsent  FROM today_msgs WHERE channel = 'linkedin'), 0) AS linkedin_approved_unsent,
       COALESCE((SELECT sent             FROM today_msgs WHERE channel = 'linkedin'), 0) AS linkedin_sent,
       (SELECT n FROM pool_email)    AS pool_email_ready,
       (SELECT n FROM pool_linkedin) AS pool_linkedin_only,
       (SELECT pending_n    FROM stale_approvals) AS approvals_pending_n,
       (SELECT oldest_hours FROM stale_approvals) AS approvals_oldest_hours`,
    [clientId]
  );

  const targetsPromise = pool.query(
    `SELECT COALESCE(target_email_sent, 30) AS te,
            COALESCE(target_linkedin_sent, 20) AS tl,
            COALESCE(target, 50) AS total
     FROM daily_kpi
     WHERE client_id = $1 AND date = (NOW() AT TIME ZONE 'UTC')::date
     LIMIT 1`,
    [clientId]
  );

  const [research, sales, enforcer, rejectReasons, pipeline,
         dbOk, cronHealth,
         spendToday, spendMtd, meetingsWeek, meetingsMtd,
         channelMix, targets, spendMaxDay] = await Promise.all([
    researchPromise, salesPromise, enforcerPromise, rejectReasonsPromise, pipelinePromise,
    dbCheckPromise, cronHealthPromise,
    spendTodayPromise, spendMtdPromise, meetingsThisWeekPromise, meetingsMtdPromise,
    channelMixPromise, targetsPromise, spendMaxDayPromise,
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
      ...getLLMHealth(),
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
      llm_max_day_usd: Number(spendMaxDay.rows[0].max_day) || 0,
      llm_monthly_budget_usd: getMonthlyBudget(),
      vp_credits_used_today: cfg.vp_credits_used_today,
      vp_credits_budget_today: cfg.vp_daily_budget_credits,
      daily_budget_usd: cfg.daily_budget_usd,
    },
    // ─── MEETINGS (the metric that defines success) ──
    meetings: {
      this_week: Number(meetingsWeek.rows[0].n) || 0,
      mtd: Number(meetingsMtd.rows[0].n) || 0,
      mtd_pace_projected: projectMonthEndMeetings(Number(meetingsMtd.rows[0].n) || 0),
    },
    // ─── CHANNEL MIX (Wave 1: 30 email / 20 linkedin) ──
    // Three KPIs per channel — drafted (kickoff's job), approved (MJ's job),
    // sent (send queue's job). Captain alerts differently for each.
    channel_mix: {
      target_email_sent:    Number(targets.rows[0]?.te) || 30,
      target_linkedin_sent: Number(targets.rows[0]?.tl) || 20,
      email: {
        drafted:           Number(channelMix.rows[0].email_drafted) || 0,
        pending_approval:  Number(channelMix.rows[0].email_pending_approval) || 0,
        approved_unsent:   Number(channelMix.rows[0].email_approved_unsent) || 0,
        sent:              Number(channelMix.rows[0].email_sent) || 0,
      },
      linkedin: {
        drafted:           Number(channelMix.rows[0].linkedin_drafted) || 0,
        pending_approval:  Number(channelMix.rows[0].linkedin_pending_approval) || 0,
        approved_unsent:   Number(channelMix.rows[0].linkedin_approved_unsent) || 0,
        sent:              Number(channelMix.rows[0].linkedin_sent) || 0,
      },
      pool_email_ready:    Number(channelMix.rows[0].pool_email_ready) || 0,
      pool_linkedin_only:  Number(channelMix.rows[0].pool_linkedin_only) || 0,
      approvals_pending:   Number(channelMix.rows[0].approvals_pending_n) || 0,
      approvals_oldest_hours: Number(channelMix.rows[0].approvals_oldest_hours) || 0,
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

  // Wave 2 (2026-05-03): pull each beaver's most recent self-report so the
  // brief quotes what the team thinks of itself, not just our derived numbers.
  let beaverSelfReports = '';
  try {
    const introspection = require('./introspection');
    const reports = await introspection.latestPerBeaver(clientId);
    if (reports.length > 0) {
      beaverSelfReports = '\n\nBEAVER SELF-REPORTS (each beaver\'s most recent self-assessment — quote verbatim where useful):\n' +
        reports.map(r => `- ${r.agent}: ${r.summary}${r.blockers ? ` BLOCKER: ${r.blockers}` : ''}`).join('\n');
    }
  } catch { /* non-critical */ }

  // ── Pre-compute interpretation flags so the LLM can't misread raw numbers ──
  // (Yesterday's brief said "VP credits exhausted (0 of 25)" — wrong, 0 USED.
  //  Said "Research Beaver flatlined" — wrong, gated by 735-lead pool.)
  const vpRemaining = Math.max(0, kpis.vp.credits_budget - kpis.vp.credits_used_today);
  const vpStatus = kpis.vp.credits_used_today === 0
    ? `unused today (${kpis.vp.credits_budget} credits available)`
    : vpRemaining === 0
      ? `EXHAUSTED — all ${kpis.vp.credits_budget} credits spent today, blocks new enrichment`
      : vpRemaining < 5
        ? `low — ${vpRemaining} of ${kpis.vp.credits_budget} remaining today`
        : `${vpRemaining} of ${kpis.vp.credits_budget} remaining today (used ${kpis.vp.credits_used_today})`;

  // Research Beaver context: sourced 0 != "flatlined" if pool is big.
  // Cold research is gated when pool >= 5 (server/routes/autonomous.js:1325).
  const researchStatus = kpis.research_beaver.pool_size >= 100
    ? `idle by design — pool has ${kpis.research_beaver.pool_size} leads, sourcing gated until pool drains`
    : kpis.research_beaver.sourced_24h >= kpis.research_beaver.sourced_floor
      ? `on target (sourced ${kpis.research_beaver.sourced_24h} of ${kpis.research_beaver.sourced_floor} floor)`
      : kpis.research_beaver.sourced_24h === 0
        ? `DORMANT — 0 sourced in 24h despite pool low (${kpis.research_beaver.pool_size} leads). Investigate.`
        : `BELOW FLOOR — sourced ${kpis.research_beaver.sourced_24h} of ${kpis.research_beaver.sourced_floor}`;

  // Sales status: "0 sent" is fine if drafts_24h is high (waiting on approval).
  const salesStatus = kpis.sales_beaver.drafts_24h === 0 && kpis.sales_beaver.sent_24h === 0
    ? `idle (0 drafts, 0 sent in 24h)`
    : kpis.sales_beaver.sent_24h === 0
      ? `${kpis.sales_beaver.drafts_24h} drafts written, 0 sent — pipeline waiting on approval/send`
      : `${kpis.sales_beaver.drafts_24h} drafts, ${kpis.sales_beaver.sent_24h} sent, ${kpis.sales_beaver.replies_24h} replies (${kpis.sales_beaver.first_attempt_pass_rate_pct ?? '—'}% first-pass)`;

  // Enforcer status. A low approve rate is NOT automatically "calibration".
  // If rejections are hard-gate failures (fabrication, sign-off, banned phrase)
  // the copy is bad and lowering the threshold will not help — read the reasons.
  const topReject = kpis.enforcer.top_reject_reasons?.[0]?.reason || '';
  const hardGateReject = /hard gate|fabricat|sign-?off|banned|wrong company|not (present|in).{0,24}lead context|no verifiable/i.test(topReject);
  const enforcerStatus = kpis.enforcer.reviews_24h === 0
    ? `idle (no reviews in 24h)`
    : kpis.enforcer.approve_rate_pct < 30
      ? (hardGateReject
          ? `DRAFT QUALITY FAILURE: ${kpis.enforcer.approve_rate_pct}% approve on ${kpis.enforcer.reviews_24h} reviews. Rejections are hard-gate failures (top: "${topReject}"). This is a COPY problem, NOT Enforcer calibration. Lowering the auto-approve threshold will NOT help — fix the Sales Beaver draft.`
          : `OVER-RESTRICTIVE: ${kpis.enforcer.approve_rate_pct}% approve on ${kpis.enforcer.reviews_24h} reviews. Rejections cluster just below threshold (top: "${topReject || 'mixed'}") — likely a calibration issue.`)
      : kpis.enforcer.approve_rate_pct < 60
        ? `tight: ${kpis.enforcer.approve_rate_pct}% approve on ${kpis.enforcer.reviews_24h} reviews. Top reject: ${topReject || 'mixed'}.`
        : `healthy: ${kpis.enforcer.approve_rate_pct}% approve on ${kpis.enforcer.reviews_24h} reviews.`;

  const overallHealth = (kpis.dam_health.db_ok && kpis.dam_health.encryption_key_ok && kpis.dam_health.stale_jobs.length === 0)
    ? 'green'
    : kpis.dam_health.stale_jobs.length > 0 || !kpis.dam_health.gmail_oauth_set
      ? 'amber'
      : 'degraded';

  // ── Phase 1 (2026-05-08): pipeline_traces funnel — replaces metadata-mining
  // workaround. Aggregates today's kickoffs (KL timezone) across stages and
  // surfaces silent-drop count + Enforcer approve rate as anomaly flags.
  // The 2026-05-08 17:37 MYT incident (95% silent drop, 56 leads vanished
  // uninstrumented) is exactly the shape this section now exposes.
  let funnelStatus = 'no kickoffs traced today (Phase 1 instrumentation deploys with this brief)';
  let funnelDetailLine = '';
  let funnelAnomalyFlag = '';
  try {
    const todayFunnel = await pipelineTrace.getTodayFunnel(clientId);
    if (todayFunnel.length > 0) {
      const stageCounts = {};
      const kickoffs = new Set();
      for (const row of todayFunnel) {
        stageCounts[row.stage] = (stageCounts[row.stage] || 0) + Number(row.cnt);
        if (row.kickoff_id) kickoffs.add(row.kickoff_id);
      }
      const enrolled = stageCounts.enrolled || 0;
      const icpRej = stageCounts.icp_rejected || 0;
      const drafted = stageCounts.drafted || 0;
      const draftFailed = stageCounts.draft_failed || 0;
      const reviewed = stageCounts.reviewed || 0;
      const approved = stageCounts.approved || 0;
      const rejected = stageCounts.rejected || 0;
      const sent = stageCounts.sent || 0;
      const replied = stageCounts.replied || 0;
      // Silent drop = leads enrolled but neither drafted, draft_failed, nor icp_rejected.
      // After Phase 1 full instrumentation, this should be ~0. If non-zero, an exit
      // path is uninstrumented or a new bug emerged.
      const silentDrop = Math.max(0, enrolled - drafted - draftFailed - icpRej);
      const draftRate = enrolled > 0 ? Math.round(((drafted + draftFailed) / Math.max(1, enrolled - icpRej)) * 100) : null;
      const approveRate = reviewed > 0 ? Math.round((approved / reviewed) * 100) : null;
      const sendRate = approved > 0 ? Math.round((sent / approved) * 100) : null;
      const replyRate = sent > 0 ? Math.round((replied / sent) * 100) : null;

      funnelStatus = `${kickoffs.size} kickoff(s) today: ${enrolled} enrolled → ${icpRej} icp-rej → ${drafted} drafted (${draftFailed} failed) → ${reviewed} reviewed → ${approved} approved → ${sent} sent → ${replied} replied`;

      funnelDetailLine = `enrolled ${enrolled} · icp-rej ${icpRej} · drafted ${drafted} (${draftRate ?? '—'}% post-icp) · draft-failed ${draftFailed} · reviewed ${reviewed} · approved ${approved} (${approveRate ?? '—'}% of reviewed) · sent ${sent} (${sendRate ?? '—'}% of approved) · replied ${replied} (${replyRate ?? '—'}% of sent)`;

      const anomalies = [];
      if (silentDrop > Math.max(2, enrolled * 0.05)) {
        anomalies.push(`SILENT-DROP ${silentDrop} of ${enrolled} (${Math.round((silentDrop / enrolled) * 100)}%) — uninstrumented exit path`);
      }
      if (approveRate !== null && approveRate < 30 && reviewed >= 5) {
        anomalies.push(`Enforcer approve ${approveRate}% on ${reviewed} reviews — ${hardGateReject ? 'hard-gate draft-quality failures (fix the copy, not the threshold)' : 'calibration drift'}`);
      }
      if (sendRate !== null && sendRate < 50 && approved >= 5) {
        anomalies.push(`send rate ${sendRate}% — approved-not-sent backlog growing`);
      }
      if (anomalies.length > 0) {
        funnelAnomalyFlag = ' ⚠️ ' + anomalies.join('; ');
      }
    }
  } catch (err) {
    console.warn('[captain] funnel pull failed:', err.message);
  }

  // ── Phase 5.5: Monday Plan of the Week injection ──────────────────────
  // On Monday (UTC day 1), load Sunday's weekly plan from agent_memory and
  // prepend it to the brief. Gives MJ the week framing before the daily ops.
  let weeklyPlanSection = '';
  try {
    if (new Date().getUTCDay() === 1) { // Monday
      const lastSunday = new Date();
      lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
      const day = lastSunday.getUTCDay();
      const diff = (day + 6) % 7;
      lastSunday.setUTCDate(lastSunday.getUTCDate() - diff);
      const weekStart = lastSunday.toISOString().slice(0, 10);

      const { rows: planRows } = await pool.query(
        `SELECT content FROM agent_memory
         WHERE client_id = $1 AND agent = 'captain_orchestrator' AND key = $2 LIMIT 1`,
        [clientId, `weekly_plan_${weekStart}`]
      );
      if (planRows[0]?.content?.summary) {
        weeklyPlanSection = `\n\n${planRows[0].content.summary}`;
      }
    }
  } catch { /* non-critical */ }

  const userMessage = `Compose this morning's brief for ${kpis.tenant.name}. Three sections, plain text + HTML, EXACTLY this format. Lead with overall health verdict in the SYSTEM HEALTH first sentence.${weeklyPlanSection ? '\n\nPREPEND this Plan of the Week BEFORE the SYSTEM HEALTH section (it is Monday):\n' + weeklyPlanSection : ''}

PRE-INTERPRETED STATUS (use these labels — do NOT re-interpret raw numbers below):
- Overall: ${overallHealth}
- VP: ${vpStatus}
- Research Beaver: ${researchStatus}
- Sales Beaver: ${salesStatus}
- Enforcer: ${enforcerStatus}
- Pipeline funnel: ${funnelStatus}${funnelAnomalyFlag}

<b>SYSTEM HEALTH</b>
DB: ${kpis.dam_health.db_ok ? 'connected' : 'UNREACHABLE'} · Encryption: ${kpis.dam_health.encryption_key_ok ? 'valid' : 'MISSING'}
API keys: llm ${kpis.dam_health.provider} ${kpis.dam_health.selected_key_set ? 'set' : 'MISSING'}, anthropic ${kpis.dam_health.anthropic_set ? 'set' : 'MISSING'}, openai ${kpis.dam_health.openai_set ? 'set' : 'MISSING'}, brave ${kpis.dam_health.brave_set ? 'set' : 'MISSING'}, vp ${kpis.dam_health.vp_set ? 'set' : 'MISSING'}, gmail-oauth ${kpis.dam_health.gmail_oauth_set ? 'set' : 'MISSING'}
Stale crons: ${kpis.dam_health.stale_jobs.length === 0 ? 'none — all firing' : kpis.dam_health.stale_jobs.join(', ')}
LLM spend: $${kpis.cost.llm_spend_today_usd.toFixed(4)} today · $${kpis.cost.llm_spend_mtd_usd.toFixed(2)} mtd / $${kpis.cost.llm_monthly_budget_usd.toFixed(2)} monthly cap${kpis.cost.llm_spend_mtd_usd >= kpis.cost.llm_monthly_budget_usd ? ' — OVER BUDGET' : kpis.cost.llm_spend_mtd_usd >= kpis.cost.llm_monthly_budget_usd * 0.8 ? ' — 80%+ of cap' : ''}${kpis.cost.llm_max_day_usd >= kpis.cost.llm_monthly_budget_usd * 0.2 ? ` · worst day $${kpis.cost.llm_max_day_usd.toFixed(2)} (SPIKE)` : ''}
VP: ${vpStatus}

<b>SITUATION REPORT</b> (last 24h)
Research Beaver: ${researchStatus}. Avg quality ${kpis.research_beaver.scored_avg ?? '—'}, top ${kpis.research_beaver.top_quality_score ?? '—'}, ${kpis.research_beaver.strategies_used} strategies in use.
Sales Beaver: ${salesStatus}.
Enforcer: ${enforcerStatus}
Pipeline: ${kpis.pipeline.pending_approvals} pending MJ, ${kpis.pipeline.approved_unsent_linkedin} LinkedIn unsent, ${kpis.pipeline.approved_unsent_email} email unsent, ${kpis.pipeline.bounces_7d} bounces 7d.
Funnel today (pipeline_traces — Phase 1): ${funnelDetailLine || 'no traced kickoffs yet today'}.${funnelAnomalyFlag ? ' Anomaly:' + funnelAnomalyFlag.replace(' ⚠️ ', ' ') : ''}
Meetings: ${kpis.meetings.this_week} this week, ${kpis.meetings.mtd} mtd, projecting ${kpis.meetings.mtd_pace_projected} by month-end.

<b>ORDERS OF THE DAY</b>
TASKS — what each beaver works on today, 1-2 lines.
ACTIONS TAKEN — autonomous calls overnight, 1 line if anything.
NEEDS YOUR CALL — forced-choice decisions for MJ, numbered. "nothing needs your call today." if none.
${beaverSelfReports}

<b>CHANNEL MIX</b> (today's progress)
Email: ${kpis.channel_mix.email.sent}/${kpis.channel_mix.target_email_sent} sent (${kpis.channel_mix.email.drafted} drafted) · Pool email-ready: ${kpis.channel_mix.pool_email_ready}
LinkedIn: ${kpis.channel_mix.linkedin.sent}/${kpis.channel_mix.target_linkedin_sent} sent (${kpis.channel_mix.linkedin.drafted} drafted) · Pool linkedin-only: ${kpis.channel_mix.pool_linkedin_only}

Write the brief now. Use the PRE-INTERPRETED STATUS labels above; do not re-narrate the raw numbers. Where a beaver self-report is sharp, quote it. NO json wrapper, NO code fences, NO "═══" separators. Single blank line between sections.`;

  let summary;
  try {
    const result = await callAgent('captain_orchestrator', userMessage, { clientId });
    summary = extractBriefText(result);
  } catch (err) {
    console.warn('[captain] brief generation failed:', err.message);
    summary = null;
  }

  // Fallback: if LLM fails, return a structured plain-text brief so MJ
  // never gets a silent morning. Better degraded than missing.
  if (!summary || typeof summary !== 'string' || summary.trim().length < 20) {
    summary = renderPlainBrief(kpis);
  }

  return { summary: sanitizeForTelegram(summary), raw_kpis: kpis };
}

/**
 * Extract Telegram-ready text from whatever shape callAgent returned.
 * Sonnet sometimes wraps the brief in JSON ({brief: "..."}) even when the
 * prompt asks for plain text. Sometimes callAgent's parse leaves the raw
 * pretty-printed JSON in {raw: "..."}. Handle every case here so the
 * callsite doesn't have to care.
 */
function extractBriefText(result) {
  if (result == null) return null;
  if (typeof result === 'string') return unwrapBriefString(result);

  // Common shapes: {brief}, {summary}, {text}, {message}, {content}, {raw}
  const candidates = [
    result.brief, result.summary, result.text,
    result.message, result.content, result.raw,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return unwrapBriefString(c);
    }
  }
  // Object with no recognized key — last resort: stringify so MJ at least
  // sees something and we can debug from the message body.
  return null;
}

/**
 * If a string is JSON-looking, parse it and re-extract. Strip code fences.
 * Convert literal \n / \\n escapes to real newlines.
 */
function unwrapBriefString(s) {
  let out = String(s);
  // Strip code fences if Sonnet added them
  out = out.replace(/^```(?:json|html|text)?\s*/i, '').replace(/```\s*$/i, '');
  out = out.trim();

  // Path 1: well-formed JSON object/string wrapping the brief — unwrap.
  if ((out.startsWith('{') && out.endsWith('}')) ||
      (out.startsWith('"') && out.endsWith('"'))) {
    try {
      const parsed = JSON.parse(out);
      if (typeof parsed === 'string') {
        out = parsed;
      } else if (parsed && typeof parsed === 'object') {
        const inner = parsed.brief ?? parsed.summary ?? parsed.text ?? parsed.message ?? parsed.content;
        if (typeof inner === 'string' && inner.trim()) out = inner;
      }
    } catch { /* not valid JSON, fall through to path 2 */ }
  }

  // Path 2: TRUNCATED JSON (LLM hit maxTokens mid-string) — regex-extract
  // the brief field. Looks for "brief"|"summary"|"text" key followed by
  // a string value. Stops at the next unescaped quote — handles brief
  // content that ends mid-sentence cleanly.
  if (out.startsWith('{')) {
    const m = out.match(/"(?:brief|summary|text|message|content)"\s*:\s*"((?:[^"\\]|\\.)*)$/);
    if (m && m[1]) {
      out = m[1];
    } else {
      // Try a non-greedy match that allows partial closure
      const m2 = out.match(/"(?:brief|summary|text|message|content)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m2 && m2[1]) out = m2[1];
    }
  }

  // Convert any leftover literal \n escapes to real newlines (defensive)
  if (out.includes('\\n')) out = out.replace(/\\n/g, '\n');
  if (out.includes('\\"')) out = out.replace(/\\"/g, '"');
  if (out.includes('\\\\')) out = out.replace(/\\\\/g, '\\');

  return out.trim();
}

/**
 * Final scrub before sending to Telegram. Removes the visual-noise
 * artifacts the prompt asked the LLM to avoid but which sneak through:
 *   - "═══..." or "===..." separator lines
 *   - "---..." separator lines
 *   - Multiple consecutive blank lines collapsed to one
 */
function sanitizeForTelegram(s) {
  if (!s) return s;
  let out = String(s);
  // Drop separator-only lines (3+ of these chars and nothing else)
  out = out.replace(/^[ \t]*[═=─-]{3,}[ \t]*$/gm, '');
  // Drop "═══ FOO ═══" decorations — keep only the inner label, bolded
  out = out.replace(/[═=─-]{3,}\s*([^═=─\n]+?)\s*[═=─-]{3,}/g, (_, label) => `<b>${label.trim()}</b>`);
  // Collapse 3+ newlines to 2
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
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
    `<b>SYSTEM HEALTH</b>`,
    `db ${k.dam_health.db_ok ? 'ok' : 'UNREACHABLE'} · enc-key ${k.dam_health.encryption_key_ok ? 'valid' : 'MISSING'} · crons ${k.dam_health.stale_jobs.length === 0 ? 'all firing' : 'STALE: ' + k.dam_health.stale_jobs.join(', ')}`,
    `spend $${k.cost.llm_spend_today_usd.toFixed(4)} today · $${k.cost.llm_spend_mtd_usd.toFixed(2)}/$${k.cost.llm_monthly_budget_usd.toFixed(2)} mtd${k.cost.llm_spend_mtd_usd >= k.cost.llm_monthly_budget_usd ? ' OVER BUDGET' : k.cost.llm_spend_mtd_usd >= k.cost.llm_monthly_budget_usd * 0.8 ? ' (80%+)' : ''} · vp credits ${k.cost.vp_credits_used_today}/${k.cost.vp_credits_budget_today}`,
    ``,
    `<b>SITUATION REPORT</b>`,
    `research beaver: ${k.research_beaver.sourced_24h}/${k.research_beaver.sourced_floor} sourced ${k.research_beaver.meeting_floor ? '(on target)' : '(BELOW FLOOR)'}, avg quality ${k.research_beaver.scored_avg ?? '—'}, pool ${k.research_beaver.pool_size}`,
    `sales beaver: ${k.sales_beaver.drafts_24h} drafts, ${k.sales_beaver.first_attempt_pass_rate_pct ?? '—'}% first-pass, ${k.sales_beaver.sent_24h} sent, ${k.sales_beaver.replies_24h} replies`,
    `enforcer: ${k.enforcer.approve_rate_pct ?? '—'}% approve, top reject: ${k.enforcer.top_reject_reasons[0]?.reason || 'none'}`,
    `pipeline: ${k.pipeline.pending_approvals} pending you, ${k.pipeline.approved_unsent_linkedin} linkedin unsent, ${k.pipeline.approved_unsent_email} email unsent, ${k.pipeline.bounces_7d} bounces 7d`,
    `meetings: ${k.meetings.this_week} this week, ${k.meetings.mtd} mtd, projecting ${k.meetings.mtd_pace_projected} by month-end`,
    ``,
    `<b>ORDERS OF THE DAY</b>`,
    `(captain's llm offline — fallback brief. plan: clear ${k.pipeline.pending_approvals} pending approvals, hit ${k.research_beaver.sourced_floor} quality leads, watch bounces.)`,
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

  // Wave 2 (2026-05-03): pull each beaver's most recent introspection self-report
  // + Captain's directive landing report (did the directives Captain wrote actually
  // move the metric?) + 14d cost-per-outcome rollup. Feeds the full feedback loop.
  let beaverSelfReports = '';
  let directiveLanding = '';
  let costRollup = '';
  try {
    const introspection = require('./introspection');
    const reports = await introspection.latestPerBeaver(clientId);
    if (reports.length > 0) {
      beaverSelfReports = '\n\nINTROSPECTION (each beaver\'s latest self-report):\n' +
        reports.map(r => `- ${r.agent}: ${r.summary}${r.blockers ? ` BLOCKER: ${r.blockers}` : ''}`).join('\n');
    }
    const landing = await introspection.directiveLandingReport(clientId, 24);
    const consumedRows = landing.filter(d => d.directive_status === 'consumed');
    const expiredRows  = landing.filter(d => d.directive_status === 'expired');
    if (landing.length > 0) {
      directiveLanding = `\n\nDIRECTIVE LANDING (24h): ${landing.length} written, ${consumedRows.length} consumed, ${expiredRows.length} expired unread.`;
    }
    const outcomeCost = require('./outcomeCost');
    const rollup = await outcomeCost.costPerOutcomeByChannel(clientId, 14);
    const summaryLine = outcomeCost.formatRollupForBrief(rollup);
    if (summaryLine) costRollup = `\n\nCOST PER OUTCOME (the ROI metric): ${summaryLine}`;
  } catch { /* non-critical */ }

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
channel mix today: email ${kpis.channel_mix.email.sent}/${kpis.channel_mix.target_email_sent} sent, linkedin ${kpis.channel_mix.linkedin.sent}/${kpis.channel_mix.target_linkedin_sent} sent
meetings: ${kpis.meetings.this_week} this week, ${kpis.meetings.mtd} mtd, projecting ${kpis.meetings.mtd_pace_projected} by month-end

actions you took today: ${todaysActions.length === 0 ? 'none' : todaysActions.map(a => a.action).join(', ')}${beaverSelfReports}${directiveLanding}${costRollup}

═══ TOMORROW'S SETUP ═══
Surface what each beaver is working on tomorrow + any decisions queued for MJ overnight. If channel mix missed targets, name what needs to change tomorrow (research focus, send pacing, your approval cadence).

Write the brief now. Conversational-tight, lowercase opener, no fluff.`;

  let summary;
  try {
    const result = await callAgent('captain_orchestrator', userMessage, { clientId });
    // Use the same unwrapper as the morning brief — handles ```json code
    // fences and nested {brief|summary|text} JSON envelopes from Sonnet.
    // (Bug 2026-05-02: this used to be a raw property fallback chain which
    //  leaked the entire JSON envelope to Telegram when the model wrapped
    //  output in markdown code fences.)
    summary = extractBriefText(result);
  } catch (err) {
    console.warn('[captain] EOD brief generation failed:', err.message);
  }

  if (!summary || typeof summary !== 'string' || summary.trim().length < 20) {
    summary = renderPlainEodBrief(kpis, beaverReports, todaysActions);
  }

  return {
    summary: sanitizeForTelegram(summary),
    raw_kpis: kpis,
    beaver_reports: beaverReports,
    actions_taken: todaysActions,
  };
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
    `meetings: ${k.meetings.this_week} this week, ${k.meetings.mtd} mtd, projecting ${k.meetings.mtd_pace_projected} by month-end`,
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

/* ─── Captain-led follow-up planning (2026-05-11) ─────────────────── */

/**
 * The 10 cold-start angle templates Captain rotates through for the first 50
 * sent follow-ups (then overlaid with learned signal from shared/followup_learnings).
 *
 * Source: projects/beavrdam-rebuild/ANGLE-TEMPLATE-LIBRARY.md
 */
const ANGLE_TEMPLATES = [
  { id: 1, name: 'Hiring Signal', when_use: 'Lead\'s company posted a relevant role (BD/Sales/Marketing) in last 30 days', best_touches: [2, 3] },
  { id: 2, name: 'Founder-Doing-Outbound', when_use: 'Lead is founder/CEO at company under 20 staff', best_touches: [2] },
  { id: 3, name: 'Industry Contrarian', when_use: 'Lead is in vertical with clear pattern', best_touches: [3, 4] },
  { id: 4, name: 'Recent Company News', when_use: 'Verifiable recent event (funding, partnership, launch, exec hire)', best_touches: [2, 3] },
  { id: 5, name: 'Role-Specific Question', when_use: 'Title suggests clear pain (Head of Growth, CRO, VP Sales)', best_touches: [2] },
  { id: 6, name: 'Peer Reference', when_use: 'Real peer comparison available; no fabrication', best_touches: [3, 4] },
  { id: 7, name: 'Market Shift', when_use: 'Macro shift in vertical (AI adoption, hiring freeze, regulation)', best_touches: [4, 5] },
  { id: 8, name: 'Timing Check', when_use: 'Default safe angle — short, low pressure', best_touches: [3, 5] },
  { id: 9, name: 'Break-up', when_use: 'Touch 5 ALWAYS — planned exit', best_touches: [5] },
  { id: 10, name: 'Re-awaken', when_use: 'Touch 6 ONLY — requires NEW context (post/hire/news)', best_touches: [6] },
];

/**
 * Generate Captain's follow-up plan for today.
 *
 * One Sonnet call analyzes ALL due follow-ups in a single batch — gives Sonnet
 * the full context of every lead's history so it can propose distinct angles
 * (not the same template for every lead in the same segment).
 *
 * Returns: { date, total_due, planned, skipped, leads: [{lead_id, lead_name, company, touch_number, channel, proposed_angle, angle_template_id, reason, skip}] }
 */
async function planFollowUps(clientId) {
  const followupSequence = require('./followupSequence');
  const today = new Date().toISOString().slice(0, 10);

  // 1. Load all due follow-ups with full context
  const dueWithContext = await followupSequence.getDueFollowUpsWithContext(clientId);

  if (dueWithContext.length === 0) {
    const emptyPlan = {
      date: today,
      total_due: 0,
      planned: 0,
      skipped: 0,
      leads: [],
      summary: 'No follow-ups due today.',
    };
    await persistFollowUpPlan(clientId, emptyPlan);
    return emptyPlan;
  }

  // 2. Auto-skip leads with thin context (no fabrication possible)
  const planned = [];
  const skipped = [];
  for (const item of dueWithContext) {
    const company = (item.lead.company || '').trim();
    const thinCompany = !company || /^(unknown|independent|n\/a|self[- ]?employed|freelanc|stealth|confidential|-)$/i.test(company);
    if (thinCompany) {
      skipped.push({
        lead_id: item.lead_id,
        lead_name: item.lead.name,
        company: item.lead.company || 'Unknown',
        touch_number: item.touch_number,
        skip: true,
        skip_reason: 'Thin context — no real company name. Cannot write non-fabricated follow-up.',
      });
    } else {
      planned.push(item);
    }
  }

  // 3. If everything was skipped, persist + return early
  if (planned.length === 0) {
    const planObj = {
      date: today,
      total_due: dueWithContext.length,
      planned: 0,
      skipped: skipped.length,
      leads: skipped,
      summary: `${skipped.length} follow-ups due, all skipped (thin context).`,
    };
    await persistFollowUpPlan(clientId, planObj);
    return planObj;
  }

  // 4. Pull learning context — bias proposals toward winning templates
  let learningsBlock = '';
  try {
    const { summarizeFollowUpLearnings } = require('./learningEngine');
    learningsBlock = await summarizeFollowUpLearnings(clientId);
  } catch (e) { /* non-critical */ }

  // 5. Sonnet batch call: propose an angle per planned lead
  const userMessage = `You are Captain Beaver planning today's follow-up batch. For EACH lead below, choose ONE angle from the template library and write a specific per-lead angle directive that Sales Beaver will execute.

${learningsBlock ? `LEARNING CONTEXT (use this to bias your angle selection):\n${learningsBlock}\n\n` : ''}ANGLE TEMPLATE LIBRARY (pick one per lead):
${ANGLE_TEMPLATES.map(t => `${t.id}. ${t.name} — ${t.when_use} (best at touches ${t.best_touches.join(',')})`).join('\n')}

HARD RULES (binding):
- Touch 5 ALWAYS = template 9 (Break-up). No exceptions.
- Touch 6 ALWAYS = template 10 (Re-awaken) IF new context exists in lead.signal/notes/metadata. If no new context, skip the lead.
- Never reuse the same angle template the lead has received in a previous message (check previous_messages.metadata.angle_template_id if present).
- Anti-fabrication absolute: if you cite a hiring signal, funding, etc., it MUST appear in lead.signal or lead.notes. Do NOT invent.
- The proposed_angle must be SPECIFIC to this lead — not a generic template instruction. Reference what you actually know.
- If you cannot find a non-fabricated angle for a lead, mark skip=true with skip_reason.

LEADS TO PLAN (${planned.length}):
${JSON.stringify(planned.map(p => ({
  lead_id: p.lead_id,
  lead_name: p.lead.name,
  title: p.lead.title,
  company: p.lead.company,
  industry: p.lead.industry,
  signal: p.lead.signal,
  notes: p.lead.notes,
  touch_number: p.touch_number,
  previous_message_summaries: p.previous_messages.map(m => ({
    channel: m.channel,
    subject: m.subject,
    body_preview: (m.body || '').substring(0, 200),
  })),
  rejection_history_count: p.rejection_history.length,
})), null, 2)}

Return JSON ONLY in this exact shape:
{
  "leads": [
    {
      "lead_id": "uuid",
      "lead_name": "...",
      "company": "...",
      "touch_number": N,
      "channel": "email|linkedin",
      "proposed_angle": "Specific 1-2 sentence angle directive Sales Beaver must follow",
      "angle_template_id": 1-10,
      "reason": "Why this angle for this lead (one sentence)",
      "skip": false
    }
  ]
}`;

  let proposals;
  try {
    const result = await callAgent('captain_orchestrator', userMessage, { clientId });
    // Unwrap potential markdown code fence
    const raw = typeof result === 'string' ? result : (result?.brief || result?.summary || result?.text || JSON.stringify(result));
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    proposals = JSON.parse(cleaned);
  } catch (err) {
    console.warn('[captain] plan generation failed:', err.message);
    // Fallback: use default template per touch number
    proposals = {
      leads: planned.map(p => ({
        lead_id: p.lead_id,
        lead_name: p.lead.name,
        company: p.lead.company,
        touch_number: p.touch_number,
        channel: p.previous_messages[0]?.channel || 'email',
        proposed_angle: `Default template fallback — Captain LLM unavailable. Touch ${p.touch_number} standard instruction.`,
        angle_template_id: p.touch_number === 5 ? 9 : p.touch_number === 6 ? 10 : 8,
        reason: 'Captain LLM unavailable, fallback to safe default',
        skip: false,
      })),
    };
  }

  const planObj = {
    date: today,
    total_due: dueWithContext.length,
    planned: proposals.leads.filter(l => !l.skip).length,
    skipped: skipped.length + proposals.leads.filter(l => l.skip).length,
    leads: [...proposals.leads, ...skipped],
    summary: `${proposals.leads.filter(l => !l.skip).length} planned, ${skipped.length + proposals.leads.filter(l => l.skip).length} skipped of ${dueWithContext.length} due.`,
  };

  await persistFollowUpPlan(clientId, planObj);
  return planObj;
}

async function persistFollowUpPlan(clientId, plan) {
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, `followup_plan_${plan.date}`, JSON.stringify(plan)]
  );
}

/**
 * Format the follow-up plan for Telegram delivery.
 * Concise summary if >10 items (redirect to web app), full detail if <=10.
 */
function formatPlanForTelegram(plan) {
  if (plan.total_due === 0) return '📋 No follow-ups due today.';

  const planned = plan.leads.filter(l => !l.skip);
  const skipped = plan.leads.filter(l => l.skip);

  // Per MJ rule: >10 → redirect to web app
  if (planned.length > 10) {
    return `📋 <b>Follow-up Plan — ${plan.date}</b>\n\n${planned.length} follow-ups planned, ${skipped.length} skipped (${plan.total_due} due total).\n\nReview and approve in the BeavrDam app — too many for Telegram batch.\n\nReply <code>approve all</code> to greenlight Captain's angles as-is, or use the web app to review per-lead.`;
  }

  const lines = [`📋 <b>Follow-up Plan — ${plan.date}</b>`, ''];
  lines.push(`<b>${planned.length} planned · ${skipped.length} skipped · ${plan.total_due} due total</b>`);
  lines.push('');

  planned.forEach((lead, idx) => {
    lines.push(`<b>${idx + 1}. ${lead.company} — ${lead.lead_name}</b> (Touch ${lead.touch_number}, ${lead.channel})`);
    lines.push(`Angle: ${lead.proposed_angle}`);
    if (lead.reason) lines.push(`<i>Why: ${lead.reason}</i>`);
    lines.push('');
  });

  if (skipped.length > 0) {
    lines.push('<b>Skipped:</b>');
    skipped.forEach(s => {
      lines.push(`• ${s.company} — ${s.lead_name}: ${s.skip_reason || 'skipped by Captain'}`);
    });
    lines.push('');
  }

  lines.push(`Reply <code>approve all</code> to execute all angles, or specify changes per lead.`);
  return lines.join('\n');
}

/**
 * Run the daily follow-up planning routine: plan + Telegram dispatch.
 * Called by the daily cron at 09:00 MYT after the morning brief.
 */
async function runFollowUpPlanning(clientId) {
  const plan = await planFollowUps(clientId);
  const telegram = require('./telegram');
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (chatId && plan.total_due > 0) {
    const message = formatPlanForTelegram(plan);
    await telegram.sendMessage(chatId, message).catch(err =>
      console.warn('[captain] follow-up plan Telegram send failed:', err.message)
    );
  }
  return plan;
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

  // Issues 6-8: Channel-mix imbalance (Wave 1, 2026-05-03).
  // Three distinct alert types — see buildChannelMixIssues comments.
  // The hourly cron in index.js dedupes by issue type per hour already;
  // we further dedupe per day inside the cron handler before firing Telegram
  // to respect MJ's "morning brief / EOD / impromptu only" notification policy.
  for (const issue of buildChannelMixIssues(kpis)) {
    issues.push(issue);
  }

  // Issue 9 (Jules F-07): sourcing flatlined. The system used to "flatline
  // silently" — Brave 402 / pool starvation / VP failure produced zero leads
  // for days with no alert. Fire ONLY when the system is actively trying and
  // failing (>=3 dry-run signals in 4h) AND no leads landed in 6h — so a quiet
  // night or a fresh tenant never trips it. Per-day dedupe handled by the cron.
  if (utcHour >= 1 && utcHour <= 11) {
    try {
      const { rows: src } = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM leads WHERE client_id = $1 AND created_at > NOW() - INTERVAL '6 hours') AS leads_6h,
           (SELECT COUNT(*) FROM logs  WHERE client_id = $1 AND created_at > NOW() - INTERVAL '4 hours'
              AND action IN ('research_no_results','kickoff_zero_output','vp_rescue_empty','research_pool_exhausted')) AS dry_4h`,
        [clientId]
      );
      const leads6h = parseInt(src[0]?.leads_6h || 0, 10);
      const dry4h = parseInt(src[0]?.dry_4h || 0, 10);
      if (leads6h === 0 && dry4h >= 3) {
        issues.push({
          severity: 'critical',
          type: 'sourcing_flatlined',
          detail: `0 leads sourced in 6h with ${dry4h} dry-run signals in 4h — Research Beaver is producing nothing. Check Brave quota (HTTP 402) and VP/Explorium credit balance.`,
          recommended_action: 'escalateToMJ',
        });
      }
    } catch (err) {
      console.warn('[captain] sourcing-flatline check failed:', err.message);
    }
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
 * Dynamic auto-approve threshold tuner (Wave 3, 2026-05-03).
 *
 * Closes the MJ-as-bottleneck loop. Captain raises the auto_approve_threshold
 * (= more drafts skip MJ approval and go straight to send) when:
 *   - Approval queue has piled up AND oldest item is stale (>4h), AND
 *   - Sales' first-attempt pass rate is healthy enough that auto-approving
 *     high-Enforcer-score drafts is safe.
 *
 * Lowers the threshold (= MJ reviews more) when:
 *   - Queue is clear AND MJ is keeping up, OR
 *   - Recent bounce / reply-quality signals suggest auto-approves are missing things.
 *
 * Conservative bands: never below 80, never above 95. 80 means only the
 * highest-quality drafts auto-approve; 95 means almost nothing auto-approves
 * (MJ reviews everything). Default is 75 = off (no auto-approve at all).
 *
 * Returns { tuned: bool, from, to, reason }.
 */
async function tuneAutoApprove(clientId, kpisSnapshot = null) {
  const kpis = kpisSnapshot || await collectTeamKPIs(clientId);
  const cfg = await tenantConfig.getTenantConfig(clientId);
  const current = cfg.auto_approve_threshold;
  const cm = kpis.channel_mix;

  const queueOverloaded = cm.approvals_pending >= 20 && cm.approvals_oldest_hours >= 4;
  const queueClear      = cm.approvals_pending <= 5;
  const enforcerHealthy = (kpis.enforcer.approve_rate_pct ?? 0) >= 60 && kpis.enforcer.reviews_24h >= 10;
  const bouncesHigh     = kpis.pipeline.bounces_7d >= 5;

  const MIN = 80;
  const MAX = 95;
  const STEP = 3;

  let target = current ?? null;
  let reason = null;

  if (queueOverloaded && enforcerHealthy && !bouncesHigh) {
    // MJ is the choke point and Sales is producing clean drafts → loosen auto-approve.
    const start = (current === null || current >= 95) ? 90 : current;
    target = Math.max(MIN, Math.min(MAX, start - STEP));
    reason = `queue overloaded (${cm.approvals_pending} pending, oldest ${cm.approvals_oldest_hours.toFixed(1)}h), enforcer healthy (${kpis.enforcer.approve_rate_pct}% approve) → loosen auto-approve to ${target}`;
  } else if (queueClear && current !== null && current < 95) {
    // MJ is keeping up → tighten back so MJ keeps eyes on more.
    target = Math.min(MAX, (current ?? 90) + STEP);
    reason = `queue clear (${cm.approvals_pending} pending) → tighten auto-approve back to ${target}`;
  } else if (bouncesHigh && current !== null && current < 95) {
    // Bounce signal → don't trust auto-approve; tighten or off.
    target = Math.min(MAX, (current ?? 90) + STEP);
    reason = `bounces elevated (${kpis.pipeline.bounces_7d}/7d) → tighten auto-approve to ${target}`;
  }

  if (target === null || target === current) {
    return { tuned: false, from: current, to: current, reason: 'no change needed' };
  }

  await tenantConfig.setAutoApproveThreshold(clientId, target);
  await beaverState.logCaptainAction(clientId, 'tune_auto_approve', { from: current, to: target, reason });
  return { tuned: true, from: current, to: target, reason };
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

/* ─── Phase 5.5b: Target-agent liveness check (2026-05-06) ────────────
 *
 * Honest orchestrator. If the target_agent of a directive hasn't logged
 * activity recently, writing yet another directive is futile — it sits
 * pending, expires, gets re-issued. Caller skips the directive AND fires
 * a deduped escalateToMJ('<agent> offline') so MJ knows to act.
 *
 * Liveness signal = last log row from that agent in the last N hours.
 * Returns { alive: bool, last_seen: Date|null, hours_since: number|null }.
 */
async function checkAgentLiveness(clientId, targetAgent, freshnessHours = 2) {
  // Some target_agents are event-driven (kickoff, reply_handler, sales_beaver)
  // and don't need a heartbeat — they fire when triggered. Skip the check for them.
  const EVENT_DRIVEN = new Set(['kickoff', 'sales_beaver', 'reply_handler', 'enforcer_beaver']);
  if (EVENT_DRIVEN.has(targetAgent)) return { alive: true, last_seen: null, hours_since: null, skipped: true };

  try {
    const { rows } = await pool.query(
      `SELECT MAX(created_at) AS last_seen
       FROM logs
       WHERE client_id = $1
         AND (agent = $2 OR (agent = 'research_beaver' AND $2 = 'db_builder'))
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [clientId, targetAgent]
    );
    const lastSeen = rows[0]?.last_seen;
    if (!lastSeen) {
      return { alive: false, last_seen: null, hours_since: null };
    }
    const hoursSince = (Date.now() - new Date(lastSeen).getTime()) / 3600000;
    return {
      alive: hoursSince <= freshnessHours,
      last_seen: lastSeen,
      hours_since: hoursSince,
    };
  } catch {
    return { alive: true, last_seen: null, hours_since: null }; // fail-open — don't block sweep on a query error
  }
}

/**
 * Per-day deduped offline escalation. Captain writes ONE escalation per
 * (client, target_agent, day) so the EOD brief shows the gap once, not
 * every 30 min. Returns true if a new escalation was recorded.
 */
async function recordOfflineEscalation(clientId, targetAgent, hoursSince) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `agent_offline_${targetAgent}_${today}`;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
       VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'journal')
       ON CONFLICT (client_id, agent, key) DO NOTHING`,
      [clientId, key, JSON.stringify({
        target_agent: targetAgent,
        hours_since_last_seen: hoursSince,
        flagged_at: new Date().toISOString(),
      })]
    );
    return rowCount > 0;
  } catch { return false; }
}

/* ─── Phase 5.5: Directive re-push escalation helper ─────────────────
 *
 * When Captain issues a directive but the metric hasn't improved by the next
 * sweep cycle, severity escalates: normal → high → critical.
 * This prevents the same soft directive sitting unconsumed (or consumed but
 * ineffective) for hours while the gap grows.
 *
 * Logic: if a directive of the same type was consumed in the last 2 sweep
 * cycles (~1h) but the metric didn't move, the caller passes a higher base
 * severity. This helper checks if a prior consumed directive exists recently
 * and escalates one step if so.
 */
async function getDirectiveEscalationSeverity(clientId, targetAgent, directiveType, baseSeverity = 'normal') {
  try {
    const { rows } = await pool.query(
      `SELECT id FROM agent_directives
       WHERE client_id = $1
         AND target_agent = $2
         AND directive_type = $3
         AND status = 'consumed'
         AND consumed_at > NOW() - INTERVAL '2 hours'
       LIMIT 1`,
      [clientId, targetAgent, directiveType]
    );
    if (rows.length === 0) return baseSeverity;
    // Prior consumed directive but metric still needs attention → escalate
    const ESCALATION = { low: 'normal', normal: 'high', high: 'critical', critical: 'critical' };
    return ESCALATION[baseSeverity] || baseSeverity;
  } catch {
    return baseSeverity; // non-fatal
  }
}

/* ─── Phase 5.5: Weekly Learnings + Plan of the Week (Sunday cron) ───
 *
 * Synthesises 7 days of hook performance, rejection patterns, segment
 * outcomes, and sourcing misses into a structured weekly_learnings row.
 * Also writes a plan_of_week that the Monday morning brief surfaces.
 *
 * Called from index.js runWeeklyReview() on Sunday, after the existing
 * weekly strategy synthesis. Separate from runWeeklyReview to keep concerns
 * clean — this owns the DB write + plan generation, not the Telegram voice.
 */
async function runWeeklyLearnings(clientId) {
  const now = new Date();

  // Compute Monday of this week (UTC) as the canonical week_start key
  const day = now.getUTCDay();
  const diff = (day + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  const weekStart = monday.toISOString().slice(0, 10);

  // ── 1. Pull the raw stats for the week ──────────────────────────────

  const [hookStatsRes, rejectPatternsRes, segmentRes, sourceQualityRes, outcomeRes] = await Promise.all([
    // Hook performance — grouped, ordered by reply rate
    pool.query(
      `SELECT hook_text, channel,
              SUM(times_used)::int AS total_sent,
              SUM(replies)::int    AS total_replies,
              CASE WHEN SUM(times_used) > 0
                THEN ROUND((SUM(replies)::numeric / SUM(times_used)) * 100, 2)
                ELSE 0 END         AS reply_rate
       FROM hook_performance
       WHERE client_id = $1
         AND week_start >= $2::date - INTERVAL '7 days'
       GROUP BY hook_text, channel
       ORDER BY reply_rate DESC, total_sent DESC
       LIMIT 10`,
      [clientId, weekStart]
    ),
    // Top Enforcer rejection reasons this week
    pool.query(
      `SELECT COALESCE(SPLIT_PART(ranger_notes, ':', 1), 'no_note') AS reason, COUNT(*) AS n
       FROM messages
       WHERE client_id = $1
         AND status = 'ranger_rejected'
         AND created_at > NOW() - INTERVAL '7 days'
         AND ranger_notes IS NOT NULL
       GROUP BY reason ORDER BY n DESC LIMIT 8`,
      [clientId]
    ),
    // Industry/segment breakdown of sent messages (signals which verticals are working)
    pool.query(
      `SELECT COALESCE(l.metadata->>'industry', 'unknown') AS segment,
              COUNT(*) AS sent,
              COUNT(*) FILTER (WHERE m.reply_detected_at IS NOT NULL) AS replies
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.client_id = $1
         AND m.status = 'sent'
         AND m.sent_at > NOW() - INTERVAL '7 days'
       GROUP BY segment
       ORDER BY replies DESC, sent DESC
       LIMIT 8`,
      [clientId]
    ),
    // Research Beaver sourcing quality — avg lead score this week
    pool.query(
      `SELECT
         COUNT(*) AS sourced,
         ROUND(AVG(quality_score) FILTER (WHERE quality_score IS NOT NULL))::int AS avg_score,
         COUNT(*) FILTER (WHERE email IS NOT NULL) AS with_email,
         COUNT(*) FILTER (WHERE linkedin_url IS NOT NULL) AS with_linkedin
       FROM leads
       WHERE client_id = $1 AND created_at > NOW() - INTERVAL '7 days' AND deleted_at IS NULL`,
      [clientId]
    ),
    // Outcome summary (sent / replied / meetings)
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '7 days') AS sent_7d,
         COUNT(*) FILTER (WHERE reply_detected_at > NOW() - INTERVAL '7 days') AS replies_7d,
         COUNT(*) FILTER (WHERE status = 'sent' AND channel = 'email' AND sent_at > NOW() - INTERVAL '7 days') AS email_sent,
         COUNT(*) FILTER (WHERE status = 'sent' AND channel = 'linkedin' AND sent_at > NOW() - INTERVAL '7 days') AS linkedin_sent
       FROM messages WHERE client_id = $1`,
      [clientId]
    ),
  ]);

  const hookStats = hookStatsRes.rows;
  const rejectPatterns = rejectPatternsRes.rows;
  const segments = segmentRes.rows;
  const srcQuality = sourceQualityRes.rows[0] || {};
  const outcomes = outcomeRes.rows[0] || {};

  // ── 2. Derive structured learnings ──────────────────────────────────

  const winningHooks = hookStats.filter(h => h.total_replies >= 2 && parseFloat(h.reply_rate) >= 20);
  const losingPatterns = rejectPatterns.map(r => ({ reason: r.reason, count: Number(r.n) }));
  const segmentRanking = segments.map(s => ({
    segment: s.segment,
    sent: Number(s.sent),
    replies: Number(s.replies),
    reply_rate: s.sent > 0 ? Math.round((s.replies / s.sent) * 100) : 0,
  }));

  const rawStats = {
    week_start: weekStart,
    outcomes: {
      sent_7d: Number(outcomes.sent_7d) || 0,
      replies_7d: Number(outcomes.replies_7d) || 0,
      email_sent: Number(outcomes.email_sent) || 0,
      linkedin_sent: Number(outcomes.linkedin_sent) || 0,
      reply_rate_pct: outcomes.sent_7d > 0
        ? Math.round((outcomes.replies_7d / outcomes.sent_7d) * 100)
        : 0,
    },
    sourcing: {
      sourced: Number(srcQuality.sourced) || 0,
      avg_score: srcQuality.avg_score ? Number(srcQuality.avg_score) : null,
      with_email: Number(srcQuality.with_email) || 0,
      with_linkedin: Number(srcQuality.with_linkedin) || 0,
    },
    hook_count: hookStats.length,
    reject_pattern_count: rejectPatterns.length,
  };

  // ── 3. Generate the Plan of the Week via Sonnet ──────────────────────

  let planOfWeek = null;
  let summaryText = null;

  try {
    const bestHooksLines = winningHooks.length > 0
      ? winningHooks.slice(0, 3).map(h => `- "${h.hook_text}" (${h.channel}, ${h.reply_rate}% reply rate, ${h.total_replies} replies)`).join('\n')
      : '- none yet (not enough reply data)';

    const topRejectLines = losingPatterns.length > 0
      ? losingPatterns.slice(0, 5).map(p => `- ${p.reason} (${p.count}×)`).join('\n')
      : '- none';

    const bestSegLines = segmentRanking.length > 0
      ? segmentRanking.slice(0, 3).map(s => `- ${s.segment}: ${s.sent} sent, ${s.replies} replies (${s.reply_rate}% reply rate)`).join('\n')
      : '- no segment data yet';

    const promptText = `You are Captain Beaver, orchestrator of BeavrDam. Review this week's results and write the Plan of the Week for the team.

WEEK ${weekStart} RESULTS:
- Sent: ${rawStats.outcomes.sent_7d} total (${rawStats.outcomes.email_sent} email, ${rawStats.outcomes.linkedin_sent} LinkedIn)
- Replies: ${rawStats.outcomes.replies_7d} (${rawStats.outcomes.reply_rate_pct}% reply rate)
- Leads sourced: ${rawStats.sourcing.sourced} (avg quality score: ${rawStats.sourcing.avg_score ?? 'n/a'}, email-ready: ${rawStats.sourcing.with_email})

WINNING HOOKS (use these patterns next week):
${bestHooksLines}

TOP ENFORCER REJECTIONS (Sales Beaver must avoid):
${topRejectLines}

BEST PERFORMING SEGMENTS:
${bestSegLines}

Write a PLAN OF THE WEEK with exactly these sections. Be specific, not generic.

<b>📋 WEEK PLAN</b>
<b>Hook bias</b>: [which hook style/angle to lead with this week and why, based on winning hooks above]
<b>Vertical focus</b>: [which 1-2 segments to prioritise based on reply rate data]
<b>Avoid</b>: [top 2-3 Enforcer reject patterns Sales Beaver must not repeat]
<b>Sourcing target</b>: [what email-ready pool size to aim for and any sourcing angle shifts]
<b>MJ's one call</b>: [single most important decision only MJ can make this week — null if nothing]

Keep it under 200 words. Conversational-tight tone. No fluff.`;

    const result = await callAgent('captain_orchestrator', promptText, { clientId });
    const rawText = typeof result === 'string' ? result : (result?.brief || result?.summary || result?.text || '');
    summaryText = rawText ? rawText.trim() : null;

    planOfWeek = {
      generated_at: new Date().toISOString(),
      winning_hooks: winningHooks.slice(0, 3),
      avoid_patterns: losingPatterns.slice(0, 3),
      best_segments: segmentRanking.slice(0, 3),
      summary: summaryText,
    };
  } catch (err) {
    console.warn('[weekly-learnings] plan generation failed (non-fatal):', err.message);
    summaryText = `Week ${weekStart}: ${rawStats.outcomes.sent_7d} sent, ${rawStats.outcomes.replies_7d} replies (${rawStats.outcomes.reply_rate_pct}% reply rate). ${winningHooks.length} winning hook(s) identified.`;
    planOfWeek = { generated_at: new Date().toISOString(), summary: summaryText };
  }

  // ── 4. Persist to weekly_learnings + agent_memory ────────────────────

  // Phase 5.5: weekly_learnings is the existing table from earlier sprints (best_hooks,
  // ranger_top_rejections, best_industries, director_notes already present). Migration 063
  // added plan_of_week, raw_stats, updated_at. We map our new fields onto the existing
  // column names so dashboard.js + learningEngine.js continue to work.
  const weekEnd = new Date(monday);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  await pool.query(
    `INSERT INTO weekly_learnings
       (client_id, week_start, week_end,
        total_outreach, total_replies, total_meetings, reply_rate,
        best_hooks, best_industries, ranger_top_rejections, director_notes,
        plan_of_week, raw_stats)
     VALUES ($1, $2::date, $3::date,
             $4, $5, $6, $7,
             $8::jsonb, $9::jsonb, $10::jsonb, $11,
             $12::jsonb, $13::jsonb)
     ON CONFLICT (client_id, week_start) DO UPDATE SET
       week_end              = EXCLUDED.week_end,
       total_outreach        = EXCLUDED.total_outreach,
       total_replies         = EXCLUDED.total_replies,
       total_meetings        = EXCLUDED.total_meetings,
       reply_rate            = EXCLUDED.reply_rate,
       best_hooks            = EXCLUDED.best_hooks,
       best_industries       = EXCLUDED.best_industries,
       ranger_top_rejections = EXCLUDED.ranger_top_rejections,
       director_notes        = EXCLUDED.director_notes,
       plan_of_week          = EXCLUDED.plan_of_week,
       raw_stats             = EXCLUDED.raw_stats,
       updated_at            = NOW()`,
    [
      clientId, weekStart, weekEndStr,
      rawStats.outcomes.sent_7d,
      rawStats.outcomes.replies_7d,
      0, // total_meetings — populated by autonomous.js weekly review path; we leave 0 here
      rawStats.outcomes.reply_rate_pct,
      JSON.stringify(winningHooks),
      JSON.stringify(segmentRanking),
      JSON.stringify(losingPatterns),
      summaryText,
      JSON.stringify(planOfWeek),
      JSON.stringify(rawStats),
    ]
  );

  // Write plan_of_week to agent_memory so Monday morning brief can read it
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'journal')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, `weekly_plan_${weekStart}`, JSON.stringify(planOfWeek)]
  );

  console.log(`[weekly-learnings] client=${clientId} week=${weekStart} hooks=${winningHooks.length} patterns=${losingPatterns.length} segments=${segmentRanking.length}`);
  return { weekStart, winningHooks, losingPatterns, segmentRanking, planOfWeek, summaryText, rawStats };
}

/* ─── Goal-hunting directive sweep (Wave 1, 2026-05-03) ──────────────
 *
 * Captain's active driving function. Reads team KPIs, computes per-beaver
 * gaps, and writes structured directives that beavers consume at the start
 * of their next run. UPSERTs through the unique partial index so re-running
 * every poll cycle just refreshes the live directive instead of stacking.
 *
 * This is what makes the system goal-hunting instead of merely reactive.
 */
const directives = require('./directives');

async function runDirectiveSweep(clientId) {
  const runStartedAt = new Date();
  const kpis = await collectTeamKPIs(clientId);
  const cm = kpis.channel_mix;
  const written = [];

  const utcHour = new Date().getUTCHours();
  const isAfterMidday = utcHour >= 4; // 12:00 MYT = 04:00 UTC
  const isLate = utcHour >= 9;        // 17:00 MYT = 09:00 UTC

  // ── 1. Email channel: are we on track to hit target_email_sent? ──
  const emailGap = Math.max(0, cm.target_email_sent - cm.email.sent);
  const emailDraftedTowardTarget = cm.email.drafted; // includes pending+approved+sent
  const emailDraftGap = Math.max(0, cm.target_email_sent - emailDraftedTowardTarget);

  if (emailDraftGap > 0 && cm.pool_email_ready < emailDraftGap) {
    // Pool can't satisfy the drafting need → tell DB Builder to source more email-ready leads.
    // Phase 5.5b (2026-05-06): liveness gate. If db_builder hasn't logged activity in 2h,
    // skip the directive and escalate to MJ instead — writing more directives to a dead
    // agent is futile and pollutes the EOD landing report.
    const liveness = await checkAgentLiveness(clientId, 'db_builder', 2);
    if (!liveness.alive) {
      const escalated = await recordOfflineEscalation(clientId, 'db_builder', liveness.hours_since);
      if (escalated) {
        await escalateToMJ(clientId, {
          type: 'agent_offline',
          target_agent: 'db_builder',
          hours_since_last_seen: liveness.hours_since,
          gap: `email pool ${cm.pool_email_ready} short by ${emailDraftGap - cm.pool_email_ready}`,
          recommended: 'verify DB_BUILDER_ENABLED_CLIENTS env or fire run_campaign manually',
        });
      }
    } else {
      const needed = emailDraftGap - cm.pool_email_ready;
      const emailEscSeverity = await getDirectiveEscalationSeverity(clientId, 'db_builder', 'source_more_email_leads', isLate ? 'critical' : 'high');
      written.push(await directives.writeDirective(
        clientId,
        'db_builder',
        'source_more_email_leads',
        { needed_minimum: needed, by: 'today_eod', reason_kpi: { email_drafted: emailDraftedTowardTarget, email_target: cm.target_email_sent } },
        {
          reason: `Email at ${cm.email.sent}/${cm.target_email_sent} sent · pool email-ready ${cm.pool_email_ready} can't cover draft gap of ${emailDraftGap} · need ${needed} more email-ready leads`,
          severity: emailEscSeverity,
        }
      ));
    }
  }

  // ── 2. Kickoff: bias next batch toward the channel with the bigger gap ──
  const linkedinGap = Math.max(0, cm.target_linkedin_sent - cm.linkedin.sent);
  if (emailGap > 0 || linkedinGap > 0) {
    written.push(await directives.writeDirective(
      clientId,
      'kickoff',
      'channel_focus',
      {
        email:    { gap: emailGap,    target: cm.target_email_sent,    sent: cm.email.sent },
        linkedin: { gap: linkedinGap, target: cm.target_linkedin_sent, sent: cm.linkedin.sent },
        pool_email_ready:   cm.pool_email_ready,
        pool_linkedin_only: cm.pool_linkedin_only,
        // Option C: when email pool dry, kickoff may overrun linkedin to keep moving.
        linkedin_overrun_allowed_if_email_pool_dry: true,
      },
      {
        reason: `email gap ${emailGap}/${cm.target_email_sent}, linkedin gap ${linkedinGap}/${cm.target_linkedin_sent}, pool email=${cm.pool_email_ready} linkedin=${cm.pool_linkedin_only}`,
        severity: 'normal',
      }
    ));
  }

  // ── 3. Sales: feed today's top reject reasons into next draft batch ──
  const topRejects = (kpis.enforcer.top_reject_reasons || []).filter(r => r.n >= 3);
  if (topRejects.length > 0) {
    written.push(await directives.writeDirective(
      clientId,
      'sales_beaver',
      'apply_rejection_patterns',
      { patterns: topRejects, since: new Date(Date.now() - 24 * 3600 * 1000).toISOString() },
      {
        reason: `Avoid today's top reject reasons: ${topRejects.map(r => `${r.reason} (${r.n})`).join(', ')}`,
        severity: 'normal',
      }
    ));
  }

  // ── 4. DB Builder: target email-ready pool size, not raw pool ──
  const EMAIL_POOL_FLOOR = 30; // a day's worth of email-channel drafts
  if (cm.pool_email_ready < EMAIL_POOL_FLOOR) {
    // Phase 5.5b (2026-05-06): liveness gate before writing directive.
    const liveness = await checkAgentLiveness(clientId, 'db_builder', 2);
    if (!liveness.alive) {
      const escalated = await recordOfflineEscalation(clientId, 'db_builder', liveness.hours_since);
      if (escalated) {
        await escalateToMJ(clientId, {
          type: 'agent_offline',
          target_agent: 'db_builder',
          hours_since_last_seen: liveness.hours_since,
          gap: `email-ready pool at ${cm.pool_email_ready}/${EMAIL_POOL_FLOOR}`,
          recommended: 'verify DB_BUILDER_ENABLED_CLIENTS env on Railway',
        });
      }
    } else {
      const rebuildBaseSeverity = cm.pool_email_ready === 0 ? 'high' : 'normal';
      const rebuildEscSeverity = await getDirectiveEscalationSeverity(clientId, 'db_builder', 'rebuild_email_pool', rebuildBaseSeverity);
      written.push(await directives.writeDirective(
        clientId,
        'db_builder',
        'rebuild_email_pool',
        { target_min: EMAIL_POOL_FLOOR, current: cm.pool_email_ready },
        {
          reason: `Email-ready pool at ${cm.pool_email_ready}/${EMAIL_POOL_FLOOR} — DB Builder must source email-discoverable leads`,
          severity: rebuildEscSeverity,
        }
      ));
    }
  }

  // ── 5b. Hook performance: tell Sales Beaver which hooks are winning (Phase 5.5) ──
  // Written when ≥ 3 reply events confirm a winning hook. Positive counterpart to
  // apply_rejection_patterns — Sales biases TOWARD these patterns, not away from them.
  try {
    const hookTracking = require('./hookTracking');
    const hookStats = await hookTracking.getHookStats(clientId);
    const winningHooks = hookStats.filter(h => h.total_replies >= 3 && parseFloat(h.reply_rate) >= 25);
    if (winningHooks.length > 0) {
      written.push(await directives.writeDirective(
        clientId,
        'sales_beaver',
        'apply_winning_hooks',
        {
          hooks: winningHooks.slice(0, 5).map(h => ({
            text: h.hook_text,
            channel: h.channel,
            reply_rate: h.reply_rate,
            total_replies: h.total_replies,
            total_sent: h.total_sent,
          })),
        },
        {
          reason: `${winningHooks.length} winning hook(s) with ≥3 replies — bias Sales Beaver toward these opening patterns`,
          severity: 'normal',
        }
      ));
    }
  } catch (err) {
    console.warn('[directive-sweep] winning hooks check failed (non-fatal):', err.message);
  }

  // ── 5. Dynamic auto-approve threshold (Wave 3, 2026-05-03) ──
  // Captain decides whether the auto_approve_threshold needs tuning based on
  // queue state + Enforcer health. Acts directly (config UPDATE), not a
  // directive — this is Captain's executive authority on operational config.
  try {
    const tuneResult = await tuneAutoApprove(clientId, kpis);
    if (tuneResult.tuned) {
      written.push({ id: 'auto_approve_tune', kind: 'config_change', result: tuneResult });
    }
  } catch (err) {
    // Non-fatal — config tune isn't worth crashing the sweep over.
    console.warn('[directive-sweep] tuneAutoApprove failed:', err.message);
  }

  // Sweep expired directives in the same tick (cheap, dedupes the cron list)
  await directives.expireStale().catch(() => {});

  // Wave 3 (2026-05-03): persist a KPI snapshot to dam_kpi_snapshots so the
  // Dashboard's Goal Hunt widget can render the latest state without
  // re-running collectTeamKPIs (several joins) on every page load.
  try {
    await pool.query(
      `INSERT INTO dam_kpi_snapshots
        (client_id, snapshot, email_sent, email_target, linkedin_sent, linkedin_target,
         pool_email_ready, pool_linkedin_only, approvals_pending)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)`,
      [
        clientId,
        JSON.stringify(kpis),
        cm.email.sent, cm.target_email_sent,
        cm.linkedin.sent, cm.target_linkedin_sent,
        cm.pool_email_ready, cm.pool_linkedin_only,
        cm.approvals_pending,
      ]
    );
  } catch (err) {
    console.warn('[directive-sweep] dam_kpi_snapshots write failed (non-fatal):', err.message);
  }

  // Wave 2 (2026-05-03): Captain writes its own self-report each sweep.
  // Briefs read this to show what Captain decided + why, not just the issues
  // detected. Acts as a running journal of orchestration decisions.
  try {
    const introspection = require('./introspection');
    const summary = written.length === 0
      ? `Sweep clean. Email ${cm.email.sent}/${cm.target_email_sent}, linkedin ${cm.linkedin.sent}/${cm.target_linkedin_sent}. Pool email=${cm.pool_email_ready} linkedin=${cm.pool_linkedin_only}.`
      : `Issued ${written.length} directives. Email ${cm.email.sent}/${cm.target_email_sent}, linkedin ${cm.linkedin.sent}/${cm.target_linkedin_sent}.`;
    await introspection.writeReport(clientId, 'captain_orchestrator', {
      runStartedAt,
      metrics: {
        directives_written: written.length,
        email_sent: cm.email.sent,
        email_target: cm.target_email_sent,
        linkedin_sent: cm.linkedin.sent,
        linkedin_target: cm.target_linkedin_sent,
        pool_email_ready: cm.pool_email_ready,
        pool_linkedin_only: cm.pool_linkedin_only,
        approvals_pending: cm.approvals_pending,
      },
      summary,
      blockers: cm.approvals_pending >= 20 && cm.approvals_oldest_hours >= 4
        ? `Approval queue stuck: ${cm.approvals_pending} pending, oldest ${cm.approvals_oldest_hours.toFixed(1)}h.`
        : null,
    }).catch(() => {});
  } catch { /* non-critical */ }

  return { directives_written: written.length, kpis_snapshot: kpis };
}

/**
 * Channel-mix imbalance check, called from detectStuckStates.
 * Separated so the dedupe + MJ-bottleneck logic stays readable.
 *
 * Three distinct alert types:
 *   - bottleneck_approvals: MJ hasn't cleared the queue → don't blame the rule
 *   - email_behind_drafted:  pipeline hasn't drafted enough → research/source problem
 *   - email_behind_sent:     drafts exist, sends lag → send queue / Gmail issue
 */
function buildChannelMixIssues(kpis) {
  const out = [];
  const cm = kpis.channel_mix;
  const utcHour = new Date().getUTCHours();
  const isAfterMidday = utcHour >= 4; // 12:00 MYT
  if (!isAfterMidday) return out;

  // MJ-bottleneck dominates: don't fire other channel alerts when this is true
  if (cm.approvals_pending >= 20 && cm.approvals_oldest_hours >= 4) {
    out.push({
      severity: 'high',
      type: 'bottleneck_approvals_mj',
      detail: `${cm.approvals_pending} approvals waiting (oldest ${cm.approvals_oldest_hours.toFixed(1)}h). Resolve queue or today's send target is dead.`,
      recommended_action: 'escalateToMJ',
    });
    return out; // suppress the channel-mix alerts when MJ is the choke point
  }

  // Drafting gap (kickoff/research problem)
  const emailDrafted = cm.email.drafted;
  if (emailDrafted < cm.target_email_sent * 0.5) {
    out.push({
      severity: 'high',
      type: 'email_behind_drafted',
      detail: `Email drafted ${emailDrafted}/${cm.target_email_sent} by midday. Pool email-ready=${cm.pool_email_ready}. Research/sourcing problem.`,
      recommended_action: 'escalateToMJ',
    });
  }

  // Sending gap (send queue / Gmail problem) — only if drafts exist but sends lag
  if (emailDrafted >= cm.target_email_sent * 0.7 && cm.email.sent < cm.target_email_sent * 0.4) {
    out.push({
      severity: 'high',
      type: 'email_behind_sent',
      detail: `Drafted ${emailDrafted} emails but only ${cm.email.sent} sent. Send queue or Gmail issue.`,
      recommended_action: 'escalateToMJ',
    });
  }

  return out;
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
  // Goal-hunting (Wave 1, 2026-05-03)
  runDirectiveSweep,
  buildChannelMixIssues,
  // Tactical execution stubs
  fireCoachingLoop,
  switchResearchStrategy,
  tuneVpThreshold,
  tuneAutoApprove,
  throttleSend,
  escalateToMJ,
  // Phase 5.5: Captain Learning Loop (2026-05-06)
  runWeeklyLearnings,
  getDirectiveEscalationSeverity,
  // Phase 5.5b: target-agent liveness (2026-05-06)
  checkAgentLiveness,
  recordOfflineEscalation,
  // Captain-led follow-up planning (2026-05-11)
  planFollowUps,
  runFollowUpPlanning,
  formatPlanForTelegram,
  persistFollowUpPlan,
  ANGLE_TEMPLATES,
};
