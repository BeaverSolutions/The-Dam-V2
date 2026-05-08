-- 065: Buying-signal contract — Phase 2 V2 Step 5 (Architecture Pivot 2026-05-08).
--
-- Adds two columns to leads to enforce the producer/consumer architecture's
-- quality contract:
--
--   buying_signal_strength  — 'rich' | 'lite' | 'expired'
--     rich    = dated trigger event (Series A in last 30d, hire, product launch)
--     lite    = role/company observation (specific, verifiable)
--     expired = signal_dated_at > 30 days OR replaced via TTL cron
--   signal_dated_at         — when the signal occurred (NOT when we sourced it)
--
-- This migration is intentionally LIBERAL:
--   - Columns added nullable, no CHECK constraint
--   - Existing rows backfilled to 'lite' + created_at as best-effort default
--   - Producers updated separately (Phase 2 V2 Step 6: Research Beaver contract)
--   - CHECK constraint added in Step 9 AFTER 5 consecutive days of clean production data
--
-- Why not enforce immediately: 1166 existing leads on Beaver Solutions tenant
-- have NO buying-signal data. If we add a CHECK constraint at write time
-- before backfill + producer updates land, we lose the ability to write any
-- new leads. Liberal-then-strict ordering keeps writes flowing.
--
-- Distinguishing this from existing columns:
--   signal_tier (P1/P2/P3) = match-quality tier derived from `score` (KEEP, untouched)
--   buying_signal_strength = NEW, semantically distinct, the actual buying signal
--
-- Rollback: ALTER TABLE leads DROP COLUMN buying_signal_strength, DROP COLUMN signal_dated_at;
-- (idempotent; safe to revert if anything breaks downstream)

BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS buying_signal_strength VARCHAR(8) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS signal_dated_at        TIMESTAMPTZ DEFAULT NULL;

-- Backfill existing rows. 'lite' is the best-effort default — these leads
-- were sourced before the contract existed, so they may or may not have a
-- real signal. The TTL cron (Step 9) will flip them to 'expired' once
-- signal_dated_at > 30 days, naturally aging them out.
UPDATE leads
SET buying_signal_strength = 'lite',
    signal_dated_at        = created_at
WHERE buying_signal_strength IS NULL
   OR signal_dated_at IS NULL;

-- Index for the queue query: Captain pulls quality leads ordered by tier + recency.
-- Composite covers: WHERE client_id = ? AND deleted_at IS NULL
--   ORDER BY buying_signal_strength, signal_dated_at DESC
CREATE INDEX IF NOT EXISTS idx_leads_buying_signal_queue
  ON leads (client_id, buying_signal_strength, signal_dated_at DESC)
  WHERE deleted_at IS NULL;

COMMIT;
