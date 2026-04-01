-- Migration: 005 Agent Memory Key Column
-- Adds key column + unique index for clean upsert operations

ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS key VARCHAR(100);

-- Backfill key from memory_type for existing rows
UPDATE agent_memory SET key = memory_type WHERE key IS NULL;

-- Set default and not null
ALTER TABLE agent_memory ALTER COLUMN key SET DEFAULT 'default';
UPDATE agent_memory SET key = 'default' WHERE key IS NULL;
ALTER TABLE agent_memory ALTER COLUMN key SET NOT NULL;

-- Replace non-unique index with unique one
DROP INDEX IF EXISTS idx_agent_memory_client_agent;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_unique ON agent_memory(client_id, agent, key);

INSERT INTO schema_migrations (version) VALUES (5) ON CONFLICT (version) DO NOTHING;
