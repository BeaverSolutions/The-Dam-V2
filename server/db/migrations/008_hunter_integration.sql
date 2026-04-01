-- Migration 008: Hunter.io email enrichment columns
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_source VARCHAR(50); -- 'hunter', 'hunter_domain', 'manual', 'apollo'

CREATE INDEX IF NOT EXISTS idx_leads_email_verified
  ON leads(client_id, email_verified)
  WHERE email_verified = FALSE AND deleted_at IS NULL;

INSERT INTO schema_migrations (version) VALUES (8) ON CONFLICT (version) DO NOTHING;
