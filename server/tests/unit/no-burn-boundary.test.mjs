import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autonomousSource = readFileSync(resolve(__dirname, '../../routes/autonomous.js'), 'utf-8');
const agentsSource = readFileSync(resolve(__dirname, '../../services/agents.js'), 'utf-8');
const pipelineSource = readFileSync(resolve(__dirname, '../../services/pipeline.js'), 'utf-8');

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
    const indexBudgetLog = readFileSync(resolve(__dirname, '../../index.js'), 'utf-8')
      .indexOf("'daily_kickoff_blocked_budget'");
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
});
