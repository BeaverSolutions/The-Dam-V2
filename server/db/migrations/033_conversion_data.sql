-- Migration 033: Conversion data tracking + lead enrichment columns
-- Tracks full lead-to-close journey for analytics and MyClaw training data
-- Idempotent, forward-only

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enrich leads table with research pipeline columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Industry vertical for segmented analytics
ALTER TABLE leads ADD COLUMN IF NOT EXISTS vertical VARCHAR(50);

-- Country code (ISO 3166-1 alpha-2)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS country VARCHAR(10);

-- Company headcount bracket
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_size VARCHAR(20);

-- All known contact channels for this lead
ALTER TABLE leads ADD COLUMN IF NOT EXISTS outreach_channels JSONB DEFAULT '{}';

-- MyClaw's confidence score after validation (0-100)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS myclaw_confidence INTEGER;

-- When Research Beaver first found this lead
ALTER TABLE leads ADD COLUMN IF NOT EXISTS researched_at TIMESTAMPTZ;

-- When MyClaw validated this lead as qualified
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;

-- Pipeline stage (if not already present from earlier migration)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pipeline_stage VARCHAR(30);

-- Meeting fields (if not already present)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_date TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meeting_notes TEXT;

-- Indexes for new lead columns
CREATE INDEX IF NOT EXISTS idx_leads_vertical ON leads(client_id, vertical);
CREATE INDEX IF NOT EXISTS idx_leads_country ON leads(client_id, country);
CREATE INDEX IF NOT EXISTS idx_leads_company_size ON leads(client_id, company_size);
CREATE INDEX IF NOT EXISTS idx_leads_myclaw_confidence ON leads(client_id, myclaw_confidence DESC) WHERE myclaw_confidence IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. conversion_events — immutable event log for every pipeline transition
--    One row per event. Queryable for funnel analysis, cohort breakdown,
--    time-to-close, and MyClaw training extraction.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversion_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- What this event is about
  lead_id         UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  message_id      UUID        REFERENCES messages(id) ON DELETE SET NULL,

  -- Event classification
  event_type      VARCHAR(50) NOT NULL,
  -- Valid event_type values:
  --   lead_created, lead_researched, lead_qualified, lead_disqualified,
  --   message_sent, message_opened, message_clicked, message_replied,
  --   reply_positive, reply_neutral, reply_negative, reply_objection,
  --   followup_sent, followup_replied,
  --   meeting_booked, meeting_held, meeting_no_show,
  --   proposal_sent, proposal_viewed,
  --   deal_won, deal_lost, deal_nurture,
  --   objection_raised, objection_handled, objection_resolved

  -- Context
  channel         VARCHAR(20),  -- email, linkedin, instagram
  touch_number    INTEGER,      -- 0=cold opener, 1=FU1, 2=FU2, 3=FU3

  -- Lead snapshot at time of event (denormalized for analytics)
  vertical        VARCHAR(50),
  country         VARCHAR(10),
  company_size    VARCHAR(20),
  signal_tier     VARCHAR(5),   -- P1, P2, P3

  -- Message/reply data
  reply_sentiment VARCHAR(20),  -- positive, neutral, negative, objection
  objection_type  VARCHAR(100), -- budget, timing, authority, need, competitor, other
  objection_handling TEXT,      -- how the objection was addressed

  -- Deal data
  deal_value      NUMERIC(12,2),  -- revenue amount if deal_won
  deal_currency   VARCHAR(3) DEFAULT 'MYR',

  -- Timing (for time-to-X calculations)
  days_since_first_touch INTEGER,  -- computed at insert time
  days_in_current_stage  INTEGER,  -- how long in this stage before transitioning

  -- Agent attribution
  agent           VARCHAR(50),  -- which beaver triggered this event

  -- Flexible metadata for anything else
  -- e.g. { "hook_used": "...", "angle": "...", "ranger_score": 85,
  --        "rejection_reason": "...", "meeting_type": "discovery" }
  metadata        JSONB NOT NULL DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query patterns
CREATE INDEX IF NOT EXISTS idx_ce_client_id ON conversion_events(client_id);
CREATE INDEX IF NOT EXISTS idx_ce_lead_id ON conversion_events(client_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_ce_event_type ON conversion_events(client_id, event_type);
CREATE INDEX IF NOT EXISTS idx_ce_created ON conversion_events(client_id, created_at DESC);

-- Funnel analytics: filter by vertical/country/size + event type
CREATE INDEX IF NOT EXISTS idx_ce_vertical ON conversion_events(client_id, vertical, event_type);
CREATE INDEX IF NOT EXISTS idx_ce_country ON conversion_events(client_id, country, event_type);
CREATE INDEX IF NOT EXISTS idx_ce_company_size ON conversion_events(client_id, company_size, event_type);

-- Channel performance
CREATE INDEX IF NOT EXISTS idx_ce_channel ON conversion_events(client_id, channel, event_type);

-- Signal tier conversion tracking
CREATE INDEX IF NOT EXISTS idx_ce_signal_tier ON conversion_events(client_id, signal_tier, event_type);

-- Touch number performance (Day 0/2/4/7 analysis)
CREATE INDEX IF NOT EXISTS idx_ce_touch ON conversion_events(client_id, touch_number, event_type);

-- Objection analysis
CREATE INDEX IF NOT EXISTS idx_ce_objection ON conversion_events(client_id, objection_type)
  WHERE objection_type IS NOT NULL;

-- Deal tracking
CREATE INDEX IF NOT EXISTS idx_ce_deals ON conversion_events(client_id, event_type, deal_value)
  WHERE event_type IN ('deal_won', 'deal_lost');

-- MyClaw training data extraction: recent events with metadata
CREATE INDEX IF NOT EXISTS idx_ce_training ON conversion_events(client_id, created_at DESC)
  WHERE event_type IN ('reply_positive', 'reply_objection', 'deal_won', 'deal_lost');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. deal_summary — one row per deal (lead that reached proposal+ stage)
--    Materialized view of the full journey for quick ROI queries
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS deal_summary (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id           UUID        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- Lead profile
  company           VARCHAR(200),
  vertical          VARCHAR(50),
  country           VARCHAR(10),
  company_size      VARCHAR(20),
  signal_tier       VARCHAR(5),

  -- Timeline
  first_touch_at    TIMESTAMPTZ,
  first_reply_at    TIMESTAMPTZ,
  meeting_booked_at TIMESTAMPTZ,
  meeting_held_at   TIMESTAMPTZ,
  proposal_sent_at  TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,

  -- Computed durations (days)
  days_to_reply     INTEGER,
  days_to_meeting   INTEGER,
  days_to_close     INTEGER,

  -- Outreach stats
  total_touches     INTEGER NOT NULL DEFAULT 0,
  channels_used     JSONB DEFAULT '[]',   -- ["email", "linkedin"]
  objections_faced  INTEGER NOT NULL DEFAULT 0,
  objection_types   JSONB DEFAULT '[]',   -- ["budget", "timing"]

  -- Outcome
  outcome           VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (outcome IN ('open', 'won', 'lost', 'nurture')),
  deal_value        NUMERIC(12,2),
  deal_currency     VARCHAR(3) DEFAULT 'MYR',
  loss_reason       TEXT,

  -- What worked
  winning_hook      TEXT,      -- the message hook that got the reply
  winning_channel   VARCHAR(20),
  winning_angle     TEXT,      -- the research angle that converted

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (client_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_ds_client_id ON deal_summary(client_id);
CREATE INDEX IF NOT EXISTS idx_ds_outcome ON deal_summary(client_id, outcome);
CREATE INDEX IF NOT EXISTS idx_ds_vertical ON deal_summary(client_id, vertical, outcome);
CREATE INDEX IF NOT EXISTS idx_ds_country ON deal_summary(client_id, country, outcome);
CREATE INDEX IF NOT EXISTS idx_ds_closed ON deal_summary(client_id, closed_at DESC)
  WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ds_deal_value ON deal_summary(client_id, deal_value DESC)
  WHERE outcome = 'won';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Enable RLS on new tables
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE conversion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_summary ENABLE ROW LEVEL SECURITY;

-- RLS policies — tenant isolation
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'conversion_events' AND policyname = 'conversion_events_tenant_isolation'
  ) THEN
    CREATE POLICY conversion_events_tenant_isolation ON conversion_events
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'deal_summary' AND policyname = 'deal_summary_tenant_isolation'
  ) THEN
    CREATE POLICY deal_summary_tenant_isolation ON deal_summary
      USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Record migration
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (version) VALUES (33) ON CONFLICT (version) DO NOTHING;
