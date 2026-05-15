-- 068: approval_audit — audit trail for every auto-approve / auto-reject decision.
-- Referenced by q2-plan.md Standing Authorizations: "every auto-decision writes a row
-- to approval_audit (draft_id, decision, score, reasons_json, model, timestamp)."
-- Daily count reported in 12:00 Telegram message.

CREATE TABLE IF NOT EXISTS approval_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id),
  message_id    uuid REFERENCES messages(id),
  lead_id       uuid REFERENCES leads(id),
  decision      text NOT NULL,  -- 'auto_approved', 'auto_rejected', 'borderline_surfaced', 'manual_pending'
  score         integer,
  reasons       jsonb NOT NULL DEFAULT '{}',
  model         text,
  channel       text,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_audit_client_date
  ON approval_audit (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_audit_decision
  ON approval_audit (decision, created_at DESC);

ALTER TABLE approval_audit ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'approval_audit' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON approval_audit
      USING (client_id = current_setting('app.current_client_id')::uuid);
  END IF;
END $$;
