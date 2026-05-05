#!/usr/bin/env node
/**
 * test-sales-internal.mjs
 *
 * Dry-run validation of the Sales Beaver + Enforcer pipeline against 5 real
 * leads. Imports the live BeavrDam config so the prompt + model under test
 * are EXACTLY what would deploy. NO database writes. NO send queue. Just
 * Anthropic calls + console output.
 *
 * Run from repo root with --env-file (Node 20.6+):
 *   node --env-file=server/.env scripts/test-sales-internal.mjs
 *
 * Required env (in server/.env):
 *   ANTHROPIC_API_KEY
 *
 * Cost: ~10 Anthropic calls (5 sales + 5 enforcer) on Sonnet ≈ $0.05.
 *
 * Zero external deps — uses Node's built-in fetch and require().
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Run with: node --env-file=server/.env scripts/test-sales-internal.mjs');
  process.exit(1);
}

// Import LIVE config — exactly what will deploy
const { AGENTS } = require('../server/config/agents.js');
const sales    = AGENTS.sales_beaver;
const enforcer = AGENTS.ranger;

// 5 real thin-context leads from the Beaver Solutions pool — the failure mode
const LEADS = [
  { name: 'Dalveen Kaur',    company: 'Alpha Access PR',                title: 'Director' },
  { name: 'How Yong Guan',   company: 'Airlytic',                       title: 'Founder' },
  { name: 'Jin Tan',         company: 'Monsta Infinite',                title: 'Founder' },
  { name: 'Elizabbeth Siew', company: 'Malaysia PropTech Association',  title: 'Founder' },
  { name: 'Carol Tan',       company: 'Independent',                    title: 'Marketing & BD Strategist' },
];

async function callAnthropic({ model, max_tokens, system, user }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model, max_tokens, system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.content[0]?.text || '';
}

function buildContext(lead) {
  return [
    `Name: ${lead.name}`,
    `Company: ${lead.company}`,
    `Title: ${lead.title || 'Unknown'}`,
  ].join('\n');
}

function tryParseJson(text) {
  const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function callSales(lead) {
  const userMsg = `Write a linkedin outreach message for this lead: ${buildContext(lead)}
DO NOT include any sign-off like "Regards," or "Best," — this is a linkedin DM, not an email. No sign-off at all. Just end with the question.`;

  const text = await callAnthropic({
    model: sales.model, max_tokens: sales.maxTokens,
    system: sales.systemPrompt, user: userMsg,
  });
  const json = tryParseJson(text);
  return { body: json?.body || text, subject: json?.subject || null, raw: text };
}

async function callEnforcer(messageBody, lead) {
  const leadContextStr = `LEAD CONTEXT (validate message is accurate for this person):
- Name: ${lead.name}
- Company: ${lead.company || 'Unknown'}
- Title: ${lead.title || 'Unknown'}
- Signal (why now): Not specified
- Angle: Not specified
- Friction: Not specified

`;
  const userMsg = `Review this message:\n\n${leadContextStr}MESSAGE:\n${messageBody}`;
  const text = await callAnthropic({
    model: enforcer.model, max_tokens: enforcer.maxTokens,
    system: enforcer.systemPrompt, user: userMsg,
  });
  const json = tryParseJson(text);
  return {
    decision: json?.decision || 'parse_error',
    score:    json?.score    || 0,
    feedback: json?.feedback || json?.reject_reason || text.slice(0, 280),
  };
}

async function main() {
  console.log(`\n=== Sales Beaver internal test ===`);
  console.log(`Sales model:    ${sales.model}`);
  console.log(`Enforcer model: ${enforcer.model}`);
  console.log(`Leads under test: ${LEADS.length}\n`);

  let approved = 0;
  let totalScore = 0;

  for (const lead of LEADS) {
    console.log(`──────────────────────────────────────`);
    console.log(`Lead: ${lead.name} — ${lead.title} @ ${lead.company}`);
    try {
      const draft = await callSales(lead);
      console.log(`\nDraft body:\n${draft.body}\n`);
      const review = await callEnforcer(draft.body, lead);
      const passed = review.decision === 'approve' || review.decision === 'approve_with_edits';
      if (passed) approved++;
      totalScore += (review.score || 0);
      console.log(`Enforcer: decision=${review.decision} score=${review.score}`);
      console.log(`Notes:    ${(review.feedback || '').slice(0, 280)}`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
    console.log('');
  }

  console.log(`──────────────────────────────────────`);
  console.log(`SUMMARY`);
  console.log(`  Approved:  ${approved}/${LEADS.length}  (${Math.round(100*approved/LEADS.length)}%)`);
  console.log(`  Avg score: ${Math.round(totalScore / LEADS.length)}`);
  console.log(`\nBaseline (Haiku, last 5 days): 0% approve, score 0 across 90 messages.`);
  console.log(`Ship target:                    ≥40% approve, avg score ≥50.`);
}

main().catch(err => { console.error(err); process.exit(1); });
