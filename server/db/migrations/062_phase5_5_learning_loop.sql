-- Phase 5.5: Captain Learning Loop
-- Migrated: 2026-05-06
--
-- weekly_learnings: Captain's Sunday synthesis — what worked, what didn't, plan for next week.
--   Written by runWeeklyLearnings() every Sunday. Read by Monday morning brief + Sales Beaver.
--
-- mistake_memory: Per-lead failure log — cross-agent shared context.
--   Written when Enforcer hard-rejects a draft (score < 60). Read by Sales Beaver on next draft
--   for the same company/vertical so it doesn't repeat the same mistakes.

-- ── weekly_learnings ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS weekly_learnings (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  week_start       DATE         NOT NULL,
  winning_hooks    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  losing_patterns  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  segment_ranking  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  plan_of_week     JSONB,
  summary_text     TEXT,
  raw_stats        JSONB,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_weekly_learnings_client_week
  ON weekly_learnings (client_id, week_start DESC);

-- ── mistake_memory ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mistake_memory (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id       UUID         REFERENCES leads(id) ON DELETE SET NULL,
  agent         TEXT         NOT NULL,
  mistake_type  TEXT         NOT NULL,
  description   TEXT         NOT NULL,
  payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mistake_memory_client_agent
  ON mistake_memory (client_id, agent, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mistake_memory_client_lead
  ON mistake_memory (client_id, lead_id);

-- Fast lookup: "any mistakes for this company/vertical in the last 30 days?"
CREATE INDEX IF NOT EXISTS idx_mistake_memory_client_recent
  ON mistake_memory (client_id, created_at DESC);
