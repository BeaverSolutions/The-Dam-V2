import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf-8');

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
  return source.slice(start, end > start ? end : start + 6000);
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
    expect(onDemandBody).toContain('researchModule.researchLeads');
    expect(onDemandBody).toContain('maxPaidQueries');
    expect(onDemandBody).toContain('web_linkedin_hunter_millionverifier');
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
    expect(kickoffBody).toContain("sourceMode: 'daily_web_linkedin_topup'");
    expect(kickoffBody).toContain('maxPaidSignalQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP');
    expect(kickoffBody).toContain("'daily_web_linkedin_topup_deduped'");
    expect(kickoffBody).toContain("'daily_web_linkedin_topup_empty'");
    expect(kickoffBody).toContain('verifyKickoffOutput(clientId, target)');
    expect(kickoffBody).toContain("require('../services/kpi').recountKpi(clientId)");
    expect(kickoffBody).not.toContain('zeroStreak');
    expect(kickoffBody).not.toContain('vp_rescue');
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
