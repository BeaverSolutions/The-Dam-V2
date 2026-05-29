#!/usr/bin/env node
// Read-only post-deploy autonomy verifier.
// Calls /health and /api/autonomous/system-health only. No provider calls,
// no kickoff trigger, no DB writes, no Telegram side effects.

const API_URL = process.env.BEAVRDAM_API_URL || 'https://app.beaver.solutions';
const API_KEY = process.env.BEAVRDAM_INTERNAL_API_KEY;
const CLIENT_SLUG = (process.env.CLIENT_SLUG || 'beaver-solutions').trim();
const EXPECT_DAILY_KICKOFF_ENABLED = process.env.EXPECT_DAILY_KICKOFF_ENABLED === 'true';
const EXPECT_MARKET_SENSING_ENABLED = process.env.EXPECT_MARKET_SENSING_ENABLED === 'true';
const MAX_REVIEWABLE = Number(process.env.MAX_REVIEWABLE_APPROVALS || 20);

if (!API_KEY) {
  console.error('Missing env: BEAVRDAM_INTERNAL_API_KEY');
  process.exit(1);
}

async function getJson(path, headers = {}) {
  const res = await fetch(`${API_URL}${path}`, { headers });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* keep body in error */ }
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

function jobStatus(health, name) {
  return health.jobs?.[name] || null;
}

function pass(checks, name, detail = '') {
  checks.push({ name, ok: true, detail });
}

function fail(checks, name, detail = '') {
  checks.push({ name, ok: false, detail });
}

function validateHealth(checks, health) {
  if (health.status === 'ok') pass(checks, 'public health ok');
  else fail(checks, 'public health ok', `status=${health.status || 'missing'}`);

  if (health.env?.database === 'ok') pass(checks, 'database ok');
  else fail(checks, 'database ok', `database=${health.env?.database || 'missing'}`);

  if (health.env?.encryption_key === 'valid') pass(checks, 'encryption key valid');
  else fail(checks, 'encryption key valid', `encryption_key=${health.env?.encryption_key || 'missing'}`);

  if ((health.stale_jobs || []).length === 0) pass(checks, 'no stale jobs');
  else fail(checks, 'no stale jobs', `stale=${health.stale_jobs.join(',')}`);

  const daily = jobStatus(health, 'daily_kickoff');
  if (!daily) {
    fail(checks, 'daily kickoff job visible', 'job missing from /health');
  } else if (EXPECT_DAILY_KICKOFF_ENABLED) {
    if (daily.status === 'disabled') fail(checks, 'daily kickoff enabled', daily.lastSkipReason || 'disabled');
    else pass(checks, 'daily kickoff enabled', `status=${daily.status}`);
  } else if (daily.status === 'disabled' && /CAPTAIN_DAILY_KICKOFF_ENABLED disabled/.test(daily.lastSkipReason || '')) {
    pass(checks, 'daily kickoff safely disabled', daily.lastSkipReason);
  } else {
    fail(checks, 'daily kickoff safely disabled', `status=${daily.status}, reason=${daily.lastSkipReason || 'none'}`);
  }

  const market = jobStatus(health, 'market_sensing');
  if (!market) {
    fail(checks, 'market sensing job visible', 'job missing from /health');
  } else if (EXPECT_MARKET_SENSING_ENABLED) {
    if (market.status === 'disabled') fail(checks, 'market sensing enabled', market.lastSkipReason || 'disabled');
    else pass(checks, 'market sensing enabled', `status=${market.status}`);
  } else if (market.status === 'disabled' && /MARKET_SENSING_ENABLED disabled/.test(market.lastSkipReason || '')) {
    pass(checks, 'market sensing safely disabled', market.lastSkipReason);
  } else {
    fail(checks, 'market sensing safely disabled', `status=${market.status}, reason=${market.lastSkipReason || 'none'}`);
  }
}

function validateSystemHealth(checks, data) {
  if (data.timezone === 'Asia/Kuala_Lumpur') pass(checks, 'system-health uses MYT');
  else fail(checks, 'system-health uses MYT', `timezone=${data.timezone || 'missing'}`);

  if (data.enabled_slugs?.includes(CLIENT_SLUG)) pass(checks, 'target tenant enabled', CLIENT_SLUG);
  else fail(checks, 'target tenant enabled', `enabled=${data.enabled_slugs?.join(',') || 'empty'}`);

  const target = (data.tenants || []).find(t => t.slug === CLIENT_SLUG);
  if (!target) {
    fail(checks, 'target tenant health present', CLIENT_SLUG);
    return;
  }
  pass(checks, 'target tenant health present', target.name);

  const kickoffState = target.kickoff_today?.state || 'missing';
  if (EXPECT_DAILY_KICKOFF_ENABLED) {
    if (['disabled', 'missed', 'missing'].includes(kickoffState)) {
      fail(checks, 'kickoff state not disabled/missed', kickoffState);
    } else {
      pass(checks, 'kickoff state not disabled/missed', kickoffState);
    }
  } else if (kickoffState === 'disabled') {
    pass(checks, 'system-health reports kickoff disabled', kickoffState);
  } else {
    fail(checks, 'system-health reports kickoff disabled', kickoffState);
  }

  const aq = target.approval_queue || {};
  for (const key of ['reviewable', 'linkedin_awaiting_accept', 'stale_orphan_rows']) {
    if (Number.isFinite(Number(aq[key]))) pass(checks, `approval queue exposes ${key}`, String(aq[key]));
    else fail(checks, `approval queue exposes ${key}`, 'missing/non-numeric');
  }

  if (Number(aq.reviewable || 0) <= MAX_REVIEWABLE) {
    pass(checks, 'reviewable approvals under cap', `${aq.reviewable || 0}/${MAX_REVIEWABLE}`);
  } else {
    fail(checks, 'reviewable approvals under cap', `${aq.reviewable}/${MAX_REVIEWABLE}`);
  }

  const stale = Number(aq.stale_orphan_rows || 0);
  if (stale > 0) {
    checks.push({ name: 'stale approval rows reported', ok: true, detail: `${stale} stale rows; cleanup required but not hidden` });
  }
}

async function main() {
  const checks = [];
  const [health, systemHealth] = await Promise.all([
    getJson('/health'),
    getJson('/api/autonomous/system-health', { 'x-internal-key': API_KEY }),
  ]);

  validateHealth(checks, health);
  validateSystemHealth(checks, systemHealth.data || {});

  for (const c of checks) {
    console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);
  }

  const failures = checks.filter(c => !c.ok);
  console.log(`\n${checks.length} checks: ${checks.length - failures.length} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch(err => {
  console.error('[post-deploy-autonomy-check] failed:', err.message);
  process.exit(1);
});
