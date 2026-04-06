-- Migration: 007 Signup Tokens
-- One-time invite links for client onboarding (Option B)

CREATE TABLE IF NOT EXISTS signup_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token       VARCHAR(64) NOT NULL UNIQUE,
  role        VARCHAR(20) NOT NULL DEFAULT 'admin',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signup_tokens_token ON signup_tokens(token);
CREATE INDEX IF NOT EXISTS idx_signup_tokens_client_id ON signup_tokens(client_id);
