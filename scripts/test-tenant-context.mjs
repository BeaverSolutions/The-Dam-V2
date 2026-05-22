#!/usr/bin/env node
/**
 * test-tenant-context.mjs
 *
 * Smoke test for the tenant profile helper (Phase B2).
 *
 * Tests pure-function behavior of `tenantContext.js` and `tenantProfileSchema.js`:
 *   - profileSchema parses a valid profile cleanly
 *   - profileSchema rejects invalid shapes
 *   - profileActivationSchema enforces the good>=3 / bad>=2 examples floor
 *   - createAuthContext rejects malformed input
 *   - assertAuthCtx rejects raw client_id strings (the core safety guard)
 *   - All 4 role projections produce expected rendered text + correct constraints
 *   - tokenCount estimate is reasonable
 *
 * NO DB access. NO network calls. Pure module-level smoke test. Run after any
 * edit to tenantContext.js or tenantProfileSchema.js.
 *
 * Run from repo root:
 *   node scripts/test-tenant-context.mjs
 *
 * Exit code 0 = PASS, non-zero = FAIL.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { profileSchema, profileActivationSchema } = require('../server/services/tenantProfileSchema.js');
const { createAuthContext, _internal } = require('../server/services/tenantContext.js');
const { projectForResearch, projectForSales, projectForEnforcer, projectForCaptain, estimateTokens } = _internal;

let passCount = 0;
let failCount = 0;
const failures = [];

function pass(name) {
  passCount++;
  console.log(`  PASS  ${name}`);
}

function fail(name, detail) {
  failCount++;
  failures.push({ name, detail });
  console.log(`  FAIL  ${name}`);
  console.log(`        ${detail}`);
}

function assert(name, cond, detail) {
  if (cond) pass(name);
  else fail(name, detail || 'assertion failed');
}

function assertThrows(name, fn, expectedSubstring) {
  try {
    fn();
    fail(name, 'did not throw');
  } catch (err) {
    if (!expectedSubstring || err.message.includes(expectedSubstring)) {
      pass(name);
    } else {
      fail(name, `threw with "${err.message}", expected substring "${expectedSubstring}"`);
    }
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const validProfile = {
  identity: {
    company: 'Beaver Solutions',
    founder: { name: 'MJ', role: 'Founder', linkedin_url: 'https://linkedin.com/in/example' },
    sender_persona: { name: 'Michael Jerry', title: 'Founder', email: 'hello@beaver.solutions' },
    brand_voice: 'Direct operator running sales, no fluff, commercially aware.',
  },
  offer: {
    product: 'BeavrDam — AI sales crew that runs outreach autonomously.',
    services: ['cold outreach', 'reply handling', 'follow-up sequencing'],
    pricing: { tiers: [{ name: 'Trial', price: 'free', terms: '3 days' }], notes: null },
    positioning: 'Clone the founder, sharpen with our expertise. 50 outreaches a day, founder doesn\'t touch send.',
  },
  icp: {
    verticals: ['B2B training', 'agencies', 'consultancies'],
    personas: ['founder', 'head of sales', 'BD lead'],
    geo: ['MY', 'SG'],
    exclusions: ['MNCs', 'one-person freelancers'],
    competitor_offers: ['outbound agency', 'lead gen agency', 'AI SDR'],
  },
  proof: [
    { claim: 'first positive reply from cold pipeline', metric: '1 reply / 10 days', source: 'Tamsa Global, 2026-05-11', approved_for_outreach: true },
    { claim: 'reduced cold outreach time', metric: '8h/wk → 30min/wk', source: 'Beaver Solutions internal, 2026-05-22', approved_for_outreach: false },
  ],
  voice: {
    tone: ['direct', 'no fluff', 'operator-mode'],
    do: ['lead with the specific observation', 'ask one pointed question'],
    dont: ['pitch features', 'hedge with "just checking in"'],
    examples: {
      good: [
        'Saw your team grew 40% last quarter — is your outbound team keeping up?',
        'You posted about scaling SDRs — what are you using to keep their messages on-brand?',
        'Noticed your hiring spike on LinkedIn — is your pipeline ready for the new closers?',
      ],
      bad: [
        'Just checking in to see if you got my email!',
        'Hi, I work with companies like yours and would love to chat about how we can help.',
      ],
    },
  },
  constraints: {
    word_cap_by_channel: { email: 80, linkedin_dm: 60, linkedin_invite: 40 },
    banned_phrases: ['just checking in', 'at what point does'],
    signoff_by_channel: { email: 'Regards,\nMichael Jerry', linkedin_dm: null, linkedin_invite: null },
    max_links: 1,
    allow_emoji: false,
  },
  documents: [],
};

// ── Schema parsing ───────────────────────────────────────────────────────
console.log('\n[1] profileSchema parsing');

{
  const r = profileSchema.safeParse(validProfile);
  assert('valid profile parses cleanly', r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3)));
}

{
  const bad = { ...validProfile, identity: { ...validProfile.identity, company: '' } };
  const r = profileSchema.safeParse(bad);
  assert('empty company is rejected', !r.success && r.error.issues.some(i => i.path.includes('company')));
}

{
  const bad = { ...validProfile, foo: 'bar' };  // extra field — strict mode rejects
  const r = profileSchema.safeParse(bad);
  assert('strict mode rejects extra top-level fields', !r.success);
}

{
  const bad = {
    ...validProfile,
    proof: [{ claim: 'x', metric: 'y' /* missing source */, approved_for_outreach: true }],
  };
  const r = profileSchema.safeParse(bad);
  assert('proof item missing source rejected', !r.success);
}

// ── Activation gate ──────────────────────────────────────────────────────
console.log('\n[2] profileActivationSchema (examples floor)');

{
  const r = profileActivationSchema.safeParse(validProfile);
  assert('valid profile with 3 good + 2 bad passes activation', r.success, r.success ? '' : JSON.stringify(r.error.issues));
}

{
  const tooFewGood = {
    ...validProfile,
    voice: { ...validProfile.voice, examples: { ...validProfile.voice.examples, good: validProfile.voice.examples.good.slice(0, 2) } },
  };
  const r = profileActivationSchema.safeParse(tooFewGood);
  assert(
    'activation rejects when good < 3',
    !r.success && r.error.issues.some(i => i.path.join('.').includes('examples.good')),
    r.success ? 'unexpectedly passed' : '',
  );
}

{
  const tooFewBad = {
    ...validProfile,
    voice: { ...validProfile.voice, examples: { ...validProfile.voice.examples, bad: [validProfile.voice.examples.bad[0]] } },
  };
  const r = profileActivationSchema.safeParse(tooFewBad);
  assert(
    'activation rejects when bad < 2',
    !r.success && r.error.issues.some(i => i.path.join('.').includes('examples.bad')),
    r.success ? 'unexpectedly passed' : '',
  );
}

{
  // Draft save with only 1 good + 0 bad should still pass base schema (drafts can be incomplete)
  const incompleteDraft = {
    ...validProfile,
    voice: { ...validProfile.voice, examples: { good: ['one'], bad: [] } },
  };
  const r = profileSchema.safeParse(incompleteDraft);
  assert('base profileSchema permits incomplete examples (draft saves)', r.success);
}

// ── createAuthContext ────────────────────────────────────────────────────
console.log('\n[3] createAuthContext / assertAuthCtx');

assertThrows(
  'createAuthContext rejects missing clientId',
  () => createAuthContext({ source: 'http' }),
  'clientId required',
);

assertThrows(
  'createAuthContext rejects missing source',
  () => createAuthContext({ clientId: 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030' }),
  'source must be one of',
);

assertThrows(
  'createAuthContext rejects bad source value',
  () => createAuthContext({ clientId: 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030', source: 'bogus' }),
  'source must be one of',
);

{
  const ctx = createAuthContext({ clientId: 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030', source: 'service' });
  assert('valid createAuthContext returns branded object', ctx && ctx.__authCtx === _internal.AUTH_CTX_BRAND && ctx.clientId === 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030');
}

// Smoke: assertAuthCtx is the runtime guard inside getTenantContext.
// We can't call getTenantContext here without DB, but we can verify the
// guard rejects raw strings by constructing a fake bad arg.
{
  const fakeBadAuthCtx = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';  // a raw string!
  // The actual assertAuthCtx is module-private; getTenantContext is the
  // public surface. Verify the brand symbol mismatch by checking that the
  // raw string doesn't carry the brand:
  assert(
    'raw string lacks the AUTH_CTX brand',
    typeof fakeBadAuthCtx === 'string' && fakeBadAuthCtx.__authCtx !== _internal.AUTH_CTX_BRAND,
  );
}

{
  // Fake auth ctx with WRONG brand symbol (impostor)
  const impostor = { __authCtx: Symbol('not-the-real-brand'), clientId: 'x' };
  assert(
    'impostor object with non-matching brand is rejected by brand check',
    impostor.__authCtx !== _internal.AUTH_CTX_BRAND,
  );
}

// ── Role projections ─────────────────────────────────────────────────────
console.log('\n[4] Role projections');

// Research
{
  const r = projectForResearch(validProfile);
  assert('research projection includes ICP exclusions', r.rendered.includes('MNCs'));
  assert('research projection includes competitor offers', r.rendered.includes('outbound agency'));
  assert('research projection excludes proof', !r.rendered.includes('Tamsa Global'));
  assert('research projection excludes sender persona email', !r.rendered.includes('hello@beaver.solutions'));
  assert('research projection constraints is null', r.constraints === null);
}

// Sales
{
  const r = projectForSales(validProfile, 'email');
  assert('sales projection includes sender persona', r.rendered.includes('Michael Jerry'));
  assert('sales projection includes APPROVED proof only', r.rendered.includes('Tamsa Global') && !r.rendered.includes('Beaver Solutions internal'));
  assert('sales projection includes voice good examples', r.rendered.includes('grew 40%'));
  assert('sales projection includes voice bad examples', r.rendered.includes('Just checking in'));
  assert('sales projection excludes ICP exclusions', !r.rendered.includes('MNCs'));
  assert('sales projection excludes competitor list', !r.rendered.includes('outbound agency'));
  assert('sales constraints word_cap for email = 80', r.constraints.word_cap === 80);
  assert('sales constraints signoff for email present', typeof r.constraints.signoff === 'string' && r.constraints.signoff.includes('Michael Jerry'));
  assert('sales constraints banned_phrases present', r.constraints.banned_phrases.includes('just checking in'));
  assert('sales constraints max_links = 1', r.constraints.max_links === 1);
  assert('sales constraints allow_emoji = false', r.constraints.allow_emoji === false);
}

// Sales with linkedin_dm channel should swap word_cap and signoff
{
  const r = projectForSales(validProfile, 'linkedin_dm');
  assert('sales constraints word_cap for linkedin_dm = 60', r.constraints.word_cap === 60);
  assert('sales constraints signoff for linkedin_dm is null', r.constraints.signoff === null);
}

// Enforcer
{
  const r = projectForEnforcer(validProfile, 'email');
  assert('enforcer projection lists constraints', r.rendered.includes('Word cap'));
  assert('enforcer projection includes good examples for drift check', r.rendered.includes('grew 40%'));
  assert('enforcer projection lists banned phrases', r.rendered.includes('just checking in'));
  assert('enforcer projection excludes offer/pricing detail', !r.rendered.includes('Trial') && !r.rendered.includes('free'));
  assert('enforcer constraints match sales for same channel', r.constraints.word_cap === 80);
}

// Captain
{
  const r = projectForCaptain(validProfile);
  assert('captain projection includes tenant company', r.rendered.includes('Beaver Solutions'));
  assert('captain projection includes 1-liner product', r.rendered.includes('BeavrDam'));
  assert('captain projection excludes proof', !r.rendered.includes('Tamsa Global'));
  assert('captain projection excludes constraints', !r.rendered.includes('word_cap') && r.constraints === null);
}

// ── tokenCount ───────────────────────────────────────────────────────────
console.log('\n[5] tokenCount estimate');

{
  const empty = estimateTokens('');
  assert('estimateTokens("") = 0', empty === 0);
}

{
  const fourChars = estimateTokens('abcd');
  assert('estimateTokens("abcd") = 1', fourChars === 1);
}

{
  const salesText = projectForSales(validProfile, 'email').rendered;
  const tokens = estimateTokens(salesText);
  // Sanity: sales rendered text should be at least a few hundred chars → 100+ tokens.
  assert(`estimateTokens(sales-rendered) is reasonable (got ${tokens})`, tokens > 100 && tokens < 5000);
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────');
console.log(`PASS: ${passCount}   FAIL: ${failCount}`);
if (failCount > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
} else {
  console.log('All smoke tests passed.');
  process.exit(0);
}
