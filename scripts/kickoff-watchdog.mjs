#!/usr/bin/env node
// Kickoff Watchdog — fires every 15 min from 09:30-11:00 MYT.
// Alerts ONLY if no autonomous_kickoff log row for today by the time it fires.
// Silent if kickoff fired. Prevents the silent-skip-on-Railway-restart class of bug.

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

async function main() {
  const res = await fetch(`${API_URL}/api/autonomous/system-health`, {
    headers: { 'x-internal-key': API_KEY },
  });
  if (!res.ok) {
    await tg(`<b>Kickoff Watchdog: API down</b>\n\n${res.status} from ${API_URL}`);
    process.exit(1);
  }
  const { data } = await res.json();
  const missed = data.tenants.filter(t => !t.kickoff_today.fired);
  if (missed.length === 0) {
    console.log('Watchdog: all kickoffs fired. Silent.');
    return;
  }
  const lines = ['<b>Kickoff Watchdog: KICKOFF MISSED</b>', ''];
  for (const t of missed) {
    lines.push(`❌ ${t.name} (<code>${t.slug}</code>) — no autonomous_kickoff log today`);
  }
  lines.push('');
  lines.push('Likely cause: Railway dyno restart in cron poll window, or AUTONOMOUS_ENABLED_CLIENTS env var missing.');
  lines.push(`Manual trigger: <code>POST ${API_URL}/api/autonomous/kickoff-all</code> with x-internal-key.`);
  await tg(lines.join('\n'));
}

main().catch(err => {
  console.error('[kickoff-watchdog] failed:', err);
  process.exit(1);
});
