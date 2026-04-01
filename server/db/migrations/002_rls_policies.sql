-- Migration: 002 Row-Level Security Policies

-- Enable RLS on all tenant-scoped tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorised_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;

-- RLS Policies (safety net — app also filters by client_id)
-- Use current_setting with default null to avoid errors when not in tenant context

DO $$
BEGIN
  -- users
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'users' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON users
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- access_codes
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'access_codes' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON access_codes
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- authorised_devices
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'authorised_devices' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON authorised_devices
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- leads
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'leads' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON leads
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- messages
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'messages' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON messages
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- approvals
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'approvals' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON approvals
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- logs
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'logs' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON logs
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- calendar_events
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'calendar_events' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON calendar_events
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;

  -- agent_memory
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'agent_memory' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON agent_memory
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

-- Grant bypass RLS to superuser role (the app connects as postgres in dev)
-- In production, create a dedicated app role without BYPASSRLS

INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT (version) DO NOTHING;
