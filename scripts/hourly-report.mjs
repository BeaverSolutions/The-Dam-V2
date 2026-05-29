#!/usr/bin/env node
// Hourly status report. Read-only: pulls /api/autonomous/system-health and
// sends Telegram. Does not trigger kickoff, sourcing, providers, or DB writes.

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.BEAVRDAM_API_URL || 'https://app.beaver.solutions';
const API_KEY = process.env.BEAVRDAM_INTERNAL_API_KEY;

if (!TOKEN || !CHAT_ID || !API_KEY) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BEAVRDAM_INTERNAL_API_KEY');
  process.exit(1);
}

const WORK_START_UTC = 1;   // 09:00 MYT
const WORK_END_UTC   = 11;  // 19:00 MYT inclusive

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function kickoffLabel(kickoff) {
  const state = kickoff?.state || 'unknown';
  if (state === 'fired') return `fired${kickoff.at ? ` (${new Date(kickoff.at).toLocaleTimeString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' })} MYT)` : ''}`;
  if (state === 'waiting') return 'waiting for 09:30 MYT';
  if (state === 'window_open') return '09:30 window open';
  return state;
}

async function main() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const force = process.argv.includes('--force');

  if (!force && (utcHour < WORK_START_UTC || utcHour > WORK_END_UTC)) {
    console.log(`Skipping: UTC hour ${utcHour} outside 09-19 MYT window`);
    return;
  }

  const healthRes = await fetch(`${API_URL}/api/autonomous/system-health`, {
    headers: { 'x-internal-key': API_KEY },
  });
  if (!healthRes.ok) {
    const body = await healthRes.text().catch(() => '');
    throw new Error(`BeavrDam API ${healthRes.status}: ${body.slice(0, 300)}`);
  }

  const { data } = await healthRes.json();
  const mytHour = Math.floor((Number(data.kl_minutes_now || ((utcHour + 8) % 24) * 60)) / 60);
  const tenant = data.tenants?.[0];
  if (!tenant) {
    throw new Error(`No tenant returned by system-health. enabled_slugs=${data.enabled_slugs?.join(',') || 'empty'}`);
  }

  const kpi = tenant.kpi || {};
  const messages = tenant.messages || {};
  const approvalQueue = tenant.approval_queue || {};
  const sendQueue = tenant.send_queue || {};
  const research = tenant.research_beaver || {};
  const integrations = tenant.integrations || {};
  const sent = messages.sent_today ?? 0;
  const target = kpi.target ?? '?';
  const pendingToday = messages.pending_today ?? 0;
  const rejectedToday = messages.rejected_today ?? 0;
  const approvedEmail = tenant.approved_unsent?.email ?? 0;
  const approvedLinkedIn = tenant.approved_unsent?.linkedin ?? 0;
  const reviewable = approvalQueue.reviewable ?? 0;
  const awaitingAccept = approvalQueue.linkedin_awaiting_accept ?? 0;
  const staleRows = approvalQueue.stale_orphan_rows ?? 0;

  const lines = [
    `<b>[${String(mytHour).padStart(2, '0')}:00 MYT] BeavrDam Hourly</b>`,
    '',
    `<b>${tenant.name}</b>`,
    `Kickoff: ${kickoffLabel(tenant.kickoff_today)}`,
    `Sent today: ${sent}/${target}. Pending today: ${pendingToday}. Rejected today: ${rejectedToday}.`,
    `Approval queue: ${reviewable} reviewable, ${awaitingAccept} LinkedIn awaiting accept, ${staleRows} stale rows.`,
    `Approved unsent: ${approvedEmail} email, ${approvedLinkedIn} LinkedIn.`,
    `Send queue: ${sendQueue.sq_pending ?? 0} pending, ${sendQueue.sq_stuck ?? 0} stuck, ${sendQueue.sq_failed ?? 0} failed.`,
    `Research: ${research.leads_saved_24h ?? 0} saved in 24h, ${research.no_results_24h ?? 0} no-result runs, pool ${tenant.lead_pool_remaining ?? '?'}.`,
    `Integrations: Gmail ${integrations.gmail_connected ? 'connected' : 'missing'}, AgentMail ${integrations.agentmail_provisioned ? 'ready' : 'missing'}.`,
    '',
    `Daily kickoff gate: ${data.captain_daily_kickoff_enabled ? 'enabled' : 'disabled'}. Market sensing: ${data.market_sensing_enabled ? 'enabled' : 'disabled'}.`,
  ];

  const res = await tg('sendMessage', { chat_id: CHAT_ID, text: lines.join('\n'), parse_mode: 'HTML' });
  if (!res.ok) throw new Error(`Telegram: ${res.description}`);
  console.log(`Sent hourly report for ${tenant.slug} at ${mytHour}:00 MYT; message_id=${res.result.message_id}`);
}

main().catch(async err => {
  console.error('Hourly report failed:', err.message);
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `<b>Hourly report error</b>\n${err.message}`,
      parse_mode: 'HTML',
    }),
  }).catch(() => {});
  process.exit(1);
});
