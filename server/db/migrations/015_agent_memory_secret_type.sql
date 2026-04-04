-- Migration 015: Allow 'secret' memory_type in agent_memory
-- setClientSecret() inserts with memory_type = 'secret' but the original
-- check constraint only allowed icp/brand_voice/objection/pattern/preference/conversion_data.
-- This was blocking ALL integration credential storage (Gmail tokens, Apollo key, Hunter key).

ALTER TABLE agent_memory
  DROP CONSTRAINT IF EXISTS agent_memory_memory_type_check;

ALTER TABLE agent_memory
  ADD CONSTRAINT agent_memory_memory_type_check
  CHECK (memory_type IN (
    'icp', 'brand_voice', 'objection', 'pattern', 'preference', 'conversion_data', 'secret'
  ));

INSERT INTO schema_migrations (version) VALUES (15) ON CONFLICT (version) DO NOTHING;
