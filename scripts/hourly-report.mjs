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
    const [pending, channelStats, aa, ar, failed, leadStats, patternCount] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM approvals WHERE status='pending' AND (notes IS NULL OR notes != 'linkedin_requested')`),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE channel = 'email' AND status IN ('sent','approved','pending_send') AND created_at::date = CURRENT_DATE)::int AS email_sent,
          COUNT(*) FILTER (WHERE channel = 'email' AND status IN ('pending_approval') AND created_at::date = CURRENT_DATE)::int AS email_pending,
          COUNT(*) FILTER (WHERE channel = 'email' AND status = 'replied')::int AS email_replied,
          COUNT(*) FILTER (WHERE channel = 'linkedin' AND status IN ('sent','approved','pending_send') AND created_at::date = CURRENT_DATE)::int AS li_sent,
          COUNT(*) FILTER (WHERE channel = 'linkedin' AND status IN ('pending_approval','linkedin_requested') AND created_at::date = CURRENT_DATE)::int AS li_pending,
          COUNT(*) FILTER (WHERE channel = 'linkedin' AND status = 'replied')::int AS li_replied
        FROM messages`),
      pool.query(`SELECT COUNT(*)::int AS c FROM approval_audit WHERE decision='approved' AND created_at::date = CURRENT_DATE`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM approval_audit WHERE decision='rejected' AND created_at::date = CURRENT_DATE`).catch(() => ({ rows: [{ c: 0 }] })),
      pool.query(`SELECT COUNT(*)::int AS c FROM messages WHERE status='failed' AND updated_at > NOW() - INTERVAL '1 hour'`),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE metadata->>'outreach_route' = 'email')::int AS email_route,
          COUNT(*) FILTER (WHERE metadata->>'outreach_route' = 'linkedin')::int AS linkedin_route
        FROM leads WHERE created_at::date = CURRENT_DATE AND deleted_at IS NULL`),
      pool.query(`SELECT content FROM agent_memory WHERE agent = 'research_beaver' AND key = 'email_patterns_verified' LIMIT 1`).catch(() => ({ rows: [] })),
    ]);

    const cs = channelStats.rows[0];
    const ls = leadStats.rows[0];
    const rawPatterns = patternCount.rows[0]?.content;
    const patternN = rawPatterns
      ? Object.keys(typeof rawPatterns === 'string' ? JSON.parse(rawPatterns) : rawPatterns).length
      : 0;

    const text = `<b>[${String(mytHour).padStart(2,'0')}:00 MYT] Hourly</b>

<b>Pipeline (today):</b>
📧 Email:     ${cs.email_sent} sent · ${cs.email_pending} pending · ${cs.email_replied} replied
🔗 LinkedIn:  ${cs.li_sent} sent · ${cs.li_pending} pending · ${cs.li_replied} accepted

<b>DB Builder:</b>
+${ls.total} new leads (${ls.email_route} email-route · ${ls.linkedin_route} linkedin-route)
Pattern memory: ${patternN} verified companies

<b>Queue:</b> ${pending.rows[0].c} pending approval · ${aa.rows[0].c} auto-✅ · ${ar.rows[0].c} auto-❌ · ${failed.rows[0].c} failed

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
