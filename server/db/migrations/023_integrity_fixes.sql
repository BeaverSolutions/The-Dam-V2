-- Migration: 023 — Database integrity fixes
-- Fixes: nullable client_id, missing RLS, missing ON DELETE CASCADE, missing NOT NULL,
--         adds WITH CHECK to all RLS policies, updates logs.agent check constraint

-- ─── Fix nullable client_id ──────────────────────────────────
-- Guard: only SET NOT NULL if rows with NULL exist, clean them first
DELETE FROM llm_usage WHERE client_id IS NULL;
ALTER TABLE llm_usage ALTER COLUMN client_id SET NOT NULL;

DELETE FROM telegram_pending_plans WHERE client_id IS NULL;
ALTER TABLE telegram_pending_plans ALTER COLUMN client_id SET NOT NULL;

-- ─── Add NOT NULL to timestamps ──────────────────────────────
-- Set defaults first for any existing NULLs
UPDATE daily_kpi SET created_at = NOW() WHERE created_at IS NULL;
UPDATE daily_kpi SET updated_at = NOW() WHERE updated_at IS NULL;
UPDATE weekly_learnings SET created_at = NOW() WHERE created_at IS NULL;
UPDATE weekly_learnings SET updated_at = NOW() WHERE updated_at IS NULL;
UPDATE followup_queue SET created_at = NOW() WHERE created_at IS NULL;

ALTER TABLE daily_kpi ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE daily_kpi ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE weekly_learnings ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE weekly_learnings ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE followup_queue ALTER COLUMN created_at SET NOT NULL;

-- ─── Add missing ON DELETE CASCADE ───────────────────────────
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_client_id_fkey;
ALTER TABLE plans ADD CONSTRAINT plans_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE daily_kpi DROP CONSTRAINT IF EXISTS daily_kpi_client_id_fkey;
ALTER TABLE daily_kpi ADD CONSTRAINT daily_kpi_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE weekly_learnings DROP CONSTRAINT IF EXISTS weekly_learnings_client_id_fkey;
ALTER TABLE weekly_learnings ADD CONSTRAINT weekly_learnings_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE followup_queue DROP CONSTRAINT IF EXISTS followup_queue_client_id_fkey;
ALTER TABLE followup_queue ADD CONSTRAINT followup_queue_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

-- ─── Enable RLS on missing tables ────────────────────────────
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_pending_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_kpi ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_learnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_queue ENABLE ROW LEVEL SECURITY;

-- ─── Recreate ALL RLS policies with WITH CHECK ──────────────
-- Drop existing + create new with both USING and WITH CHECK

DO $$
DECLARE
  tbl TEXT;
  tbls TEXT[] := ARRAY[
    'users', 'access_codes', 'authorised_devices', 'leads', 'messages',
    'approvals', 'logs', 'calendar_events', 'agent_memory',
    'plans', 'smart_briefs', 'signup_tokens', 'telegram_pending_plans',
    'llm_usage', 'daily_kpi', 'weekly_learnings', 'followup_queue'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (client_id = NULLIF(current_setting(''app.current_client_id'', true), '''')::UUID)
         WITH CHECK (client_id = NULLIF(current_setting(''app.current_client_id'', true), '''')::UUID)',
      tbl
    );
  END LOOP;
END $$;

-- ─── Fix logs.agent CHECK constraint ─────────────────────────
ALTER TABLE logs DROP CONSTRAINT IF EXISTS logs_agent_check;
ALTER TABLE logs ADD CONSTRAINT logs_agent_check
  CHECK (agent IN ('research_beaver', 'sales_beaver', 'ranger', 'enforcer_beaver',
                   'director', 'captain_beaver', 'system', 'claw'));

INSERT INTO schema_migrations (version) VALUES (23) ON CONFLICT (version) DO NOTHING;
