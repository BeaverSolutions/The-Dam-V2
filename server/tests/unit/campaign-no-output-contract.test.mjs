import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function source(path) {
  return readFileSync(resolve(__dirname, '../..', path), 'utf-8').replace(/\r\n/g, '\n');
}

describe('no-output campaign contract', () => {
  const agents = source('services/agents.js');
  const agentsRoute = source('routes/agents.js');
  const captainBeaver = source('services/captainBeaver.js');
  const captainOrchestrator = source('services/captainOrchestrator.js');
  const chatPage = source('../client/src/pages/Chat.jsx');
  const autonomousRoute = source('routes/autonomous.js');
  const messagesRoute = source('routes/messages.js');

  it('runs Director Chat campaign preflight before any planning LLM call', () => {
    const planStart = agents.indexOf('async function directorPlan');
    const planEnd = agents.indexOf('/**\n * =========================\n * EMAIL ENRICHMENT', planStart);
    const planBody = agents.slice(planStart, planEnd);
    const preflightIdx = planBody.indexOf('getRunCampaignPreflight');
    const callAgentIdx = planBody.indexOf("callAgent('director'");

    expect(preflightIdx).toBeGreaterThan(-1);
    expect(callAgentIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(callAgentIdx);
    expect(planBody).toContain("status: 'blocked'");
    expect(planBody).toContain('question: blockedMessage');
  });

  it('stops and prompts MJ when a full kickoff run yields 5 or fewer outputs', () => {
    const continueIdx = agents.indexOf('captain_continue_signal_first_shortfall');
    const lowYieldIdx = agents.indexOf('captain_low_yield_prompt_required');

    expect(agents).toContain('shouldStopForLowOutput');
    expect(agents).toContain("blocker: 'low_yield_outputs'");
    expect(agents).toContain('Captain stopped this campaign because a full kickoff run produced only');
    expect(lowYieldIdx).toBeGreaterThan(-1);
    expect(continueIdx).toBeGreaterThan(-1);
    expect(lowYieldIdx).toBeLessThan(continueIdx);
  });

  it('scheduled kickoff writes a Captain blocker before KPI-gap can spend again', () => {
    const verifyIdx = autonomousRoute.indexOf('const kickoffVerification = await verifyKickoffOutput(clientId, target, { runStartedAt: kickoffRunStartedAt })');
    const recountIdx = autonomousRoute.indexOf("require('../services/kpi').recountKpi(clientId)");
    const returnIdx = autonomousRoute.indexOf('blocked: kickoffVerification?.blocked === true', recountIdx);

    expect(autonomousRoute).toContain('const kickoffVerification = await verifyKickoffOutput(clientId, target, { runStartedAt: kickoffRunStartedAt })');
    expect(autonomousRoute).toContain('shouldStopForLowOutput({ requested, delivered })');
    expect(autonomousRoute).toContain('captain_kickoff_blocker_');
    expect(autonomousRoute).toContain("blocker: 'zero_outputs'");
    expect(autonomousRoute).toContain("blocker: 'low_yield_outputs'");
    expect(autonomousRoute).toContain('verification: kickoffVerification');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(recountIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(recountIdx);
    expect(verifyIdx).toBeLessThan(recountIdx);
  });

  it('preserves blocked and needs_input as terminal execution statuses', () => {
    expect(agentsRoute).toContain("status: result?.status || 'completed'");
    expect(agentsRoute).not.toContain("JSON.stringify({ status: 'completed', result");
    expect(chatPage).toContain("['completed', 'blocked', 'needs_input']");
    expect(chatPage).toContain("pollStatus === 'blocked' || pollStatus === 'needs_input'");
  });

  it('does not render an approval button for blocked or needs-input plans', () => {
    expect(chatPage).toContain("plan.status === 'blocked' || plan.status === 'needs_input'");
    expect(chatPage).toContain("msg.plan.status === 'pending_approval'");
  });

  it('keeps autonomous routes behind the internal key middleware', () => {
    const middlewareIdx = autonomousRoute.indexOf('router.use(requireInternalKey)');
    const firstRouteIdx = autonomousRoute.indexOf('router.post(');

    expect(middlewareIdx).toBeGreaterThan(-1);
    expect(firstRouteIdx).toBeGreaterThan(-1);
    expect(middlewareIdx).toBeLessThan(firstRouteIdx);
  });

  it('counts only execution-supported search providers in campaign preflight capacity', () => {
    expect(captainOrchestrator).toContain('const campaignResearchRemaining = braveRemaining + googleRemaining;');
    expect(captainOrchestrator).not.toContain('braveRemaining + googleRemaining + apolloRemaining');
    expect(captainBeaver).toContain("getRunCampaignPreflight: orchestratorPreflight");
  });

  it('enqueues email sends when borderline drafts are approved by message routes', () => {
    expect(messagesRoute).toContain("require('../services/sendQueueWorker')");
    expect(messagesRoute).toContain('await enqueueIfEmailPendingSend(req.clientId, msg.id, nextStatus)');
  });
});
