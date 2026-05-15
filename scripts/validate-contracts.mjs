#!/usr/bin/env node
/**
 * validate-contracts.mjs — static analysis of BeavrDam hero-film contracts.
 *
 * Checks that structural invariants hold in the codebase:
 *   1. No message sends without Enforcer gate
 *   2. Borderline 60-79 surfaced, never auto-approved
 *   3. BANNED_PHRASES exist and are applied at Enforcer
 *   4. approval_audit written on every auto-decision path
 *   5. pipeline_traces written at key stages
 *   6. VP daily credit cap enforced
 *
 * Exit code 0 = all pass, 1 = failures found.
 * Sends Telegram alert on failure if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, '..', 'server');

function readFile(relPath) {
  return readFileSync(resolve(SERVER, relPath), 'utf8');
}

const results = [];

function check(name, pass, detail) {
  results.push({ name, pass, detail });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Load source files ──
const agents = readFile('services/agents.js');
const dbBuilder = readFile('services/dbBuilder.js');
const sendQueue = readFile('services/sendQueueWorker.js');
const pipeline = readFile('services/pipeline.js');
const pipelineTrace = readFile('services/pipelineTrace.js');
const allSources = [agents, dbBuilder, sendQueue, pipeline];

// 1. Enforcer gate: both pipeline paths must call runRanger / callAgent with enforcer
const signalEnforcer = agents.includes('rangerResult') && agents.includes('ranger_score');
check('Enforcer gate exists in pipeline', signalEnforcer,
  signalEnforcer ? 'rangerResult + ranger_score found' : 'MISSING enforcer call in agents.js');

// 2. Borderline 60-79 surfaced — both paths must check score range
const borderlineCheck = (agents.match(/rangerScore >= 60 && rangerScore < 80/g) || []).length;
check('Borderline 60-79 detection (both paths)', borderlineCheck >= 2,
  `${borderlineCheck} site(s) found, need >= 2`);

// 3. BANNED_PHRASES defined and non-empty
const bannedMatch = agents.match(/BANNED_PHRASES\s*=\s*\[/);
const vendorMatch = agents.match(/VENDOR_SPEAK_PHRASES\s*=\s*\[/);
const coldMatch = agents.match(/COLD_TELL_PHRASES\s*=\s*\[/);
check('BANNED_PHRASES defined (split into VENDOR_SPEAK + COLD_TELL)', !!(bannedMatch && vendorMatch && coldMatch),
  bannedMatch ? 'all three arrays found' : 'MISSING banned phrase arrays');

// 4. approval_audit write at both pipeline sites
const auditWrites = (agents.match(/INSERT INTO approval_audit/g) || []).length;
check('approval_audit wired at both pipeline paths', auditWrites >= 2,
  `${auditWrites} INSERT site(s) found`);

// 5. pipeline_traces at key stages
const traceStages = ['enrolled', 'drafted', 'draft_failed', 'reviewed', 'approved', 'sent', 'send_failed'];
for (const stage of traceStages) {
  const re = new RegExp(`['"]${stage}['"]`);
  const found = allSources.some(src => re.test(src) && src.includes('traceStage'));
  check(`pipeline_trace stage '${stage}'`, found, found ? 'found' : 'MISSING');
}

// 6. VP daily credit cap
const vpCap = dbBuilder.includes('VP_DAILY_CREDIT_CAP');
check('VP daily credit cap enforced', vpCap,
  vpCap ? 'VP_DAILY_CREDIT_CAP constant found' : 'MISSING — autonomous VP sourcing has no spend limit');

// 7. VP email-only channel split
const vpEmailOnly = dbBuilder.includes("neededChannel === 'email'") || dbBuilder.includes('EMAIL CHANNEL ONLY');
check('VP sources email channel only', vpEmailOnly,
  vpEmailOnly ? 'channel guard found' : 'VP may source LinkedIn leads (credit waste)');

// 8. Enforcer model is Sonnet (not Haiku)
const enforcerModel = agents.match(/MODEL_SONNET|claude-sonnet/);
check('Enforcer uses Sonnet model', !!enforcerModel,
  enforcerModel ? 'Sonnet reference found' : 'Enforcer may be using wrong model');

// ── Summary ──
const failures = results.filter(r => !r.pass);
console.log(`\n${results.length} checks: ${results.length - failures.length} passed, ${failures.length} failed`);

if (failures.length > 0) {
  const failList = failures.map(f => `- ${f.name}: ${f.detail}`).join('\n');
  console.error(`\nFAILURES:\n${failList}`);

  // Telegram alert
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    const msg = `🚨 BeavrDam Contract Validator FAILED\n\n${failures.length} failure(s):\n${failList}`;
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
    }).catch(err => console.warn('Telegram alert failed:', err.message));
  }

  process.exit(1);
}

process.exit(0);
