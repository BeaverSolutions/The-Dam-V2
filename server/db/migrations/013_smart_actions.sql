-- Migration 013: Smart Actions — contextual AI briefs per lead
-- Stores generated briefs so they persist between sessions

CREATE TABLE IF NOT EXISTS smart_briefs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id       UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  brief_type    VARCHAR(40) NOT NULL CHECK (brief_type IN ('call_prep', 'competitive_brief', 'post_meeting', 'account_research')),
  content       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, lead_id, brief_type)
);

CREATE INDEX IF NOT EXISTS idx_smart_briefs_lead ON smart_briefs(lead_id, brief_type);

-- Add meeting_date to leads for future date-based triggers
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_date TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_notes TEXT;
