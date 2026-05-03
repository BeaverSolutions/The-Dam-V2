-- 057: agent_directives — Captain → Beaver coordination bus.
-- Wave 1 of goal-hunting refactor. Captain reads system state, computes
-- per-beaver gaps, and writes directives. Each beaver reads its pending
-- directives at the START of its next run and adjusts behaviour.
--
-- Why a new table vs reusing agent_memory:
--   - Distinct lifecycle (issued → consumed → expired)
--   - Multiple per beaver per day; agent_memory is keyed singleton
--   - Append-only audit of what Captain instructed and whether it landed
--   - Separate concerns: memory = facts/learnings, directives = orders

BEGIN;

CREATE TABLE IF NOT EXISTS agent_directives (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- Recipient. Names match agent strings used elsewhere
  -- (research_beaver, sales_beaver, db_builder, signal_hunt, etc).
  target_agent    VARCHAR(32) NOT NULL,

  -- What Captain wants done. Free-form but caller picks from a known set
  -- (channel_focus, source_more_email_leads, apply_rejection_patterns,
  --  pause_cohort, etc) to keep beaver-side switch statements simple.
  directive_type  VARCHAR(64) NOT NULL,

  -- Structured payload — beaver-specific. e.g.
  --   { "channel": "email", "needed": 18, "by": "today_eod" }
  --   { "patterns": [...], "since": "2026-05-03T00:00:00Z" }
  payload         JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- Lifecycle. 'pending' until consumed, then 'consumed' or 'expired'.
  -- Beavers SET status='consumed' + consumed_at when they read+apply.
  -- A separate sweep marks unconsumed directives 'expired' after 24h.
  status          VARCHAR(16) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'consumed', 'expired', 'superseded')),

  -- Captain's reasoning — for the EOD brief / debugging.
  -- "email at 12/30 by 2pm, pool email-ready < gap"
  reason          TEXT,

  -- Severity drives Captain's escalation logic. 'critical' = also Telegram.
  severity        VARCHAR(16) NOT NULL DEFAULT 'normal'
                  CHECK (severity IN ('low', 'normal', 'high', 'critical')),

  -- Set at INSERT time (not a DATE() expression at index time) so the
  -- partial unique index below doesn't trip the IMMUTABLE requirement.
  effective_date  DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::DATE,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at     TIMESTAMPTZ
);

COMMENT ON TABLE agent_directives IS
  'Captain → Beaver coordination bus. Captain writes directives based on KPI gaps; each beaver reads pending directives at start of run and adjusts. Append-only audit of what Captain instructed — enables learning whether directives actually moved the metric.';

-- Hot path: "give me pending directives for this beaver right now"
CREATE INDEX IF NOT EXISTS idx_agent_directives_pending
  ON agent_directives (client_id, target_agent, created_at DESC)
  WHERE status = 'pending';

-- Sweep path: "mark expired directives expired"
CREATE INDEX IF NOT EXISTS idx_agent_directives_expiry
  ON agent_directives (expires_at)
  WHERE status = 'pending';

-- Prevent duplicate active directives of the same type per beaver per day.
-- Captain runs every 10 min; without this it would flood the table. The
-- partial uniqueness lets us either UPDATE existing or skip.
-- One pending directive per (client, beaver, type) per day. Captain UPSERTs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_directives_unique_active
  ON agent_directives (client_id, target_agent, directive_type, effective_date)
  WHERE status = 'pending';

ALTER TABLE agent_directives ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_directives' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON agent_directives
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version, applied_at)
VALUES (57, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
