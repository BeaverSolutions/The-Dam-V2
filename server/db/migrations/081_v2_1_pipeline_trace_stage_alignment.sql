-- V2.1 trace schema alignment.
-- Code has emitted repair_routed since Phase 4; production constraint must accept it.

ALTER TABLE pipeline_traces
  DROP CONSTRAINT IF EXISTS pipeline_traces_stage_check;

ALTER TABLE pipeline_traces
  ADD CONSTRAINT pipeline_traces_stage_check
  CHECK (stage = ANY (ARRAY[
    'enrolled',
    'icp_passed',
    'icp_rejected',
    'readiness_passed',
    'readiness_rejected',
    'drafted',
    'draft_failed',
    'reviewed',
    'approved',
    'rejected',
    'borderline',
    'repair_routed',
    'sent',
    'send_failed',
    'replied',
    'reply_classified',
    'meeting_booked',
    'skipped'
  ]::text[]));
