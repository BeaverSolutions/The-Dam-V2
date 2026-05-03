-- 058: agent_introspection — per-beaver self-reports.
-- Wave 2 of goal-hunting refactor. At end of every run, each beaver writes
-- one row: target / actual / blockers. Captain quotes these in morning + EOD
-- briefs so MJ sees what the team thinks of itself, not just raw counters.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_introspection (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  agent           VARCHAR(32) NOT NULL,
  run_started_at  TIMESTAMPTZ NOT NULL,
  run_ended_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Target-vs-actual snapshot. Beaver-specific shape, e.g.
  -- Research:  { "target": 30, "actual": 18, "email_ready_only": true }
  -- Sales:     { "target_pass_rate_pct": 70, "actual_pass_rate_pct": 41 }
  -- Send Q:    { "target_retry_failure_pct": 5, "actual": 2 }
  metrics         JSONB NOT NULL DEFAULT '{}'::JSONB,

  -- One-sentence narrative. Captain reads this verbatim in the brief.
  -- "Sourced 18/30 email-ready. Pool starved — 4 of 6 strategies returned LinkedIn-only."
  summary         TEXT NOT NULL,

  -- What stopped me from hitting target (free-form, optional).
  -- Drives Captain's directive-issuing logic the next cycle.
  blockers        TEXT,

  -- Which directive(s) this run was acting on, if any. Lets us measure
  -- whether Captain's directives actually moved the metric.
  acted_on_directives UUID[] DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE agent_introspection IS
  'Per-beaver self-report at end of run. Captain reads recent rows for the morning + EOD brief and to evaluate whether prior directives landed.';

-- "Get the most recent introspection per beaver" — brief composition path
CREATE INDEX IF NOT EXISTS idx_agent_introspection_recent
  ON agent_introspection (client_id, agent, run_ended_at DESC);

ALTER TABLE agent_introspection ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_introspection' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON agent_introspection
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version, applied_at)
VALUES (58, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
