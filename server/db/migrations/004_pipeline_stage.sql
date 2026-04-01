-- Migration 004: Add pipeline_stage to leads
-- Forward-only, idempotent

ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline_stage VARCHAR(20)
  NOT NULL DEFAULT 'prospecting'
  CHECK (pipeline_stage IN ('prospecting', 'outreach', 'qualifying', 'booked', 'closed'));

UPDATE leads SET pipeline_stage = CASE
  WHEN status = 'new'           THEN 'prospecting'
  WHEN status = 'contacted'     THEN 'outreach'
  WHEN status = 'replied'       THEN 'qualifying'
  WHEN status = 'meeting_booked' THEN 'booked'
  WHEN status IN ('closed_won', 'closed_lost') THEN 'closed'
  ELSE 'prospecting'
END
WHERE pipeline_stage = 'prospecting';

CREATE INDEX IF NOT EXISTS idx_leads_pipeline ON leads(client_id, pipeline_stage);

INSERT INTO schema_migrations (version) VALUES (4) ON CONFLICT (version) DO NOTHING;
