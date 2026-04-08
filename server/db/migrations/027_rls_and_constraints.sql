-- Migration 027: RLS policies, constraints, indexes, and triggers
-- Fixes: missing RLS on 3 tables from 025, missing constraints, missing indexes

-- ── RLS on tables from migration 025 ──────────────────────────────────────────

ALTER TABLE follow_up_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE kpi_snapshots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hook_performance    ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'follow_up_sequences' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON follow_up_sequences
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'kpi_snapshots' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON kpi_snapshots
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'hook_performance' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON hook_performance
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

-- ── hook_performance unique constraint (required by hookTracking.js ON CONFLICT) ──

CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_perf_unique
  ON hook_performance(client_id, channel, week_start, MD5(hook_text));

-- ── messages.follow_up_parent_id ON DELETE SET NULL ──

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_follow_up_parent_id_fkey;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'follow_up_parent_id') THEN
    ALTER TABLE messages ADD CONSTRAINT messages_follow_up_parent_id_fkey
      FOREIGN KEY (follow_up_parent_id) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── follow_up_sequences message FK ON DELETE SET NULL ──

DO $$ BEGIN
  ALTER TABLE follow_up_sequences DROP CONSTRAINT IF EXISTS follow_up_sequences_day0_message_id_fkey;
  ALTER TABLE follow_up_sequences DROP CONSTRAINT IF EXISTS follow_up_sequences_day2_message_id_fkey;
  ALTER TABLE follow_up_sequences DROP CONSTRAINT IF EXISTS follow_up_sequences_day4_message_id_fkey;
  ALTER TABLE follow_up_sequences DROP CONSTRAINT IF EXISTS follow_up_sequences_day7_message_id_fkey;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'follow_up_sequences' AND column_name = 'day0_message_id') THEN
    ALTER TABLE follow_up_sequences ADD CONSTRAINT follow_up_sequences_day0_message_id_fkey
      FOREIGN KEY (day0_message_id) REFERENCES messages(id) ON DELETE SET NULL;
    ALTER TABLE follow_up_sequences ADD CONSTRAINT follow_up_sequences_day2_message_id_fkey
      FOREIGN KEY (day2_message_id) REFERENCES messages(id) ON DELETE SET NULL;
    ALTER TABLE follow_up_sequences ADD CONSTRAINT follow_up_sequences_day4_message_id_fkey
      FOREIGN KEY (day4_message_id) REFERENCES messages(id) ON DELETE SET NULL;
    ALTER TABLE follow_up_sequences ADD CONSTRAINT follow_up_sequences_day7_message_id_fkey
      FOREIGN KEY (day7_message_id) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── clients.slug NOT NULL ──

UPDATE clients SET slug = LOWER(REPLACE(REPLACE(name, ' ', '-'), '.', '')) WHERE slug IS NULL;
ALTER TABLE clients ALTER COLUMN slug SET NOT NULL;

-- ── Check constraints ──

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memory_agent_check') THEN
    ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_agent_check
      CHECK (agent IN ('research_beaver','sales_beaver','enforcer_beaver','captain_beaver','system','claw','director','ranger'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signup_tokens_role_check') THEN
    ALTER TABLE signup_tokens ADD CONSTRAINT signup_tokens_role_check
      CHECK (role IN ('admin', 'user'));
  END IF;
END $$;

-- ── Performance indexes ──

CREATE INDEX IF NOT EXISTS idx_messages_sent_at
  ON messages(client_id, sent_at DESC) WHERE sent_at IS NOT NULL;

-- ── updated_at trigger function ──

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to key tables (idempotent: drop if exists first)
DROP TRIGGER IF EXISTS set_updated_at ON leads;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON messages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON approvals;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON clients;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS set_updated_at ON users;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── schema_migrations ──

INSERT INTO schema_migrations (version) VALUES (27) ON CONFLICT (version) DO NOTHING;
