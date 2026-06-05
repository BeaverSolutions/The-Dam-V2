import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const service = (path) => readFileSync(resolve(__dirname, '../../', path), 'utf-8');

function fnBody(source, marker, endMarker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = endMarker ? source.indexOf(endMarker, start) : -1;
  return source.slice(start, end > start ? end : start + 5000);
}

describe('P0 stabilization contracts', () => {
  it('trusted CSV imports are source-specific, trusted, tiered, and deduped beyond email', () => {
    const src = service('routes/import.js');
    expect(src).toContain('vibe_csv');
    expect(src).toContain('apollo_csv');
    expect(src).toContain('const isTrustedEmailCsv = isVibeCsv || isApolloCsv');
    expect(src).toContain('meta.email_verification = email ? `trusted_from_${importSource}` : \'not_present\'');
    expect(src).toContain('emailSource = emailVerified ? importSource : null');
    expect(src).toContain("email ? 'A' : normalizedLinkedIn ? 'B' : null");
    expect(src).toContain('LOWER(TRIM(email))');
    expect(src).toContain("SPLIT_PART(linkedin_url, '?', 1)");
    expect(src).toContain('REGEXP_REPLACE(COALESCE(name');
    expect(src).not.toContain("source: 'csv_import' })");
  });

  it('dashboard daily-progress is read-only and counts email/linkedin separately', () => {
    const src = service('routes/dashboard.js');
    const route = fnBody(src, "router.get('/daily-progress'", "router.get('/weekly-learnings'");
    expect(route).not.toContain('INSERT INTO daily_kpi');
    expect(route).not.toContain('UPDATE daily_kpi');
    expect(route).toContain("channel = 'email'");
    expect(route).toContain("channel = 'linkedin'");
    expect(route).toContain('target_email_sent');
    expect(route).toContain('target_linkedin_sent');
    expect(route).toContain("AT TIME ZONE 'Asia/Kuala_Lumpur'");
  });

  it('simulated sends cannot become sent or count toward KPI/conversion', () => {
    const src = service('services/sendQueueWorker.js');
    const simulatedIdx = src.indexOf("result.status === 'simulated'");
    const sentIdx = src.indexOf("UPDATE send_queue SET status = 'sent'");
    expect(simulatedIdx).toBeGreaterThanOrEqual(0);
    expect(sentIdx).toBeGreaterThan(simulatedIdx);
    expect(src).toContain("'simulated_send_not_delivered'");
    expect(src).toContain("'send_simulated_not_counted'");
    expect(src).toContain('recoverStaleSendingJobs');
  });

  it('paid provider calls are guarded through spendGuard', () => {
    expect(service('services/searchService.js')).toMatch(/checkProvider\('brave'[\s\S]+checkProvider\('google_cse'/);
    expect(service('services/searchService.js')).toContain('provider_error');
    expect(service('services/searchService.js')).toContain('logProviderError');
    expect(service('services/marketSensing.js')).toContain("checkProvider('brave'");
    expect(service('services/hunter.js')).toContain("checkProvider('hunter'");
    expect(service('services/emailEnrichment.js')).toContain("checkProvider('millionverifier'");
    expect(service('services/apollo.js')).toContain("checkProvider('apollo'");
    expect(service('services/spendGuard.js')).toContain("apollo: envNumber('APOLLO_DAILY_QUERY_CAP', 0)");
    expect(service('services/spendGuard.js')).toContain('providerUsageToday(provider, clientId)');
    expect(service('services/vibeProspecting.js')).toContain('ALLOW_VP_PAID_ENRICHMENT');
    expect(service('services/spendGuard.js')).toContain("brave: envNumber('BRAVE_DAILY_QUERY_CAP', 70)");
    expect(service('services/searchService.js')).toContain('SEARCH_MAX_PAID_QUERIES_PER_OPERATION');
    expect(service('services/searchService.js')).toContain('splitPaidQueryBudget');
    expect(service('services/research.js')).toContain('paidQueriesRemaining');
    expect(service('services/research.js')).toContain("paid query cap (${paidQueryCap}) reached");
    expect(service('services/spendGuard.js')).toContain('provider_blocked');
  });

  it('campaigns cannot silently claim output after zero-useful-lead paths', () => {
    const captain = service('services/captainBeaver.js');
    const agents = service('services/agents.js');
    const index = service('index.js');

    expect(index).toContain('CAPTAIN_KPI_GAP_KICKOFF_ENABLED');
    expect(captain).toContain('getRunCampaignPreflight');
    expect(captain).toContain('buildCampaignCommandFromClientConfig');
    expect(captain).toContain('isLeadCampaignRequest');
    expect(captain).toContain('campaign_background_failed');
    expect(captain).toContain('campaign_blocked');
    expect(captain).toContain('findRecentRunningExecution');
    expect(captain).toContain('expireStaleRunningExecutions');
    expect(captain).toContain('persistExecTerminalStatus');
    expect(captain).toContain('has_sufficient_research_capacity');
    expect(captain).toContain('required_paid_queries');
    expect(captain).toContain('raw_eligible_count');
    expect(captain).toContain('channel_ready_count');
    expect(captain).toContain('channel_exhausted_count');
    expect(captain).toContain('repeat_reject_count');
    expect(captain).toContain('prior_reject_count < 2');
    expect(captain).toContain("ml.channel = 'linkedin'");
    expect(captain).toContain('insufficient_paid_search_capacity');
    expect(captain).toContain("status: result?.status || 'completed'");
    expect(captain).toContain("response.status = 'captain_response'");
    expect(captain).toContain('campaign_status: campaignResult.status');
    expect(captain).not.toContain('\n      status: campaignResult.status,');
    expect(captain).toContain("NULLIF(BTRIM(l.company), '') IS NOT NULL");
    expect(agents).toContain("NULLIF(BTRIM(l.company), '') IS NOT NULL");
    expect(agents).toContain("ml.channel = 'linkedin'");
    expect(agents).toContain("l.email_verified IS TRUE OR l.email_source = 'hunter'");
    expect(agents).toContain("mr.status IN ('rejected', 'ranger_rejected')");
    expect(agents).toContain(') < 2');
    expect(agents).toContain('Provider/search parser returned 0 usable candidates');
    expect(agents).toContain('status: zeroResult.status');
    expect(agents).toContain('paid_search_capacity_insufficient');
    expect(agents).toContain('required_paid_queries');
    expect(agents).toContain('signal_first_started');
    expect(agents).toContain('runSignalHunt');
    expect(agents).toContain('signal_first_terminal_block');
    expect(agents).toContain("const blocker = diagnostics.signal_first_error ? 'signal_first_failed' : 'signal_first_unfulfilled'");
    expect(agents.indexOf('signal_first_terminal_block')).toBeLessThan(
      agents.indexOf('const MAX_RESEARCH_ROUNDS = 3')
    );
    expect(agents).toContain('research_verified');
    expect(agents).toContain('provider_candidates');
    expect(agents).toContain('original_lead_count');
    expect(agents).toContain('skipped_same_day');
    expect(agents).toContain('signal_pipeline_skipped');
    expect(agents).toContain('same_day_enrolled_dedupe');
  });

  it('signal pipeline retries rejected signal drafts before manual fallback', () => {
    const agents = service('services/agents.js');

    expect(agents).toContain('MAX_SIGNAL_RANGER_RETRIES = 2');
    expect(agents).toContain('Signal redraft ${retryAttempt + 1}');
    expect(agents).toContain('approved_after_redraft');
    expect(agents).toContain('rejected_after_redraft');
    expect(agents).toContain('Do NOT repeat the same product-pitch structure');
    expect(agents).toContain("requestedBy: 'captain_fallback'");
    expect(agents).toContain('captain_fallback_manual_review');
    expect(agents).not.toContain("requested_by, status) VALUES ($1, $2, 'enforcer_fallback', 'pending')");
  });

  it('message UI separates rejected drafts from live leads with replacement drafts', () => {
    const serviceSrc = service('services/messages.js');
    const pageSrc = service('../client/src/pages/Messages.jsx');

    expect(serviceSrc).toContain('sibling_pending_approval_count');
    expect(serviceSrc).toContain('latest_pending_approval_id');
    expect(pageSrc).toContain("ranger_rejected: { label: 'Draft Rejected'");
    expect(pageSrc).toContain('Replacement Pending');
    expect(pageSrc).toContain('Replacement draft is waiting in approvals for this same lead.');
  });

  it('VP spend ledger records paid contact enrichment immediately', () => {
    expect(service('services/spendGuard.js')).toContain("metadata->>'provider' = 'vp'");
    expect(service('services/spendGuard.js')).toContain("VP_CREDITS_PER_LEAD = envNumber('VP_CREDITS_PER_LEAD', 5)");
    expect(service('services/vibeProspecting.js')).toContain("logProviderUsage('vp'");
    expect(service('services/dbBuilder.js')).toContain("checkProvider('vp', { clientId, estimatedUnits: 5 })");
    expect(service('services/dbBuilder.js')).toContain('checkVP(0, { clientId })');
  });

  it('LLM calls require client attribution before provider spend', () => {
    expect(service('services/claude.js')).toContain('LLM_CLIENT_ID_REQUIRED');
    expect(service('services/claude.js')).toContain('allowUnattributedLLM');
    expect(service('services/claude.js')).toContain('function selectedLLMProvider()');
    expect(service('services/claude.js')).toContain("if (process.env.OPENAI_API_KEY) return 'openai'");
    expect(service('services/llm/openai.js')).toContain('LLM_CLIENT_ID_REQUIRED');
    expect(service('services/captainBeaver.js')).toContain('runWithClientContext(clientId');
    expect(service('../.env.example')).toContain('LLM_PROVIDER=openai');
    expect(service('../.env.example')).toContain('OPENAI_API_KEY=');
    expect(service('../.env.production.example')).toContain('LLM_PROVIDER=openai');
    expect(service('services/captainOrchestrator.js')).toContain('selected_key_set');
    expect(service('services/captainOrchestrator.js')).toContain("openaiSet ? 'openai' : 'anthropic'");
  });

  it('meetings are outcome tracking, not a fixed KPI target', () => {
    const captain = service('services/captainOrchestrator.js');
    const config = service('config/agents.js');
    expect(captain).not.toContain('MONTHLY_MEETING_TARGET');
    expect(captain).not.toContain('monthly_target');
    expect(captain).not.toContain('gap_to_target');
    expect(config).not.toContain('target of 10');
    expect(config).not.toContain('projection misses target');
    expect(captain).toContain('meetings outcome:');
  });

  it('Captain morning brief separates approval review queue from LinkedIn awaiting accept', () => {
    const captain = service('services/captainOrchestrator.js');
    expect(captain).toContain("COALESCE(a.notes, '') <> 'linkedin_requested'");
    expect(captain).toContain("m.status = 'pending_approval'");
    expect(captain).toContain('linkedin_awaiting_accept');
    expect(captain).toContain('stale_orphan_approval_rows');
    expect(captain).toContain('yesterday_email_sent');
    expect(captain).toContain('yesterday_linkedin_sent');
    expect(captain).toContain('renderPlainBrief(kpis)');
    expect(captain).not.toContain('quote verbatim where useful');
  });

  it('scheduled Captain Telegram never falls back to legacy directorBrief', () => {
    const index = service('index.js');
    const morningJob = fnBody(index, 'async function runMorningBrief', 'async function runWeeklyReview');
    expect(morningJob).not.toContain('directorBrief');
    expect(morningJob).not.toContain('Pipeline ready');
    expect(morningJob).toContain('generateEmergencyMorningBrief');
    expect(service('services/agents.js')).not.toContain('You have ${stats.total_leads} leads in the pipeline');
    expect(service('services/agents.js')).not.toContain('waiting for your review.');
  });

  it('Captain situation report leads with operational sections MJ needs', () => {
    const captain = service('services/captainOrchestrator.js');
    expect(captain).toContain('<b>PIPELINE STATUS</b>');
    expect(captain).toContain('<b>OUTREACH STATUS</b>');
    expect(captain).toContain("<b>TODAY'S PLAN</b>");
    expect(captain).toContain('<b>IMPEDIMENTS</b>');
    expect(captain).toContain('<b>NEED YOUR CALL</b>');
    expect(captain).toContain('draft_failed');
    expect(captain).toContain('LLM budget cap hit');
  });

  it('Captain Need Your Call separates approval tab, follow-up tab, and LinkedIn send checks', () => {
    const captain = service('services/captainOrchestrator.js');
    expect(captain).toContain('new_outreach_pending_approvals');
    expect(captain).toContain('followup_pending_approvals');
    expect(captain).toContain("COALESCE(m.metadata->>'is_followup', 'false') = 'true'");
    expect(captain).toContain("COALESCE(m.metadata->>'is_followup', 'false') <> 'true'");
    expect(captain).toContain('new outreach draft');
    expect(captain).toContain('Approval tab need your approval');
    expect(captain).toContain('Follow-ups tab need your approval');
    expect(captain).toContain('Need to Send tab');
    expect(captain).toContain('check LinkedIn acceptance');
  });

  it('budget Telegram alerts are scoped to the configured Telegram client', () => {
    const budget = service('services/budget.js');
    expect(budget).toContain('canSendBudgetTelegramForClient');
    expect(budget).toContain('process.env.TELEGRAM_CLIENT_SLUG');
    expect(budget).toContain('budget.telegram.suppressed_for_unlinked_client');
    expect(budget).toContain('ONLY this client spend is included');
    expect(budget).not.toContain('const slug = rows[0]?.slug || clientId');
  });

  it('Captain EOD brief is deterministic and does not use stale self-report narration', () => {
    const captain = service('services/captainOrchestrator.js');
    const eod = fnBody(captain, 'async function generateEodBrief', 'function renderPlainEodBrief');
    expect(eod).toContain('const summary = renderPlainEodBrief(kpis, todaysActions);');
    expect(eod).not.toContain("callAgent('captain_orchestrator'");
    expect(eod).not.toContain("INTROSPECTION (each beaver's latest self-report)");
    expect(eod).not.toContain('directiveLanding');
    expect(captain).toContain('meetings outcome:');
    expect(captain).not.toContain('projecting ${kpis.meetings.mtd_pace_projected}');
    expect(captain).not.toContain('projecting ${k.meetings.mtd_pace_projected}');
  });

  it('daily kickoff and market sensing cannot look green when disabled or missed', () => {
    const index = service('index.js');
    const jobHealth = service('services/jobHealth.js');
    const captain = service('services/captainOrchestrator.js');
    const autonomyState = service('services/autonomyState.js');

    expect(index).toContain("CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true'");
    expect(index).toContain("CAPTAIN_KPI_GAP_KICKOFF_ENABLED !== 'true'");
    expect(autonomyState).toContain("env.SCHEDULED_AUTONOMY_PAUSED !== 'false'");
    expect(autonomyState).toContain('SCHEDULED_AUTONOMY_PAUSED default-on emergency spend brake');
    expect(index).toContain("const autonomyState = require('./services/autonomyState')");
    expect(index).toContain('autonomy_state: currentAutonomyState');
    expect(index).toContain("markScheduledPause('db_builder')");
    expect(index).toContain("markScheduledPause('linkedin_sweep')");
    expect(index).toContain('CAPTAIN_DAILY_KICKOFF_ENABLED disabled; refusing KPI-gap kickoff');
    expect(index).toContain("MARKET_SENSING_ENABLED !== 'true'");
    expect(service('../.env.example')).toContain('CAPTAIN_KPI_GAP_KICKOFF_ENABLED=false');
    expect(service('../.env.example')).toContain('MARKET_SENSING_ENABLED=false');
    expect(service('../.env.production.example')).toContain('CAPTAIN_KPI_GAP_KICKOFF_ENABLED=false');
    expect(service('../.env.production.example')).toContain('MARKET_SENSING_ENABLED=false');
    expect(index).toContain("jobHealth.markSkipped('daily_kickoff'");
    expect(index).toContain("jobHealth.markSkipped('kpi_gap_kickoff'");
    expect(index).toContain("jobHealth.markSkipped('market_sensing'");
    expect(index).toContain('daily kickoff window passed without all tenant dedupe rows');
    expect(index).toContain('minutesSinceMalaysiaMidnight(now)');
    expect(index).toContain('`daily_kickoff_${todayInMalaysia(now)}`');
    expect(jobHealth).toContain('function markSkipped');
    expect(jobHealth).toContain("status: skippedStatus");
    expect(captain).toContain("CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true'");
    expect(captain).toContain('AUTONOMOUS_ENABLED_CLIENTS empty');
    expect(captain).toContain("am.key = 'daily_kickoff_' || b.today_kl::text");
    expect(captain).toContain("k.business_day.kickoff.state === 'disabled'");
    expect(captain).toContain("MARKET_SENSING_ENABLED !== 'true'");
  });

  it('pipeline stage updates do not write the removed next_action column', () => {
    const leads = service('services/leads.js');
    const updateLead = fnBody(leads, 'async function updateLead', 'async function deleteLead');
    const fieldsMatch = updateLead.match(/const fields = \[([^\]]+)\]/);

    expect(leads).toContain("meeting_booked: 'meeting_booked'");
    expect(leads).toContain("return stage === 'booked' ? 'meeting_booked' : stage");
    expect(leads).not.toContain("  'booked',");
    expect(leads).toContain("PIPELINE_STAGE_INPUTS = Object.freeze([...PIPELINE_STAGES, 'booked'])");
    expect(updateLead).toContain('delete data.next_action');
    expect(updateLead).toContain('stage_history');
    expect(fieldsMatch?.[1] || '').not.toContain('next_action');
    expect(service('routes/leads.js')).toContain("body('pipeline_stage').optional().isIn(leadsService.PIPELINE_STAGE_INPUTS)");
  });

  it('drafted messages preserve campaign provenance for end-to-end audits', () => {
    const pipeline = service('services/pipeline.js');

    expect(pipeline).toContain('kickoff_id,');
    expect(pipeline).toContain('pipeline_path,');
    expect(pipeline).toContain('metadata: { channel, draft_source, signal }');
  });

  it('Captain can provide authenticated tenant-scoped database exports without leaking secrets', () => {
    const captain = service('services/captainBeaver.js');
    const index = service('index.js');
    const route = service('routes/exports.js');
    const exporter = service('services/databaseExport.js');

    expect(captain).toContain("name: 'export_database'");
    expect(captain).toContain('toolExportDatabase');
    expect(captain).toContain("case 'export_database'");
    expect(index).toContain("app.use('/api/exports'");
    expect(index).toContain("authMiddleware, tenantScope, clientContext, require('./routes/exports')");
    expect(route).toContain("router.get('/database.xlsx'");
    expect(route).toContain('req.clientId');
    expect(route).toContain('Content-Disposition');
    expect(exporter).toContain('ExcelJS');
    expect(exporter).toContain('WHERE client_id = $1');
    expect(exporter).toContain("memory_type <> 'secret'");
    expect(exporter).toContain('database_export_requested');
    expect(exporter).not.toContain('express.static');
  });

  it('Apollo is guarded and not trusted as a verified email source', () => {
    const agents = service('services/agents.js');
    expect(agents).not.toContain("lead.email_source === 'apollo'");
    expect(service('services/apollo.js')).toContain("checkProvider('apollo'");
    expect(service('services/apollo.js')).toContain("logProviderUsage('apollo'");
  });

  it('research stays signal-first while company support stays inside the paid query picker', () => {
    const research = service('services/research.js');
    expect(research).toContain('signal_jobs: 0');
    expect(research).toContain('signalStrategies');
    expect(research).toContain("q.strategy === 'direct'");
    expect(research).toContain('const companyQueries = picked.filter');
    expect(research).toContain('const companyDiscoveryQueries = [');
    expect(research).toContain('signal_jobs');
    expect(research).toContain('signal_company_first');
    expect(research).toContain('queryItems');
    expect(research).toContain('maxFallbackProfileQueries');
    expect(research).toContain('fallbackQueriesUsed');
    expect(research).toContain('fallbackProfileBudget > 0');
    expect(research).toContain('function companyDiscoveryMatchesQuery');
    expect(research).toContain('companyDiscoveryMatchesQuery(item, c)');
    expect(research).toContain('companyFilteredOut');
    expect(research).toContain('seenCompanyKeys');
    expect(research).toContain('initial verification rejected all');
    expect(research).toContain('rejection_summary');
    expect(research).toContain('rejection_samples');
    expect(research).toContain('retryCompanyQueries');
  });

  it('Signal Hunt uses current ICP before stale stored config and does not double-reserve query budget', () => {
    const signalHunt = service('services/signalHunt.js');

    expect(signalHunt).toContain('function hasIcpSearchScope');
    expect(signalHunt).toContain('const icpQueries = hasIcpSearchScope(icp) ? buildSignalQueriesFromIcp(icp) : []');
    expect(signalHunt).toContain('const fallbackQueries = icpQueries.length > 0');
    expect(signalHunt).toContain('...icpQueries, ...configuredQueries');
    expect(signalHunt).toContain('for (const industry of industries)');
    expect(signalHunt).toContain('for (const country of countries)');
    expect(signalHunt.indexOf('for (const industry of industries)')).toBeLessThan(
      signalHunt.indexOf('for (const country of countries)')
    );
    expect(signalHunt).toContain('consumePaidQuery(1)');
    expect(signalHunt).not.toContain('consumePaidQuery(2)');
    expect(signalHunt).toContain('signal_hunt_complete');
    expect(signalHunt).toContain('query_source: config.query_source');
  });

  it('DB Builder deficit sourcing uses Signal Hunt first and gates legacy Research fallback', () => {
    const dbBuilder = service('services/dbBuilder.js');
    const sourceStart = dbBuilder.indexOf('async function sourceLeads');
    const sourceEnd = dbBuilder.indexOf('// ── Main Loop', sourceStart);
    const sourceBody = dbBuilder.slice(sourceStart, sourceEnd);

    expect(sourceBody).toContain("require('./signalHunt')");
    expect(sourceBody).toContain('runSignalHunt(clientId');
    expect(sourceBody).toContain('saveSignalLeads(clientId');
    expect(sourceBody).toContain("'db_signal_first_complete'");
    expect(sourceBody).toContain("envInt('DB_BUILDER_SIGNAL_FIRST_QUERY_CAP', 12)");
    expect(sourceBody).toContain("process.env.DB_BUILDER_LEGACY_RESEARCH_FALLBACK_ENABLED === 'true'");
    expect(sourceBody.indexOf('runSignalHunt(clientId')).toBeLessThan(sourceBody.indexOf('researchModule.researchLeads(clientId'));
  });

  it('autonomous routes require the internal key at router level', () => {
    const autonomous = service('routes/autonomous.js');
    expect(autonomous).toContain('router.use(requireInternalKey)');
  });

  it('channel escalation is capped, queue-aware, and traced before drafting', () => {
    const autonomous = service('routes/autonomous.js');
    const block = fnBody(autonomous, 'Channel escalation: after touch 3+', 'Sprint 7D: Ranger rejection pattern detection');

    expect(autonomous).toContain('CHANNEL_ESCALATION_DAILY_CAP');
    expect(block).toContain('channelEscalationHeadroom');
    expect(block).toContain('channelEscalationRemaining');
    expect(block).toContain('LIMIT $2');
    expect(block).toContain('pipelineTrace.traceStage(clientId');
    expect(block.indexOf('approval_queue_swamped')).toBeLessThan(block.indexOf("callAgent('sales_beaver'"));
  });

  it('channel escalation drafts do not consume follow-up draft capacity', () => {
    const autonomous = service('routes/autonomous.js');
    const block = fnBody(autonomous, 'Channel escalation: after touch 3+', 'Sprint 7D: Ranger rejection pattern detection');
    expect(block).toContain('follow_up_day');
    expect(block).toContain('NULL');

    const followups = service('services/followupSequence.js');
    const counter = fnBody(followups, 'async function followUpsDraftedToday', 'async function remainingFollowUpCapacity');
    expect(counter).toContain("COALESCE(metadata->>'is_channel_escalation', 'false') <> 'true'");
    expect(counter).toContain('follow_up_day > 0');
  });

  it('manual kickoff workflow is single-tenant and never uses kickoff-all or force', () => {
    const autonomous = service('routes/autonomous.js');
    const trigger = service('../scripts/trigger-kickoff.mjs');
    const watchdog = service('../scripts/kickoff-watchdog.mjs');
    const workflow = service('../.github/workflows/trigger-kickoff.yml');

    expect(autonomous).toContain('client_id: c.id');
    expect(autonomous).toContain("KICKOFF_ALL_ENABLED !== 'true'");
    expect(autonomous).toContain("KICKOFF_FORCE_OVERRIDE_ENABLED !== 'true'");
    expect(autonomous).toContain('KICKOFF_ALL_DISABLED');
    expect(autonomous).toContain('AUTONOMOUS_ENABLED_CLIENTS empty — fanout routes resolve to zero clients');
    expect(autonomous).not.toContain("const { rows } = await pool.query('SELECT id FROM clients')");
    expect(service('../.env.example')).toContain('KICKOFF_ALL_ENABLED=false');
    expect(service('../.env.example')).toContain('AUTONOMOUS_ENABLED_CLIENTS=beaver-solutions');
    expect(service('../.env.production.example')).toContain('KICKOFF_FORCE_OVERRIDE_ENABLED=false');
    expect(service('../.env.production.example')).toContain('AUTONOMOUS_ENABLED_CLIENTS=beaver-solutions');
    expect(trigger).toContain('Missing env: CLIENT_SLUG. Refusing all-tenant kickoff.');
    expect(trigger).toContain('/api/autonomous/kickoff');
    expect(trigger).not.toContain('/api/autonomous/kickoff-all');
    expect(trigger).not.toContain('force=1');
    expect(trigger).not.toContain('force: true');
    expect(watchdog).toContain('Do not use /kickoff-all or force=1');
    expect(workflow).toContain('required: true');
  });

  it('system-health and watchdog use MYT kickoff state and approval queue truth', () => {
    const autonomous = service('routes/autonomous.js');
    const healthPack = service('../scripts/daily-health-pack.mjs');
    const hourlyReport = service('../scripts/hourly-report.mjs');
    const watchdog = service('../scripts/kickoff-watchdog.mjs');
    const platformHealth = service('../scripts/platform-health.mjs');
    const postDeployCheck = service('../scripts/post-deploy-autonomy-check.mjs');
    const postDeployWorkflow = service('../.github/workflows/post-deploy-autonomy-check.yml');
    const packageJson = service('../package.json');

    expect(autonomous).toContain("Asia/Kuala_Lumpur");
    expect(autonomous).toContain('kl_minutes_now');
    expect(autonomous).toContain('memory_written');
    expect(autonomous).toContain('kickoffWorkProof');
    expect(autonomous).toContain('kickoffMemoryOnlyStarted');
    expect(autonomous).toContain("state: kickoffState");
    expect(autonomous).toContain('memory_only_started');
    expect(autonomous).toContain('trace_count');
    expect(autonomous).toContain('source_truth');
    expect(autonomous).toContain('daily_kpi_row_present');
    expect(autonomous).toContain('COALESCE(dk.target, 50)');
    expect(autonomous).toContain('approval_queue');
    expect(autonomous).toContain('followup_queue');
    expect(autonomous).toContain('orphaned_sent_leads');
    expect(autonomous).toContain('linkedin_awaiting_accept');
    expect(autonomous).toContain('captain_kpi_gap_kickoff_enabled');
    expect(healthPack).toContain("state === 'missed'");
    expect(healthPack).toContain('waiting for 09:30 MYT');
    expect(healthPack).toContain('started marker only; no work proof');
    expect(healthPack).toContain('Approval queue:');
    expect(healthPack).toContain('Follow-ups:');
    expect(healthPack).toContain('sent leads missing follow-up rows');
    expect(healthPack).toContain('research starved and lead pool thin');
    expect(hourlyReport).toContain('/api/autonomous/system-health');
    expect(hourlyReport).toContain('Approval queue:');
    expect(hourlyReport).toContain('Follow-ups:');
    expect(hourlyReport).toContain('LinkedIn awaiting accept');
    expect(hourlyReport).toContain('Daily kickoff gate:');
    expect(hourlyReport).toContain('<b>Action needed</b>');
    expect(hourlyReport).toContain('KPI-gap:');
    expect(hourlyReport).toContain('daily kickoff disabled');
    expect(hourlyReport).toContain('sent leads missing follow-up rows');
    expect(hourlyReport).toContain('started marker only; no work proof');
    expect(hourlyReport).not.toContain('/api/autonomous/hourly-stats');
    expect(hourlyReport).not.toContain('Q2:');
    expect(hourlyReport).not.toContain('Emplifive');
    expect(watchdog).toContain("['missed', 'disabled'].includes");
    expect(platformHealth).toContain("api('/api/autonomous/system-health')");
    expect(platformHealth).not.toContain("api('/api/autonomous/hourly-stats')");
    expect(platformHealth).not.toContain('Sent: ${sentToday}/50');
    expect(platformHealth).toContain('LI-awaiting');
    expect(platformHealth).toContain('follow-ups due');
    expect(platformHealth).toContain('sent leads missing follow-up rows');
    expect(platformHealth).toContain('pipeline produced no approval-ready output');
    expect(platformHealth).toContain('kickoff has only a start marker, no work proof');
    expect(postDeployCheck).toContain("getJson('/health')");
    expect(postDeployCheck).toContain("getJson('/api/autonomous/system-health'");
    expect(postDeployCheck).toContain('EXPECT_DAILY_KICKOFF_ENABLED');
    expect(autonomous).toContain('scheduled_autonomy_paused: scheduledAutonomyPaused');
    expect(autonomous).toContain('autonomy_state: autonomyState');
    expect(postDeployCheck).toContain('SCHEDULED_AUTONOMY_PAUSED');
    expect(postDeployCheck).toContain('function isPausedOrDisabled');
    expect(postDeployCheck).toContain('function isGlobalScheduledPauseVisible');
    expect(postDeployCheck).toContain("['disabled', 'skipped'].includes(job.status)");
    expect(postDeployCheck).toContain('global scheduled pause visible before job marker');
    expect(postDeployCheck).toContain('EXPECT_KPI_GAP_KICKOFF_ENABLED');
    expect(postDeployCheck).toContain("jobStatus(lastHealth, 'kpi_gap_kickoff')");
    expect(postDeployCheck).toContain('WAIT_FOR_DEPLOY_SECONDS');
    expect(postDeployCheck).toContain('waitForFreshDeploy');
    expect(postDeployCheck).toContain('WAIT_FOR_JOBS_SECONDS');
    expect(postDeployCheck).not.toContain('Promise.all');
    expect(postDeployCheck).toContain('system-health exposes daily KPI target');
    expect(postDeployCheck).toContain("['outreach_sent', 'outreach_email', 'outreach_linkedin']");
    expect(postDeployCheck).toContain('reviewable approvals under cap');
    expect(postDeployCheck).toContain("['pending', 'due_today', 'orphaned_sent_leads']");
    expect(postDeployCheck).not.toContain("method: 'POST'");
    expect(postDeployCheck).not.toContain('/kickoff');
    expect(postDeployWorkflow).toContain('workflow_dispatch');
    expect(postDeployWorkflow).toContain('BEAVRDAM_INTERNAL_API_KEY');
    expect(postDeployWorkflow).toContain('expect_daily_kickoff_enabled');
    expect(postDeployWorkflow).toContain('expect_kpi_gap_kickoff_enabled');
    expect(postDeployWorkflow).toContain('WAIT_FOR_DEPLOY_SECONDS');
    expect(postDeployWorkflow).toContain('WAIT_FOR_JOBS_SECONDS');
    expect(packageJson).toContain('"check:post-deploy"');
  });
});
