-- Migration 016: Expand agent_memory memory_type constraint
-- Adds persona, journal, config, mistakes, key types used by agents

ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_memory_type_check;
ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_memory_type_check
  CHECK (memory_type IN (
    'icp','brand_voice','objection','pattern','preference','conversion_data',
    'secret','persona','journal','config','mistakes','key'
  ));
