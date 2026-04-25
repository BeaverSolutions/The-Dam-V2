#!/usr/bin/env node
// Hourly status report — runs via GitHub Actions cron at :07 each UTC hour.
// Skips fires outside 09:00–19:00 MYT (01:00–11:00 UTC).
// Calls BeavrDam HTTP API (/api/autonomous/hourly-stats) — no direct DB access needed.
//
// Env required:
//   TELEGRAM_BOT_TOKEN        Jarvis bot (@BeaverSolutionsBot)
//   TELEGRAM_CHAT_ID          MJ's numeric chat id
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

const WORK_START_UTC = 1;   // 09:00 MYT
const WORK_END_UTC   = 11;  // 19:00 MYT (inclusive)

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function main() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const force = process.argv.includes('--force');

  if (!force && (utcHour < WORK_START_UTC || utcHour > WORK_END_UTC)) {
    console.log(`Skipping: UTC hour ${utcHour} outside 09-19 MYT window`);
    return;
  }

  const mytHour = (utcHour + 8) % 24;

  const statsRes = await fetch(`${API_URL}/api/autonomous/hourly-stats`, {
    headers: { 'x-internal-key': API_KEY },
  });

  if (!statsRes.ok) {
    const body = await statsRes.text().catch(() => '');
    throw new Error(`BeavrDam API ${statsRes.status}: ${body}`);
  }

  const { data: d } = await statsRes.json();

  const text = `<b>[${String(mytHour).padStart(2,'0')}:00 MYT] Hourly</b>

<b>Pipeline (today):</b>
📧 Email:     ${d.email_sent} sent · ${d.email_pending} pending · ${d.email_replied} replied
🔗 LinkedIn:  ${d.li_sent} sent · ${d.li_pending} pending · ${d.li_replied} accepted

<b>DB Builder:</b>
+${d.leads_today} new leads (${d.leads_email_route} email-route · ${d.leads_linkedin_route} linkedin-route)
Pattern memory: ${d.pattern_count} verified companies

<b>Queue:</b> ${d.pending_approval} pending approval · ${d.auto_approved} auto-✅ · ${d.auto_rejected} auto-❌ · ${d.failed_1h} failed

<b>Q2:</b> 20 clients (10 Beaver + 10 Emplifive)`;

  const res = await tg('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  if (!res.ok) throw new Error(`Telegram: ${res.description}`);
  console.log(`Sent for ${mytHour}:00 MYT · message_id=${res.result.message_id}`);
}

main().catch(async err => {
  console.error('Hourly report failed:', err.message);
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `<b>⚠️ Hourly report error</b>\n${err.message}`,
      parse_mode: 'HTML',
    }),
  }).catch(() => {});
  process.exit(1);
});
