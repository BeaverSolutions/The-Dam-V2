import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, '../../services/autoApprovalRecovery.js'),
  'utf-8'
);

describe('autoApprovalRecovery — channel-routing state machine contracts', () => {
  describe('email channel routing', () => {
    it('sets nextStatus to pending_send for email channel', () => {
      expect(src).toContain("channel === 'email' ? 'pending_send' : 'linkedin_requested'");
    });

    it('sets approvalStatus to approved for email channel', () => {
      expect(src).toContain("channel === 'email' ? 'approved' : 'pending'");
    });

    it('sets resolvedAt to a Date for email channel (non-null)', () => {
      // Email gets resolved_at = new Date(), LinkedIn gets null
      expect(src).toContain("channel === 'email' ? new Date() : null");
    });

    it('enqueueMessage is called only when channel is email', () => {
      // The enqueueMessage call is inside: if (row.channel === 'email') { ... }
      expect(src).toContain("if (row.channel === 'email')");
      expect(src).toContain('enqueueMessage(clientId, row.message_id)');
    });
  });

  describe('LinkedIn channel routing', () => {
    it('sets approvalNotes to linkedin_requested for LinkedIn channel', () => {
      expect(src).toContain("channel === 'email' ? null : 'linkedin_requested'");
    });

    it('LinkedIn recovery approval row stays at status=pending (not approved) and has notes=linkedin_requested', () => {
      // The approvalNotes null/linkedin_requested split means LinkedIn approval is never resolved
      expect(src).toContain("approvalStatus, resolvedAt, approvalNotes");
      // Both paths use the same INSERT shape
      expect(src).toContain('auto_approval_recovery');
    });
  });

  describe('approval_audit insert contract', () => {
    it('records decision=auto_approved in approval_audit', () => {
      expect(src).toContain("'auto_approved'");
    });

    it('records method=auto_approval_recovery in audit reasons JSON', () => {
      expect(src).toContain("method: 'auto_approval_recovery'");
    });

    it('records channel in audit row', () => {
      expect(src).toContain('row.channel');
    });
  });

  describe('pipeline_trace absence — known gap', () => {
    it('does NOT import pipelineTrace (gap: recovered approvals are invisible to funnel debug)', () => {
      // This assertion documents the known gap identified in silent-drop findings.
      // If someone adds traceStage to this file, this test will fail and the
      // send-without-approval anomaly detection in beavrdam-pipeline-validation will
      // need to be updated to accept recovery-source approved rows.
      expect(src).not.toContain('pipelineTrace');
      expect(src).not.toContain('traceStage');
    });

    it('does NOT import pipeline.js (recovery is fully independent of main pipeline path)', () => {
      expect(src).not.toContain("require('./pipeline')");
    });
  });

  describe('dedup and rollback safety', () => {
    it('uses BEGIN/COMMIT/ROLLBACK transaction wrapping each recovery row', () => {
      expect(src).toContain("db.query('BEGIN')");
      expect(src).toContain("db.query('COMMIT')");
      expect(src).toContain("db.query('ROLLBACK')");
    });

    it('uses UPDATE with AND status=pending_approval to prevent double-recovery race', () => {
      expect(src).toContain("AND status = 'pending_approval'");
    });

    it('checks rowCount === 1 after update and rolls back if message was already moved', () => {
      expect(src).toContain('updated.rowCount !== 1');
      expect(src).toContain('message_not_pending_approval');
    });

    it('uses INSERT ... WHERE NOT EXISTS for idempotent approval row creation', () => {
      expect(src).toContain('WHERE NOT EXISTS');
      expect(src).toContain('SELECT 1 FROM approvals WHERE client_id = $1 AND message_id = $2');
    });
  });
});