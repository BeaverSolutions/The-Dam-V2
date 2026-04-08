-- Migration 029: Add ranger_attempt_count to messages
-- Tracks how many times Sales Beaver has redrafted for a given message.
-- Enables the 2-attempt rule: Enforcer rejects → Sales redrafts with feedback → Enforcer retries.
-- On attempt 3, Ranger writes the message itself (rangerDraft fallback).

ALTER TABLE messages ADD COLUMN IF NOT EXISTS ranger_attempt_count INTEGER DEFAULT 0;

COMMENT ON COLUMN messages.ranger_attempt_count IS
  'How many times Sales Beaver redrafted this message after Enforcer rejection. Max 2 before Ranger self-drafts.';
