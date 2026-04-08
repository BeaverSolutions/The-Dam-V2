-- Migration 034: Expand pipeline_stage constraint for research pipeline
-- Adds stages for MyClaw validation gate and full lifecycle tracking

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_pipeline_stage_check;
ALTER TABLE leads ADD CONSTRAINT leads_pipeline_stage_check
  CHECK (pipeline_stage IN (
    'researched',       -- Research Beaver found this lead
    'qualified',        -- MyClaw validated (ICP fit + contact channel)
    'rejected',         -- MyClaw rejected (bad data or no ICP fit)
    'outreach_ready',   -- Sales Beaver picked for daily batch
    'prospecting',      -- Legacy: initial stage (pre-research pipeline)
    'outreach',         -- Legacy: contacted
    'contacted',        -- Message sent, awaiting reply
    'replied',          -- Prospect replied
    'qualifying',       -- In qualification conversation
    'meeting_booked',   -- Meeting scheduled
    'booked',           -- Legacy alias for meeting_booked
    'proposal',         -- Proposal sent
    'closed_won',       -- Deal won
    'closed_lost',      -- Deal lost
    'nurture',          -- Not ready now, follow up later
    'closed'            -- Legacy alias
  ));
