-- Migration 006: Apollo.io integration columns
ALTER TABLE leads ADD COLUMN IF NOT EXISTS apollo_enriched BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS apollo_person_id VARCHAR(100);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS apollo_org_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_leads_apollo_person ON leads(apollo_person_id) WHERE apollo_person_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES (6) ON CONFLICT (version) DO NOTHING;
