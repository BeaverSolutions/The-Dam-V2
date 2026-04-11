-- Migration 036: Fix followup_queue schema to match the code
--
-- Two distinct bugs surfaced today (2026-04-12) when the first real reply
-- arrived and replyHandler tried to operate on followup_queue:
--
-- BUG 1 — followup_queue has no `updated_at` column.
--   replyHandler.js line 96 ran:
--     UPDATE followup_queue SET status = 'cancelled', updated_at = NOW() WHERE ...
--   Postgres rejected with: column "updated_at" of relation "followup_queue" does not exist
--   The error was swallowed by handleReply's outer try/catch, which silently
--   stopped execution BEFORE the no_fit branch could mark the lead as
--   closed_lost. Lead stayed at 'qualifying' instead of 'closed'.
--
-- BUG 2 — touch_number_check was 1..4 but the code schedules touches 2..6.
--   followupSequence.js line 66-72 schedules Day 2/5/10/18/30 → touches 2,3,4,5,6.
--   The constraint allowed only 1..4. Touches 5 and 6 silently failed on every
--   first send. From yesterday's logs:
--     [integrations] Follow-up scheduling failed: new row for relation
--     "followup_queue" violates check constraint "followup_queue_touch_number_check"
--
-- Fix both atomically. Idempotent — safe to re-run.

-- BUG 1 fix: add updated_at column with sane default
ALTER TABLE followup_queue
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- BUG 2 fix: widen touch_number_check from 1..4 to 1..10
-- (10 gives headroom for future cadence experiments without another migration)
ALTER TABLE followup_queue
  DROP CONSTRAINT IF EXISTS followup_queue_touch_number_check;

ALTER TABLE followup_queue
  ADD CONSTRAINT followup_queue_touch_number_check
    CHECK (touch_number >= 1 AND touch_number <= 10);

COMMENT ON COLUMN followup_queue.updated_at IS
  'Last update timestamp. Added 2026-04-12 to match other tables and replyHandler''s UPDATE pattern.';

-- Record this migration
INSERT INTO schema_migrations (version) VALUES (36) ON CONFLICT DO NOTHING;
