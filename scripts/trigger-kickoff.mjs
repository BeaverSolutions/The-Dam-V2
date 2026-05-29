#!/usr/bin/env node
// Manual single-tenant kickoff trigger.
// Requires CLIENT_SLUG. Never uses /kickoff-all and never force-overrides
// dedupe gates; both caused prior paid-provider burn incidents.

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.BEAVRDAM_API_URL || 'https://app.beaver.solutions';
const API_KEY = process.env.BEAVRDAM_INTERNAL_API_KEY;
const SLUG    = (process.env.CLIENT_SLUG || '').trim();

if (!TOKEN || !CHAT_ID || !API_KEY) {
  console.error('Missing env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BEAVRDAM_INTERNAL_API_KEY');
  process.exit(1);
}
if (!SLUG) {
  console.error('Missing env: CLIENT_SLUG. Refusing all-tenant kickoff.');
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

  const targets = data.tenants.filter(t => t.slug === SLUG);

  if (targets.length === 0) {
    await tg(`<b>Trigger Kickoff: no match</b>\nSlug "${SLUG}" not in AUTONOMOUS_ENABLED_CLIENTS (${data.enabled_slugs?.join(', ') || 'empty'})`);
    process.exit(1);
  }
  if (targets.length > 1) {
    await tg(`<b>Trigger Kickoff: unsafe target set</b>\nSlug "${SLUG}" resolved to ${targets.length} tenants. Refusing.`);
    process.exit(1);
  }
  const target = targets[0];
  if (!target.client_id) {
    await tg(`<b>Trigger Kickoff: missing client_id</b>\n/system-health did not return a client_id for <code>${SLUG}</code>. Refusing fallback to kickoff-all.`);
    process.exit(1);
  }

  await tg(`<b>Manual Kickoff Triggered</b>\n\nTenant: <code>${target.slug}</code>\nEndpoint: <code>/api/autonomous/kickoff</code>\nNo force override.`);

  const triggerRes = await fetch(`${API_URL}/api/autonomous/kickoff`, {
    method: 'POST',
    headers: { 'x-internal-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: target.client_id }),
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
