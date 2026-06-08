BEGIN;

CREATE TABLE IF NOT EXISTS platform_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('proof', 'trusted_scheduled', 'impromptu')),
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'pending_approval', 'approved', 'executed', 'blocked', 'expired')),
  objective TEXT NOT NULL,
  requested_count INTEGER NOT NULL CHECK (requested_count > 0),
  budget_cap_usd NUMERIC(10, 4) CHECK (budget_cap_usd IS NULL OR budget_cap_usd >= 0),
  max_paid_queries INTEGER NOT NULL DEFAULT 0 CHECK (max_paid_queries >= 0),
  stop_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
  platform_sequence JSONB NOT NULL DEFAULT '[]'::jsonb,
  excluded_platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
  query_set_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  approval_requested_at TIMESTAMPTZ,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  blocker TEXT,
  created_by TEXT NOT NULL DEFAULT 'captain',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  CONSTRAINT platform_plans_client_id_id_key UNIQUE (client_id, id),
  CONSTRAINT platform_plans_approved_by_nonblank CHECK (approved_by IS NULL OR length(trim(approved_by)) > 0),
  CONSTRAINT platform_plans_executed_status_requires_executed_at CHECK (status <> 'executed' OR executed_at IS NOT NULL),
  CONSTRAINT platform_plans_approval_required_state_check CHECK (approval_required = FALSE OR status NOT IN ('approved', 'executed') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_platform_plans_client_recent
  ON platform_plans (client_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_plans_pending_hash
  ON platform_plans (client_id, plan_hash)
  WHERE status IN ('preview', 'pending_approval', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_directives_client_id_id
  ON agent_directives (client_id, id);

CREATE TABLE IF NOT EXISTS platform_yield_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan_id UUID,
  directive_id UUID,
  platform TEXT NOT NULL,
  provider TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('preview', 'proof', 'trusted_scheduled', 'impromptu')),
  signal_id TEXT,
  signal_family TEXT,
  source_channel TEXT,
  geo TEXT,
  query TEXT,
  query_hash TEXT,
  query_chars INTEGER NOT NULL DEFAULT 0 CHECK (query_chars >= 0),
  query_words INTEGER NOT NULL DEFAULT 0 CHECK (query_words >= 0),
  query_valid BOOLEAN NOT NULL DEFAULT TRUE,
  paid_units INTEGER NOT NULL DEFAULT 0 CHECK (paid_units >= 0),
  raw_results INTEGER NOT NULL DEFAULT 0 CHECK (raw_results >= 0),
  raw_candidates INTEGER NOT NULL DEFAULT 0 CHECK (raw_candidates >= 0),
  icp_passed INTEGER NOT NULL DEFAULT 0 CHECK (icp_passed >= 0),
  decision_makers_found INTEGER NOT NULL DEFAULT 0 CHECK (decision_makers_found >= 0),
  contacts_found INTEGER NOT NULL DEFAULT 0 CHECK (contacts_found >= 0),
  saved_leads INTEGER NOT NULL DEFAULT 0 CHECK (saved_leads >= 0),
  approval_ready INTEGER NOT NULL DEFAULT 0 CHECK (approval_ready >= 0),
  sent INTEGER NOT NULL DEFAULT 0 CHECK (sent >= 0),
  replies INTEGER NOT NULL DEFAULT 0 CHECK (replies >= 0),
  meetings INTEGER NOT NULL DEFAULT 0 CHECK (meetings >= 0),
  blocker TEXT,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_yield_events_plan_tenant_fk
    FOREIGN KEY (client_id, plan_id) REFERENCES platform_plans(client_id, id) ON DELETE SET NULL (plan_id),
  CONSTRAINT platform_yield_events_directive_tenant_fk
    FOREIGN KEY (client_id, directive_id) REFERENCES agent_directives(client_id, id) ON DELETE SET NULL (directive_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_yield_events_client_recent
  ON platform_yield_events (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_yield_events_strategy
  ON platform_yield_events (client_id, platform, signal_id, geo, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_strategy_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  strategy_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proof' CHECK (status IN ('proof', 'trusted', 'suspended')),
  signal_id TEXT,
  geo TEXT,
  platforms JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_plan_id UUID,
  last_plan_hash TEXT,
  last_yield_pct NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (last_yield_pct >= 0),
  last_requested_count INTEGER NOT NULL DEFAULT 0 CHECK (last_requested_count >= 0),
  last_output_count INTEGER NOT NULL DEFAULT 0 CHECK (last_output_count >= 0),
  consecutive_green_runs INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_green_runs >= 0),
  last_blocker TEXT,
  trusted_at TIMESTAMPTZ,
  trusted_by TEXT,
  downgraded_at TIMESTAMPTZ,
  downgrade_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, strategy_key),
  CONSTRAINT platform_strategy_state_last_plan_tenant_fk
    FOREIGN KEY (client_id, last_plan_id) REFERENCES platform_plans(client_id, id) ON DELETE SET NULL (last_plan_id)
);

ALTER TABLE platform_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_yield_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_strategy_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'platform_plans' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON platform_plans
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'platform_yield_events' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON platform_yield_events
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'platform_strategy_state' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON platform_strategy_state
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES (82) ON CONFLICT (version) DO NOTHING;

COMMIT;
