-- 038: Add 'sending' to messages status CHECK constraint
-- The /api/autonomous/send-approved endpoint uses 'sending' as an atomic lock
-- to prevent double-sends, but it was missing from the constraint.
-- This caused "[auto-send] Batch send failed" every 5 minutes in production.

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN (
    'draft', 'pending_ranger', 'ranger_rejected',
    'pending_approval', 'approved', 'pending_send',
    'sending', 'sent', 'failed', 'rejected', 'replied'
  ));
