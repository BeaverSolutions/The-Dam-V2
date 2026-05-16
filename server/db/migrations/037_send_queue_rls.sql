-- 037: Enable RLS on send_queue table
-- send_queue contains approved message email addresses, subjects, retry state.
-- Without RLS, a bypassed auth layer exposes all clients' outbound email data.

ALTER TABLE send_queue ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS in Postgres — guard against re-run crashes
-- (the 2026-05-12 migration-066 incident). Mirror the 002_rls_policies pattern.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'send_queue' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON send_queue
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'send_queue' AND policyname = 'tenant_isolation_insert') THEN
    CREATE POLICY tenant_isolation_insert ON send_queue
      FOR INSERT
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;
