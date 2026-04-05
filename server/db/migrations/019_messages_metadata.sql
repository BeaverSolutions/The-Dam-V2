-- Migration 019: Add metadata column to messages table
-- metadata was used in INSERT statements but never formally added via migration.
-- Adding it here idempotently to fix "column metadata does not exist" errors
-- in the pending-approvals and recent-replies endpoints.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- Also ensure the pending_send and rejected statuses exist in the check constraint.
-- The autonomous pipeline uses these statuses but the original constraint was narrower.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN (
    'draft', 'pending_ranger', 'ranger_rejected',
    'pending_approval', 'approved', 'pending_send',
    'sent', 'failed', 'rejected', 'replied'
  ));

INSERT INTO schema_migrations (version) VALUES (19) ON CONFLICT (version) DO NOTHING;
