-- 055: Extend agent_memory.memory_type CHECK to allow 'kpi' + 'outcome'
--
-- The reportDailyKPIs helper in services/beaverState.js (added 2026-04-30
-- via commit 59ada22) writes rows with memory_type='kpi'. The pre-existing
-- CHECK constraint allowlists only 12 values; 'kpi' is not among them.
-- Result: every reportDailyKPIs INSERT has been silently failing the
-- CHECK and getting swallowed by the .catch in agents.js + research.js.
-- Discovered 2026-05-01 EOD during live kickoff validation — daily_kpi_*
-- rows never appeared in agent_memory despite 5+ kickoffs trying to
-- write them. Captain's morning brief was reading empty agent perspective.
--
-- Also adding 'outcome' for future use — in case anything wants to write
-- structured outcome snapshots into agent_memory (separate from the
-- agent_outcomes table from migration 053).
--
-- Idempotent: drops + recreates with expanded list. Safe to re-run.

BEGIN;

ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_memory_type_check;

ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_memory_type_check
  CHECK (memory_type IN (
    'icp','brand_voice','objection','pattern','preference','conversion_data',
    'secret','persona','journal','config','mistakes','key',
    'kpi','outcome'
  ));

INSERT INTO schema_migrations (version, applied_at)
VALUES (55, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
