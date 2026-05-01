-- 054: Extend agent_memory.agent CHECK constraint
--
-- Original constraint (migration ~001-ish): hard-coded allowlist of 11 agents
-- (research_beaver, sales_beaver, enforcer_beaver, captain_beaver, system,
-- claw, director, ranger, myclaw, captain, shared).
--
-- Two new agents need persistence access but are missing from the list:
--   - market_sensor       — Phase E daily MY-news scanner (commit 909ca3b)
--   - captain_orchestrator — Captain orchestrator persistence (commits 04ee602+)
--
-- Both have been silently failing INSERTs into agent_memory because every
-- write fails the CHECK constraint. The .catch(...) swallow in the persist
-- callsites hid the error as a log warning. Result:
--   - Captain morning brief content was never stored (only the dedup "sent"
--     flag from index.js, which uses agent='captain' and passes)
--   - market_sensor opportunities were never persisted, so Research Beaver
--     could never read them in its morning loop
--
-- Idempotent: drops the old constraint by name (matches existing migration
-- pattern) and recreates with the expanded set. Safe to re-run.

BEGIN;

ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_agent_check;

ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_agent_check
  CHECK (agent IN (
    'research_beaver',
    'sales_beaver',
    'enforcer_beaver',
    'captain_beaver',
    'captain',
    'captain_orchestrator',
    'market_sensor',
    'system',
    'claw',
    'director',
    'ranger',
    'myclaw',
    'shared'
  ));

INSERT INTO schema_migrations (version, applied_at)
VALUES (54, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
