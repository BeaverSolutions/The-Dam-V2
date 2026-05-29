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

function section(source, marker, endMarker) {
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const end = endMarker ? source.indexOf(endMarker, start) : -1;
  return source.slice(start, end > start ? end : start + 5000);
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
const searchService = readFile('services/searchService.js');
const autoApprovalRecovery = readFile('services/autoApprovalRecovery.js');
const captainOrchestrator = readFile('services/captainOrchestrator.js');
const jobHealth = readFile('services/jobHealth.js');
const index = readFile('index.js');
const autonomousRoute = readFile('routes/autonomous.js');
const triggerKickoff = readFileSync(resolve(SERVER, '..', 'scripts', 'trigger-kickoff.mjs'), 'utf8');
const kickoffWatchdog = readFileSync(resolve(SERVER, '..', 'scripts', 'kickoff-watchdog.mjs'), 'utf8');
const dailyHealthPack = readFileSync(resolve(SERVER, '..', 'scripts', 'daily-health-pack.mjs'), 'utf8');
const platformHealth = readFileSync(resolve(SERVER, '..', 'scripts', 'platform-health.mjs'), 'utf8');
const hourlyReport = readFileSync(resolve(SERVER, '..', 'scripts', 'hourly-report.mjs'), 'utf8');
const postDeployAutonomyCheck = readFileSync(resolve(SERVER, '..', 'scripts', 'post-deploy-autonomy-check.mjs'), 'utf8');
const triggerKickoffWorkflow = readFileSync(resolve(SERVER, '..', '.github', 'workflows', 'trigger-kickoff.yml'), 'utf8');
const postDeployAutonomyWorkflow = readFileSync(resolve(SERVER, '..', '.github', 'workflows', 'post-deploy-autonomy-check.yml'), 'utf8');
const envExample = readFileSync(resolve(SERVER, '..', '.env.example'), 'utf8');
const prodEnvExample = readFileSync(resolve(SERVER, '..', '.env.production.example'), 'utf8');
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

// 9. Daily kickoff must be explicitly armed, and disabled/missed states must be
// visible to Captain instead of being marked as green cron health.
const dailyKickoffHealthTruth = index.includes("CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true'")
  && index.includes("markSkipped('daily_kickoff'")
  && index.includes('daily kickoff window passed without all tenant dedupe rows')
  && jobHealth.includes('markSkipped')
  && jobHealth.includes("status: skippedStatus")
  && captainOrchestrator.includes("CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true'")
  && captainOrchestrator.includes('AUTONOMOUS_ENABLED_CLIENTS empty')
  && captainOrchestrator.includes("k.business_day.kickoff.state === 'disabled'");
check('Daily kickoff disabled/missed state is visible', dailyKickoffHealthTruth,
  dailyKickoffHealthTruth ? 'kickoff opt-in plus skipped/disabled health path found' : 'daily kickoff can still look green when disabled or missed');

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

// 14. Fresh sourcing must not recycle active/sent outreach, but old rejected
// drafts must not permanently starve DB-first recovery.
const captainBeaver = readFile('services/captainBeaver.js');
const activeOutreachDedupe = agents.includes("m.status IN (")
  && agents.includes("'pending_ranger', 'pending_approval', 'approved'")
  && agents.includes("'pending_send', 'sending', 'sent', 'delivered'")
  && agents.includes("'linkedin_requested', 'awaiting_accept'")
  && captainBeaver.includes("m.status IN (")
  && captainBeaver.includes("'pending_ranger', 'pending_approval', 'approved'")
  && captainBeaver.includes("'pending_send', 'sending', 'sent', 'delivered'")
  && captainBeaver.includes("'linkedin_requested', 'awaiting_accept'")
  && agents.includes("status: 'channel_exhausted'");
check('Fresh campaign excludes active outreach without starving rejected drafts', activeOutreachDedupe,
  activeOutreachDedupe ? 'DB-first + Captain search block active/sent outreach states while rejected drafts can recover' : 'old rejected drafts may still starve DB-first or active outreach may recycle');

// 15. Research fanout must be capped per run and adjustable by remaining provider capacity.
const researchSource = readFile('services/research.js');
const researchFanoutCap = researchSource.includes('RESEARCH_MAX_PAID_QUERIES_PER_RUN')
  && researchSource.includes('maxPaidQueries')
  && agents.includes('remainingPaidQueries')
  && agents.includes('paid_search_capacity_exhausted')
  && agents.includes('paid_search_capacity_insufficient');
check('Research paid-query fanout capped by remaining capacity', researchFanoutCap,
  researchFanoutCap ? 'research receives maxPaidQueries and blocks when paid capacity is exhausted' : 'research may fan out after caps are exhausted');

// ── Summary ──
// 16. Captain chat campaigns must not create duplicate UI executions, and hidden
// Captain executions must finalize exec state after directorExecute resolves.
const captainNoDuplicateRun = captainBeaver.includes("response.status = 'captain_response'")
  && captainBeaver.includes('campaign_status: campaignResult.status')
  && !captainBeaver.includes('\n      status: campaignResult.status,')
  && captainBeaver.includes('findRecentRunningExecution')
  && captainBeaver.includes('persistExecTerminalStatus')
  && captainBeaver.includes("status: result?.status || 'completed'");
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

// 18. Manual campaigns must run signal-first before generic profile research.
const signalFirstManualCampaign = agents.includes('signal_first_started')
  && agents.includes('runSignalHunt')
  && agents.includes('saveSignalLeads')
  && agents.includes("run_kind: signalLeadsCount > 0 ? 'signal_first'")
  && signalHunt.includes('maxPaidQueries')
  && signalHunt.includes('consumePaidQuery');
check('Manual campaign sourcing is signal-first and budgeted', signalFirstManualCampaign,
  signalFirstManualCampaign ? 'Director runs bounded signal hunt before generic research' : 'manual run_campaign may skip signal-first or spend unbounded signal queries');

// 19. Research fallback may use companies, but the paid-query picker remains signal-led.
const researchSignalFirst = researchSource.includes('signal_jobs: 0')
  && researchSource.includes('signalStrategies')
  && researchSource.includes("q.strategy === 'direct'")
  && researchSource.includes('fallbackQueriesUsed')
  && researchSource.includes('retryCompanyQueries')
  && researchSource.includes('initial verification rejected all');
check('Research picker is signal-first with bounded company support', researchSignalFirst,
  researchSignalFirst ? 'signal strategies sort first, direct profiles last, company fallback budget tracked' : 'research picker may burn generic profile queries before signals');

// 20. Captain preflight blocks campaigns that cannot afford the requested output.
const captainCapacityTruth = captainBeaver.includes('has_sufficient_research_capacity')
  && captainBeaver.includes('required_paid_queries')
  && captainBeaver.includes('remaining_paid_queries')
  && captainBeaver.includes('insufficient_paid_search_capacity')
  && captainBeaver.includes('expireStaleRunningExecutions');
check('Captain preflight blocks unaffordable campaigns and expires stale runs', captainCapacityTruth,
  captainCapacityTruth ? 'capacity shortfall and stale exec guards found' : 'Captain can still queue underfunded or stale-blocked campaigns');

// 21. Search fallback must preserve LinkedIn company searches.
const companySearchFallback = searchService.includes('(?:in|company)')
  && searchService.includes('site:${site}')
  && searchService.includes('braveCountryFor')
  && searchService.includes('requested_country');
check('Search fallback preserves company discovery and SG-safe Brave country', companySearchFallback,
  companySearchFallback ? 'CSE/DDG preserve /company and Brave maps unsupported country safely' : 'company-first fallback may still force /in or Brave SG 422');

// 22. Signal-sourced good leads get rewrite attempts before manual fallback.
const signalRetryBeforeFallback = agents.includes('MAX_SIGNAL_RANGER_RETRIES = 2')
  && agents.includes('Signal redraft ${retryAttempt + 1}')
  && agents.includes('approved_after_redraft')
  && agents.includes('rejected_after_redraft')
  && agents.includes('Do NOT repeat the same product-pitch structure')
  && agents.includes("'enforcer_fallback', 'pending'");
check('Signal pipeline retries rejected drafts before fallback', signalRetryBeforeFallback,
  signalRetryBeforeFallback ? 'signal path has bounded Sales redrafts before Enforcer fallback' : 'signal path may skip straight from rejection to fallback');

// 23. Missed auto-approval recovery must preserve Enforcer gates and send safety.
const autoApprovalRecoveryGuarded = autoApprovalRecovery.includes("AUTO_APPROVE_ENABLED === 'false'")
  && autoApprovalRecovery.includes('score < threshold')
  && autoApprovalRecovery.includes('client_is_seasoned')
  && autoApprovalRecovery.includes('autoApproveThreshold')
  && !autoApprovalRecovery.includes('JOIN clients c')
  && autoApprovalRecovery.includes('recent_sent_count')
  && autoApprovalRecovery.includes("COALESCE(la.reasons->>'borderline', 'false') <> 'true'")
  && autoApprovalRecovery.includes("la.reasons->>'gate_fail'")
  && autoApprovalRecovery.includes("m.channel IN ('email', 'linkedin')")
  && autoApprovalRecovery.includes("row.channel === 'email' ? 'pending_send' : 'linkedin_requested'")
  && autoApprovalRecovery.includes('enqueueMessage(clientId, row.message_id)')
  && autoApprovalRecovery.includes("INSERT INTO approval_audit")
  && autoApprovalRecovery.includes("'auto_approval_recovery'")
  && index.includes("jobHealth.markRun('auto_approval_recovery'")
  && index.includes("jobHealth.markError('auto_approval_recovery'");
check('Auto-approval recovery keeps gates before enqueue', autoApprovalRecoveryGuarded,
  autoApprovalRecoveryGuarded ? 'threshold/seasoning/recent-send/gate-fail/channel/audit/enqueue/health/RLS guards found' : 'recovery may bypass approval or send safety gates');

// 24. Captain morning truth must separate real approval reviews from LinkedIn
// awaiting-accept rows and stale orphan approval rows.
const captainApprovalTruth = captainOrchestrator.includes("COALESCE(a.notes, '') <> 'linkedin_requested'")
  && captainOrchestrator.includes("m.status = 'pending_approval'")
  && captainOrchestrator.includes('linkedin_awaiting_accept')
  && captainOrchestrator.includes('stale_orphan_approval_rows')
  && captainOrchestrator.includes('yesterday_email_sent')
  && captainOrchestrator.includes('yesterday_linkedin_sent')
  && captainOrchestrator.includes('renderPlainBrief(kpis)')
  && !captainOrchestrator.includes('quote verbatim where useful');
check('Captain brief uses deterministic queue and channel truth', captainApprovalTruth,
  captainApprovalTruth ? 'approval queue, LinkedIn awaiting, stale rows, yesterday channels, and deterministic renderer found' : 'Captain can still blend stale/raw approval truth');

// 25. Market sensing is a spend-adjacent job and must not run unless explicitly
// enabled; skipped/disabled state must be reported through job health.
const marketSensingGate = index.includes("MARKET_SENSING_ENABLED !== 'true'")
  && index.includes("markSkipped('market_sensing'")
  && index.includes('market-sensing window passed without run')
  && captainOrchestrator.includes("MARKET_SENSING_ENABLED !== 'true'")
  && envExample.includes('MARKET_SENSING_ENABLED=false')
  && prodEnvExample.includes('MARKET_SENSING_ENABLED=false');
check('Market sensing has explicit spend gate and health truth', marketSensingGate,
  marketSensingGate ? 'MARKET_SENSING_ENABLED and skipped health path found' : 'market sensing may still spend by default or look green when skipped');

// 26. Manual production validation must stay single-tenant. The GitHub trigger
// script previously used /kickoff-all?force=1, which can fan out and burn spend.
const singleTenantKickoffTrigger = autonomousRoute.includes('client_id: c.id')
  && autonomousRoute.includes("KICKOFF_ALL_ENABLED !== 'true'")
  && autonomousRoute.includes("KICKOFF_FORCE_OVERRIDE_ENABLED !== 'true'")
  && autonomousRoute.includes('KICKOFF_ALL_DISABLED')
  && envExample.includes('KICKOFF_ALL_ENABLED=false')
  && prodEnvExample.includes('KICKOFF_FORCE_OVERRIDE_ENABLED=false')
  && triggerKickoff.includes('Missing env: CLIENT_SLUG. Refusing all-tenant kickoff.')
  && triggerKickoff.includes('/api/autonomous/kickoff')
  && !triggerKickoff.includes('/api/autonomous/kickoff-all')
  && !triggerKickoff.includes('force=1')
  && !triggerKickoff.includes('force: true')
  && kickoffWatchdog.includes('Do not use /kickoff-all or force=1')
  && triggerKickoffWorkflow.includes('required: true');
check('Manual kickoff trigger is single-tenant and no-force', singleTenantKickoffTrigger,
  singleTenantKickoffTrigger ? 'trigger script resolves one client_id and posts /kickoff only' : 'manual validation can still fan out or force bypass');

// 27. Cloud health surfaces MYT kickoff state and real approval queue truth.
// The 09:05 health pack must not call kickoff "missed" before the 09:30 window.
const systemHealthTruth = autonomousRoute.includes("Asia/Kuala_Lumpur")
  && autonomousRoute.includes('kl_minutes_now')
  && autonomousRoute.includes('memory_written')
  && autonomousRoute.includes('kickoffWorkProof')
  && autonomousRoute.includes('kickoffMemoryOnlyStarted')
  && autonomousRoute.includes('memory_only_started')
  && autonomousRoute.includes('trace_count')
  && autonomousRoute.includes('source_truth')
  && autonomousRoute.includes('daily_kpi_row_present')
  && autonomousRoute.includes('COALESCE(dk.target, 50)')
  && autonomousRoute.includes("pt.pipeline_path IN ('kickoff_pipeline', 'signal_pipeline')")
  && autonomousRoute.includes('captain_kpi_gap_kickoff_enabled')
  && autonomousRoute.includes('approval_queue')
  && autonomousRoute.includes('followup_queue')
  && autonomousRoute.includes('orphaned_sent_leads')
  && autonomousRoute.includes('linkedin_awaiting_accept')
  && dailyHealthPack.includes("state === 'missed'")
  && dailyHealthPack.includes('started marker only; no work proof')
  && dailyHealthPack.includes('waiting for 09:30 MYT')
  && dailyHealthPack.includes('Approval queue:')
  && dailyHealthPack.includes('Follow-ups:')
  && dailyHealthPack.includes('sent leads missing follow-up rows')
  && dailyHealthPack.includes('research starved and lead pool thin')
  && kickoffWatchdog.includes("['missed', 'disabled'].includes");
check('System health and watchdog use MYT kickoff/queue truth', systemHealthTruth,
  systemHealthTruth ? 'system-health exposes state, traces, memory, and queue split' : 'health pack can still false-alarm or hide queue truth');

// 28. Platform Health must not use the old hourly-stats/50-target report shape.
// It should read system-health truth, report LinkedIn-awaiting separately, and
// only call zero-output when no approval-ready output exists after kickoff.
const platformHealthTruth = platformHealth.includes("api('/api/autonomous/system-health')")
  && !platformHealth.includes("api('/api/autonomous/hourly-stats')")
  && !platformHealth.includes('Sent: ${sentToday}/50')
  && platformHealth.includes('LI-awaiting')
  && platformHealth.includes('follow-ups due')
  && platformHealth.includes('sent leads missing follow-up rows')
  && platformHealth.includes('kickoff has only a start marker, no work proof')
  && platformHealth.includes('pipeline produced no approval-ready output');
check('Platform Health uses system-health kickoff/queue truth', platformHealthTruth,
  platformHealthTruth ? 'platform-health no longer uses hourly-stats/50-target framing' : 'platform-health can still report stale target or queue truth');

// 29. Hourly report must use the same system-health queue/kickoff truth and
// must not keep old Emplifive/Q2 or raw hourly-stats framing.
const hourlyReportTruth = hourlyReport.includes('/api/autonomous/system-health')
  && hourlyReport.includes('Approval queue:')
  && hourlyReport.includes('Follow-ups:')
  && hourlyReport.includes('LinkedIn awaiting accept')
  && hourlyReport.includes('Daily kickoff gate:')
  && hourlyReport.includes('started marker only; no work proof')
  && !hourlyReport.includes('/api/autonomous/hourly-stats')
  && !hourlyReport.includes('Q2:')
  && !hourlyReport.includes('Emplifive')
  && !hourlyReport.includes('20 clients')
  && !hourlyReport.includes('pending approval ·');
check('Hourly report uses system-health queue/kickoff truth', hourlyReportTruth,
  hourlyReportTruth ? 'hourly report no longer uses hourly-stats/Q2 framing' : 'hourly report can still send stale queue or Q2 truth');

// 30. Post-deploy verification must stay read-only and no-money.
const postDeployNoMoneyCheck = postDeployAutonomyCheck.includes("getJson('/health')")
  && postDeployAutonomyCheck.includes("getJson('/api/autonomous/system-health'")
  && postDeployAutonomyCheck.includes('EXPECT_DAILY_KICKOFF_ENABLED')
  && postDeployAutonomyCheck.includes('EXPECT_KPI_GAP_KICKOFF_ENABLED')
  && postDeployAutonomyCheck.includes('EXPECT_MARKET_SENSING_ENABLED')
  && postDeployAutonomyCheck.includes("jobStatus(lastHealth, 'kpi_gap_kickoff')")
  && postDeployAutonomyCheck.includes('WAIT_FOR_DEPLOY_SECONDS')
  && postDeployAutonomyCheck.includes('waitForFreshDeploy')
  && postDeployAutonomyCheck.includes('WAIT_FOR_JOBS_SECONDS')
  && !postDeployAutonomyCheck.includes('Promise.all')
  && postDeployAutonomyCheck.includes('system-health exposes daily KPI target')
  && postDeployAutonomyCheck.includes("['outreach_sent', 'outreach_email', 'outreach_linkedin']")
  && postDeployAutonomyCheck.includes('reviewable approvals under cap')
  && postDeployAutonomyCheck.includes("['pending', 'due_today', 'orphaned_sent_leads']")
  && !postDeployAutonomyCheck.includes("method: 'POST'")
  && !postDeployAutonomyCheck.includes('/kickoff')
  && !postDeployAutonomyCheck.includes('provider_usage')
  && postDeployAutonomyWorkflow.includes('workflow_dispatch')
  && postDeployAutonomyWorkflow.includes('BEAVRDAM_INTERNAL_API_KEY')
  && postDeployAutonomyWorkflow.includes('WAIT_FOR_DEPLOY_SECONDS')
  && postDeployAutonomyWorkflow.includes('WAIT_FOR_JOBS_SECONDS')
  && postDeployAutonomyWorkflow.includes('expect_daily_kickoff_enabled')
  && postDeployAutonomyWorkflow.includes('expect_kpi_gap_kickoff_enabled');
check('Post-deploy autonomy check is read-only/no-money', postDeployNoMoneyCheck,
  postDeployNoMoneyCheck ? 'checker uses /health + /system-health only' : 'checker can mutate, trigger kickoff, or rely on provider data');

// 31. EOD must use the same factual-reporting discipline as morning. The LLM
// can analyze elsewhere, but it must not compose KPI truth from stale self-reports.
const eodBody = section(captainOrchestrator, 'async function generateEodBrief', 'function renderPlainEodBrief');
const eodDeterministic = eodBody.includes('const summary = renderPlainEodBrief(kpis, todaysActions);')
  && !eodBody.includes("callAgent('captain_orchestrator'")
  && captainOrchestrator.includes('meetings outcome:')
  && !captainOrchestrator.includes('projecting ${kpis.meetings.mtd_pace_projected}')
  && !captainOrchestrator.includes('projecting ${k.meetings.mtd_pace_projected}');
check('Captain EOD brief uses deterministic KPI truth', eodDeterministic,
  eodDeterministic ? 'EOD renderer owns factual KPI text with no LLM narration/projection' : 'EOD can still narrate stale/self-reported KPI truth');

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
