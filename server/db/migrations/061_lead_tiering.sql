-- 061: Tiered sourcing pool — replace channel-presence gate with ICP-quality gate.
--
-- Phase 5 contact gate required BOTH email AND linkedin_url at sourcing,
-- which starves the pool given current SMB ICP + thin Hunter coverage.
-- This migration introduces a 3-tier model:
--
--   A — drafted-ready    (email_verified OR 1st-degree linkedin)
--   B — enrichment-queue (high-ICP P1 score with linkedin_url, no verified email — retry enrich for up to 14 days)
--   C — rejected         (low-fit or no channels — same as today's research_misses)
--
-- The gate at sourcing now rejects only on ICP fit + zero-channel cases.
-- Channel preference (email-first) stays at draft time, not sourcing time.
-- This preserves email-first reply rate without the upstream starvation.
--
-- Behavior change: existing leads get retroactively tiered based on their
-- current state so DB Builder's "is the pool full?" check stays meaningful.

BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lead_tier            CHAR(1) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS enrichment_attempts  INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_enrichment_at   TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tiered_at            TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_lead_tier_check;
ALTER TABLE leads
  ADD CONSTRAINT leads_lead_tier_check
    CHECK (lead_tier IS NULL OR lead_tier IN ('A','B','C'));

COMMENT ON COLUMN leads.lead_tier IS
  'Tiered sourcing classification (migration 061). A=drafted-ready (email_verified or 1st-degree linkedin); B=enrichment-queue (P1 score, linkedin_url, no email — retry up to 14 days); C=rejected at sourcing. NULL=legacy lead pre-tiering or untiered manual insert. DB Builder targets Tier A pool fill; Tier B background worker retries enrichment.';

COMMENT ON COLUMN leads.enrichment_attempts IS
  'Count of Hunter / alt-domain / linkedin-reveal enrichment passes attempted while in Tier B. Capped at 3; after 3 failed attempts, lead moves to Tier C.';

COMMENT ON COLUMN leads.last_enrichment_at IS
  'Timestamp of last enrichment attempt. Tier B worker re-attempts only after 24h since last try, to avoid Hunter quota churn.';

COMMENT ON COLUMN leads.tiered_at IS
  'Timestamp of initial tier assignment. Used to age out Tier B after 14 days (TTL).';

-- Index for Tier A pool size queries (DB Builder hot path).
CREATE INDEX IF NOT EXISTS idx_leads_client_tier_a
  ON leads (client_id, status)
  WHERE lead_tier = 'A' AND deleted_at IS NULL;

-- Index for Tier B retry worker (pick eligible candidates).
CREATE INDEX IF NOT EXISTS idx_leads_client_tier_b_retry
  ON leads (client_id, last_enrichment_at NULLS FIRST, enrichment_attempts)
  WHERE lead_tier = 'B' AND deleted_at IS NULL;

-- ───────────────────────────────────────────────────────────────────────
-- Retroactive tier assignment for existing leads.
--
-- The forward-looking GATE in contactGate.js applies the strict P1 rule
-- (score >= 85) for new sourcing. But legacy leads were sourced under
-- pre-tiering logic, with `quality_score` never populated and `score`
-- distribution tight around 65-75. Applying the strict rule retroactively
-- would dump ~97% of the pool into Tier C, which is wrong — we want the
-- Tier B retry worker to take one Hunter pass at every legacy linkedin-only
-- lead before discarding.
--
-- Retroactive rules (more permissive than the gate):
--   A: email_verified = true OR provider-sourced email (hunter/manual)
--   B: lead_tier still NULL after A + linkedin_url present  ← any score
--   C: everything else still NULL (rare — no email AND no linkedin)
--
-- Forward gate (services/contactGate.js, separate from this migration):
--   A: email_verified at sourcing time (Hunter inline returned valid)
--   B: no verified email + linkedin_url + score >= 85   ← strict
--   C: rejected (logged in research_misses)
-- ───────────────────────────────────────────────────────────────────────

-- Tier A: leads with a usable, provider-sourced email.
UPDATE leads
   SET lead_tier = 'A',
       tiered_at = NOW()
 WHERE lead_tier IS NULL
   AND deleted_at IS NULL
   AND (
         email_verified = true
      OR (email IS NOT NULL AND email <> ''
          AND email_source IN ('hunter','hunter_backfill','manual'))
       );

-- Tier B: any remaining lead with linkedin_url. The retry worker will
-- attempt Hunter enrichment up to 3 times across 14 days; success →
-- promote to A; exhaustion → demote to C. This gives every legacy lead
-- a fair single-pass enrichment chance under the new framework.
UPDATE leads
   SET lead_tier = 'B',
       tiered_at = NOW()
 WHERE lead_tier IS NULL
   AND deleted_at IS NULL
   AND linkedin_url IS NOT NULL AND linkedin_url <> '';

-- Tier C: everything else — no email, no linkedin (rare).
UPDATE leads
   SET lead_tier = 'C',
       tiered_at = NOW()
 WHERE lead_tier IS NULL
   AND deleted_at IS NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES (61, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
