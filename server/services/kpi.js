'use strict';
// KPI counter recompute helper.
// Single source of truth for daily_kpi counter values — recomputes from the
// messages + leads tables on demand. Idempotent. Safe to call after every
// send, lead insert, or kickoff cycle.
//
// Why a recompute helper instead of incremental UPDATEs:
// - Multiple code paths produce sends (send_queue worker, manual approve route,
//   LinkedIn manual mark-sent, follow-up scheduler). Wiring an increment to
//   each one is fragile — miss one, counters drift.
// - Recompute is O(few rows per day per client), so cost is negligible.
// - Counters always match the underlying truth in messages + leads.
//
// Why a dedicated client (not pool.query): autonomous kickoff chains many
// queries; pool.query takes a fresh connection per call which can hit pool
// limits or race with concurrent transactions. Dedicated client + explicit
// release + instrumentation logs make the recount auditable in the logs table.

const pool = require('../db/pool');
const { buildCaptainPeriodReport, formatCaptainPeriodReport } = require('./beaverScorecard');
const { addDaysToDateKey, todayInMalaysia } = require('../utils/businessDay');

const todayKualaLumpurDate = todayInMalaysia;
function autonomousSentMessageFilterSql(alias = null) {
  const metadata = alias ? `${alias}.metadata` : 'metadata';
  return `
              AND COALESCE(${metadata}->>'manual_proof', 'false') <> 'true'
              AND COALESCE(${metadata}->>'source', '') <> 'manual_proof'
              AND COALESCE(${metadata}->>'send_source', '') <> 'manual_proof'
              AND COALESCE(${metadata}->>'autonomous_output', 'true') <> 'false'`;
}

const autonomousSentMessageFilter = `
              AND COALESCE(metadata->>'manual_proof', 'false') <> 'true'
              AND COALESCE(metadata->>'source', '') <> 'manual_proof'
              AND COALESCE(metadata->>'send_source', '') <> 'manual_proof'
              AND COALESCE(metadata->>'autonomous_output', 'true') <> 'false'`;

function dayOfWeekFromDateKey(dateKey) {
  const [year, month, day] = String(dateKey).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysBetweenDateKeys(startDate, endDate) {
  const [sy, sm, sd] = String(startDate).split('-').map(Number);
  const [ey, em, ed] = String(endDate).split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  return Math.max(1, Math.round((end - start) / 86400000));
}

function previousMonthBounds(dateKey) {
  const [year, month] = String(dateKey).slice(0, 10).split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 2, 1));
  const end = new Date(Date.UTC(year, month - 1, 1));
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

function captainPeriodBounds(reportType = 'weekly', now = new Date()) {
  const today = todayInMalaysia(now);
  if (reportType === 'monthly') {
    const bounds = previousMonthBounds(today);
    return {
      type: 'monthly',
      ...bounds,
      days: daysBetweenDateKeys(bounds.start_date, bounds.end_date),
      label: `${bounds.start_date} to ${bounds.end_date}`,
    };
  }
  const endDate = today;
  const startDate = addDaysToDateKey(endDate, -7);
  return {
    type: 'weekly',
    start_date: startDate,
    end_date: endDate,
    days: 7,
    label: `${startDate} to ${endDate}`,
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function numberRow(row = {}, key) {
  const n = Number(row[key]);
  return Number.isFinite(n) ? n : 0;
}

async function collectCaptainPeriodReport(clientId, options = {}) {
  const reportType = options.reportType || options.period || 'weekly';
  const period = captainPeriodBounds(reportType, options.now || new Date());
  const params = [clientId, period.start_date, period.end_date];
  const boundsSql = `
    WITH bounds AS (
      SELECT
        ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AS start_at,
        ($3::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AS end_at
    )`;

  const tenantPromise = pool.query(
    `SELECT c.slug, c.name,
            COALESCE(tp.profile->'icp'->'active_industries', '[]'::jsonb) AS active_industries
     FROM clients c
     LEFT JOIN tenant_profiles tp ON tp.client_id = c.id AND tp.status = 'active'
     WHERE c.id = $1
     LIMIT 1`,
    [clientId]
  ).catch(() => ({ rows: [{}] }));

  const totalsPromise = pool.query(
    `${boundsSql}
     SELECT
       (SELECT COUNT(*)::int FROM leads l, bounds
         WHERE l.client_id = $1 AND l.deleted_at IS NULL
           AND l.created_at >= bounds.start_at AND l.created_at < bounds.end_at) AS leads_found,
       (SELECT COUNT(*)::int FROM messages
         WHERE client_id = $1 AND status = 'sent' AND sent_at IS NOT NULL
           AND sent_at >= bounds.start_at AND sent_at < bounds.end_at
           ${autonomousSentMessageFilter}) AS outreach_sent,
       (SELECT COUNT(*)::int FROM messages
         WHERE client_id = $1 AND reply_detected_at IS NOT NULL
           AND reply_detected_at >= bounds.start_at AND reply_detected_at < bounds.end_at) AS replies,
       (SELECT COUNT(*)::int FROM leads l, bounds
         WHERE l.client_id = $1 AND l.deleted_at IS NULL
           AND (l.status = 'meeting_booked' OR l.pipeline_stage = 'meeting_booked')
           AND COALESCE(l.updated_at, l.created_at) >= bounds.start_at
           AND COALESCE(l.updated_at, l.created_at) < bounds.end_at) AS meetings`,
    params
  );

  const channelPromise = pool.query(
    `${boundsSql}
     SELECT COALESCE(m.channel, 'unknown') AS channel,
            COUNT(*) FILTER (
              WHERE m.status = 'sent'
                AND m.sent_at IS NOT NULL
                AND m.sent_at >= bounds.start_at
                AND m.sent_at < bounds.end_at
                ${autonomousSentMessageFilterSql('m')}
            )::int AS sent,
            COUNT(*) FILTER (
              WHERE m.reply_detected_at IS NOT NULL
                AND m.reply_detected_at >= bounds.start_at
                AND m.reply_detected_at < bounds.end_at
            )::int AS replies
     FROM messages m, bounds
     WHERE m.client_id = $1
       AND (
         (m.sent_at IS NOT NULL AND m.sent_at >= bounds.start_at AND m.sent_at < bounds.end_at)
         OR (m.reply_detected_at IS NOT NULL AND m.reply_detected_at >= bounds.start_at AND m.reply_detected_at < bounds.end_at)
       )
     GROUP BY COALESCE(m.channel, 'unknown')`,
    params
  );

  const funnelPromise = pool.query(
    `${boundsSql}
     SELECT stage, COUNT(*)::int AS count
     FROM pipeline_traces, bounds
     WHERE client_id = $1
       AND created_at >= bounds.start_at
       AND created_at < bounds.end_at
     GROUP BY stage`,
    params
  );

  const industryPromise = pool.query(
    `${boundsSql},
     lead_rows AS (
       SELECT
         l.id,
         COALESCE(
           l.metadata->'signal_package'->'company_icp_fit'->>'vertical_match',
           l.metadata->>'industry',
           l.vertical,
           'unknown'
         ) AS industry,
         l.created_at,
         l.updated_at,
         l.status,
         l.pipeline_stage
       FROM leads l
       WHERE l.client_id = $1 AND l.deleted_at IS NULL
     ),
     lead_metrics AS (
       SELECT
         l.industry,
         COUNT(*) FILTER (WHERE l.created_at >= bounds.start_at AND l.created_at < bounds.end_at)::int AS saved,
         COUNT(DISTINCT m.id) FILTER (
           WHERE m.status = 'sent'
             AND m.sent_at IS NOT NULL
             AND m.sent_at >= bounds.start_at
             AND m.sent_at < bounds.end_at
             ${autonomousSentMessageFilterSql('m')}
         )::int AS sent,
         COUNT(DISTINCT m.id) FILTER (
           WHERE m.reply_detected_at IS NOT NULL
             AND m.reply_detected_at >= bounds.start_at
             AND m.reply_detected_at < bounds.end_at
         )::int AS replies,
         COUNT(*) FILTER (
           WHERE (l.status = 'meeting_booked' OR l.pipeline_stage = 'meeting_booked')
             AND COALESCE(l.updated_at, l.created_at) >= bounds.start_at
             AND COALESCE(l.updated_at, l.created_at) < bounds.end_at
         )::int AS meetings
       FROM lead_rows l
       CROSS JOIN bounds
       LEFT JOIN messages m ON m.lead_id = l.id AND m.client_id = $1
       GROUP BY l.industry
     ),
     query_metrics AS (
       SELECT
         COALESCE(
           logs.metadata->>'industry',
           logs.metadata->>'expected_industry',
           logs.metadata->>'vertical_match',
           'unknown'
         ) AS industry,
         SUM(CASE WHEN (logs.metadata->>'queries_run') ~ '^[0-9]+$' THEN (logs.metadata->>'queries_run')::int ELSE 0 END)::int AS queries_run,
         SUM(CASE WHEN (logs.metadata->>'raw_candidates_total') ~ '^[0-9]+$' THEN (logs.metadata->>'raw_candidates_total')::int ELSE 0 END)::int AS raw_candidates
       FROM logs, bounds
       WHERE logs.client_id = $1
         AND logs.created_at >= bounds.start_at
         AND logs.created_at < bounds.end_at
         AND logs.action IN ('signal_hunt_complete', 'research_blocker', 'research_no_results')
       GROUP BY industry
     )
     SELECT
       COALESCE(lm.industry, qm.industry) AS industry,
       COALESCE(qm.queries_run, 0)::int AS queries_run,
       COALESCE(qm.raw_candidates, 0)::int AS raw_candidates,
       COALESCE(lm.saved, 0)::int AS saved,
       COALESCE(lm.sent, 0)::int AS sent,
       COALESCE(lm.replies, 0)::int AS replies,
       COALESCE(lm.meetings, 0)::int AS meetings
     FROM lead_metrics lm
     FULL OUTER JOIN query_metrics qm ON qm.industry = lm.industry`,
    params
  );

  const spendPromise = pool.query(
    `${boundsSql}
     SELECT
       COALESCE(logs.metadata->>'provider', 'unknown') AS provider,
       SUM(CASE WHEN (logs.metadata->>'units') ~ '^[0-9]+$' THEN (logs.metadata->>'units')::int ELSE 1 END)::int AS units,
       SUM(CASE WHEN (logs.metadata->>'cost_usd') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (logs.metadata->>'cost_usd')::numeric ELSE 0 END)::numeric AS cost_usd
     FROM logs, bounds
     WHERE logs.client_id = $1
       AND logs.action = 'provider_usage'
       AND logs.created_at >= bounds.start_at
       AND logs.created_at < bounds.end_at
     GROUP BY provider`,
    params
  );

  const llmSpendPromise = pool.query(
    `${boundsSql}
     SELECT COALESCE(SUM(cost_usd), 0)::numeric AS llm_cost_usd
     FROM llm_usage, bounds
     WHERE client_id = $1
       AND created_at >= bounds.start_at
       AND created_at < bounds.end_at`,
    params
  );

  const platformYieldPromise = pool.query(
    `${boundsSql}
     SELECT
       platform,
       signal_id,
       signal_family,
       geo,
       SUM(paid_units)::int AS paid_units,
       SUM(raw_results)::int AS raw_results,
       SUM(raw_candidates)::int AS raw_candidates,
       SUM(icp_passed)::int AS icp_passed,
       SUM(saved_leads)::int AS saved_leads,
       SUM(approval_ready)::int AS approval_ready,
       SUM(replies)::int AS replies,
       SUM(meetings)::int AS meetings,
       COALESCE(blocker, 'none') AS blocker
     FROM platform_yield_events, bounds
     WHERE client_id = $1
       AND created_at >= bounds.start_at
       AND created_at < bounds.end_at
     GROUP BY platform, signal_id, signal_family, geo, COALESCE(blocker, 'none')
     ORDER BY saved_leads DESC, approval_ready DESC, raw_candidates DESC`,
    params
  ).catch(() => ({ rows: [] }));

  const blockersPromise = pool.query(
    `${boundsSql}
     SELECT COALESCE(metadata->>'blocker', metadata->>'reason', reason, 'unknown') AS reason,
            COUNT(*)::int AS count
     FROM logs, bounds
     WHERE client_id = $1
       AND created_at >= bounds.start_at
       AND created_at < bounds.end_at
       AND (
         action IN ('research_blocker', 'research_no_results', 'signal_hunt_complete', 'signal_hunt_zero_query_set_blocked', 'kickoff_zero_output', 'daily_kickoff_low_yield_blocker')
         OR metadata ? 'blocker'
       )
     GROUP BY reason
     ORDER BY count DESC
     LIMIT 8`,
    params
  );

  const enforcerPromise = pool.query(
    `${boundsSql}
     SELECT
       COUNT(*) FILTER (WHERE ranger_score IS NOT NULL)::int AS reviewed,
       COUNT(*) FILTER (WHERE ranger_score >= 75)::int AS approved,
       COUNT(*) FILTER (WHERE status = 'ranger_rejected' OR (ranger_score IS NOT NULL AND ranger_score < 75))::int AS rejected
     FROM messages, bounds
     WHERE client_id = $1
       AND created_at >= bounds.start_at
       AND created_at < bounds.end_at`,
    params
  );

  const rejectReasonsPromise = pool.query(
    `${boundsSql}
     SELECT COALESCE(SPLIT_PART(ranger_notes, ':', 1), 'no_note') AS reason,
            COUNT(*)::int AS count
     FROM messages, bounds
     WHERE client_id = $1
       AND created_at >= bounds.start_at
       AND created_at < bounds.end_at
       AND ranger_notes IS NOT NULL
     GROUP BY reason
     ORDER BY count DESC
     LIMIT 5`,
    params
  );

  const [
    tenantRes,
    totalsRes,
    channelRes,
    funnelRes,
    industryRes,
    spendRes,
    llmSpendRes,
    platformYieldRes,
    blockersRes,
    enforcerRes,
    rejectReasonsRes,
  ] = await Promise.all([
    tenantPromise,
    totalsPromise,
    channelPromise,
    funnelPromise,
    industryPromise,
    spendPromise,
    llmSpendPromise,
    platformYieldPromise,
    blockersPromise,
    enforcerPromise,
    rejectReasonsPromise,
  ]);

  const tenant = tenantRes.rows[0] || {};
  const totals = totalsRes.rows[0] || {};
  const funnelCounts = Object.fromEntries((funnelRes.rows || []).map(row => [row.stage, numberRow(row, 'count')]));
  const providerUnits = {};
  const providers = {};
  let providerCost = 0;
  for (const row of spendRes.rows || []) {
    const provider = row.provider || 'unknown';
    providerUnits[provider] = numberRow(row, 'units');
    providers[provider] = { units: providerUnits[provider], cost_usd: Number(row.cost_usd) || 0 };
    providerCost += Number(row.cost_usd) || 0;
  }
  const llmCost = Number(llmSpendRes.rows[0]?.llm_cost_usd) || 0;
  const activeIndustries = parseJsonArray(tenant.active_industries);
  const target = period.days * 50;

  return buildCaptainPeriodReport({
    tenant,
    period,
    active_industries: activeIndustries,
    targets: { outreach_sent: target },
    totals: {
      leads_found: numberRow(totals, 'leads_found'),
      outreach_sent: numberRow(totals, 'outreach_sent'),
      replies: numberRow(totals, 'replies'),
      meetings: numberRow(totals, 'meetings'),
    },
    funnel: {
      raw_candidates: (industryRes.rows || []).reduce((sum, row) => sum + numberRow(row, 'raw_candidates'), 0),
      saved: numberRow(totals, 'leads_found') || funnelCounts.enrolled || 0,
      drafted: funnelCounts.drafted || 0,
      approved: funnelCounts.approved || 0,
    },
    industries: industryRes.rows || [],
    channels: channelRes.rows || [],
    platform_yield: platformYieldRes.rows || [],
    spend: {
      providers,
      provider_units: providerUnits,
      provider_cost_usd: providerCost,
      llm_cost_usd: llmCost,
      total_cost_usd: providerCost + llmCost,
      notes: ['Provider cost is shown only when provider_usage logs include cost_usd; otherwise unit counts are reported.'],
    },
    blockers: blockersRes.rows || [],
    enforcer: {
      ...(enforcerRes.rows[0] || {}),
      top_reject_reasons: rejectReasonsRes.rows || [],
    },
  });
}

async function saveCaptainPeriodReport(clientId, report, text) {
  const keyPrefix = report.period.type === 'monthly' ? 'captain_monthly_report_' : 'captain_weekly_report_';
  const key = `${keyPrefix}${report.period.start_date}_${report.period.end_date}`;
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'captain', $2, $3::jsonb, 'kpi')
     ON CONFLICT (client_id, agent, key) DO UPDATE SET
       content = EXCLUDED.content,
       memory_type = EXCLUDED.memory_type,
       updated_at = NOW()`,
    [clientId, key, JSON.stringify({ report, text, generated_at: new Date().toISOString() })]
  );
  return key;
}

async function generateCaptainPeriodReport(clientId, options = {}) {
  const report = await collectCaptainPeriodReport(clientId, options);
  const text = formatCaptainPeriodReport(report);
  const artifactKey = await saveCaptainPeriodReport(clientId, report, text);
  return { report, text, artifactKey };
}

async function recountKpi(clientId, date = null) {
  const today = date || todayKualaLumpurDate();

  // Instrumentation: log entry so we can verify the function is being hit
  // (separate connection so it works even if the main pool path is blocked)
  pool.query(
    `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
     VALUES ($1, 'system', 'kpi_recount_started', 'system', $2, NOW())`,
    [clientId, JSON.stringify({ today, source: 'kpi.js' })]
  ).catch(() => {});

  let client;
  let step = 'connect';
  try {
    client = await pool.connect();
    step = 'insert';
    await client.query(
      `INSERT INTO daily_kpi (client_id, date) VALUES ($1, $2)
       ON CONFLICT (client_id, date) DO NOTHING`,
      [clientId, today]
    );
    step = 'update';
    // kpi_met is a GENERATED column (outreach_sent >= target) — DO NOT update it.
    // Postgres rejects with "column kpi_met can only be updated to DEFAULT" otherwise.
    const updateRes = await client.query(
      `WITH bounds AS (
         SELECT
           $2::date AS kpi_date,
           ($2::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AS start_at,
           (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AS end_at
       )
       UPDATE daily_kpi SET
         outreach_sent = (
            SELECT COUNT(*) FROM messages
            WHERE client_id = $1 AND status = 'sent'
              AND sent_at IS NOT NULL
              AND sent_at >= bounds.start_at
              AND sent_at < bounds.end_at
              ${autonomousSentMessageFilter}
         ),
         outreach_email = (
            SELECT COUNT(*) FROM messages
            WHERE client_id = $1 AND status = 'sent' AND channel = 'email'
              AND sent_at IS NOT NULL
              AND sent_at >= bounds.start_at
              AND sent_at < bounds.end_at
              ${autonomousSentMessageFilter}
         ),
         outreach_linkedin = (
            SELECT COUNT(*) FROM messages
            WHERE client_id = $1 AND status = 'sent' AND channel = 'linkedin'
              AND sent_at IS NOT NULL
              AND sent_at >= bounds.start_at
              AND sent_at < bounds.end_at
              ${autonomousSentMessageFilter}
         ),
         leads_found = (
            SELECT COUNT(*) FROM leads
            WHERE client_id = $1
              AND deleted_at IS NULL
              AND created_at >= bounds.start_at
              AND created_at < bounds.end_at
         ),
         replies_received = (
            SELECT COUNT(*) FROM messages
            WHERE client_id = $1 AND reply_detected_at IS NOT NULL
              AND reply_detected_at >= bounds.start_at
              AND reply_detected_at < bounds.end_at
         ),
         updated_at = NOW()
       FROM bounds
       WHERE client_id = $1 AND date = bounds.kpi_date`,
      [clientId, today]
    );

    pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
       VALUES ($1, 'system', 'kpi_recount_completed', 'system', $2, NOW())`,
      [clientId, JSON.stringify({ today, rows_updated: updateRes.rowCount })]
    ).catch(() => {});
  } catch (err) {
    // Capture the actual error to logs so we can debug remotely.
    pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
       VALUES ($1, 'system', 'kpi_recount_failed', 'system', $2, NOW())`,
      [clientId, JSON.stringify({
        today,
        step,
        err_message: String(err?.message || err).slice(0, 500),
        err_code: err?.code || null,
      })]
    ).catch(() => {});
    throw err;
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  recountKpi,
  todayKualaLumpurDate,
  autonomousSentMessageFilterSql,
  captainPeriodBounds,
  collectCaptainPeriodReport,
  generateCaptainPeriodReport,
};
