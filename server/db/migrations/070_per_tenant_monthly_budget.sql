-- Migration 070: A8-2 — per-tenant monthly LLM budget.
--
-- The monthly cap was a single process-global constant (LLM_MONTHLY_BUDGET_USD),
-- so every tenant silently shared the same ceiling and there was no way to set a
-- different monthly limit per client — unlike daily_budget_usd, which is already
-- a per-client column. This adds the matching monthly column so checkBudget()
-- can enforce a real per-tenant monthly cap.
--
-- Default 80 mirrors the previous LLM_MONTHLY_BUDGET_USD default. Idempotent.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS monthly_budget_usd NUMERIC(10,2) NOT NULL DEFAULT 80;

INSERT INTO schema_migrations (version) VALUES (70) ON CONFLICT (version) DO NOTHING;
