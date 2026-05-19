#!/usr/bin/env node
/**
 * validate-followup-v1.mjs
 *
 * Dry-run validation of BEAVER_FOLLOWUP_FORMAT.md v1.0 prompt.
 * Reproduces the 3 prospects from MJ's 2026-05-12 screenshot
 * (Jeremy Raj / codeme.pro, Zheng Yen Ang / Digital Agency, Navin Manian /
 * U Mobile) + 2 fresh lead contexts. Runs PATCHED draftFollowUp() against each,
 * prints drafts + 4-part attestation check + banned-phrase scan.
 *
 * NO DB writes, NO DB reads — pure Anthropic calls against the patched prompt.
 *
 * Run from beavrdam/server:
 *   export ANTHROPIC_API_KEY=...
 *   node ../scripts/validate-followup-v1.mjs
 *
 * Cost: ~10 Anthropic calls (5 sales + 5 enforcer) ≈ $0.10.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(pathToFileURL(path.join(__dirname, '..', 'server', 'placeholder.js')).href);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY.');
  process.exit(1);
}

const { draftFollowUp } = require('./services/followupSequence.js');
const { rangerReview } = require('./services/agents.js');

// 5 lead contexts. First 3 mirror MJ's screenshot (the rejected drafts).
// Last 2 are fresh shapes to exercise different per-touch roles.
const TEST_CASES = [
  {
    label: 'Jeremy Raj / codeme.pro (was rejected today as FU)',
    lead: {
      id: 'test-1', name: 'Jeremy Raj', title: 'Founder',
      company: 'codeme.pro', industry: 'B2B SaaS / Dev Tools',
      metadata: { signal: 'Founder running outbound himself, 8 staff' },
    },
    touch_number: 2,
    previousMessages: [
      {
        channel: 'linkedin', subject: 'codeme.pro outbound',
        body: 'Hi Jeremy, saw codeme.pro is shipping a dev-onboarding tool and you\'re running outbound yourself. Most founders at 8 staff hit a wall where the SDR they\'d hire costs 3x the deal size. Worth 15 min to see how we\'d source + draft + send 50/day on autopilot?',
        metadata: {},
      },
    ],
  },
  {
    label: 'Zheng Yen Ang / Digital Agency (was rejected today as FU)',
    lead: {
      id: 'test-2', name: 'Zheng Yen Ang', title: 'Founder',
      company: 'Mackyclyde SEO', industry: 'SEO Agency',
      metadata: { signal: 'Founder posts about agency growth, no SDR' },
    },
    touch_number: 3,
    previousMessages: [
      {
        channel: 'linkedin', subject: null,
        body: 'Hi Zheng, noticed Mackyclyde\'s positioning around technical SEO. Agencies in your size band usually have one founder doing outbound on top of delivery. Quick one: are you sourcing in-house or paying for a list?',
        metadata: {},
      },
      {
        channel: 'linkedin', subject: null,
        body: 'Hi Zheng, following up on my note last week. Wanted to share that we built BeavrDam specifically for boutique agency founders. Worth a quick call?',
        metadata: {},
      },
    ],
  },
  {
    label: 'Navin Manian / U Mobile (was rejected today as FU)',
    lead: {
      id: 'test-3', name: 'Navin Manian', title: 'Marketing Lead',
      company: 'U Mobile', industry: 'Telco',
      metadata: { signal: 'U Mobile launched 5G postpaid push Q1 2026' },
    },
    touch_number: 2,
    previousMessages: [
      {
        channel: 'email', subject: 'U Mobile 5G push outbound',
        body: 'Hi Navin, saw U Mobile\'s Q1 5G postpaid push. The big telcos have inbound brand demand; the challenge is enterprise lead nurture velocity. Worth a chat on how we sequence B2B accounts at scale?',
        metadata: {},
      },
    ],
  },
  {
    label: 'Sarah Lim / boutique B2B training agency (touch 4 contrarian)',
    lead: {
      id: 'test-4', name: 'Sarah Lim', title: 'Founder',
      company: 'GrowEdge Training', industry: 'B2B Sales Training',
      metadata: { signal: 'Posted about MY corporate L&D budget cuts Q2 2026' },
    },
    touch_number: 4,
    previousMessages: [
      { channel: 'email', subject: 'GrowEdge outbound', body: 'Hi Sarah, saw your post on Q2 L&D budget cuts. Training providers in MY are getting squeezed on retainer renewal cycles. How are you handling outbound to net-new enterprise accounts?', metadata: {} },
      { channel: 'email', subject: 'Re: GrowEdge outbound', body: 'Hi Sarah, sent you a note last week. Quick add: most MY training shops we talk to are sourcing via referrals only. Curious where you land on that.', metadata: {} },
      { channel: 'linkedin', subject: null, body: 'Hi Sarah, saw GrowEdge ran a session at the Bursa breakfast last Thursday. Different angle: is the bottleneck finding the right HR head, or getting past procurement?', metadata: {} },
    ],
  },
  {
    label: 'Ali Khan / fintech reseller (touch 5 break-up)',
    lead: {
      id: 'test-5', name: 'Ali Khan', title: 'Director, Sales',
      company: 'FinSync Asia', industry: 'Fintech reseller',
      metadata: { signal: 'Hiring 2 BDRs per Mar 2026 LinkedIn posting' },
    },
    touch_number: 5,
    previousMessages: [
      { channel: 'email', subject: 'FinSync BDR scaling', body: 'Hi Ali, saw the 2 BDR postings. Most BDR teams scaling to 4-5 hit the same ceiling: 2 weeks of ramp per hire + zero attribution on which channels source the pipeline.', metadata: {} },
      { channel: 'email', subject: 'Re: FinSync BDR scaling', body: 'Hi Ali, sent you a note. Different angle: are the BDRs going to be outbound or AE handoff support?', metadata: {} },
      { channel: 'linkedin', subject: null, body: 'Hi Ali, contrarian thought: the fintech resellers winning right now have shrunk the BDR team and put the budget into a clone-the-founder outbound system. Worth a chat?', metadata: {} },
      { channel: 'linkedin', subject: null, body: 'Hi Ali, last note: saw the LSEG partnership announcement. Worth 10 min if you want to compare notes on outbound automation.', metadata: {} },
    ],
  },
];

const BANNED_PATTERNS = [
  /still thinking/i, /just thinking/i, /still wondering/i,
  /just checking in/i, /circling back/i, /following up on/i, /touching base/i,
  /does .{0,30} make sense/i,
  /any thoughts/i, /\bwdyt\b/i,
  /Most founders/i, /Most \w+s I (talk to|come across)/i,
  /quick favor/i, /quick ask/i,
  /hope this finds you well/i, /hope you'?re doing well/i, /hope all is well/i,
  /^Regards,?\s*$/im, /^Best regards,?\s*$/im, /^Sincerely,?\s*$/im, /^Cheers,?\s*$/im, /^Best,?\s*$/im,
];

function bannedHits(text) {
  if (!text) return [];
  const hits = [];
  for (const re of BANNED_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

function partsCheck(thinking) {
  // Looks for "PART 1", "PART 2", etc in thinking field
  const checks = { p1: /part\s*1/i.test(thinking), p2: /part\s*2/i.test(thinking), p3: /part\s*3/i.test(thinking), p4: /part\s*4/i.test(thinking) };
  const got = Object.values(checks).filter(Boolean).length;
  return { got, total: 4, ok: got === 4 };
}

async function main() {
  console.log('=== BEAVER_FOLLOWUP_FORMAT v1.0 — Dry-Run Validation ===\n');
  console.log('Mode: synthetic lead contexts mirroring rejected drafts + fresh shapes');
  console.log('Sample: 5 cases\n');

  let totalPass = 0, totalFail = 0;
  const summary = [];

  for (const tc of TEST_CASES) {
    console.log('='.repeat(75));
    console.log(`Case: ${tc.label}`);
    console.log(`Touch: ${tc.touch_number} | Prior touches: ${tc.previousMessages.length}`);

    let draft;
    try {
      draft = await draftFollowUp(tc.lead, tc.touch_number, tc.previousMessages, null);
    } catch (e) {
      console.log(`✗ draftFollowUp threw: ${e.message}\n`);
      totalFail++;
      summary.push({ case: tc.label, verdict: 'THREW', detail: e.message });
      continue;
    }

    if (draft?.status === 'needs_more_research') {
      console.log(`⚠ needs_more_research: ${draft.reason} (missing: ${(draft.missing_fields || []).join(', ')})\n`);
      summary.push({ case: tc.label, verdict: 'NEEDS_RESEARCH', detail: draft.reason });
      continue;
    }

    const body = draft?.body || '';
    const subject = draft?.subject || '';
    const thinking = draft?.thinking || '';

    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const qCount = (body.match(/\?/g) || []).length;
    const hits = bannedHits(body);
    const parts = partsCheck(thinking);

    console.log(`\n--- THINKING (truncated, full in raw output) ---`);
    console.log(thinking.substring(0, 800));
    if (subject) console.log(`\n--- SUBJECT --- ${subject}`);
    console.log(`\n--- BODY (${wordCount} words, ${qCount} Q) ---\n${body}`);

    console.log(`\n--- CHECKS ---`);
    console.log(`Parts attested (1-4 in thinking field): ${parts.got}/4 ${parts.ok ? '✓' : '✗'}`);
    console.log(`Banned-phrase hits: ${hits.length === 0 ? 'NONE ✓' : '✗ ' + hits.join(' | ')}`);
    console.log(`Word count under cap: ${wordCount <= 70 ? '✓' : '✗'} (${wordCount})`);
    console.log(`Question marks ≤ 1: ${qCount <= 1 ? '✓' : '✗'} (${qCount})`);

    const allChecksPass = parts.ok && hits.length === 0 && qCount <= 1 && wordCount <= 70;
    if (allChecksPass) totalPass++; else totalFail++;
    summary.push({ case: tc.label, verdict: allChecksPass ? 'PASS' : 'FAIL', wordCount, qCount, bannedHits: hits.length, partsAttested: parts.got });

    console.log('');
  }

  console.log('='.repeat(75));
  console.log(`SUMMARY: ${totalPass}/${TEST_CASES.length} pass`);
  console.table(summary);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
