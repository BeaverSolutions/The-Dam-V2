-- 056: Per-channel daily targets on daily_kpi.
-- Wave 1 of goal-hunting refactor — kickoff and Captain need to know how
-- many sends to chase per channel, not just total. Today's policy (set by
-- MJ 2026-05-03): 30 email + 20 linkedin = 50/day total.
--
-- daily_kpi already tracks outreach_email / outreach_linkedin actuals; this
-- adds the matching targets so the kickoff lead picker can compute per-channel
-- gaps and Captain can detect channel-mix imbalance.

BEGIN;

ALTER TABLE daily_kpi
  ADD COLUMN IF NOT EXISTS target_email_sent    INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS target_linkedin_sent INTEGER NOT NULL DEFAULT 20;

COMMENT ON COLUMN daily_kpi.target_email_sent IS
  'Daily send target for email channel. Default 30 per MJ policy 2026-05-03. Captain alerts when actual lags behind by margin past midday.';

COMMENT ON COLUMN daily_kpi.target_linkedin_sent IS
  'Daily send target for linkedin channel. Default 20 per MJ policy 2026-05-03. Hard ceiling: kickoff stops drafting linkedin once hit unless email pool is dry (Option C).';

INSERT INTO schema_migrations (version, applied_at)
VALUES (56, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
