import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSource = (path) => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');
const indexSource = readSource('../../index.js');
const autonomousSource = readSource('../../routes/autonomous.js');
const agentsSource = readSource('../../services/agents.js');
const pipelineSource = readSource('../../services/pipeline.js');
const researchEnrichmentSource = readSource('../../services/researchEnrichment.js');
const signalHuntSource = readSource('../../services/signalHunt.js');
const searchServiceSource = readSource('../../services/searchService.js');
const marketSensingSource = readSource('../../services/marketSensing.js');
const emailEnrichmentSource = readSource('../../services/emailEnrichment.js');
const dbBuilderSource = readSource('../../services/dbBuilder.js');
const researchSource = readSource('../../services/research.js');
const agentConfigSource = readSource('../../config/agents.js');

// ── 2c: unify the no-burn boundary across the autonomous kickoff loop ─────
// Autonomous Beaver sourcing is web/LinkedIn first, then Hunter, then
// MillionVerifier verification. VP/Explorium is manual CSV or subscribed-client
// only, never an automatic rescue path for Beaver.
describe('autonomous kickoff loop — no-burn boundary (Phase 2c)', () => {
  it('gates generic on-demand sourcing behind GENERIC_SOURCING_ENABLED', () => {
    const gates = autonomousSource.match(/process\.env\.GENERIC_SOURCING_ENABLED !== 'true'/g) || [];
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(autonomousSource).toContain("'generic_sourcing_disabled_skip'");
    expect(autonomousSource).toContain("context: 'pool_dry_on_demand_research'");
    expect(autonomousSource).not.toContain("context: 'zero_streak_web_linkedin_topup'");
  });

  it('puts the generic gate BEFORE sourceLeadsOnDemand (no burn when off)', () => {
    const poolDryGate = autonomousSource.indexOf("context: 'pool_dry_on_demand_research'");
    const firstGenericCall = autonomousSource.indexOf('const result = await sourceLeadsOnDemand(clientId, {');
    expect(poolDryGate).toBeGreaterThan(-1);
    expect(firstGenericCall).toBeGreaterThan(-1);
    expect(poolDryGate).toBeLessThan(firstGenericCall);
    expect(autonomousSource.slice(firstGenericCall, firstGenericCall + 250)).toContain('maxPaidQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP');
  });

  it('does not keep the old zero-streak rescue path alive', () => {
    expect(autonomousSource).not.toContain('zeroStreak');
    expect(autonomousSource).not.toContain('zero_streak_web_linkedin_topup');
    expect(autonomousSource).not.toContain('3 consecutive zero-lead batches');
  });

  it('blocks VP from all autonomous on-demand sourcing paths', () => {
    const onDemandStart = dbBuilderSource.indexOf('async function sourceLeadsOnDemand');
    const exportsStart = dbBuilderSource.indexOf('module.exports', onDemandStart);
    const onDemandBody = dbBuilderSource.slice(onDemandStart, exportsStart);

    expect(onDemandBody).not.toContain('sourceLeadsViaVP');
    expect(onDemandBody).toContain("'web_linkedin_topup'");
    expect(onDemandBody).toContain("'web_linkedin_no_results'");
    expect(autonomousSource).not.toContain('vp_rescue_success');
    expect(autonomousSource).not.toContain('vp_rescue_empty');
    expect(autonomousSource).not.toContain('zero_streak_vp_rescue');
    expect(agentsSource).not.toContain('enableVp: true');
    expect(pipelineSource).not.toContain('enableVp: true');
    expect(pipelineSource).not.toContain('vpService');
    expect(agentConfigSource).not.toContain('VP enrichment fires preventively');
    expect(agentConfigSource).toContain('Autonomous Beaver sourcing never uses VP');
  });

  it('daily DB-pool director execution cannot silently run paid Signal Hunt', () => {
    const dbPoolCall = autonomousSource.indexOf('const dbResult = await directorExecute');
    const dbPoolCallBody = autonomousSource.slice(dbPoolCall, dbPoolCall + 1000);

    expect(dbPoolCallBody).toContain("allowPaidSignal: false");
    expect(dbPoolCallBody).toContain("sourceMode: 'daily_db_pool'");
  });

  it('daily web/LinkedIn top-up is explicit, capped, and one-attempt', () => {
    expect(autonomousSource).toContain('DAILY_WEB_LINKEDIN_SIGNAL_CAP');
    expect(autonomousSource).toContain('Number(process.env.DAILY_WEB_LINKEDIN_SIGNAL_CAP || 6)');
    expect(autonomousSource).toContain("sourceMode: 'daily_web_linkedin_topup'");
    expect(autonomousSource).toContain('maxPaidSignalQueries: DAILY_WEB_LINKEDIN_SIGNAL_CAP');
    expect(autonomousSource).toContain("'daily_web_linkedin_topup_empty'");
    expect(autonomousSource).toContain("'web_linkedin_topup_attempted'");
    expect(autonomousSource).toContain("'daily_web_linkedin_topup_deduped'");
    expect(autonomousSource).toContain("'one_topup_attempt_per_kickoff'");
    expect(agentsSource).toContain("'daily_web_linkedin_topup_already_attempted'");
    expect(agentsSource).toContain("'one_topup_attempt_per_myt_day'");
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
