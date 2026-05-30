-- Migration 080: prelaunch security hardening
--
-- Closes Supabase advisor findings from the May 31, 2026 prelaunch security
-- pass: admin_api_errors RLS and mutable function search_path.

ALTER TABLE admin_api_errors ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'admin_api_errors'
      AND policyname = 'beaver_super_admin_read'
  ) THEN
    CREATE POLICY beaver_super_admin_read ON admin_api_errors
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM clients c
          WHERE c.id = NULLIF(current_setting('app.current_client_id', true), '')::UUID
            AND c.slug = 'beaver-solutions'
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tenant_profiles_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_intents_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (version) VALUES (80) ON CONFLICT (version) DO NOTHING;
