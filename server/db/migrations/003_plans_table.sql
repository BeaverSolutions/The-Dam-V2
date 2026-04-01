-- Migration 003: Plans table for Director orchestration
-- Idempotent: safe to run multiple times

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id),
  command TEXT NOT NULL,
  interpretation TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','approved','executing','completed','failed','cancelled')),
  estimated_leads INTEGER,
  estimated_time TEXT,
  results JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_plans_client_id ON plans(client_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(client_id, status);
