-- Migration 012: Phase 1 Hardening (Sprint 7A-7D)
-- Sprint 7B: Add linkedin_url to leads for deduplication
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_linkedin ON leads(client_id, linkedin_url) WHERE linkedin_url IS NOT NULL AND deleted_at IS NULL;

-- Sprint 7B: Index on email dedup (should already exist but ensure it)
CREATE INDEX IF NOT EXISTS idx_leads_email_dedup ON leads(client_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Sprint 7C: Ensure sequence_status index exists for unsubscribe lookups
CREATE INDEX IF NOT EXISTS idx_leads_sequence_status ON leads(client_id, sequence_status) WHERE deleted_at IS NULL;

-- Sprint 7D: Ranger pattern tracking — ensure agent_memory constraint allows ranger agent
-- (agent_memory already exists; no schema change needed, just a note for reference)
