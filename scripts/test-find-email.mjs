#!/usr/bin/env node
/**
 * test-find-email.mjs — Phase 2 acceptance test for emailEnrichment.findEmail v2.
 *
 * Runs findEmail on 3 known Beaver Solutions leads (hardcoded — no DB
 * dependency). Prints { email, status, confidence, isCatchAll, email_source }
 * per lead. NO DB writes.
 *
 * SPEND RULE (corrections.md 2026-05-23): MillionVerifier 500-credit cap is
 * finite. Total credit consumption for this test must be <10. findEmail
 * caps verify calls at 3 per lead. We test 3 leads → worst case 9 credits.
 * Best case: clean scrape consensus → 0 credits.
 *
 * Run from repo root, with env loaded:
 *   node --env-file=.env scripts/test-find-email.mjs
 *
 * Env (require ONE of):
 *   MILLION_VERIFIER       — MJ's local key
 *   EMAIL_VERIFY_API_KEY   — alt name (spec)
 *
 * Exit 0 = test ran, 1 = fatal error.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { findEmail } = require('../server/services/emailEnrichment.js');

// Three real Beaver tenant leads pulled from prior session SQL queries +
// today's daily log. Hardcoded so this script has zero DB dependency.
const TEST_LEADS = [
  { name: 'Jacob Froats',     company: 'Tincityimpact',   known_email: 'jacob@tincityimpact.com' },
  { name: 'Richard Yek',      company: 'Inspirit 360',    known_email: null /* LinkedIn-only — tests no-email path */ },
  { name: 'Szymon Borowski',  company: 'StillFlow Group', known_email: null /* LinkedIn-only — tests no-email path */ },
];

async function main() {
  const haveKey = !!(process.env.MILLION_VERIFIER || process.env.EMAIL_VERIFY_API_KEY);
  console.log(`[test-find-email] MillionVerifier key: ${haveKey ? 'PRESENT' : 'MISSING (verifyEmail will return unknown)'}`);
  console.log(`[test-find-email] Spend ceiling: <10 credits total. Test mode: ${TEST_LEADS.length} leads.`);
  console.log('');

  for (const lead of TEST_LEADS) {
    console.log(`──────────────────────────────────────────────────────────`);
    console.log(`Lead: ${lead.name} @ ${lead.company}`);
    console.log(`Known email: ${lead.known_email || '(none — LinkedIn-only lead)'}`);
    const t0 = Date.now();
    let result;
    try {
      result = await findEmail({ name: lead.name, company: lead.company });
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      console.log(`  Stack: ${err.stack?.split('\n').slice(0, 3).join(' | ')}`);
      continue;
    }
    const dt = Date.now() - t0;
    if (!result) {
      console.log(`  findEmail returned: null (no candidate found)`);
      console.log(`  Time: ${dt}ms`);
    } else {
      const matches = lead.known_email
        ? result.email.toLowerCase() === String(lead.known_email).toLowerCase()
        : null;
      console.log(`  findEmail result:`);
      console.log(`    email:        ${result.email}`);
      console.log(`    status:       ${result.status}`);
      console.log(`    confidence:   ${result.confidence}`);
      console.log(`    isCatchAll:   ${result.isCatchAll}`);
      console.log(`    email_source: ${result.email_source}`);
      if (matches === true)  console.log(`    match-known:  YES (matches known)`);
      if (matches === false) console.log(`    match-known:  NO (differs from known: ${lead.known_email})`);
      if (matches === null)  console.log(`    match-known:  N/A (no ground truth)`);
      console.log(`  Time: ${dt}ms`);
    }
    console.log('');
  }

  console.log(`──────────────────────────────────────────────────────────`);
  console.log(`[test-find-email] Done. Verify MillionVerifier dashboard for actual credit consumption.`);
}

main().catch(err => {
  console.error('[test-find-email] Fatal:', err);
  process.exit(1);
});
