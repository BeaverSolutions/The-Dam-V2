-- Migration 078: add calendar_events.updated_at
--
-- Google Calendar sync updates calendar_events.updated_at on conflict, but the
-- original table never had that column. The missing column makes protected page
-- requests surface generic 500s whenever calendar sync runs or dashboard stats
-- touch calendar state.

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS set_updated_at ON calendar_events;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

INSERT INTO schema_migrations (version) VALUES (78) ON CONFLICT (version) DO NOTHING;
