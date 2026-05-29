#!/usr/bin/env node
// Daily Health Pack — fires 09:05 MYT (01:05 UTC) via GitHub Actions cron.
// Pulls /api/autonomous/system-health and posts a Telegram summary so MJ
// sees pipeline state before opening Claude Code.
//
// Env required:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
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
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  return res.json();
}

function emoji(ok) { return ok ? '🟢' : '🔴'; }

function kickoffLabel(kickoff) {
  const state = kickoff?.state || (kickoff?.fired ? 'fired' : 'unknown');
  if (state === 'fired') {
    return `✅ fired${kickoff.at ? ` (${new Date(kickoff.at).toLocaleTimeString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' })} MYT)` : ''}`;
  }
  if (state === 'waiting') return '⏳ waiting for 09:30 MYT';
  if (state === 'window_open') return '⏳ 09:30 window open';
  if (state === 'started') return '⚠ started marker only; no work proof';
  if (state === 'disabled') return '🔴 disabled';
  if (state === 'missed') return '🔴 MISSED';
  return `⚠ ${state}`;
}

async function main() {
  const statsRes = await fetch(`${API_URL}/api/autonomous/system-health`, {
    headers: { 'x-internal-key': API_KEY },
  });
  if (!statsRes.ok) {
    const body = await statsRes.text().catch(() => '');
    await tg(`<b>Health Pack FAILED</b>\n\nAPI ${statsRes.status}: ${body.slice(0, 200)}`);
    process.exit(1);
  }
  const { data } = await statsRes.json();

  const lines = [];
  lines.push('<b>BeavrDam Health Pack — ' + data.date + '</b>');
  lines.push('');

  // Env presence
  lines.push('<b>Env</b>');
  lines.push(`${emoji(data.telegram_chat_id_present)} Telegram chat id`);
  lines.push(`${emoji(data.telegram_bot_token_present)} Telegram bot token`);
  lines.push(`${emoji(data.agentmail_configured)} AgentMail API key`);
  lines.push(`${emoji(data.gmail_oauth_configured)} Gmail OAuth`);
  lines.push('');

  if (!data.enabled_slugs?.length) {
    lines.push('🔴 <b>AUTONOMOUS_ENABLED_CLIENTS empty</b> — no tenant in autonomous mode.');
    await tg(lines.join('\n'));
    return;
  }

  for (const t of data.tenants) {
    lines.push(`<b>${t.name}</b>`);
    const kpi = t.kpi || {};
    const target = kpi.target ?? '?';
    const sent = t.messages?.sent_today ?? 0;
    const pending = t.messages?.pending_today ?? 0;
    const rejected = t.messages?.rejected_today ?? 0;
    const gap = (kpi.target ?? 0) - sent;
    lines.push(`Target ${target} · Sent ${sent} · Pending ${pending} · Rejected ${rejected} · Gap ${gap}`);
    lines.push(`Kickoff: ${kickoffLabel(t.kickoff_today)}`);
    const aue = t.approved_unsent?.email ?? 0;
    const auli = t.approved_unsent?.linkedin ?? 0;
    lines.push(`Approved unsent: ${aue} email · ${auli} linkedin`);
    const aq = t.approval_queue || {};
    lines.push(`Approval queue: ${aq.reviewable ?? 0} reviewable · ${aq.linkedin_awaiting_accept ?? 0} LinkedIn awaiting accept · ${aq.stale_orphan_rows ?? 0} stale rows`);
    const fq = t.followup_queue || {};
    lines.push(`Follow-ups: ${fq.due_today ?? 0} due today · ${fq.pending ?? 0} pending · ${fq.orphaned_sent_leads ?? 0} orphaned sent leads`);
    const sq = t.send_queue || {};
    lines.push(`Send queue: ${sq.sq_pending ?? 0} pending · ${sq.sq_stuck ?? 0} stuck >1h · ${sq.sq_failed ?? 0} failed`);
    const rb = t.research_beaver || {};
    lines.push(`Research Beaver: ${rb.leads_saved_24h ?? 0} saved · ${rb.no_results_24h ?? 0} no-results · last run ${rb.last_run ? new Date(rb.last_run).toISOString().slice(0, 10) : 'NEVER'}`);
    lines.push(`Lead pool remaining: ${t.lead_pool_remaining}`);
    const ig = t.integrations || {};
    lines.push(`Integrations: ${emoji(ig.gmail_connected)} Gmail · ${emoji(ig.calendar_connected)} Calendar · ${emoji(ig.hunter_configured)} Hunter · ${emoji(ig.agentmail_provisioned)} AgentMail`);
    lines.push('');
  }

  // Health verdict
  const t0 = data.tenants[0];
  const verdict = [];
  if (t0?.kickoff_today?.state === 'missed') verdict.push('❌ kickoff missed');
  if (t0?.kickoff_today?.state === 'disabled') verdict.push('❌ daily kickoff disabled');
  if ((t0?.research_beaver?.leads_saved_24h ?? 0) < 10 && (t0?.lead_pool_remaining ?? 0) < 30) verdict.push('⚠ research starved and lead pool thin');
  if ((t0?.send_queue?.sq_stuck ?? 0) > 0) verdict.push('⚠ send queue stuck');
  if ((t0?.approval_queue?.reviewable ?? 0) > 20) verdict.push(`⚠ ${t0.approval_queue.reviewable} reviewable approvals waiting`);
  if ((t0?.approval_queue?.stale_orphan_rows ?? 0) > 0) verdict.push(`⚠ ${t0.approval_queue.stale_orphan_rows} stale approval rows need cleanup`);
  if ((t0?.followup_queue?.due_today ?? 0) > 20) verdict.push(`⚠ ${t0.followup_queue.due_today} follow-ups due today`);
  if ((t0?.followup_queue?.orphaned_sent_leads ?? 0) > 0) verdict.push(`⚠ ${t0.followup_queue.orphaned_sent_leads} sent leads missing follow-up rows`);
  if (!data.gmail_oauth_configured && !data.agentmail_configured) verdict.push('❌ NO email provider configured');

  if (verdict.length) {
    lines.push('<b>Action needed:</b>');
    verdict.forEach(v => lines.push('• ' + v));
  } else {
    lines.push('🟢 All green.');
  }

  lines.push('');
  lines.push(`<a href="${API_URL}/approvals">Open BeavrDam →</a>`);

  await tg(lines.join('\n'));
}

main().catch(err => {
  console.error('[health-pack] failed:', err);
  tg(`<b>Health Pack ERROR</b>\n\n${err.message?.slice(0, 300) || 'unknown'}`).catch(() => {});
  process.exit(1);
});
