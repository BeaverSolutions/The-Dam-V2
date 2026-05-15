-- 067_buying_signal_check.sql
-- Phase 2 V2 Step 9 (2026-05-15): add the deferred CHECK constraint on
-- leads.buying_signal_strength. Migration 065 added the column nullable and
-- deferred the constraint pending a 5-day validation window. That window has
-- elapsed. Applied via Supabase MCP first, file committed within the hour
-- per the idempotency rule (corrections.md 2026-05-13).
--
-- Idempotency guard required: Postgres has no native CREATE CONSTRAINT IF NOT
-- EXISTS, and the Railway per-deploy runner re-runs every migration file.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leads_buying_signal_check'
      AND conrelid = 'leads'::regclass
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_buying_signal_check
      CHECK (buying_signal_strength IS NULL
          OR buying_signal_strength IN ('rich','lite','expired'));
  END IF;
END $$;
