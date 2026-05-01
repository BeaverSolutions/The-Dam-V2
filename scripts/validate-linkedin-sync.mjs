#!/usr/bin/env node
// One-off validator for POST /api/autonomous/linkedin-sync-replies.
// Hits the endpoint with an empty batch, then with two synthetic replies
// (one inbound matching a known sent message, one outbound) and reports
// the response via Telegram. Read-only payload from the matcher's POV
// EXCEPT when CLIENT_ID + LEAD_PROFILE_URL match a real lead with a real
// sent LinkedIn message — in that case it WILL mark reply_detected_at.
// Set DRY=1 to skip the marking call (sentinel-only auth + empty batch).

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.BEAVRDAM_API_URL || 'https://app.beaver.solutions';
const API_KEY = process.env.BEAVRDAM_INTERNAL_API_KEY;
const CLIENT_ID = process.env.CLIENT_ID || 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';
const TEST_PROFILE = process.env.TEST_PROFILE_URL || '';
const DRY = process.env.DRY === '1';

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

async function call(payload) {
  const res = await fetch(`${API_URL}/api/autonomous/linkedin-sync-replies`, {
    method: 'POST',
    headers: { 'x-internal-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({ raw: 'invalid_json' }));
  return { status: res.status, json };
}

async function main() {
  // 1. Empty batch → expect 200 + received:0
  const empty = await call({ client_id: CLIENT_ID, replies: [] });
  console.log('[empty]', empty.status, JSON.stringify(empty.json));

  // 2. Outbound-only → expect 200 + skipped_outbound_only:1
  const outbound = await call({
    client_id: CLIENT_ID,
    replies: [{
      profile_url: 'https://www.linkedin.com/in/test-outbound-only-fake/',
      last_msg_text: 'You: hi from me',
      last_msg_at: new Date().toISOString(),
      last_msg_from_me: true,
    }],
  });
  console.log('[outbound]', outbound.status, JSON.stringify(outbound.json));

  // 3. Inbound but no matching lead → expect 200 + skipped_no_match:1
  const noMatch = await call({
    client_id: CLIENT_ID,
    replies: [{
      profile_url: 'https://www.linkedin.com/in/definitely-not-a-real-lead-' + Date.now() + '/',
      last_msg_text: 'thanks for reaching out',
      last_msg_at: new Date().toISOString(),
      last_msg_from_me: false,
    }],
  });
  console.log('[no_match]', noMatch.status, JSON.stringify(noMatch.json));

  let realResult = null;
  if (TEST_PROFILE && !DRY) {
    // 4. Real inbound on a real lead → expect 200 + matched_leads:1 + new_replies:1
    const real = await call({
      client_id: CLIENT_ID,
      replies: [{
        profile_url: TEST_PROFILE,
        last_msg_text: '[validation] Synthetic reply for Day 2 endpoint validation. Safe to revert: UPDATE messages SET reply_detected_at=NULL, reply_snippet=NULL WHERE reply_snippet LIKE \'[validation]%\';',
        last_msg_at: new Date().toISOString(),
        last_msg_from_me: false,
      }],
    });
    realResult = real;
    console.log('[real]', real.status, JSON.stringify(real.json));
  }

  const lines = [
    '<b>linkedin-sync-replies validation</b>',
    '',
    `empty:    HTTP ${empty.status} · received=${empty.json.data?.received ?? '?'} · new=${empty.json.data?.new_replies ?? '?'}`,
    `outbound: HTTP ${outbound.status} · skipped_outbound=${outbound.json.data?.skipped_outbound_only ?? '?'}`,
    `no_match: HTTP ${noMatch.status} · skipped_no_match=${noMatch.json.data?.skipped_no_match ?? '?'}`,
  ];
  if (realResult) {
    lines.push(`real:     HTTP ${realResult.status} · matched=${realResult.json.data?.matched_leads ?? '?'} · new_replies=${realResult.json.data?.new_replies ?? '?'}`);
    if (realResult.json.data?.details?.[0]) {
      const d = realResult.json.data.details[0];
      lines.push(`           lead_id=${(d.lead_id || '?').slice(0,8)}.. result=${d.result}`);
    }
  } else if (TEST_PROFILE) {
    lines.push('real:     SKIPPED (DRY=1)');
  } else {
    lines.push('real:     SKIPPED (no TEST_PROFILE_URL)');
  }

  await tg(lines.join('\n'));

  // Exit non-zero if any auth/route failure occurred
  const allOk = [empty.status, outbound.status, noMatch.status].every(s => s === 200);
  if (!allOk) process.exit(1);
}

main().catch(err => {
  console.error('[validate-linkedin-sync] failed:', err);
  tg(`<b>linkedin-sync-replies validation: ERROR</b>\n\n${(err.message || 'unknown').slice(0, 300)}`).catch(() => {});
  process.exit(1);
});
