-- Migration 072: tenant_profiles + tenant_profile_history (additive, RLS-isolated)
--
-- Source of truth for everything true about a tenant — identity, offer, ICP,
-- proof, voice, constraints, documents. All 4 beavers will read from this via
-- getTenantContext (Phase B2). v1 spec:
-- MJxClaude/projects/beavrdam-rebuild/tenant-profile-schema-v1.md
--
-- This migration is purely additive. No existing table is touched. No code
-- reads from these tables until Phase B2 ships. Status defaults to 'draft' so
-- no profile is ever live without explicit activation.
--
-- Idempotent, forward-only.
-- Applied via Supabase MCP 2026-05-22 against prod (zzvfisddztsinbnhfcnq).
-- File written for fresh-deploy bootstrap parity (per A7-8/A7-9 reconcile pattern).

CREATE TABLE IF NOT EXISTS tenant_profiles (
  client_id        UUID         PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  schema_version   INTEGER      NOT NULL DEFAULT 1,
  content_version  INTEGER      NOT NULL DEFAULT 1,
  status           TEXT         NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
  profile          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by       UUID         NULL
);

CREATE INDEX IF NOT EXISTS idx_tenant_profiles_status
  ON tenant_profiles (status);

CREATE TABLE IF NOT EXISTS tenant_profile_history (
  client_id        UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  content_version  INTEGER      NOT NULL,
  profile          JSONB        NOT NULL,
  change_summary   TEXT         NULL,
  activated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  activated_by     UUID         NULL,
  PRIMARY KEY (client_id, content_version)
);

CREATE INDEX IF NOT EXISTS idx_tenant_profile_history_recent
  ON tenant_profile_history (client_id, activated_at DESC);

-- ── RLS — UUID-typed match with WITH CHECK (matches 069 canonical pattern) ──

ALTER TABLE tenant_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_profile_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tenant_profiles' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON tenant_profiles
      USING      (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'tenant_profile_history' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON tenant_profile_history
      USING      (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID)
      WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

-- ── updated_at trigger on tenant_profiles ──────────────────────────────────

CREATE OR REPLACE FUNCTION tenant_profiles_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_profiles_updated_at_trigger ON tenant_profiles;
CREATE TRIGGER tenant_profiles_updated_at_trigger
  BEFORE UPDATE ON tenant_profiles
  FOR EACH ROW EXECUTE FUNCTION tenant_profiles_set_updated_at();

-- Note: GRANTs to beavrdam_app inherited via ALTER DEFAULT PRIVILEGES set
-- in migration 045. No explicit GRANT needed for new tables in public schema.

INSERT INTO schema_migrations (version) VALUES (72) ON CONFLICT (version) DO NOTHING;
