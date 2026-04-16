-- Migration 039: Partial index for DB Builder pool health checks
-- Optimises the count query used by Research Beaver's continuous sourcing loop

CREATE INDEX IF NOT EXISTS idx_leads_pool_health
  ON leads(client_id, pipeline_stage, status)
  WHERE deleted_at IS NULL AND pipeline_stage = 'prospecting' AND status = 'new';
