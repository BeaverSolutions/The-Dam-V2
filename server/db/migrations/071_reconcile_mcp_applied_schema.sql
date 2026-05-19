-- Migration 071: reconcile schema objects that were applied to production
-- directly (via Supabase MCP) but never captured in a migration file.
--
-- Audit A7-8 / A7-9: pipeline_traces (the canonical pipeline-observability
-- table) and the weekly_learnings columns plan_of_week / raw_stats / updated_at
-- exist in prod but no migration creates them — a fresh deploy from this repo
-- would come up WITHOUT them and the observability + learning loops would
-- break on first run.
--
-- This migration idempotently (re)creates every such object. It is a complete
-- no-op against the current production DB and a full repair on a fresh deploy.
-- Migration 064 was skipped in the sequence; that gap is intentional and
-- harmless — migrate.js keys on the parsed version number, not contiguity.

-- ── pipeline_traces — stage-by-stage pipeline observability (A7-9) ───────────
CREATE TABLE IF NOT EXISTS pipeline_traces (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID         NOT NULL,
  lead_id       UUID,
  message_id    UUID,
  kickoff_id    TEXT,
  stage         TEXT         NOT NULL,
  status        TEXT         NOT NULL,
  agent         TEXT,
  score         INTEGER,
  reason        TEXT,
  pipeline_path TEXT,
  metadata      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_traces_client_kickoff
  ON pipeline_traces (client_id, kickoff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_traces_lead
  ON pipeline_traces (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_traces_stage
  ON pipeline_traces (client_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_traces_funnel
  ON pipeline_traces (client_id, created_at DESC, stage, status);

ALTER TABLE pipeline_traces ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'pipeline_traces' AND policyname = 'tenant_isolation_pipeline_traces'
  ) THEN
    CREATE POLICY tenant_isolation_pipeline_traces ON pipeline_traces
      USING (client_id::text = current_setting('app.current_client_id', true));
  END IF;
END $$;

-- ── weekly_learnings — columns 062 expected from a never-created 064 (A7-8) ──
ALTER TABLE weekly_learnings ADD COLUMN IF NOT EXISTS plan_of_week JSONB;
ALTER TABLE weekly_learnings ADD COLUMN IF NOT EXISTS raw_stats    JSONB;
ALTER TABLE weekly_learnings ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ── mistake_memory — ensure RLS + tenant policy (062 created neither) ───────
ALTER TABLE mistake_memory ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'mistake_memory' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON mistake_memory
      USING      (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES (71) ON CONFLICT (version) DO NOTHING;
