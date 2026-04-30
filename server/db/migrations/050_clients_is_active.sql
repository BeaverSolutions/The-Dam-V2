-- Migration 050: add clients.is_active flag for fail-closed disable.
-- Per MJ direction 2026-04-30 — only Beaver Solutions stays in autonomous mode.
-- The Gaming Company, MGMAX, Emplifive disabled until ICPs + API keys configured.
-- Existing kickoff cron + system-health endpoint already gate on AUTONOMOUS_ENABLED_CLIENTS,
-- but adding is_active = true to those queries gives a defense-in-depth control
-- that survives env var misconfiguration and makes "disabled" visible at the data layer.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_clients_active ON clients (is_active) WHERE is_active = true;

UPDATE clients
SET is_active = false, updated_at = NOW()
WHERE slug IN ('the-gaming-company','mgmax-sdn-bhd','emplifive');
