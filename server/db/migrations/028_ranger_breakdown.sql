-- Migration 028: Add ranger_breakdown column to messages
-- Persists Enforcer's detailed scoring breakdown (personalisation/relevance/quality/cta)
-- Previously calculated but never stored — only total score was saved.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS ranger_breakdown JSONB;

COMMENT ON COLUMN messages.ranger_breakdown IS
  'Enforcer scoring breakdown: {personalisation: 0-30, relevance: 0-25, quality: 0-25, cta: 0-20}';
