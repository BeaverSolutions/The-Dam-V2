import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autonomousSource = readFileSync(resolve(__dirname, '../../routes/autonomous.js'), 'utf-8').replace(/\r\n/g, '\n');
const agentsSource = readFileSync(resolve(__dirname, '../../services/agents.js'), 'utf-8').replace(/\r\n/g, '\n');
const approvalsSource = readFileSync(resolve(__dirname, '../../services/approvals.js'), 'utf-8').replace(/\r\n/g, '\n');
const captainSource = readFileSync(resolve(__dirname, '../../services/captainBeaver.js'), 'utf-8').replace(/\r\n/g, '\n');

describe('chat campaign control', () => {
  const chatStart = autonomousSource.indexOf('// ── Intent 2: KICKOFF / EXECUTE');
  const chatEnd = autonomousSource.indexOf('// ── Intent 3: APPROVALS query', chatStart);
  const chatCampaignBody = autonomousSource.slice(chatStart, chatEnd);

  it('routes plural lead-finding requests as campaigns even when they say approval-ready', () => {
    expect(autonomousSource).toContain('function isChatCampaignIntent(message)');
    expect(autonomousSource).toContain('isChatCampaignIntent(lowerMsg)');
    expect(autonomousSource).toMatch(/leads\?/);
    expect(autonomousSource).toContain("module.exports._test = { parseRequestedLeadLimit, boundedChatSignalQueryCap, isChatCampaignIntent }");
  });

  it('expires stale director executions before chat dispatch starts another run', () => {
    const staleCleanup = chatCampaignBody.indexOf('expireStaleRunningExecutions(client_id)');
    const firstDirectorDispatch = chatCampaignBody.indexOf('directorExecute(client_id');

    expect(chatCampaignBody).toContain("require('../services/captainBeaver')");
    expect(staleCleanup).toBeGreaterThan(-1);
    expect(firstDirectorDispatch).toBeGreaterThan(-1);
    expect(staleCleanup).toBeLessThan(firstDirectorDispatch);
  });

  it('releases the chat signal cap while preserving bounded manual proof runs', () => {
    expect(autonomousSource).toContain('function boundedChatSignalQueryCap(requestedLimit)');
    expect(autonomousSource).toContain('return Math.max(3, Math.min(20, (Math.ceil(n) * 3) + 2))');
  });

  it('impromptu find-leads requests require no-spend platform plan unless cap and stop rule are explicit', () => {
    expect(autonomousSource).toContain('platform_plan_preview_required');
    expect(autonomousSource).toContain('extra_daily_request');
    expect(autonomousSource).toContain('spend_cap');
    expect(autonomousSource).toContain('stop_rule');
    expect(captainSource).toContain('platform_plan_preview_required');
    expect(captainSource).toContain('extra_daily_request');
    expect(captainSource).toContain('spend_cap');
    expect(captainSource).toContain('stop_rule');
  });
});

describe('Captain campaign orchestration contracts', () => {
  const planStart = agentsSource.indexOf('async function directorPlan');
  const planEnd = agentsSource.indexOf('/**\n * =========================\n * EMAIL ENRICHMENT', planStart);
  const planBody = agentsSource.slice(planStart, planEnd);
  const directorStart = agentsSource.indexOf('async function directorExecute');
  const directorEnd = agentsSource.indexOf('module.exports', directorStart);
  const directorBody = agentsSource.slice(directorStart, directorEnd);
  const terminalBlock = directorBody.indexOf('signal_first_terminal_block');
  const continuationBlock = directorBody.indexOf('captain_continue_signal_first_shortfall');
  const zeroStopBlock = directorBody.indexOf('captain_user_prompt_required');

  it('ties bare Director Chat kickoff to the remaining daily KPI gap', () => {
    expect(agentsSource).toContain("require('../utils/campaignKpiTarget')");
    expect(planBody).toContain('resolveDirectorCampaignTarget(clientId, explicitRequestedCount)');
    expect(planBody).toContain('estimated_leads: requestedCount,');
    expect(planBody).not.toContain('estimated_leads: result.estimated_leads || requestedCount');
    expect(directorBody).toContain('resolveDirectorCampaignTarget(clientId, explicitCommandTarget)');
    expect(directorBody).toContain('explicitCommandTarget === null && !requestedTarget');
    expect(directorBody).toContain('diagnostics.campaign_target_context = targetContext');
  });

  it('lets Captain continue partial signal-first campaigns before the terminal block', () => {
    expect(directorBody).toContain('captain_continue_signal_first_shortfall');
    expect(directorBody).toContain('completionAttempt: completionAttempt + 1');
    expect(directorBody).toContain('deliveredSoFar: delivered');
    expect(directorBody).toContain('requestedTarget: campaignRequested');
    expect(continuationBlock).toBeGreaterThan(-1);
    expect(terminalBlock).toBeGreaterThan(-1);
    expect(continuationBlock).toBeLessThan(terminalBlock);
  });

  it('stops and prompts MJ when a signal-first pass creates zero new outputs', () => {
    expect(directorBody).toContain('captain_user_prompt_required');
    expect(directorBody).toContain("status: 'needs_input'");
    expect(directorBody).toContain('question: captainPrompt');
    expect(directorBody).toContain('zero_new_outputs');
    expect(zeroStopBlock).toBeGreaterThan(-1);
    expect(zeroStopBlock).toBeLessThan(terminalBlock);
  });

  it('turns manual campaign rejections into Captain replacement directives', () => {
    expect(approvalsSource).toContain('async function writeCaptainReplacementDirective');
    expect(approvalsSource).toContain("writeDirective(clientId, 'research_beaver', 'run_signal_playbook'");
    expect(approvalsSource).toContain("reason: 'MJ rejected a campaign output; Captain requested one replacement lead.'");
    expect(approvalsSource).toContain('kickoff_id: msg.metadata?.kickoff_id || null');
    expect(approvalsSource).toContain('approval_id: approvalId');
    expect(approvalsSource).toContain('message_id: existing.rows[0].message_id');
    expect(approvalsSource).toContain("'captain_replacement_directive_created'");
  });
});
