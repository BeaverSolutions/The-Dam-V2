-- 060: dam_kpi_snapshots — half-hourly cache of Captain's KPI view.
-- Wave 3 of goal-hunting refactor (2026-05-03). Powers the Goal Hunt UI
-- widget without re-running collectTeamKPIs (which is several joins).
-- Captain writes one row at the end of every directive sweep. Frontend
-- reads the latest row.
--
-- Named "dam_*" to avoid collision with the existing kpi_snapshots table
-- (weekly per-beaver rollup, different shape).

BEGIN;

CREATE TABLE IF NOT EXISTS dam_kpi_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  snapshot    JSONB NOT NULL,
  email_sent       INTEGER NOT NULL DEFAULT 0,
  email_target     INTEGER NOT NULL DEFAULT 30,
  linkedin_sent    INTEGER NOT NULL DEFAULT 0,
  linkedin_target  INTEGER NOT NULL DEFAULT 20,
  pool_email_ready INTEGER NOT NULL DEFAULT 0,
  pool_linkedin_only INTEGER NOT NULL DEFAULT 0,
  approvals_pending INTEGER NOT NULL DEFAULT 0,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE dam_kpi_snapshots IS
  'Half-hourly snapshot of Captain s KPI view. Powers the Goal Hunt dashboard widget.';

CREATE INDEX IF NOT EXISTS idx_dam_kpi_snapshots_latest
  ON dam_kpi_snapshots (client_id, taken_at DESC);

ALTER TABLE dam_kpi_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'dam_kpi_snapshots' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON dam_kpi_snapshots
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version, applied_at)
VALUES (60, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
