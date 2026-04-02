-- Migration 010: Autonomous Director — KPI tracking + weekly learnings memory

-- Add sent_at column to messages (needed for daily KPI counting)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;


-- Daily KPI tracking
CREATE TABLE IF NOT EXISTS daily_kpi (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  date DATE NOT NULL,
  target INTEGER NOT NULL DEFAULT 80,
  outreach_sent INTEGER NOT NULL DEFAULT 0,
  outreach_linkedin INTEGER NOT NULL DEFAULT 0,
  outreach_email INTEGER NOT NULL DEFAULT 0,
  leads_found INTEGER NOT NULL DEFAULT 0,
  replies_received INTEGER NOT NULL DEFAULT 0,
  meetings_booked INTEGER NOT NULL DEFAULT 0,
  kpi_met BOOLEAN GENERATED ALWAYS AS (outreach_sent >= target) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, date)
);

-- Weekly learning memory (Director stores insights here)
CREATE TABLE IF NOT EXISTS weekly_learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  total_outreach INTEGER DEFAULT 0,
  total_replies INTEGER DEFAULT 0,
  total_meetings INTEGER DEFAULT 0,
  reply_rate NUMERIC(5,2) DEFAULT 0,
  best_hooks JSONB DEFAULT '[]',
  best_subject_lines JSONB DEFAULT '[]',
  best_industries JSONB DEFAULT '[]',
  worst_industries JSONB DEFAULT '[]',
  ranger_top_rejections JSONB DEFAULT '[]',
  director_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_daily_kpi_client_date ON daily_kpi(client_id, date);
CREATE INDEX IF NOT EXISTS idx_weekly_learnings_client ON weekly_learnings(client_id, week_start);
