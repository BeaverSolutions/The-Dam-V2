-- Migration 018: Persist Telegram pending plans across restarts
--
-- Previously stored in an in-memory Map inside routes/telegram.js — any
-- server restart (deploy, crash, Railway restart) lost every pending plan
-- and the user's "approve" button would return "plan expired".

CREATE TABLE IF NOT EXISTS telegram_pending_plans (
  chat_id        VARCHAR(100) PRIMARY KEY,
  client_id      UUID REFERENCES clients(id) ON DELETE CASCADE,
  plan_id        UUID NOT NULL,
  command        TEXT NOT NULL,
  steps          JSONB,
  interpretation TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour')
);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_plans_expires
  ON telegram_pending_plans(expires_at);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_plans_client
  ON telegram_pending_plans(client_id);

INSERT INTO schema_migrations (version) VALUES (18) ON CONFLICT (version) DO NOTHING;
