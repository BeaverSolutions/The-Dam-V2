#!/usr/bin/env node
// Hourly status report — runs via GitHub Actions cron at :07 each UTC hour.
// Skips fires outside 09:00–19:00 MYT (01:00–11:00 UTC).
// Queries BeavrDam Postgres for counts + pushes to Telegram.
//
// Env required:
//   TELEGRAM_BOT_TOKEN     Jarvis bot (@BeaverSolutionsBot)
//   TELEGRAM_CHAT_ID       MJ's numeric chat id
//   BEAVRDAM_DATABASE_URL  Railway Postgres connection string

import pg from 'pg';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DB_URL = process.env.BEAVRDAM_DATABASE_URL;

if (!TOKEN || !CHAT_ID || !DB_URL) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BEAVRDAM_DATABASE_URL');
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
  const pool = new pg.Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

  try {
    const [pending, msgsToday, aa, ar, failed] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM approvals WHERE status='pending' AND (notes IS NULL OR notes != 'linkedin_requested')`),
      pool.query(`SELECT COUNT(*)::int AS c FROM messages WHERE status IN ('sent','approved','pending_send') AND created_at::date = CURRENT_DATE`),
      pool.query(`SELECT COUNT(*)::int AS c FROM approval_audit WHERE decision='approved' AND created_at::date = CURRENT_DATE`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM approval_audit WHERE decision='rejected' AND created_at::date = CURRENT_DATE`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM messages WHERE status='failed' AND updated_at > NOW() - INTERVAL '1 hour'`),
    ]);

    const text = `<b>[${String(mytHour).padStart(2,'0')}:00 MYT] Hourly</b>

<b>BeavrDam:</b>
• ${pending.rows[0].c} pending approvals
• ${msgsToday.rows[0].c} messages today
• ${aa.rows[0].c} auto-✅ · ${ar.rows[0].c} auto-❌
• ${failed.rows[0].c} failed last hour

<b>Q2:</b> 20 clients (10 Beaver + 10 Emplifive)`;

    const res = await tg('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'HTML' });
    if (!res.ok) throw new Error(`Telegram: ${res.description}`);
    console.log(`Sent for ${mytHour}:00 MYT · message_id=${res.result.message_id}`);
  } catch (err) {
    console.error('Hourly report failed:', err.message);
    await tg('sendMessage', {
      chat_id: CHAT_ID,
      text: `<b>⚠️ Hourly report error</b>\n${err.message}`,
      parse_mode: 'HTML'
    }).catch(() => {});
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
