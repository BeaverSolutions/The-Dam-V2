-- Migration 079: queryable admin API error diagnostics
--
-- Railway logs are not always available from agent sessions. Store sanitized
-- /api/admin failures in Postgres so production admin failures can be traced
-- without exposing stack traces or secrets to the browser.

CREATE TABLE IF NOT EXISTS admin_api_errors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id    UUID NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  code        TEXT NOT NULL,
  message     TEXT NOT NULL,
  client_id   UUID NULL,
  user_id     UUID NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_api_errors_recent
  ON admin_api_errors (created_at DESC);

INSERT INTO schema_migrations (version) VALUES (79) ON CONFLICT (version) DO NOTHING;
