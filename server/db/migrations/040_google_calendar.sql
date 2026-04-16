-- Migration 040: Google Calendar sync support
-- Adds google_event_id to calendar_events for deduplication

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS google_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_google_event
  ON calendar_events(client_id, google_event_id)
  WHERE google_event_id IS NOT NULL;
