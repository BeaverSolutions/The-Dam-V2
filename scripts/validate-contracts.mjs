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
const signalHunt = readFile('services/signalHunt.js');
const replyHandler = readFile('services/replyHandler.js');
const index = readFile('index.js');
const allSources = [agents, dbBuilder, sendQueue, pipeline];

// 1. Enforcer gate: both pipeline paths must call runRanger / callAgent with enforcer
const signalEnforcer = agents.includes('rangerResult') && agents.includes('ranger_score');
check('Enforcer gate exists in pipeline', signalEnforcer,
  signalEnforcer ? 'rangerResult + ranger_score found' : 'MISSING enforcer call in agents.js');

// 2. Borderline 60-79 surfaced — shared approval logic must own the range,
// and both runtime paths must call that shared function.
const borderlineCheck = (pipeline.match(/rangerScore >= 60 && rangerScore < 80/g) || []).length;
const approvalCallSites = (agents.match(/applyEnforcerDecision/g) || []).length;
check('Borderline 60-79 detection (shared + both paths)', borderlineCheck >= 1 && approvalCallSites >= 2,
  `${borderlineCheck} shared site(s), ${approvalCallSites} agents.js call site(s)`);

// 3. BANNED_PHRASES defined and non-empty
const bannedMatch = agents.match(/BANNED_PHRASES\s*=\s*\[/);
const vendorMatch = agents.match(/VENDOR_SPEAK_PHRASES\s*=\s*\[/);
const coldMatch = agents.match(/COLD_TELL_PHRASES\s*=\s*\[/);
check('BANNED_PHRASES defined (split into VENDOR_SPEAK + COLD_TELL)', !!(bannedMatch && vendorMatch && coldMatch),
  bannedMatch ? 'all three arrays found' : 'MISSING banned phrase arrays');

// 4. approval_audit write at shared decision path and fallback approval paths.
const auditWrites = (pipeline.match(/INSERT INTO approval_audit/g) || []).length
  + (agents.match(/INSERT INTO approval_audit/g) || []).length;
const fallbackAuditHelper = agents.includes('writeApprovalAuditForMessage') && agents.includes('fallback_approval');
check('approval_audit wired at shared and fallback paths', auditWrites >= 2 && fallbackAuditHelper,
  `${auditWrites} INSERT site(s) found, fallback helper=${fallbackAuditHelper}`);

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
const enforcerModel = readFile('config/agents.js').match(/ranger:\s*\{[\s\S]*model:\s*MODELS\.SONNET/);
check('Enforcer uses Sonnet model', !!enforcerModel,
  enforcerModel ? 'Sonnet reference found' : 'Enforcer may be using wrong model');

// 9. Daily kickoff is explicitly opt-in while sourcing/output paths are being repaired.
const dailyKickoffBrake = index.includes("CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true'");
check('Daily kickoff opt-in brake', dailyKickoffBrake,
  dailyKickoffBrake ? 'CAPTAIN_DAILY_KICKOFF_ENABLED guard found' : 'daily kickoff can run without explicit flag');

// 10. send_queue enqueue must report conflict truth, not claim duplicate rows enqueued.
const enqueueConflictTruth = sendQueue.includes('RETURNING id')
  && sendQueue.includes("reason: 'already_enqueued'");
check('send_queue enqueue conflict truth', enqueueConflictTruth,
  enqueueConflictTruth ? 'RETURNING id + already_enqueued found' : 'enqueue may report true on conflict no-op');

// 11. Signal Hunt must read both historical config shapes and pass country into search.
const signalConfigShape = signalHunt.includes('content?.signal_queries')
  && signalHunt.includes('Object.entries(signalQueries)')
  && signalHunt.includes('searchOpenWeb(q.query, config.max_results_per_query || 5, { country })');
check('Signal Hunt config + country-aware search', signalConfigShape,
  signalConfigShape ? 'signal_queries object/array + country search found' : 'signal hunt may ignore DB config or country');

// 12. Positive replies must not become booked meetings without a calendar/meeting side effect.
const replyNoFalseMeeting = replyHandler.includes("positive: 'qualifying'")
  && !replyHandler.includes("positive: 'meeting_booked'");
check('Positive reply does not mark meeting_booked', replyNoFalseMeeting,
  replyNoFalseMeeting ? 'positive reply maps to qualifying' : 'positive reply may count as booked meeting');

// 13. User-requested campaign counts must be output-driven, not activity-driven.
const campaignOutputDriven = agents.includes('campaign_target_unfulfilled')
  && agents.includes('campaign_completion_retry')
  && agents.includes('target_fulfilled')
  && agents.includes('targetLimit - dbApprovedCount')
  && !agents.includes('actualDrafted >= targetLimit');
check('Campaign target counts approval-ready output', campaignOutputDriven,
  campaignOutputDriven ? 'requested count tied to approved output + retry/unfulfilled logs' : 'campaign may count enrolled/drafted leads as success');

// 14. Fresh sourcing must not recycle exhausted old leads.
const captainBeaver = readFile('services/captainBeaver.js');
const noRecycledDbLeads = agents.includes("m.status <> 'deleted'")
  && captainBeaver.includes("m.status <> 'deleted'")
  && agents.includes("status: 'channel_exhausted'");
check('Fresh campaign excludes prior outreach attempts', noRecycledDbLeads,
  noRecycledDbLeads ? 'DB-first + Captain search exclude any non-deleted prior message' : 'old contacted/exhausted leads may re-enter find-N campaigns');

// 15. Research fanout must be capped per run and adjustable by remaining provider capacity.
const researchSource = readFile('services/research.js');
const researchFanoutCap = researchSource.includes('RESEARCH_MAX_PAID_QUERIES_PER_RUN')
  && researchSource.includes('maxPaidQueries')
  && agents.includes('remainingPaidQueries')
  && agents.includes('paid_search_capacity_exhausted');
check('Research paid-query fanout capped by remaining capacity', researchFanoutCap,
  researchFanoutCap ? 'research receives maxPaidQueries and blocks when paid capacity is exhausted' : 'research may fan out after caps are exhausted');

// ── Summary ──
// 16. Captain chat campaigns must not create duplicate UI executions, and hidden
// Captain executions must finalize exec state after directorExecute resolves.
const captainNoDuplicateRun = captainBeaver.includes("response.status = 'captain_response'")
  && captainBeaver.includes('campaign_status: campaignResult.status')
  && !captainBeaver.includes('\n      status: campaignResult.status,')
  && captainBeaver.includes('findRecentRunningExecution')
  && captainBeaver.includes('persistExecTerminalStatus');
check('Captain campaign launch is single-run and terminal-state safe', captainNoDuplicateRun,
  captainNoDuplicateRun ? 'Captain response cannot become a frontend plan + hidden runs finalize exec state' : 'Captain chat may double-run or leave exec state stuck');

// 17. Zero-output diagnostics must distinguish provider/parser candidates from
// Research-verified leads so "raw_count=0" cannot hide upstream rejection.
const researchDiagnosticTruth = agents.includes('provider_candidates')
  && agents.includes('research_verified')
  && agents.includes('Provider/search parser returned 0 usable candidates')
  && agents.includes('Research verification rejected all');
check('Research zero-output diagnostics separate provider candidates from verified leads', researchDiagnosticTruth,
  researchDiagnosticTruth ? 'provider_candidates + research_verified are logged' : 'zero-output diagnostics still collapse provider/parser/verification layers');

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
