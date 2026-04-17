-- Migration 043: Add 'shared' to agent_memory and logs CHECK constraints
--
-- Phase 1 (commit 013ecd5), Phase 1.5 (bcfa5fa), and Phase 2 (7d216e5) all
-- write to agent_memory with agent='shared' as the cross-agent namespace. The
-- CHECK constraint from migration 031 only allowed specific agent names, so
-- EVERY write from appendSharedMemory / generateAgentDailySummary /
-- generateWeeklyStrategy has been failing silently with
--   "new row for relation 'agent_memory' violates check constraint"
--
-- Visible in Railway logs as:
--   appendSharedMemory failed err: ... violates check constraint
--   generateAgentDailySummary failed ...
-- Captured zero events, zero daily reflections, zero strategy output.
--
-- Fix: add 'shared' to both agent_memory and logs agent constraints.

ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_agent_check;
ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_agent_check
  CHECK (agent IN (
    'research_beaver','sales_beaver','enforcer_beaver','captain_beaver',
    'system','claw','director','ranger','myclaw','captain','shared'
  ));

ALTER TABLE logs DROP CONSTRAINT IF EXISTS logs_agent_check;
ALTER TABLE logs ADD CONSTRAINT logs_agent_check
  CHECK (agent IN (
    'research_beaver','sales_beaver','ranger','enforcer_beaver',
    'director','captain_beaver','system','claw','myclaw','shared'
  ));
