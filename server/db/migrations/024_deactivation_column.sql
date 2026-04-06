-- Migration: 024 — Add proper deactivation column to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ DEFAULT NULL;

-- Migrate existing deactivated users (password_hash = 'DEACTIVATED')
UPDATE users SET deactivated_at = updated_at WHERE password_hash = 'DEACTIVATED';

INSERT INTO schema_migrations (version) VALUES (24) ON CONFLICT (version) DO NOTHING;
