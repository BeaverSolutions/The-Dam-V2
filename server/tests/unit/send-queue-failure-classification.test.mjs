import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, '../../services/sendQueueWorker.js'),
  'utf-8'
);

describe('sendQueueWorker.processJob — failure classification contracts', () => {
  describe('simulated send barrier', () => {
    it('simulated-status check appears BEFORE the sent queue update', () => {
      const simulatedIdx = src.indexOf("result.status === 'simulated'");
      const sentUpdateIdx = src.indexOf("UPDATE send_queue SET status = 'sent'");
      expect(simulatedIdx).toBeGreaterThanOrEqual(0);
      expect(sentUpdateIdx).toBeGreaterThan(simulatedIdx);
    });

    it('simulated sends are marked failed with simulated_send_not_delivered reason', () => {
      expect(src).toContain("'simulated_send_not_delivered'");
    });

    it('simulated-status result check happens before the terminal success path', () => {
      const simulatedIdx = src.indexOf("result.status === 'simulated'");
      const successIdx = src.indexOf("UPDATE send_queue SET status = 'sent', updated_at");
      expect(successIdx).toBeGreaterThan(simulatedIdx);
    });
  });

  describe('409 already-sent reconciliation', () => {
    it('contains already-sent check on errStatus === 409', () => {
      expect(src).toContain('errStatus === 409');
    });

    it('writes status=sent with already_sent_reconciled on 409', () => {
      expect(src).toContain("error_reason = 'already_sent_reconciled'");
    });

    it('returns early after reconciliation (no further retry logic)', () => {
      // The 409 block ends with return, not a fall-through
      const alreadySentBlock = src.slice(src.indexOf('errStatus === 409'), src.indexOf('errStatus === 404'));
      expect(alreadySentBlock).toContain('return;');
    });
  });

  describe('404/400 terminal failure (no retry)', () => {
    it('contains terminal condition for 404, 400, and message-pattern errors', () => {
      expect(src).toContain('errStatus === 404 || errStatus === 400');
      expect(src).toContain('/not found|must be approved|no lead email|invalid.*email/i');
    });

    it('writes status=failed with reason=terminal_state for 404/400', () => {
      expect(src).toContain("reason: 'terminal_state'");
    });

    it('emits a pipeline_trace send_failed row for terminal failures', () => {
      expect(src).toContain("stage: 'send_failed'");
      expect(src).toContain("status: 'terminal_state'");
    });
  });

  describe('reauth_required permanent failure', () => {
    it('forcePermanent is set when err.reauthRequired is true', () => {
      expect(src).toContain('err.reauthRequired === true || err.failureClass === \'permanent\'');
    });

    it('reauth_required failure emits alert text about reconnecting Gmail', () => {
      expect(src).toContain('Email provider token expired/revoked');
    });

    it('pipeline_trace emits reauth_required status on forced-permanent failure', () => {
      expect(src).toContain("status: forcePermanent ? 'reauth_required' : 'max_attempts'");
    });
  });

  describe('rate_limited retry index', () => {
    it('rate_limited uses min(newAttemptCount, len-1) index — backs off at attempt 1', () => {
      expect(src).toContain("err.failureClass === 'rate_limited'");
      expect(src).toContain('Math.min(newAttemptCount, RETRY_INTERVALS.length - 1)');
    });

    it('default retry uses attempt-1 index (starts at first interval)', () => {
      expect(src).toContain(': newAttemptCount - 1');
    });
  });

  describe('stale sending recovery', () => {
    it('recoverStaleSendingJobs is called at start of processSendQueue', () => {
      const processBody = src.slice(src.indexOf('async function processSendQueue'), src.indexOf('async function recoverStaleSendingJobs'));
      expect(processBody).toContain('await recoverStaleSendingJobs()');
    });

    it('stale recovery timeout is configurable via SEND_QUEUE_STALE_SENDING_MINUTES', () => {
      expect(src).toContain('SEND_QUEUE_STALE_SENDING_MINUTES');
    });

    it('stale recovery resets to pending with stale_sending_recovered reason', () => {
      expect(src).toContain("error_reason = 'stale_sending_recovered'");
    });
  });
});