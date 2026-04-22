-- Migration 047: Auto-approval audit trail
-- Tracks every decision made by services/autoApproval.js so MJ can audit,
-- rollback a bad decision, or disable the service entirely.
--
-- Complementary to migration 035 (adds clients.auto_approve_threshold).
-- Kill switch: AUTO_APPROVAL_ENABLED=false in env.

CREATE TABLE IF NOT EXISTS approval_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  approval_id   UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  decision      VARCHAR(20) NOT NULL CHECK (decision IN ('approved', 'rejected')),
  ranger_score  INTEGER,
  threshold     INTEGER,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_audit_client  ON approval_audit(client_id);
CREATE INDEX IF NOT EXISTS idx_approval_audit_created ON approval_audit(created_at);

COMMENT ON TABLE approval_audit IS
  'One row per auto-approve/auto-reject decision by services/autoApproval.js.';

INSERT INTO schema_migrations (version) VALUES (47) ON CONFLICT DO NOTHING;
