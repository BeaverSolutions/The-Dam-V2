-- 073: Pipeline and Apollo truth cleanup
-- Canonical booked-meeting stage is meeting_booked. Apollo is no longer treated
-- as a verified email source unless email_verified=true came from another
-- verification path.

UPDATE leads
   SET pipeline_stage = 'meeting_booked',
       updated_at = NOW()
 WHERE pipeline_stage = 'booked';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_pipeline_stage_check;
ALTER TABLE leads ADD CONSTRAINT leads_pipeline_stage_check
  CHECK (pipeline_stage IN (
    'researched',
    'qualified',
    'rejected',
    'outreach_ready',
    'prospecting',
    'outreach',
    'contacted',
    'replied',
    'qualifying',
    'meeting_booked',
    'proposal',
    'closed_won',
    'closed_lost',
    'nurture',
    'closed'
  ));

UPDATE leads
   SET lead_tier = CASE
         WHEN linkedin_url IS NOT NULL AND linkedin_url <> '' THEN 'B'
         ELSE NULL
       END,
       tiered_at = NOW(),
       updated_at = NOW()
 WHERE email_source = 'apollo'
   AND COALESCE(email_verified, false) = false
   AND lead_tier = 'A';
