-- Migration 017: LLM usage tracking, per-client daily budget cap,
--                 and RLS policies on previously uncovered aux tables.
--
-- Three concerns, one migration:
--   1. llm_usage table — logs every Claude call with tokens + cost + elapsed
--   2. clients.daily_budget_usd column — per-client hard stop for runaway agents
--   3. RLS policies for daily_kpi, weekly_learnings, followup_queue, llm_usage
--      (defense-in-depth; app still connects as superuser which bypasses RLS,
--       but when we migrate to a dedicated app role these policies activate)

-- ─── 1. llm_usage table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_usage (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID REFERENCES clients(id) ON DELETE CASCADE,
  agent               VARCHAR(50) NOT NULL,
  model               VARCHAR(100) NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
  elapsed_ms          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Single composite index supports both "today's spend for client" range
-- scans and "recent calls for client" ordered reads. An expression index
-- on (created_at::date) would be rejected by Postgres since that cast is
-- STABLE, not IMMUTABLE; we use range predicates in the query layer instead.
CREATE INDEX IF NOT EXISTS idx_llm_usage_client_date
  ON llm_usage(client_id, created_at DESC);

-- ─── 2. Daily budget cap per client ────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS daily_budget_usd NUMERIC(10, 2) NOT NULL DEFAULT 10.00;

-- Beaver Solutions does the most testing — give it more headroom.
UPDATE clients SET daily_budget_usd = 20.00 WHERE slug = 'beaver-solutions';

-- ─── 3. RLS on aux tables (previously uncovered) ───────────────
ALTER TABLE daily_kpi         ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_learnings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_queue    ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage         ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'daily_kpi' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON daily_kpi
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'weekly_learnings' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON weekly_learnings
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'followup_queue' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON followup_queue
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'llm_usage' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON llm_usage
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES (17) ON CONFLICT (version) DO NOTHING;
