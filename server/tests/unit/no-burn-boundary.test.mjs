import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(resolve(__dirname, '../../index.js'), 'utf-8');
const autonomousSource = readFileSync(resolve(__dirname, '../../routes/autonomous.js'), 'utf-8');
const agentsSource = readFileSync(resolve(__dirname, '../../services/agents.js'), 'utf-8');
const pipelineSource = readFileSync(resolve(__dirname, '../../services/pipeline.js'), 'utf-8');
const researchEnrichmentSource = readFileSync(resolve(__dirname, '../../services/researchEnrichment.js'), 'utf-8');
const signalHuntSource = readFileSync(resolve(__dirname, '../../services/signalHunt.js'), 'utf-8');
const searchServiceSource = readFileSync(resolve(__dirname, '../../services/searchService.js'), 'utf-8');
const marketSensingSource = readFileSync(resolve(__dirname, '../../services/marketSensing.js'), 'utf-8');
const emailEnrichmentSource = readFileSync(resolve(__dirname, '../../services/emailEnrichment.js'), 'utf-8');
const dbBuilderSource = readFileSync(resolve(__dirname, '../../services/dbBuilder.js'), 'utf-8');
const researchSource = readFileSync(resolve(__dirname, '../../services/research.js'), 'utf-8');

// ── 2c: unify the no-burn boundary across the autonomous kickoff loop ─────
// The two generic paid-sourcing escape hatches (on-demand research + VP rescue)
// must be gated behind GENERIC_SOURCING_ENABLED so enabling daily kickoff cannot
// burn generic scraping for 0 output — same boundary as directorExecute's
// signal_first_terminal_block.
describe('autonomous kickoff loop — no-burn boundary (Phase 2c)', () => {
  it('gates BOTH generic-sourcing call-sites behind GENERIC_SOURCING_ENABLED', () => {
    const gates = autonomousSource.match(/process\.env\.GENERIC_SOURCING_ENABLED !== 'true'/g) || [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
    expect(autonomousSource).toContain("'generic_sourcing_disabled_skip'");
    expect(autonomousSource).toContain("context: 'pool_dry_on_demand_research'");
    expect(autonomousSource).toContain("context: 'zero_streak_vp_rescue'");
  });

  it('puts each gate BEFORE its sourceLeadsOnDemand call (no burn when off)', () => {
    // On-demand research site: the pool_dry gate precedes the first generic call.
    const poolDryGate = autonomousSource.indexOf("context: 'pool_dry_on_demand_research'");
    const firstGenericCall = autonomousSource.indexOf('sourceLeadsOnDemand(clientId, { neededChannel, batchSize: BATCH_SIZE })');
    expect(poolDryGate).toBeGreaterThan(-1);
    expect(firstGenericCall).toBeGreaterThan(-1);
    expect(poolDryGate).toBeLessThan(firstGenericCall);

    // Zero-streak rescue site: the rescue gate precedes the VP rescue call.
    const rescueGate = autonomousSource.indexOf("context: 'zero_streak_vp_rescue'");
    const vpRescueCall = autonomousSource.lastIndexOf('sourceLeadsOnDemand(clientId, { neededChannel, batchSize: BATCH_SIZE })');
    expect(rescueGate).toBeGreaterThan(-1);
    expect(rescueGate).toBeLessThan(vpRescueCall);
  });
});

// ── 2b: stage the per-lead PIPELINE_V2 unification (no flip yet) ──────────
// processLead is the single unified per-lead path. BOTH per-lead pipelines must
// route through it when the flag is on. The flag stays OFF in prod until the
// money-approved proof run validates it live.
describe('PIPELINE_V2 per-lead unification is wired on both paths (Phase 2b)', () => {
  it('both per-lead pipelines delegate to pipeline.processLead under isV2Enabled', () => {
    const v2Branches = agentsSource.match(/if \(pipeline\.isV2Enabled\(\)\)/g) || [];
    expect(v2Branches.length).toBeGreaterThanOrEqual(2); // signal path + kickoff path
    const processLeadCalls = agentsSource.match(/pipeline\.processLead\(/g) || [];
    expect(processLeadCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('PIPELINE_V2 stays OFF by default (flip is the Phase 4 validated proof, not now)', () => {
    expect(pipelineSource).toContain("process.env.PIPELINE_V2_ENABLED === 'true'");
  });
});

describe('budget-cap no-burn boundary', () => {
  it('blocks autonomous kickoff before it can start paid work', () => {
    const budgetGuard = autonomousSource.indexOf('const budgetState = await checkBudget(clientId)');
    const firstKpiWrite = autonomousSource.indexOf('INSERT INTO daily_kpi');
    expect(budgetGuard).toBeGreaterThan(-1);
    expect(firstKpiWrite).toBeGreaterThan(-1);
    expect(budgetGuard).toBeLessThan(firstKpiWrite);
    expect(autonomousSource).toContain("'kickoff_blocked_budget'");
  });

  it('does not mark the scheduled daily kickoff as done when budget is blocked', () => {
    const schedulerBudgetLog = autonomousSource.indexOf("'kickoff_blocked_budget'");
    const indexBudgetLog = indexSource.indexOf("'daily_kickoff_blocked_budget'");
    expect(schedulerBudgetLog).toBeGreaterThan(-1);
    expect(indexBudgetLog).toBeGreaterThan(-1);
  });

  it('treats budget cap as a hard abort, not a normal null draft', () => {
    expect(agentsSource).toContain('Sales generation blocked by budget cap');
    expect(agentsSource).toContain("status: 'budget_exceeded_abort'");
    expect(pipelineSource).toContain("'budget_exceeded_abort'");
  });

  it('stops DB-pool loops after a zero-output batch', () => {
    const dbCall = autonomousSource.indexOf('const dbResult = await directorExecute');
    const zeroStop = autonomousSource.indexOf("'db_pool_zero_output_stop'");
    expect(dbCall).toBeGreaterThan(-1);
    expect(zeroStop).toBeGreaterThan(dbCall);
  });

  it('dedupes research enrichment before paid work and keeps it bounded', () => {
    const dedupeInsert = indexSource.indexOf("daily_pre_followup_enrichment");
    const enrichmentCall = indexSource.indexOf('runDailyEnrichmentPass(clientRow.id)');
    expect(indexSource).toContain('research_enrichment_${now.toISOString().slice(0, 10)}');
    expect(dedupeInsert).toBeGreaterThan(-1);
    expect(enrichmentCall).toBeGreaterThan(dedupeInsert);
    expect(researchEnrichmentSource).toContain("envNumber('RESEARCH_ENRICHMENT_DAILY_LEAD_CAP', 5)");
    expect(researchEnrichmentSource).toContain("envNumber('RESEARCH_ENRICHMENT_BRAVE_DAILY_CAP', 5)");
    expect(researchEnrichmentSource).toContain('const selectedQueries = ENRICHMENT_EXTRA_QUERIES ? queries : queries.slice(0, 1)');
  });

  it('keeps manual cold-signal enrichment behind LLM and Brave guards', () => {
    expect(researchEnrichmentSource).toContain("envNumber('COLD_SIGNAL_ENRICHMENT_BRAVE_DAILY_CAP', 5)");
    expect(researchEnrichmentSource).toContain('Cold signal enrichment blocked by ${budget.period} LLM budget guard before Brave spend.');
    expect(researchEnrichmentSource).toContain('searchFreshSignals(lead, { clientId, maxQueries: 1 })');
    const budgetGate = researchEnrichmentSource.indexOf("reason: 'llm_budget_blocked'");
    const coldSearch = researchEnrichmentSource.indexOf('searchFreshSignals(lead, { clientId, maxQueries: 1 })');
    expect(budgetGate).toBeGreaterThan(-1);
    expect(coldSearch).toBeGreaterThan(budgetGate);
  });

  it('does not spend Signal Hunt provider calls after LLM budget is blocked', () => {
    const firstAssert = signalHuntSource.indexOf('await assertLlmBudgetOpen(clientId);');
    const openWebSearch = signalHuntSource.indexOf('searchOpenWeb(q.query');
    expect(firstAssert).toBeGreaterThan(-1);
    expect(openWebSearch).toBeGreaterThan(firstAssert);
    expect(signalHuntSource).toContain('isBudgetExceededError(err)');
    expect(signalHuntSource).toContain('throw err;');
    expect(signalHuntSource).toContain('{ country, clientId }');
  });

  it('attributes open-web provider usage to explicit clientId when supplied', () => {
    expect(searchServiceSource).toContain('function currentClientId(options = {})');
    expect(searchServiceSource).toContain('return options.clientId || getCurrentClientId() || null');
    expect(searchServiceSource).toContain('const clientId = currentClientId(options)');
    expect(emailEnrichmentSource).toContain('clientId: lead.clientId || lead.client_id || null');
    expect(pipelineSource).toContain('clientId,');
    expect(researchEnrichmentSource).toContain('findEmail({ name: lead.name, company: lead.company, clientId })');
  });

  it('keeps market sensing behind budget and per-job Brave caps', () => {
    expect(marketSensingSource).toContain("envNumber('MARKET_SENSING_BRAVE_DAILY_CAP', 10)");
    expect(marketSensingSource).toContain('const budget = await checkBudget(clientId)');
    expect(marketSensingSource).toContain('queries.slice(0, queryBudget)');
  });

  it('runs LinkedIn stale sweep after UTC budget reset and gates enrichment', () => {
    expect(indexSource).toContain('target.setHours(8, 10, 0, 0)');
    expect(indexSource).toContain('LINKEDIN_SWEEP_MIN_LLM_REMAINING_USD');
    expect(indexSource).toContain('skipped before enrichment by LLM budget guard');
    const budgetGate = indexSource.indexOf('LINKEDIN_SWEEP_MIN_LLM_REMAINING_USD');
    const enrichmentCall = indexSource.indexOf('emailEnrichment.enrichEmail');
    expect(budgetGate).toBeGreaterThan(-1);
    expect(enrichmentCall).toBeGreaterThan(budgetGate);
  });

  it('keeps pool email enrichment opt-in, budget-gated, and small by default', () => {
    expect(indexSource).toContain("POOL_EMAIL_ENRICHMENT_ENABLED !== 'true'");
    expect(indexSource).toContain('POOL_EMAIL_ENRICHMENT_MIN_LLM_REMAINING_USD');
    expect(indexSource).toContain('POOL_EMAIL_ENRICHMENT_LIMIT || 5');
    expect(researchEnrichmentSource).toContain('Pool email enrichment blocked by LLM budget guard before provider spend.');
    expect(researchEnrichmentSource).toContain("providerUsageToday('millionverifier', clientId)");
    const budgetGate = indexSource.indexOf('POOL_EMAIL_ENRICHMENT_MIN_LLM_REMAINING_USD');
    const runCall = indexSource.indexOf('runPoolEmailEnrichment(client.id');
    expect(budgetGate).toBeGreaterThan(-1);
    expect(runCall).toBeGreaterThan(budgetGate);
  });

  it('does not run paid daily Signal Hunt before DB pool execution by default', () => {
    expect(autonomousSource).toContain("DAILY_KICKOFF_SIGNAL_PREFILL_ENABLED === 'true'");
    expect(autonomousSource).toContain('daily_signal_prefill_skipped');
    expect(autonomousSource).toContain('db_pool_before_paid_signal_hunt');
  });

  it('uses eligible uncontacted pool truth for DB Builder top-up decisions', () => {
    expect(dbBuilderSource).toContain('available_with_email');
    expect(dbBuilderSource).toContain('available_linkedin');
    expect(dbBuilderSource).toContain('min_linkedin_ready_pool: 20');
    expect(dbBuilderSource).toContain('const emailDeficit = Math.max(0, emailPoolTarget - health.availableWithEmail)');
    expect(dbBuilderSource).toContain('const linkedinDeficit = Math.max(0, linkedinPoolTarget - health.availableLinkedin)');
    expect(dbBuilderSource).toContain("envInt('DB_BUILDER_MAX_BATCHES_PER_RUN', 1)");
  });

  it('blocks research paid search and verification when LLM budget is closed', () => {
    expect(researchSource).toContain('async function assertLlmBudgetOpen(clientId)');
    expect(researchSource).toContain('llm_budget_blocked_before_paid_search');
    expect(researchSource).toContain('LLM budget blocked before Hunter/Haiku verification');
    const firstBudgetCheck = researchSource.indexOf('await assertLlmBudgetOpen(clientId)');
    const initialFanout = researchSource.indexOf('const [directResults, signalResults, companyLeads] = await Promise.all');
    expect(firstBudgetCheck).toBeGreaterThan(-1);
    expect(initialFanout).toBeGreaterThan(firstBudgetCheck);
  });
});
