'use strict';
/**
 * E2E Happy Path Test
 *
 * Tests the full API flow without a browser:
 *   Login → Stats → Leads → Messages → Approvals → Logs → Agent memory
 *
 * Usage:
 *   node scripts/e2eTest.js [base_url] [email] [password]
 *
 * Defaults to local dev server with seed credentials.
 */

const BASE = process.argv[2] || 'http://localhost:3001';
const EMAIL = process.argv[3] || 'admin@beaversolutions.com';
const PASS = process.argv[4] || 'admin123456';

let passed = 0;
let failed = 0;
let cookie = '';

function ok(label) {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label, detail) {
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

async function req(method, path, body, expectStatus = 200) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}/api${path}`, opts);

  // Capture Set-Cookie on login
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const data = await res.json().catch(() => null);
  if (res.status !== expectStatus) {
    throw new Error(`HTTP ${res.status} (expected ${expectStatus}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function run() {
  console.log(`\nE2E Happy Path — ${BASE}\n`);

  // ── 1. Auth ────────────────────────────────────────────────
  console.log('1. Auth');
  try {
    const res = await req('POST', '/auth/login', { email: EMAIL, password: PASS });
    if (!res?.data?.user?.id) throw new Error('no user in response');
    if (!cookie) throw new Error('no Set-Cookie header — httpOnly cookie not set');
    ok('POST /auth/login — sets httpOnly cookie');
  } catch (e) { fail('POST /auth/login', e.message); return; }

  try {
    const res = await req('GET', '/auth/me');
    if (!res?.data?.email) throw new Error('no email in /me response');
    ok('GET /auth/me — cookie auth works');
  } catch (e) { fail('GET /auth/me', e.message); }

  // ── 2. Dashboard ───────────────────────────────────────────
  console.log('\n2. Dashboard');
  try {
    const res = await req('GET', '/dashboard/stats');
    const d = res?.data;
    if (d?.total_leads === undefined) throw new Error('missing total_leads');
    ok(`GET /dashboard/stats — total_leads=${d.total_leads}, pending=${d.pending_approvals}`);
  } catch (e) { fail('GET /dashboard/stats', e.message); }

  try {
    const res = await req('GET', '/dashboard/daily-progress');
    if (!res?.data?.target) throw new Error('missing target');
    ok(`GET /dashboard/daily-progress — target=${res.data.target}, sent=${res.data.sent}`);
  } catch (e) { fail('GET /dashboard/daily-progress', e.message); }

  // ── 3. Leads ───────────────────────────────────────────────
  console.log('\n3. Leads');
  let leadId;
  try {
    const res = await req('GET', '/leads?perPage=5');
    if (!Array.isArray(res?.data)) throw new Error('data is not array');
    if (res.meta?.total === undefined) throw new Error('missing meta.total');
    ok(`GET /leads — total=${res.meta.total}, returned=${res.data.length}`);
    leadId = res.data[0]?.id;
  } catch (e) { fail('GET /leads', e.message); }

  if (leadId) {
    try {
      const res = await req('GET', `/leads/${leadId}`);
      if (!res?.data?.id) throw new Error('missing lead id');
      ok(`GET /leads/:id — ${res.data.name || leadId}`);
    } catch (e) { fail('GET /leads/:id', e.message); }
  }

  // ── 4. Messages ────────────────────────────────────────────
  console.log('\n4. Messages');
  try {
    const res = await req('GET', '/messages?perPage=5');
    if (!Array.isArray(res?.data)) throw new Error('data is not array');
    ok(`GET /messages — total=${res.meta?.total}, returned=${res.data.length}`);
  } catch (e) { fail('GET /messages', e.message); }

  try {
    const res = await req('GET', '/messages?status=ranger_rejected&perPage=1');
    const count = res?.meta?.total ?? 0;
    ok(`GET /messages?status=ranger_rejected — count=${count}`);
  } catch (e) { fail('GET /messages?status=ranger_rejected', e.message); }

  // ── 5. Approvals ───────────────────────────────────────────
  console.log('\n5. Approvals');
  try {
    const res = await req('GET', '/approvals?status=pending');
    if (!Array.isArray(res?.data)) throw new Error('data is not array');
    ok(`GET /approvals?status=pending — count=${res.meta?.total}`);
  } catch (e) { fail('GET /approvals?status=pending', e.message); }

  // ── 6. Logs ────────────────────────────────────────────────
  console.log('\n6. Activity Logs');
  try {
    const res = await req('GET', '/logs?perPage=5');
    if (!Array.isArray(res?.data)) throw new Error('data is not array');
    ok(`GET /logs — total=${res.meta?.total}`);
  } catch (e) { fail('GET /logs', e.message); }

  // ── 7. Integrations ────────────────────────────────────────
  console.log('\n7. Integrations');
  try {
    const res = await req('GET', '/integrations/status');
    if (!res?.data) throw new Error('no data');
    const gm = res.data.gmail?.connected;
    const am = res.data.agentmail?.connected;
    ok(`GET /integrations/status — gmail=${gm}, agentmail=${am}`);
  } catch (e) { fail('GET /integrations/status', e.message); }

  // ── 8. Agent memory ────────────────────────────────────────
  console.log('\n8. Agent Memory');
  try {
    const res = await req('GET', '/agents/memory');
    if (!Array.isArray(res?.data)) throw new Error('data is not array');
    ok(`GET /agents/memory — ${res.data.length} entries`);
  } catch (e) { fail('GET /agents/memory', e.message); }

  // ── 9. Logout ──────────────────────────────────────────────
  console.log('\n9. Logout');
  try {
    await req('POST', '/auth/logout');
    ok('POST /auth/logout — cookie cleared');
  } catch (e) { fail('POST /auth/logout', e.message); }

  try {
    await req('GET', '/auth/me', undefined, 401);
    ok('GET /auth/me after logout — correctly returns 401');
  } catch (e) { fail('GET /auth/me after logout', e.message); }

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  const total = passed + failed;
  console.log(`${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) {
    console.error('\nSome tests failed — check server logs for details.');
    process.exit(1);
  } else {
    console.log('\nAll tests passed.');
  }
}

run().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
