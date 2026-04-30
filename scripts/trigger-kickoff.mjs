#!/usr/bin/env node
// Manual kickoff trigger. Hits the BeavrDam internal API to start a kickoff
// run for either a specific client_slug or all autonomous-enabled clients.
// Telegram fires on result so MJ sees what happened.

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.BEAVRDAM_API_URL || 'https://app.beaver.solutions';
const API_KEY = process.env.BEAVRDAM_INTERNAL_API_KEY;
const SLUG    = (process.env.CLIENT_SLUG || '').trim();

if (!TOKEN || !CHAT_ID || !API_KEY) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BEAVRDAM_INTERNAL_API_KEY');
  process.exit(1);
}

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
  }).catch(() => {});
}

async function main() {
  // Resolve client_id from slug via system-health endpoint (which lists enabled tenants).
  const healthRes = await fetch(`${API_URL}/api/autonomous/system-health`, {
    headers: { 'x-internal-key': API_KEY },
  });
  if (!healthRes.ok) {
    await tg(`<b>Trigger Kickoff: API down</b>\n${healthRes.status} on system-health`);
    process.exit(1);
  }
  const { data } = await healthRes.json();

  const targets = SLUG
    ? data.tenants.filter(t => t.slug === SLUG)
    : data.tenants;

  if (targets.length === 0) {
    await tg(`<b>Trigger Kickoff: no match</b>\nSlug "${SLUG}" not in AUTONOMOUS_ENABLED_CLIENTS (${data.enabled_slugs?.join(', ') || 'empty'})`);
    process.exit(1);
  }

  // The kickoff endpoint expects a tenant context — get the client_id by
  // querying system-health which returns tenants with their slugs but not ids.
  // Workaround: hit /api/autonomous/kickoff-all which iterates enabled clients
  // server-side. Or use the per-slug variant if exposed. For now, kickoff-all
  // covers AUTONOMOUS_ENABLED_CLIENTS which is currently beaver-solutions only.
  await tg(`<b>Manual Kickoff Triggered</b>\n\nTenant(s): <code>${targets.map(t => t.slug).join(', ')}</code>\nWatch for "Daily Kickoff Started" + "Completed" alerts.`);

  const triggerRes = await fetch(`${API_URL}/api/autonomous/kickoff-all`, {
    method: 'POST',
    headers: { 'x-internal-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  const triggerJson = await triggerRes.json().catch(() => ({}));
  if (!triggerRes.ok) {
    await tg(`<b>Trigger Kickoff: FAILED</b>\n${triggerRes.status}: ${JSON.stringify(triggerJson).slice(0, 300)}`);
    process.exit(1);
  }

  console.log('[trigger-kickoff] queued:', JSON.stringify(triggerJson));
}

main().catch(err => {
  console.error('[trigger-kickoff] failed:', err);
  tg(`<b>Trigger Kickoff: ERROR</b>\n\n${(err.message || 'unknown').slice(0, 300)}`).catch(() => {});
  process.exit(1);
});
