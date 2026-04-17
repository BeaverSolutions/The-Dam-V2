-- Migration 044: Seed Beaver Solutions ICP into agent_memory
--
-- Research Beaver, DB Builder, and directorExecute all read ICP via
--   SELECT content FROM agent_memory WHERE agent='director' AND key='icp'
--
-- If this row is empty or missing, Research Beaver falls back to
-- DEFAULT_INDUSTRIES ('SaaS', 'training', 'fintech', etc.) with global
-- reach — which is exactly how US/UK leads (Kyohei Kishimoto @ Enterprise
-- B2B, Ayush Verma @ Contensify) got pulled despite the Malaysia ICP in
-- config.md.
--
-- The config.md file is NEVER parsed into agent_memory — nothing writes it
-- from config. The only writer is a manual PUT /api/agents/director/icp
-- which MJ never called.
--
-- This seeds the ICP from beaver-solutions/config.md as structured fields.
-- Idempotent: uses the existing (client_id, agent, key) unique constraint,
-- only writes if no ICP is currently set so manual edits via the UI are
-- not overwritten on future deploys.

INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
SELECT
  c.id,
  'director',
  'icp',
  'icp',
  jsonb_build_object(
    'industries',  'digital agency, marketing agency, content studio, PR firm, creative studio',
    'geographies', 'Malaysia, Kuala Lumpur, Petaling Jaya, Selangor, Penang, Johor',
    'job_titles',  'Founder, Co-Founder, Managing Director, CEO, Owner, Director',
    'company_size', '5-20 employees',
    'seeded_from', 'migration_044',
    'seeded_at',   to_jsonb(NOW())
  )
FROM clients c
WHERE c.slug = 'beaver-solutions'
  AND NOT EXISTS (
    SELECT 1 FROM agent_memory am
    WHERE am.client_id = c.id
      AND am.agent = 'director'
      AND am.key = 'icp'
  );
