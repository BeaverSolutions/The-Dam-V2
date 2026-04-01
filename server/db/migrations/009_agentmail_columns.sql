-- Migration 009: AgentMail tracking columns
-- Separate from gmail columns so both providers can coexist
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agentmail_message_id VARCHAR(255);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agentmail_thread_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_messages_agentmail_thread
  ON messages(agentmail_thread_id)
  WHERE agentmail_thread_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES (9) ON CONFLICT (version) DO NOTHING;
