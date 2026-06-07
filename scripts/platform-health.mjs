#!/usr/bin/env node
// Platform Health audit — runs Mon-Fri 01:03 MYT via GitHub Actions cron.
// Calls BeavrDam HTTP API (no direct DB), composes anomaly summary, pushes Telegram.
// MJ never has to ask "did kickoff run?" — this fires before he wakes up.
//
// Env required (GH Actions secrets):
//   TELEGRAM_BOT_TOKEN        Jarvis bot
//   TELEGRAM_CHAT_ID          MJ's chat
//   BEAVRDAM_API_URL          https://app.beaver.solutions
//   BEAVRDAM_INTERNAL_API_KEY Railway INTERNAL_API_KEY value

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.BEAVRDAM_API_URL || 'https://app.beaver.solutions';
const API_KEY = process.env.BEAVRDAM_INTERNAL_API_KEY;

if (!TOKEN || !CHAT_ID || !API_KEY) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BEAVRDAM_INTERNAL_API_KEY');
  process.exit(1);
}

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
  });
}

async function api(path) {
  const res = await fetch(`${API_URL}${path}`, { headers: { 'x-internal-key': API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function severity(anomalies) {
  if (anomalies.some(a => a.startsWith('🔴'))) return '🔴 RED';
  if (anomalies.some(a => a.startsWith('🟡'))) return '🟡 YELLOW';
  return '🟢 OK';
}

function providerUsageSummary(provider_usage = {}) {
  return Object.values(provider_usage)
    .filter(row => row && row.configured)
    .map(row => `${row.provider} ${row.remaining_today ?? 0}/${row.daily_cap ?? 0} today${row.remaining_total !== null && row.remaining_total !== undefined ? `, ${row.remaining_total}/${row.trial_cap ?? 0} total` : ''}`)
    .join('; ') || 'not reported';
}

async function main() {
  const anomalies = [];
  const summary = [];

  let health;
  try {
    ({ data: health } = await api('/api/autonomous/system-health'));
  } catch (err) {
    await tg(`<b>Platform Health</b>\n\n🔴 Audit failed: ${err.message.slice(0, 300)}`);
    process.exit(1);
  }

  if (!health.enabled_slugs?.length) {
    anomalies.push('🔴 AUTONOMOUS_ENABLED_CLIENTS empty — no tenant can run scheduled autonomy');
  }

  if (!health.captain_daily_kickoff_enabled) {
    anomalies.push('🔴 CAPTAIN_DAILY_KICKOFF_ENABLED disabled — daily kickoff will not fire');
  }

  if (!health.market_sensing_enabled) {
    summary.push('Market sensing: disabled by spend gate');
  }

  const tenants = health.tenants || [];
  for (const t of tenants) {
    const kpi = t.kpi || {};
    const sent = t.messages?.sent_today ?? 0;
    const target = kpi.target ?? null;
    const reviewable = t.approval_queue?.reviewable ?? 0;
    const awaitingAccept = t.approval_queue?.linkedin_awaiting_accept ?? 0;
    const staleApprovalRows = t.approval_queue?.stale_orphan_rows ?? 0;
    const followupsDue = t.followup_queue?.due_today ?? 0;
    const orphanedSentLeads = t.followup_queue?.orphaned_sent_leads ?? 0;
    const pool = t.lead_pool_remaining ?? null;
    const researchSaved = t.research_beaver?.leads_saved_24h ?? 0;
    const noResults = t.research_beaver?.no_results_24h ?? 0;
    const stuckSend = t.send_queue?.sq_stuck ?? 0;
    const failedSend = t.send_queue?.sq_failed ?? 0;
    const kickoff = t.kickoff_today || {};
    const kickoffState = kickoff.state || 'unknown';
    const targetText = target === null ? sent : `${sent}/${target}`;
    const provider_usage = t.provider_usage || {};

    summary.push(`${t.name}: kickoff ${kickoffState}, sent ${targetText}, reviewable ${reviewable}, LI-awaiting ${awaitingAccept}, follow-ups due ${followupsDue}, pool ${pool ?? '?'}, providers ${providerUsageSummary(provider_usage)}`);

    if (kickoffState === 'missed') {
      anomalies.push(`🔴 ${t.slug} daily kickoff missed — no memory/log/trace evidence`);
    } else if (kickoffState === 'started') {
      anomalies.push(`🔴 ${t.slug} kickoff has only a start marker, no work proof`);
    } else if (kickoffState === 'disabled') {
      anomalies.push(`🔴 ${t.slug} daily kickoff disabled`);
    }

    if (reviewable >= 20) {
      anomalies.push(`🔴 ${t.slug} approval review queue ${reviewable} — clearing blocks autonomous loop`);
    } else if (reviewable >= 10) {
      anomalies.push(`🟡 ${t.slug} approval review queue ${reviewable} — review soon`);
    }

    if (staleApprovalRows > 0) {
      anomalies.push(`🟡 ${t.slug} has ${staleApprovalRows} stale approval rows — cleanup/reporting risk`);
    }
    if (followupsDue > 20) {
      anomalies.push(`🟡 ${t.slug} has ${followupsDue} follow-ups due today — follow-up plan/backlog risk`);
    }
    if (orphanedSentLeads > 0) {
      anomalies.push(`🟡 ${t.slug} has ${orphanedSentLeads} sent leads missing follow-up rows`);
    }

    if (sent === 0 && reviewable === 0 && ['fired', 'missed'].includes(kickoffState)) {
      anomalies.push(`🔴 ${t.slug} has 0 sent and 0 reviewable after kickoff window — pipeline produced no approval-ready output`);
    }

    if (target !== null && sent < target && Number(health.kl_minutes_now) >= 18 * 60) {
      anomalies.push(`🟡 ${t.slug} sent ${sent}/${target} by EOD — below configured daily outreach target`);
    }

    if (pool !== null && pool < 20) {
      anomalies.push(`🟡 ${t.slug} lead pool thin: ${pool} selectable leads`);
    } else if (pool !== null && pool >= 100 && researchSaved === 0) {
      summary.push(`${t.name}: Research idle by design while pool holds at ${pool}`);
    } else if (researchSaved === 0 && noResults > 0) {
      anomalies.push(`🟡 ${t.slug} Research returned ${noResults} no-result runs and saved 0 leads`);
    }

    if (stuckSend > 0) {
      anomalies.push(`🔴 ${t.slug} send queue has ${stuckSend} stuck rows`);
    }
    if (failedSend > 5) {
      anomalies.push(`🔴 ${t.slug} send queue has ${failedSend} failed rows`);
    }
    for (const row of Object.values(provider_usage)) {
      if (!row || !row.configured) continue;
      if (Number(row.remaining_today) <= 0) {
        anomalies.push(`🔴 ${t.slug} provider capacity low: ${row.provider} daily cap exhausted`);
      } else if (row.remaining_total !== null && row.remaining_total !== undefined && Number(row.remaining_total) <= 10) {
        anomalies.push(`🟡 ${t.slug} provider capacity low: ${row.provider} remaining_total ${row.remaining_total}/${row.trial_cap ?? 0}`);
      }
    }
  }

  const sev = severity(anomalies);
  const lines = [
    `<b>Platform Health — ${health.date || new Date().toISOString().slice(0, 10)} MYT</b>`,
    sev,
    '',
    ...summary,
  ];
  if (anomalies.length > 0) {
    lines.push('', '<b>Anomalies:</b>');
    lines.push(...anomalies);
  } else {
    lines.push('', 'No anomalies. All systems firing.');
  }

  const text = lines.join('\n').slice(0, 3800);
  await tg(text);
  console.log(`Health audit complete. ${sev}. ${anomalies.length} anomalies.`);
}

main().catch(err => {
  console.error('FATAL:', err);
  tg(`<b>Platform Health</b>\n\n🔴 Audit script crashed: ${err.message.slice(0, 300)}`).finally(() => process.exit(1));
});
