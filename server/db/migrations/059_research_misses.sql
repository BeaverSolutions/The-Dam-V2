-- 059: research_misses — leads Research Beaver found but couldn't qualify.
-- Wave 1 of goal-hunting refactor. Per MJ direction 2026-05-03: every saved
-- lead must have BOTH email AND linkedin_url. When Research Beaver finds a
-- person but can't get one of those, drop the lead BUT log the miss here so
-- we can tune sourcing strategies over time.
--
-- This is the "option (b)" choice MJ made: keep evidence of bad sourcing
-- patterns rather than dropping silently.

BEGIN;

CREATE TABLE IF NOT EXISTS research_misses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- What Research found before bailing
  candidate_name      VARCHAR(255),
  candidate_company   VARCHAR(255),
  candidate_title     VARCHAR(255),
  candidate_linkedin  TEXT,
  candidate_email     VARCHAR(255),

  -- Why we dropped it. Canonical reasons:
  --   no_email           — has linkedin, email enrichment failed
  --   no_linkedin        — has email, no linkedin URL discovered
  --   neither            — no email, no linkedin
  --   duplicate          — already in leads table
  --   icp_reject         — fails ICP gate
  --   verification_fail  — Layer 2 AI verification rejected
  miss_reason     VARCHAR(64) NOT NULL,

  -- Which sourcing strategy / query produced this candidate. Lets us
  -- compute "email_yield_rate by query strategy" later.
  source_strategy VARCHAR(64),
  query_used      TEXT,

  -- Snapshot of relevant attributes at miss time.
  metadata        JSONB DEFAULT '{}'::JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE research_misses IS
  'Leads Research Beaver found but dropped. Used to tune sourcing strategies — high no_email rate per strategy means that strategy targets industries/personas with hard-to-discover emails. After 3-4 weeks of data, deprioritize the worst strategies.';

-- Hot path: "miss rate by reason this week"
CREATE INDEX IF NOT EXISTS idx_research_misses_recent
  ON research_misses (client_id, miss_reason, created_at DESC);

-- Strategy-tuning path: "email_yield_rate by source_strategy over 14d"
CREATE INDEX IF NOT EXISTS idx_research_misses_strategy
  ON research_misses (client_id, source_strategy, created_at DESC)
  WHERE source_strategy IS NOT NULL;

ALTER TABLE research_misses ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'research_misses' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON research_misses
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version, applied_at)
VALUES (59, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
