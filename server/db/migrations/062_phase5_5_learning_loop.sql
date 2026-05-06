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
--
-- NOTE: The weekly_learnings table already exists from earlier migrations (010, 023)
-- and is heavily used by learningEngine.js + routes/autonomous.js + routes/dashboard.js.
-- Phase 5.5 reuses the existing schema and adds plan_of_week / raw_stats / updated_at
-- columns via migration 063. The columns we use:
--   best_hooks            = winning hooks (existing)
--   ranger_top_rejections = losing patterns (existing)
--   best_industries       = segment ranking (existing)
--   director_notes        = summary text (existing)
--   plan_of_week          = Captain's Plan of the Week (added in 063)
--   raw_stats             = full stat snapshot (added in 063)

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
