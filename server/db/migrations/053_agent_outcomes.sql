-- 053: Phase D piece 2 — agent_outcomes attribution table
--
-- The substrate for closed-loop intelligence. Every meaningful event in
-- the lead lifecycle gets one row, immutably. This is what Phase D piece 3
-- (weekly auto-tune of quality_weights + vp_threshold_score) reads to
-- compute pass-through rates per signal_type / segment / source_strategy.
--
-- Why a separate table (vs columns on leads/messages):
--   - Some events have no message (sourced, meeting_booked, closed_*)
--   - Time-series queries are first-class (window over last N days)
--   - Append-only — no UPDATE complexity, no race conditions
--   - Carries the *snapshot* of attributes at the moment of the event
--     (signal_type may evolve on the lead later — outcomes preserve history)
--
-- Outcomes:
--   sourced         — Research Beaver added lead to pool (write at INSERT)
--   drafted         — Sales Beaver wrote a message (write at message INSERT)
--   sent            — Send queue shipped a message OR Cowork-marked sent
--   replied         — Inbound reply detected (email or LinkedIn sync)
--   meeting_booked  — Calendar event created with prospect (deferred hook)
--   closed_won      — Manual MJ tag (deferred hook)
--   closed_lost     — Manual MJ tag (deferred hook)
--   rejected        — Enforcer or ICP filter rejected at draft / source time
--   bounced         — Email bounced or LinkedIn DM rejected (deferred hook)
--   unsubscribed    — Prospect opt-out (deferred hook)
--
-- Hooks shipped today: sourced, drafted, sent, replied. Others deferred
-- until their data sources exist (calendar, manual MJ tagging, bounce
-- inspection). Helper services/outcomeTracker.js wraps the inserts.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_outcomes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,

  outcome         VARCHAR(32) NOT NULL CHECK (outcome IN (
                    'sourced','drafted','sent','replied',
                    'meeting_booked','closed_won','closed_lost',
                    'rejected','bounced','unsubscribed'
                  )),

  -- Attribution dimensions — snapshot of lead/message at event time.
  -- All nullable; populated by recordOutcome() best-effort from the
  -- caller's existing context. Enables "reply_rate by signal_type"
  -- and "drafted_rate by segment" group-bys without re-joining leads.
  source_strategy VARCHAR(64),
  signal_type     VARCHAR(64),
  segment         VARCHAR(64),
  channel         VARCHAR(16),
  quality_score   INTEGER,
  signal_tier     VARCHAR(8),

  event_data      JSONB DEFAULT '{}'::JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_outcomes IS
  'Append-only attribution log. One row per meaningful lifecycle event. Phase D auto-tuning reads this to compute pass-through rates per signal_type/segment/source_strategy. Snapshots attribution dimensions at event time so historical analysis is stable even if lead attributes change later.';

COMMENT ON COLUMN agent_outcomes.outcome IS
  'Lifecycle event type. CHECK constraint enforces the canonical set. Add new values via separate migration if scope expands.';

COMMENT ON COLUMN agent_outcomes.source_strategy IS
  'How the lead entered the pool: signal_hunt, vp_match, manual_import, historical, etc. Snapshotted from lead.source at event time.';

COMMENT ON COLUMN agent_outcomes.signal_type IS
  'Triggering signal: hiring, funding, product_launch, exec_hire, expansion, etc. Snapshotted from lead.metadata->>signal at event time.';

COMMENT ON COLUMN agent_outcomes.segment IS
  'Vertical / industry segment: agency, ecommerce, fintech, etc. Snapshotted from lead.metadata->>industry at event time.';

COMMENT ON COLUMN agent_outcomes.event_data IS
  'Outcome-specific payload. Examples: {sweep:"auto"} for auto-graduated sent; {snippet:"..."} for replied; {ranger_score:75, gates_failed:[...]} for rejected.';

-- Indexes for the dominant query patterns:
--
-- 1. "Reply rate by signal_type over last 14 days" — Phase D piece 3 weekly cron
CREATE INDEX IF NOT EXISTS idx_agent_outcomes_client_outcome_time
  ON agent_outcomes (client_id, outcome, occurred_at DESC);

-- 2. "Full event timeline for a lead" — debugging, lead detail UI
CREATE INDEX IF NOT EXISTS idx_agent_outcomes_lead_time
  ON agent_outcomes (lead_id, occurred_at DESC);

-- 3. "All events for a message" — message detail / debug
CREATE INDEX IF NOT EXISTS idx_agent_outcomes_message
  ON agent_outcomes (message_id)
  WHERE message_id IS NOT NULL;

-- 4. "Group-by signal_type + outcome" for tuning queries — partial keys
--    that trim the table size for the common slice (excludes orphans)
CREATE INDEX IF NOT EXISTS idx_agent_outcomes_signal_outcome
  ON agent_outcomes (client_id, signal_type, outcome, occurred_at DESC)
  WHERE signal_type IS NOT NULL;

-- RLS — same tenant_isolation pattern as leads / messages / approvals.
-- Service role bypasses cleanly via Supabase MCP (no GUC set), which is how
-- background jobs (recountKpi, qualityScorer, etc) write across tenants.
ALTER TABLE agent_outcomes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_outcomes' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON agent_outcomes
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version, applied_at)
VALUES (53, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
