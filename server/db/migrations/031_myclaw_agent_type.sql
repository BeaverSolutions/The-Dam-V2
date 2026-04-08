-- Migration 031: Add 'myclaw' to agent constraints on agent_memory + logs
-- MyClaw director writes memory and logs as agent='myclaw'

ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_agent_check;
ALTER TABLE agent_memory ADD CONSTRAINT agent_memory_agent_check
  CHECK (agent IN (
    'research_beaver','sales_beaver','enforcer_beaver','captain_beaver',
    'system','claw','director','ranger','myclaw','captain'
  ));

ALTER TABLE logs DROP CONSTRAINT IF EXISTS logs_agent_check;
ALTER TABLE logs ADD CONSTRAINT logs_agent_check
  CHECK (agent IN (
    'research_beaver','sales_beaver','ranger','enforcer_beaver',
    'director','captain_beaver','system','claw','myclaw'
  ));
