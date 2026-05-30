-- Migration 077: widen learning/invite label columns
--
-- The learning loop stores model- and strategy-generated labels. Hard VARCHAR(64)
-- caps are too brittle for source_strategy, segment, miss_reason, and directive
-- labels; a single long label can fail unrelated jobs with SQLSTATE 22001.

ALTER TABLE signup_tokens
  ALTER COLUMN token TYPE TEXT;

ALTER TABLE agent_outcomes
  ALTER COLUMN source_strategy TYPE TEXT,
  ALTER COLUMN signal_type TYPE TEXT,
  ALTER COLUMN segment TYPE TEXT;

ALTER TABLE agent_directives
  ALTER COLUMN directive_type TYPE TEXT;

ALTER TABLE research_misses
  ALTER COLUMN miss_reason TYPE TEXT,
  ALTER COLUMN source_strategy TYPE TEXT;

INSERT INTO schema_migrations (version) VALUES (77) ON CONFLICT (version) DO NOTHING;
