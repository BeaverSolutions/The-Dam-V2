-- Migration 035: Auto-approval threshold
-- Adds per-client auto-approval threshold so high-scoring messages skip the
-- human approval queue. Keeps the machine running when MJ is AFK.
--
-- NULL        = off (every message needs manual approval — current default)
-- 85          = very conservative — only near-perfect messages auto-approve
-- 75          = balanced — recommended default
-- 65          = aggressive — most auto-fixed messages auto-approve

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS auto_approve_threshold INTEGER DEFAULT NULL
    CHECK (auto_approve_threshold IS NULL OR auto_approve_threshold BETWEEN 50 AND 100);

COMMENT ON COLUMN clients.auto_approve_threshold IS
  'Enforcer score threshold for auto-approval. NULL = manual approval only. 65/75/85 = auto-approve when score >= threshold.';

-- Record this migration
INSERT INTO schema_migrations (version) VALUES (35) ON CONFLICT DO NOTHING;
