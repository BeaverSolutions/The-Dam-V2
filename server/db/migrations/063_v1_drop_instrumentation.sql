-- 063_v1_drop_instrumentation.sql
--
-- v1.0 outreach rules introduce a hard required-input contract: when a lead
-- lacks first_name / company_name / persona_segment / verifiable_trigger /
-- segment_pain_id, Sales Beaver returns status=needs_more_research instead
-- of generating a fallback DM. This column captures which field(s) caused
-- the drop so we can measure upstream Research Beaver pressure and decide
-- whether sourcing or rules need adjustment.
--
-- Populated by services/agents.js when Sales Beaver returns the drop envelope.
-- Format: a short tag like "missing:verifiable_trigger" or
-- "missing:segment_pain_id,company_name". Cleared on next successful draft.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS v1_drop_reason TEXT;

COMMENT ON COLUMN leads.v1_drop_reason IS
  'v1.0 required-input contract drop tag. Populated when Sales Beaver returns needs_more_research. Cleared on successful draft.';
