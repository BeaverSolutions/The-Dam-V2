-- Migration 032: Add updated_at to approvals table
-- The set_updated_at trigger (from migration 027) expects this column but it was
-- never added to the original schema.

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
