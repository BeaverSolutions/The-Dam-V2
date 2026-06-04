import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autonomousSource = readFileSync(resolve(__dirname, '../../routes/autonomous.js'), 'utf-8').replace(/\r\n/g, '\n');

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
});
