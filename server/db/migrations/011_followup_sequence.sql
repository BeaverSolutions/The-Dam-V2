-- Migration 011: Follow-up sequence tracking

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sequence_status VARCHAR(20) DEFAULT 'active'
  CHECK (sequence_status IN ('active', 'paused', 'completed', 'unsubscribed', 'replied'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sequence_touch INTEGER DEFAULT 0;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_contacted_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sequence_completed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS followup_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  lead_id UUID NOT NULL REFERENCES leads(id),
  touch_number INTEGER NOT NULL CHECK (touch_number BETWEEN 1 AND 4),
  scheduled_for DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'cancelled')),
  message_id UUID REFERENCES messages(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(lead_id, touch_number)
);

CREATE INDEX IF NOT EXISTS idx_followup_queue_scheduled ON followup_queue(client_id, scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_leads_next_followup ON leads(client_id, next_followup_at) WHERE sequence_status = 'active';
