-- Migration 069: A7-3 — fix RLS policies on conversion_events / deal_summary.
--
-- Migration 033 created USING-only policies under non-standard names
-- (conversion_events_tenant_isolation / deal_summary_tenant_isolation). Two
-- problems:
--   1. No WITH CHECK clause — USING governs SELECT/UPDATE/DELETE visibility
--      but NOT INSERT. A tenant context could INSERT a row carrying another
--      tenant's client_id and RLS would not stop it.
--   2. Non-standard policy names — every other tenant table uses the bare
--      name `tenant_isolation`.
--
-- This migration drops the old policies and recreates them as `tenant_isolation`
-- with both USING and WITH CHECK, using the NULLIF(..., true) form so a query
-- outside any tenant context degrades to "no rows" instead of crashing.
--
-- Idempotent, forward-only.

DROP POLICY IF EXISTS conversion_events_tenant_isolation ON conversion_events;
DROP POLICY IF EXISTS tenant_isolation ON conversion_events;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'conversion_events' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON conversion_events
      USING      (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

DROP POLICY IF EXISTS deal_summary_tenant_isolation ON deal_summary;
DROP POLICY IF EXISTS tenant_isolation ON deal_summary;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'deal_summary' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON deal_summary
      USING      (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES (69) ON CONFLICT (version) DO NOTHING;
