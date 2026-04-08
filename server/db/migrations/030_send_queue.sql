-- Migration 030: Send queue with retry
-- Approved messages are auto-queued. Failed sends retry with exponential backoff.
-- Eliminates silent send failures and manual "click send" workflow.

CREATE TABLE IF NOT EXISTS send_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  message_id        UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_attempted_at TIMESTAMPTZ,
  next_retry_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_reason      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient polling: find pending jobs ready to run
CREATE INDEX IF NOT EXISTS idx_send_queue_poll
  ON send_queue (status, next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_send_queue_client
  ON send_queue (client_id, status);

COMMENT ON TABLE send_queue IS
  'Auto-send queue for approved messages. Retries on failure with exponential backoff (5m, 30m, 2h). Alerts after 3 failed attempts.';
