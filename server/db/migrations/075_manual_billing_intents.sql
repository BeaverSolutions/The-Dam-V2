-- Migration 075: manual billing intents and trial windows
--
-- Stripe is intentionally not connected yet. This records client upgrade
-- intent, total manual-invoice charges, and admin invoice/payment status.
-- Idempotent, forward-only.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS trial_length_days INTEGER NOT NULL DEFAULT 30 CHECK (trial_length_days IN (14, 30)),
  ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'trial'
    CHECK (billing_status IN ('trial', 'pending_invoice', 'invoice_sent', 'active', 'cancelled'));

CREATE TABLE IF NOT EXISTS billing_intents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL CHECK (plan IN ('starter', 'growth', 'enterprise')),
  term                TEXT NOT NULL CHECK (term IN ('monthly', 'six_months', 'annual')),
  currency            TEXT NOT NULL DEFAULT 'MYR' CHECK (currency = 'MYR'),
  monthly_amount_rm   INTEGER NOT NULL CHECK (monthly_amount_rm > 0),
  months              INTEGER NOT NULL CHECK (months IN (1, 6, 12)),
  total_amount_rm     INTEGER NOT NULL CHECK (total_amount_rm > 0),
  status              TEXT NOT NULL DEFAULT 'pending_invoice'
    CHECK (status IN ('pending_invoice', 'invoice_sent', 'paid', 'cancelled')),
  requested_by        UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invoice_sent_at     TIMESTAMPTZ NULL,
  paid_at             TIMESTAMPTZ NULL,
  cancelled_at        TIMESTAMPTZ NULL,
  notes               TEXT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_intents_client_recent
  ON billing_intents (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_intents_status
  ON billing_intents (status, created_at DESC);

ALTER TABLE billing_intents ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'billing_intents' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON billing_intents
      USING      (
        client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID
        OR EXISTS (
          SELECT 1 FROM clients c
          WHERE c.id = NULLIF(current_setting('app.current_client_id', true), '')::UUID
            AND c.slug = 'beaver-solutions'
        )
      )
      WITH CHECK (
        client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID
        OR EXISTS (
          SELECT 1 FROM clients c
          WHERE c.id = NULLIF(current_setting('app.current_client_id', true), '')::UUID
            AND c.slug = 'beaver-solutions'
        )
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION billing_intents_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_intents_updated_at_trigger ON billing_intents;
CREATE TRIGGER billing_intents_updated_at_trigger
  BEFORE UPDATE ON billing_intents
  FOR EACH ROW EXECUTE FUNCTION billing_intents_set_updated_at();

INSERT INTO schema_migrations (version) VALUES (75) ON CONFLICT (version) DO NOTHING;
