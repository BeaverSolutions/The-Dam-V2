-- 066_feedback_events.sql
-- Phase 4 of rebuild plan — execution-to-sourcing feedback loop.
--
-- feedback_events captures every event in the lifecycle of a lead/message that
-- should inform future sourcing and drafting decisions. Write-only foundation
-- shipped 2026-05-12; the consumer (weekly cron that aggregates patterns and
-- biases Research Beaver + Sales Beaver) lands in a subsequent phase.
--
-- Event types:
--   enforcer_rejected   — Enforcer killed a draft (score < threshold)
--   manually_rejected   — MJ rejected via Approvals UI
--   sent                — Outreach actually delivered (email or LinkedIn DM)
--   replied             — Prospect replied (any sentiment — replyHandler classifies)
--   meeting_booked      — Calendar webhook landed (Phase 8 future)
--
-- Hero-film "sharpen with our expertise" promise relies on this table being
-- populated for at least 7-14 days before the consumer cron has useful signal.
-- Start writing tonight, consume next sprint.

CREATE TABLE IF NOT EXISTS feedback_events (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id                  UUID         REFERENCES leads(id) ON DELETE SET NULL,
  message_id               UUID         REFERENCES messages(id) ON DELETE SET NULL,

  -- The event itself
  event_type               TEXT         NOT NULL,

  -- Contextual signal at the time of the event (so we can aggregate later
  -- without rejoining other tables that may have moved on)
  signal_strength_at_time  TEXT,                                 -- 'rich' | 'lite' | null
  source_strategy          TEXT,                                 -- where the lead came from (e.g. 'signal_hunt', 'db_builder', 'manual')
  segment                  TEXT,                                 -- industry / persona / size bucket
  channel                  TEXT,                                 -- 'email' | 'linkedin' | null
  touch_number             INT,                                  -- 0=cold, 1+=followup

  -- Numeric signal (Enforcer score, response sentiment, etc.)
  score_delta              INT,                                  -- can be negative (rejection points off) or positive
  ranger_score             INT,                                  -- snapshot at moment of event if applicable

  -- Free-form notes (rejection reason, reply snippet, etc.) — kept short
  notes                    TEXT,                                 -- max 500 chars enforced by app code

  -- Anti-PII payload for cross-tenant aggregation (segment, not raw text)
  payload                  JSONB        NOT NULL DEFAULT '{}'::jsonb,

  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT feedback_events_event_type_check
    CHECK (event_type IN ('enforcer_rejected', 'manually_rejected', 'sent', 'replied', 'meeting_booked'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_events_client_event_time
  ON feedback_events (client_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_events_lead
  ON feedback_events (client_id, lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_events_aggregation
  ON feedback_events (client_id, event_type, source_strategy, signal_strength_at_time, created_at DESC);

-- RLS — tenant isolation matches other tables
ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON feedback_events
  USING (client_id::text = current_setting('app.current_client_id', true));

COMMENT ON TABLE feedback_events IS
  'Phase 4 of rebuild plan — outcome events flowing back to Research + Sales Beaver weekly self-sharpening crons. Write-only foundation; consumer ships next sprint.';
