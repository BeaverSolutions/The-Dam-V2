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

async function main() {
  const anomalies = [];
  const summary = [];

  let hourly, health;
  try {
    [{ data: hourly }, { data: health }] = await Promise.all([
      api('/api/autonomous/hourly-stats'),
      api('/api/autonomous/system-health'),
    ]);
  } catch (err) {
    await tg(`<b>Platform Health</b>\n\n🔴 Audit failed: ${err.message.slice(0, 300)}`);
    process.exit(1);
  }

  // Pipeline numbers
  const sentToday = (hourly.email_sent || 0) + (hourly.li_sent || 0);
  const pending = hourly.pending_approval || 0;
  const replies = (hourly.email_replied || 0) + (hourly.li_replied || 0);
  const failed1h = hourly.failed_1h || 0;
  const leadsToday = hourly.leads_today || 0;

  summary.push(`Sent: ${sentToday}/50 · Pending: ${pending} · Replies: ${replies}`);
  summary.push(`Leads sourced today: ${leadsToday}`);

  // Anomaly checks
  if (pending >= 20) {
    anomalies.push(`🔴 Approval queue ${pending} pending — clearing blocks autonomous loop`);
  } else if (pending >= 10) {
    anomalies.push(`🟡 Approval queue ${pending} pending — review soon`);
  }

  if (sentToday === 0 && pending < 5) {
    anomalies.push(`🔴 0 sent today AND queue empty — pipeline producing nothing`);
  } else if (sentToday < 10 && new Date().getUTCHours() >= 10) {
    anomalies.push(`🟡 Only ${sentToday} sent by EOD — well under 50/day target`);
  }

  if (leadsToday === 0) {
    anomalies.push(`🟡 Research Beaver sourced 0 today — pool not refreshing`);
  }

  if (failed1h > 5) {
    anomalies.push(`🔴 ${failed1h} send failures in last hour`);
  }

  // System health from system-health endpoint
  if (health) {
    const cronHealth = health.cron_health || {};
    const stale = Object.entries(cronHealth).filter(([, v]) => v?.status !== 'ok');
    if (stale.length > 0) {
      anomalies.push(`🔴 Stale crons: ${stale.map(([k]) => k).join(', ')}`);
    }

    const poolEmail = health.pool_email_ready ?? null;
    const poolLi = health.pool_linkedin_only ?? null;
    if (poolEmail !== null && poolEmail < 20) {
      anomalies.push(`🟡 Email-ready pool thin: ${poolEmail} leads`);
    }

    if (poolEmail !== null && poolLi !== null) {
      summary.push(`Pool: ${poolEmail} email-ready · ${poolLi} linkedin-only`);
    }
  }

  const sev = severity(anomalies);
  const lines = [
    `<b>Platform Health — ${new Date().toISOString().slice(0, 10)}</b>`,
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
