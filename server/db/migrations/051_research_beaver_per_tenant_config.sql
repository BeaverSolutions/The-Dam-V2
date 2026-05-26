-- 051: Research Beaver redesign — Phase A — per-tenant config + scoped state
--
-- Adds JSONB config columns to clients table so each tenant has its own
-- "trained Beaver" — ICP rules, signal preferences, offering description,
-- and quality dimension weights — without changing code paths.
--
-- Behavior change: NONE in this migration. Phases B-F read these columns
-- and act on them. This migration is purely structural.
--
-- Defaults are NULL so existing tenants don't break. Service code falls
-- back to legacy hardcoded values when a column is NULL. The Beaver
-- Solutions row is seeded with current defaults at the end of this file.

BEGIN;

-- ─── Per-tenant Research Beaver config ─────────────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS icp_config           JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS signal_preferences   JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS offering             JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS quality_weights      JSONB DEFAULT NULL;

COMMENT ON COLUMN clients.icp_config IS
  'Per-tenant ICP rules. Shape: { countries:[], titles:{senior_standalone:[], senior_leader:[], junior_ic_regex:""}, verticals:[], company_size:{min,max}, banned_regex:[] }. NULL = use legacy hardcoded constants from services/agents.js applyIcpV2Filter.';

COMMENT ON COLUMN clients.signal_preferences IS
  'Per-tenant buying signal weights. Shape: { funding:0.9, hiring:0.7, exec_change:0.6, product_launch:0.5, scaling_pain:0.8, expansion:0.6 }. Tuned by Phase D learning loop.';

COMMENT ON COLUMN clients.offering IS
  'What this tenant sells. Shape: { headline:"", target_persona:"", value_props:[], pitch_frame:"" }. Drives Sales Beaver pitch frame and Research Beaver signal interpretation.';

COMMENT ON COLUMN clients.quality_weights IS
  'Per-tenant quality dimension weights. Shape: { signal:0.4, title:0.25, reachability:0.2, segment_history:0.15 } — sums to 1.0. Tuned weekly by Phase D.';

-- ─── Per-tenant Vibe Prospecting cost gates ────────────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS vp_daily_budget_credits  INT  DEFAULT 25,
  ADD COLUMN IF NOT EXISTS vp_threshold_score       INT  DEFAULT 75,
  ADD COLUMN IF NOT EXISTS vp_credits_used_today    INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vp_credits_used_total    INT  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vp_credits_reset_at      TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN clients.vp_daily_budget_credits IS
  'Hard cap on Vibe Prospecting credits per day for this tenant. Beyond this, VP enrichment is queued for tomorrow. Free tier is 400 total credits per account; 25/day = ~16 days runway.';

COMMENT ON COLUMN clients.vp_threshold_score IS
  'Quality score threshold (0-100) above which Sales Beaver enriches via VP at draft time. Below threshold, falls back to Brave/pattern email. Auto-tuned weekly by Phase D.';

COMMENT ON COLUMN clients.vp_credits_used_today IS
  'Counter incremented per VP API call. Reset to 0 by daily cron at vp_credits_reset_at + 24h.';

COMMENT ON COLUMN clients.vp_credits_used_total IS
  'Cumulative VP credits consumed. Used for monthly cost reports.';

-- ─── Per-tenant daily floor target (lead volume) ───────────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS daily_quality_lead_floor  INT  DEFAULT 100;

COMMENT ON COLUMN clients.daily_quality_lead_floor IS
  'Minimum quality-score-passing leads Research Beaver must source per day. Auto-adjusts monthly based on actual reply and meeting outcome rates. Default 100 = conservative for the 50 targeted outreaches/day operating floor.';

-- ─── Seed Beaver Solutions with current defaults ───────────────────────────
-- Beaver Solutions is the bootstrap tenant. These values mirror what
-- services/agents.js applyIcpV2Filter currently enforces in code so
-- migrating to DB-driven config is a no-op. Other tenants (TGC/TRL/
-- Emplifive) will be seeded by the 6.3 onboarding form.

UPDATE clients
SET
  icp_config = '{
    "countries": ["Malaysia", "Singapore", "Indonesia", "Philippines", "Thailand", "Vietnam"],
    "titles": {
      "senior_standalone": ["Founder", "CEO", "CTO", "CMO", "Co-founder", "Owner", "Director"],
      "senior_leader": ["VP Marketing", "VP Sales", "Head of Marketing", "Head of Sales", "Marketing Director", "Sales Director"],
      "junior_ic_regex": "(specialist|coordinator|associate|intern|junior|assistant|executive)"
    },
    "verticals": ["digital_marketing", "digital_agency", "marketing_services", "advertising"],
    "company_size": {"min": 5, "max": 50},
    "banned_regex": ["freelance", "freelancer", "self-employed", "looking for opportunities"]
  }'::jsonb,

  signal_preferences = '{
    "funding": 0.9,
    "hiring_marketing": 0.7,
    "hiring_sales": 0.7,
    "exec_change": 0.6,
    "product_launch": 0.5,
    "scaling_pain": 0.8,
    "expansion": 0.6,
    "competitor_switch": 0.4
  }'::jsonb,

  offering = '{
    "headline": "AI outreach platform for B2B sales — 4-agent autonomous team that sources, drafts, gates, and orchestrates cold outbound",
    "target_persona": "Founders and marketing leaders at SEA agencies (5-50 staff) who feel the bottleneck between BD and delivery",
    "value_props": [
      "Replace 3-4 specialized headcount with a 24/7 AI sales team",
      "ICP-tight lead sourcing — no more wasted manual prospecting",
      "Autonomous draft + QA — every message passes a quality gate before send"
    ],
    "pitch_frame": "Most agency founders hit a wall around 5-7 clients because every new contract pulls them into delivery. The bottleneck is rarely lead quality, it is lead volume meeting founder bandwidth."
  }'::jsonb,

  quality_weights = '{
    "signal": 0.40,
    "title": 0.25,
    "reachability": 0.20,
    "segment_history": 0.15
  }'::jsonb,

  vp_daily_budget_credits = 25,
  vp_threshold_score = 75,
  daily_quality_lead_floor = 100
WHERE slug = 'beaver-solutions';

-- ─── Schema version ────────────────────────────────────────────────────────
INSERT INTO schema_migrations (version, applied_at)
VALUES (51, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
