-- Migration 007: Reply tracking columns
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gmail_message_id VARCHAR(200);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS gmail_thread_id VARCHAR(200);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_detected_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_snippet TEXT;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_reply_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_gmail_thread ON messages(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_detected ON messages(client_id, reply_detected_at) WHERE reply_detected_at IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES (7) ON CONFLICT (version) DO NOTHING;
