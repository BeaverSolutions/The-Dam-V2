-- 052: Research Beaver redesign — Phase B — quality_score on leads
--
-- Adds the columns Phase B's quality scorer writes to. Each lead carries:
--   - quality_score (0-100)            — composite of 4 weighted dimensions
--   - quality_score_breakdown (jsonb)  — per-dimension detail for visibility
--   - quality_scored_at                — when scored, for re-score eligibility
--
-- The existing `score` column stays untouched — it's the Research Beaver
-- verification score (lead "real / not real / suspect") which is separate
-- from quality (lead "good fit / poor fit").
--
-- Behavior change: NONE. Columns default NULL. Phase C is where the
-- scorer starts writing to them.

BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS quality_score             INT  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS quality_score_breakdown   JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS quality_scored_at         TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN leads.quality_score IS
  'Composite 0-100 quality score from services/qualityScorer.js. Weighted sum of signal/title/reachability/segment_history dimensions per tenant''s quality_weights config. Sortable for top-N ranking.';

COMMENT ON COLUMN leads.quality_score_breakdown IS
  'Per-dimension detail. Shape: { signal: {raw:0-100, weight:0-1, contribution:0-N}, title: {...}, reachability: {...}, segment_history: {...}, sum: 0-100 }. Visible in approvals UI so reviewers can sanity-check WHY the agent prioritized a lead.';

COMMENT ON COLUMN leads.quality_scored_at IS
  'Timestamp of last scoring. Leads sourced more than 7 days ago and not yet contacted should be re-scored before send (signals decay).';

-- Index for "give me top N quality leads in pool" ranking queries.
-- Filtered by client_id + status + quality_score DESC. Common Research Beaver
-- and Sales Beaver query pattern.
CREATE INDEX IF NOT EXISTS idx_leads_client_quality
  ON leads (client_id, quality_score DESC NULLS LAST)
  WHERE quality_score IS NOT NULL AND deleted_at IS NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES (52, NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;
