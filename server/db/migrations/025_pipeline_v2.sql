-- Migration 025: Pipeline v2 — follow-up sequencing, KPI snapshots, hook performance
-- Idempotent, forward-only

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add follow-up columns to messages table
--    NOTE: channel column already exists from migration 001.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0 = cold opener, 2 = FU1, 4 = FU2, 7 = FU3
ALTER TABLE messages ADD COLUMN IF NOT EXISTS follow_up_day INTEGER DEFAULT 0;

-- Links a follow-up message back to the Day 0 original
ALTER TABLE messages ADD COLUMN IF NOT EXISTS follow_up_parent_id UUID REFERENCES messages(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. follow_up_sequences — tracks per-lead per-channel sequence state
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS follow_up_sequences (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id           UUID        NOT NULL REFERENCES leads(id)   ON DELETE CASCADE,
  channel           VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'linkedin', 'instagram')),

  -- Day 0 — cold opener
  day0_sent_at      TIMESTAMPTZ,
  day0_message_id   UUID        REFERENCES messages(id),

  -- Day 2 — FU1
  day2_sent_at      TIMESTAMPTZ,
  day2_message_id   UUID        REFERENCES messages(id),

  -- Day 4 — FU2
  day4_sent_at      TIMESTAMPTZ,
  day4_message_id   UUID        REFERENCES messages(id),

  -- Day 7 — FU3
  day7_sent_at      TIMESTAMPTZ,
  day7_message_id   UUID        REFERENCES messages(id),

  -- If set, sequence is paused (prospect replied)
  last_reply_at     TIMESTAMPTZ,
  reply_channel     VARCHAR(20),

  status            VARCHAR(30) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'replied', 'completed', 'nurture')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (client_id, lead_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_fup_seq_client_id  ON follow_up_sequences(client_id);
CREATE INDEX IF NOT EXISTS idx_fup_seq_lead_id    ON follow_up_sequences(lead_id);
CREATE INDEX IF NOT EXISTS idx_fup_seq_status     ON follow_up_sequences(client_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. kpi_snapshots — weekly KPI snapshot per agent per client
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent             VARCHAR(50)  NOT NULL,   -- research_beaver / sales_beaver / enforcer / captain
  week_start        DATE         NOT NULL,   -- Monday of the snapshot week (UTC)

  -- Research Beaver metrics
  leads_found       INTEGER      NOT NULL DEFAULT 0,
  leads_passed      INTEGER      NOT NULL DEFAULT 0,
  leads_rejected    INTEGER      NOT NULL DEFAULT 0,

  -- Sales Beaver metrics
  drafted           INTEGER      NOT NULL DEFAULT 0,
  approved          INTEGER      NOT NULL DEFAULT 0,
  failed            INTEGER      NOT NULL DEFAULT 0,

  -- Enforcer Beaver metrics
  reviewed          INTEGER      NOT NULL DEFAULT 0,
  ranger_rejected   INTEGER      NOT NULL DEFAULT 0,
  rewrite_rate      NUMERIC(5,2) NOT NULL DEFAULT 0,

  -- Outcome metrics (shared)
  sent              INTEGER      NOT NULL DEFAULT 0,
  replies           INTEGER      NOT NULL DEFAULT 0,
  reply_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
  meetings          INTEGER      NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (client_id, agent, week_start)
);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_client_id   ON kpi_snapshots(client_id);
CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_week_start  ON kpi_snapshots(client_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_agent       ON kpi_snapshots(client_id, agent);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. hook_performance — tracks which message hooks/angles perform best
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hook_performance (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  hook_text         TEXT         NOT NULL,   -- the opening line / angle used
  channel           VARCHAR(20)  CHECK (channel IN ('email', 'linkedin', 'instagram')),
  week_start        DATE,                    -- Monday of the measurement week (UTC)

  times_used        INTEGER      NOT NULL DEFAULT 0,
  replies           INTEGER      NOT NULL DEFAULT 0,
  meetings          INTEGER      NOT NULL DEFAULT 0,
  reply_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,

  -- Whether Captain Beaver has flagged this as the active hook this week
  is_current        BOOLEAN      NOT NULL DEFAULT FALSE,

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hook_perf_client_id   ON hook_performance(client_id);
CREATE INDEX IF NOT EXISTS idx_hook_perf_week_start  ON hook_performance(client_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_hook_perf_channel     ON hook_performance(client_id, channel);
CREATE INDEX IF NOT EXISTS idx_hook_perf_is_current  ON hook_performance(client_id, is_current) WHERE is_current = TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Record migration
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO schema_migrations (version) VALUES (25) ON CONFLICT (version) DO NOTHING;
