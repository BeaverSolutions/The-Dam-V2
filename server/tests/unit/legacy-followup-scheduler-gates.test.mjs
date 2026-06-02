import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(
  resolve(__dirname, '../../index.js'),
  'utf-8'
);

// Extract processFollowUps body for scoped assertions
const fnStart = indexSrc.indexOf('async function processFollowUps()');
const fnEnd = indexSrc.indexOf('\n    }\n\n    // DISABLED 2026-05-11', fnStart);
const followUpBody = fnStart >= 0 ? indexSrc.slice(fnStart, fnEnd > fnStart ? fnEnd + 5 : fnStart + 5000) : '';

describe('index.js processFollowUps — legacy gating contracts', () => {
  it('cron wires are commented out (scheduler is disabled)', () => {
    // The setInterval and setTimeout that call processFollowUps must be commented
    expect(indexSrc).toContain('// setInterval(() => { processFollowUps()');
    expect(indexSrc).toContain('// setTimeout(() => { processFollowUps()');
    // And the disable marker comment must be present
    expect(indexSrc).toContain('DISABLED 2026-05-11');
    expect(indexSrc).toContain("jobHealth.markSkipped('follow_up_scheduler'");
    expect(indexSrc).toContain('FOLLOW_UP_SCHEDULER_DISABLED');
  });

  it('processFollowUps function body exists in source (not deleted — latent risk)', () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(followUpBody.length).toBeGreaterThan(100);
  });

  it('auto-approve block reads auto_approve_threshold directly without AUTO_APPROVE_ENABLED guard', () => {
    // Absence of the env guard — this is the known ungated path
    expect(followUpBody).toContain('auto_approve_threshold');
    expect(followUpBody).not.toContain('AUTO_APPROVE_ENABLED');
    expect(followUpBody).not.toContain('AUTO_APPROVAL_RECOVERY_ENABLED');
  });

  it('auto-approve block has no 7-day client seasoned check', () => {
    expect(followUpBody).not.toContain('client_is_seasoned');
    expect(followUpBody).not.toContain('7 days');
    expect(followUpBody).not.toContain('INTERVAL');
  });

  it('followup_queue status is written as sent even for auto-approved-not-physically-sent messages', () => {
    // The status write: approved ? 'sent' : 'skipped' — but approved here means Enforcer approved
    // not actually sent to provider. This is the state confusion.
    expect(followUpBody).toContain("approved ? 'sent' : 'skipped'");
  });

  it('processFollowUps body emits zero pipelineTrace rows at any stage', () => {
    expect(followUpBody).not.toContain('pipelineTrace');
    expect(followUpBody).not.toContain('traceStage');
  });

  it('agentmail simulated send is guarded the same way as gmail in sendQueueWorker', () => {
    // Confirm the broader simulated-send contract: agentmail returns { status: simulated }
    // and sendQueueWorker checks result.status === simulated before marking sent
    const agentmailSrc = readFileSync(
      resolve(__dirname, '../../services/agentmail.js'),
      'utf-8'
    );
    const sqwSrc = readFileSync(
      resolve(__dirname, '../../services/sendQueueWorker.js'),
      'utf-8'
    );
    expect(agentmailSrc).toContain("status: 'simulated'");
    // sendQueueWorker checks result.status === 'simulated' before the sent update
    expect(sqwSrc).toContain("result.status === 'simulated'");
    // The simulated block must appear before the success sent update in file order
    const simIdx = sqwSrc.indexOf("result.status === 'simulated'");
    const sentIdx = sqwSrc.indexOf("UPDATE send_queue SET status = 'sent'");
    expect(simIdx).toBeGreaterThanOrEqual(0);
    expect(sentIdx).toBeGreaterThan(simIdx);
  });
});
