import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf-8').replace(/\r\n/g, '\n');

const indexSource = read('index.js');
const autonomousSource = read('routes/autonomous.js');
const agentsSource = read('services/agents.js');
const dbBuilderSource = read('services/dbBuilder.js');
const signalHuntSource = read('services/signalHunt.js');
const contactGateSource = read('services/contactGate.js');
const pipelineSource = read('services/pipeline.js');
const sendQueueSource = read('services/sendQueueWorker.js');
const replyDetectorSource = read('services/replyDetector.js');
const approvalsSource = read('services/approvals.js');
const kpiSource = read('services/kpi.js');
const captainSource = read('services/captainOrchestrator.js');
const directivesSource = read('services/directives.js');
const tenantConfigSource = read('services/tenantConfig.js');
const googleCalendarSource = read('services/googleCalendar.js');
const followupSource = read('services/followupSequence.js');

function functionBody(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThan(-1);
  const end = endNeedle ? source.indexOf(endNeedle, start) : -1;
  return source.slice(start, end > start ? end : source.length);
}

describe('BeavrDam autonomous end-to-end contract', () => {
  it('schedules every autonomous owner and makes disabled follow-ups visible', () => {
    expect(indexSource).toContain('processSendQueue()');
    expect(indexSource).toContain("jobHealth.markRun('send_queue'");
    expect(indexSource).toContain('runCaptainDirectiveSweep()');
    expect(indexSource).toContain("jobHealth.markRun('captain_directive_sweep'");
    expect(indexSource).toContain("jobHealth.markError('captain_directive_sweep'");
    expect(indexSource).toContain('runAutonomousKickoff(client.id)');
    expect(indexSource).toContain("jobHealth.markRun('daily_kickoff'");
    expect(indexSource).toContain('runDbBuilder()');
    expect(indexSource).toContain("jobHealth.markRun('db_builder'");
    expect(indexSource).toContain('checkAllClients()');
    expect(indexSource).toContain("jobHealth.markRun('reply_detector'");
    expect(indexSource).toContain('calendarService.syncMeetings');
    expect(indexSource).toContain("jobHealth.markSkipped('follow_up_scheduler'");
    expect(indexSource).toContain('FOLLOW_UP_SCHEDULER_DISABLED');
  });

  it('sources through capped web/LinkedIn and saves only channel-ready leads', () => {
    const onDemandBody = functionBody(dbBuilderSource, 'async function sourceLeadsOnDemand', 'module.exports');

    expect(onDemandBody).not.toContain('sourceLeadsViaVP');
    expect(onDemandBody).toContain('runSignalHunt');
    expect(onDemandBody).toContain('saveSignalLeads');
    expect(onDemandBody).toContain("'on_demand_signal_first_complete'");
    expect(onDemandBody.indexOf('runSignalHunt')).toBeLessThan(onDemandBody.indexOf('researchModule.researchLeads'));
    expect(onDemandBody).toContain('maxPaidQueries');
    expect(onDemandBody).toContain('signal_hunt_contact_gate');
    expect(signalHuntSource).toContain('MAX_SIGNAL_QUERIES_PER_RUN');
    expect(signalHuntSource).toContain('maxPaidQueries');
    expect(signalHuntSource).toContain('blockedByRepeatedZeroQuerySet');
    expect(signalHuntSource).toContain('raw_results_total');
    expect(signalHuntSource).toContain('saveSignalLeads');
    expect(signalHuntSource).toContain('contactGate.tryPersistSourcedLead');
    expect(contactGateSource).toContain("lead_tier = 'A'");
    expect(contactGateSource).toContain("return { passed: true, tier: 'B'");
    expect(signalHuntSource).toContain('lead_tier, tiered_at');
  });

  it('daily kickoff cannot turn DB-pool processing into hidden paid search', () => {
    const kickoffBody = functionBody(autonomousSource, 'async function _runAutonomousKickoffInner', '/**\n * Post-kickoff verification');

    expect(kickoffBody).toContain('const DAILY_WEB_LINKEDIN_SIGNAL_CAP');
    expect(kickoffBody).toContain("sourceMode: 'daily_db_pool'");
    expect(kickoffBody).toContain('allowPaidSignal: false');
    expect(kickoffBody).toContain('sourceLeadsOnDemand(clientId');
    expect(kickoffBody).not.toContain("sourceMode: 'daily_web_linkedin_topup'");
    expect(kickoffBody).toContain('maxPaidQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP');
    expect(kickoffBody).toContain('if (poolLeads.length > 0)');
    expect(kickoffBody).toContain('if (passingIds.length > 0)');
    expect(kickoffBody).toContain('limit: passingIds.length');
    expect(kickoffBody).toContain("currentSignalPackageEligibilitySql('leads')");
    expect(kickoffBody).not.toContain('Math.min(draftSize, 5)');
    expect(kickoffBody).toContain("'daily_web_linkedin_topup_deduped'");
    expect(kickoffBody).toContain("'daily_web_linkedin_topup_empty'");
    expect(kickoffBody).toContain('const kickoffRunStartedAt = options.kickoffRunStartedAt || new Date()');
    expect(kickoffBody).toContain('verifyKickoffOutput(clientId, target, { runStartedAt: kickoffRunStartedAt })');
    expect(kickoffBody).toContain("require('../services/kpi').recountKpi(clientId)");
    expect(kickoffBody).not.toContain('zeroStreak');
    expect(kickoffBody).not.toContain('vp_rescue');
  });

  it('Captain blocks KPI-gap auto-kickoffs after scheduled zero or low-yield kickoff output', () => {
    const kickoffBody = functionBody(autonomousSource, 'async function writeKickoffBlocker', 'function buildAutonomousBrief');
    const kpiGapBody = functionBody(indexSource, 'async function runKpiGapKickoff', 'async function runCaptainDirectiveSweep');

    expect(autonomousSource).toContain("require('../utils/campaignLimits')");
    expect(kickoffBody).toContain('shouldStopForLowOutput({ requested, delivered })');
    expect(kickoffBody).toContain('captain_kickoff_blocker_');
    expect(kickoffBody).toContain("'captain_kickoff_blocker_required'");
    expect(kickoffBody).toContain("'daily_kickoff_low_yield_blocker'");
    expect(kickoffBody).toContain("blocker: 'zero_outputs'");
    expect(kickoffBody).toContain("blocker: 'low_yield_outputs'");
    expect(kpiGapBody).toContain('captain_kickoff_blocker_');
    expect(kpiGapBody).toContain("'kpi_gap_blocked_by_kickoff_blocker'");
    expect(kpiGapBody).toContain('refusing follow-on autonomous kickoff');
  });

  it('Director enforces source mode, paid cap, same-day top-up dedupe, and no generic fallback by default', () => {
    const directorBody = functionBody(agentsSource, 'async function directorExecute', 'module.exports');

    expect(agentsSource).toContain('async function claimDailyPaidSignalAttempt');
    expect(agentsSource).toContain('one_topup_attempt_per_myt_day');
    expect(directorBody).toContain('allowPaidSignal = true');
    expect(directorBody).toContain("blocker = 'paid_signal_disabled_for_source_mode'");
    expect(directorBody).toContain('paidSignalCap');
    expect(directorBody).toContain('maxPaidSignalQueries');
    expect(directorBody).toContain('daily_web_linkedin_topup_already_attempted');
    expect(directorBody).toContain('signal_first_terminal_block');
    expect(autonomousSource).toContain("GENERIC_SOURCING_ENABLED !== 'true'");
  });

  it('scheduled daily web top-up failures are logged before post-run verification', () => {
    const kickoffBody = functionBody(autonomousSource, 'async function _runAutonomousKickoffInner', '/**\n * Post-kickoff verification');
    const failureLogs = kickoffBody.match(/'daily_web_linkedin_topup_failed'/g) || [];
    const firstTopupIdx = kickoffBody.indexOf("context: 'pool_dry_channel_target'");
    const secondTopupIdx = kickoffBody.indexOf("context: 'cold_research_fallback'");
    const verifyIdx = kickoffBody.indexOf('verifyKickoffOutput(clientId, target, { runStartedAt: kickoffRunStartedAt })');

    expect(firstTopupIdx).toBeGreaterThan(-1);
    expect(secondTopupIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(secondTopupIdx);
    expect(failureLogs.length).toBeGreaterThanOrEqual(2);
    expect(kickoffBody.slice(firstTopupIdx, verifyIdx)).toContain("context: 'pool_dry_channel_target'");
    expect(kickoffBody.slice(firstTopupIdx, verifyIdx)).toContain('catch (err)');
    expect(kickoffBody.slice(secondTopupIdx, verifyIdx)).toContain("context: 'cold_research_fallback'");
    expect(kickoffBody.slice(secondTopupIdx, verifyIdx)).toContain('catch (err)');
  });

  it('successful daily web top-up is consumed by the same kickoff run', () => {
    const kickoffBody = functionBody(autonomousSource, 'async function _runAutonomousKickoffInner', '/**\n * Post-kickoff verification');
    const poolDryTopupStart = kickoffBody.indexOf("context: 'pool_dry_channel_target'");
    const genericEnabledBranch = kickoffBody.indexOf('if (poolDryResearchAttempts >= MAX_POOL_DRY_RESEARCH)', poolDryTopupStart);
    const poolDryTopupBranch = kickoffBody.slice(poolDryTopupStart, genericEnabledBranch);
    const successIdx = poolDryTopupBranch.indexOf("'daily_web_linkedin_topup_success'");
    const continueIdx = poolDryTopupBranch.indexOf('continue;', successIdx);
    const terminalBreakIdx = poolDryTopupBranch.lastIndexOf('break;');

    expect(poolDryTopupStart).toBeGreaterThan(-1);
    expect(poolDryTopupBranch).toContain('const topupSaved');
    expect(successIdx).toBeGreaterThan(-1);
    expect(continueIdx).toBeGreaterThan(successIdx);
    expect(terminalBreakIdx).toBeGreaterThan(continueIdx);
    expect(indexSource).toContain("'daily_web_linkedin_topup_success'");
    expect(autonomousSource).toContain("'daily_web_linkedin_topup_success'");
  });

  it('system-health reports exact kickoff-selectable pool capacity, not raw lead stock', () => {
    const healthBody = functionBody(autonomousSource, "router.get('/system-health'", '/* ─── POST /api/autonomous/mark-linkedin-sent');

    expect(healthBody).toContain('kickoff_selectable_email');
    expect(healthBody).toContain('kickoff_selectable_linkedin');
    expect(healthBody).toContain('kickoff_selectable_total');
    expect(healthBody).toContain("m.status <> 'deleted'");
    expect(healthBody).toContain("lead_pool_remaining: Number(leadPool.rows[0].kickoff_selectable_total)");
    expect(healthBody).toContain('lead_pool: {');
  });

  it('start markers are not kickoff work proof and KPI-gap blocks unverified daily kickoff runs', () => {
    const healthBody = functionBody(autonomousSource, "router.get('/system-health'", '/* ─── POST /api/autonomous/mark-linkedin-sent');
    const kpiGapBody = functionBody(indexSource, 'async function runKpiGapKickoff', 'async function runCaptainDirectiveSweep');
    const dailyKickoffBody = functionBody(indexSource, 'async function runDailyKickoff', 'async function runMarketSensingCron');
    const kickoffWrapperBody = functionBody(autonomousSource, 'async function runAutonomousKickoff', 'async function _runAutonomousKickoffInner');

    expect(healthBody).toContain('last_start_log_at');
    expect(healthBody).toContain('last_work_log_at');
    expect(healthBody).toContain('const kickoffWorkProof = !!(evidence.last_work_log_at || Number(evidence.trace_count) > 0)');
    expect(healthBody).not.toContain('const kickoffWorkProof = !!(evidence.last_log_at || Number(evidence.trace_count) > 0)');
    expect(kpiGapBody).toContain('kpi_gap_blocked_by_unverified_daily_kickoff');
    expect(kpiGapBody).toContain('daily kickoff start marker has no output proof');
    expect(kpiGapBody).toContain('dailyKickoffWorkProof');
    expect(indexSource).toContain('function dailyKickoffHasWorkProof(proof)');
    expect(indexSource).toContain('async function getDailyKickoffProof(clientId, today)');
    expect(indexSource).toContain('daily_kickoff_unverified_output_blocker');
    expect(dailyKickoffBody).toContain('daily kickoff dedupe rows present but no output proof');
    expect(dailyKickoffBody).toContain("blocked: true, reason: 'daily kickoff start marker has no output proof'");
    expect(kickoffWrapperBody).toContain("'autonomous_kickoff_failed'");
    expect(kickoffWrapperBody).toContain('verifyKickoffOutput(clientId, 20, { runStartedAt: kickoffRunStartedAt })');
  });

  it('drafting and Enforcer approval converge through the shared approval/enqueue path', () => {
    expect(agentsSource).toContain('pipeline.applyEnforcerDecision(clientId');
    expect(pipelineSource).toContain('function isVerifiedEmailReadyLead');
    expect(pipelineSource).toContain('email source is not verified or trusted');
    expect(pipelineSource).toContain('INSERT INTO approvals');
    expect(pipelineSource).toContain('requestedBy = isBorderline');
    expect(pipelineSource).toContain('auto_approval');
    expect(pipelineSource).toContain('enqueueMessage(clientId, msg.id)');
    expect(pipelineSource).toContain("pipelineTrace.traceStage(clientId");
    expect(pipelineSource).toContain("stage: isBorderline ? 'reviewed' : 'approved'");
  });

  it('routes thin research through a bounded repair loop before Captain fallback', () => {
    expect(directivesSource).toContain('repair_signal_package');
    expect(pipelineSource).toContain("writeDirective(clientId, 'research_beaver', 'repair_signal_package'");
    expect(dbBuilderSource).toContain("directive_type === 'repair_signal_package'");
    expect(dbBuilderSource).toContain('repairLeadSignalPackage');
    expect(pipelineSource).toContain('signal_package: retrySignalPackage');
    expect(pipelineSource).toContain('lead: leadForFallback');
    expect(agentsSource).toContain('const effectiveSignalPackage = draft.signal_package');
    expect((agentsSource.match(/signal_package: effectiveSignalPackage/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((agentsSource.match(/\.\.\.evidenceMetadata/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(agentsSource).toContain('async function captainFallbackDraft');
    expect(agentsSource).toContain("draftSource: 'captain_fallback'");
    expect(agentsSource).toContain("'captain_fallback'");
    expect(agentsSource).toContain('researchRepairExhausted');
    expect(agentsSource).toContain("repair_route === 'needs_research_repair'");
  });

  it('send, manual-send, KPI, follow-up, and learning loops are wired after real sends', () => {
    expect(sendQueueSource).toContain("result.status === 'simulated'");
    expect(sendQueueSource).toContain("UPDATE send_queue SET status = 'sent'");
    expect(sendQueueSource).toContain("stage: 'sent'");
    expect(sendQueueSource).toContain("require('./kpi').recountKpi(client_id)");
    expect(sendQueueSource).toContain('postFeedbackEvent');
    expect(sendQueueSource).toContain('trackEvent');
    expect(approvalsSource).toContain("recountKpiAsync(clientId, 'manual-send approval')");
    expect(approvalsSource).toContain("recountKpiAsync(clientId, 'linkedin accepted')");
    expect(approvalsSource).toContain('scheduleFollowUps(clientId');
    expect(followupSource).toContain('FOLLOWUP_DAILY_DRAFT_CAP');
    expect(followupSource).toContain('needs_more_research');
    expect(kpiSource).toContain('outreach_sent = (');
    expect(kpiSource).toContain("status = 'sent'");
    expect(kpiSource).toContain('kpi_recount_failed');
  });

  it('Captain, dashboard truth, calendar sync, and health fail visible instead of false green', () => {
    expect(captainSource).toContain('dam_kpi_snapshot_failed');
    expect(captainSource).toContain('snapshot_written');
    expect(captainSource).toContain('snapshot_error');
    expect(captainSource).toContain('signal_scorecard: buildSignalScorecard');
    expect(tenantConfigSource).toContain('buying_signals');
    expect(tenantConfigSource).toContain('competitor_offers: Array.isArray(icp.competitor_offers)');
    expect(captainSource).toContain('buying_signals: cfg.buying_signals');
    expect(captainSource).toContain('buildCaptainSignalOrchestration');
    expect(captainSource).toContain('writeSignalOrchestrationDirectives');
    expect(directivesSource).toContain('run_signal_playbook');
    expect(directivesSource).toContain('fix_signal_copy');
    expect(captainSource).toContain("jobHealth.markDegraded('captain_directive_sweep'");
    expect(indexSource).toContain('captain_directive_sweep_snapshot_failed');
    expect(autonomousSource).toContain('router.get(\'/system-health\'');
    expect(autonomousSource).toContain('basic_operating_surface');
    expect(autonomousSource).toContain('BASIC_OPERATING_SURFACE_V2_1');
    expect(autonomousSource).toContain('external_tenant_activation_gate');
    expect(autonomousSource).toContain('source_truth');
    expect(autonomousSource).toContain('daily_kpi_row_present');
    expect(autonomousSource).toContain("daily_kickoff_' || b.today_kl::text");
    expect(autonomousSource).toContain('approval_queue');
    expect(autonomousSource).toContain('followup_queue');
    expect(autonomousSource).toContain('orphaned_sent_leads');
    expect(googleCalendarSource).toContain('ON CONFLICT (client_id, google_event_id) WHERE google_event_id IS NOT NULL DO UPDATE');
  });

  it('V2.1 Basic keeps LinkedIn manual-safe and excludes managed automation', () => {
    expect(autonomousSource).toContain("router.get('/linkedin-queue'");
    expect(autonomousSource).toContain('manual_linkedin_queue');
    expect(autonomousSource).toContain("managed_automation: false");
    expect(autonomousSource).toContain("accepted_dm_automation: false");
    expect(sendQueueSource).toContain('BASIC_SEND_POLICY');
    expect(sendQueueSource).toContain('basic_manual_send_channel');
    expect(replyDetectorSource).toContain('BASIC_REPLY_TRACKING_POLICY');
  });
});
