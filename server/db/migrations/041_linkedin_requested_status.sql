-- 041: Add 'linkedin_requested' to messages status CHECK constraint.
-- LinkedIn outreach has a hidden "acceptance gate" that email doesn't:
--   pending_approval → linkedin_requested (connection sent, awaiting acceptance)
--   → approved (accepted, ready to send Day 0 DM) OR → email fallback after 7 days.

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN (
    'draft', 'pending_ranger', 'ranger_rejected',
    'pending_approval', 'approved', 'pending_send',
    'sending', 'sent', 'failed', 'rejected', 'replied',
    'linkedin_requested'
  ));

-- Index for the auto-sweep job: find stale linkedin_requested messages efficiently
CREATE INDEX IF NOT EXISTS idx_messages_linkedin_requested
  ON messages(client_id, updated_at)
  WHERE status = 'linkedin_requested';
