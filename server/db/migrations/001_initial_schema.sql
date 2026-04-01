-- Migration: 001 Initial Schema
-- Idempotent, forward-only

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Schema migrations tracker
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clients (system table - no client_id)
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  plan VARCHAR(50) NOT NULL DEFAULT 'starter',
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_code VARCHAR(6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Access codes (format: BEAVER-XXXX-XXXX)
CREATE TABLE IF NOT EXISTS access_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  code VARCHAR(20) NOT NULL UNIQUE,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_access_codes_client_id ON access_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_access_codes_code ON access_codes(code);

-- Authorised devices
CREATE TABLE IF NOT EXISTS authorised_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES access_codes(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_authorised_devices_client_id ON authorised_devices(client_id);
CREATE INDEX IF NOT EXISTS idx_authorised_devices_fingerprint ON authorised_devices(device_fingerprint);

-- Leads
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(255),
  company VARCHAR(200),
  title VARCHAR(200),
  linkedin_url TEXT,
  source VARCHAR(50),
  signal_tier VARCHAR(5) CHECK (signal_tier IN ('P1', 'P2', 'P3')),
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'replied', 'meeting_booked', 'closed_won', 'closed_lost')),
  score INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_leads_client_id ON leads(client_id);
CREATE INDEX IF NOT EXISTS idx_leads_client_status ON leads(client_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_client_created ON leads(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_active ON leads(client_id, created_at DESC) WHERE deleted_at IS NULL;

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'linkedin', 'instagram')),
  subject VARCHAR(500),
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_ranger', 'ranger_rejected', 'pending_approval', 'approved', 'sent', 'failed')),
  ranger_score INTEGER,
  ranger_notes TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_client_id ON messages(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_client_status ON messages(client_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
CREATE INDEX IF NOT EXISTS idx_messages_client_lead ON messages(client_id, lead_id);

-- Approvals
CREATE TABLE IF NOT EXISTS approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  requested_by VARCHAR(50) NOT NULL,
  approved_by UUID REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approvals_client_id ON approvals(client_id);
CREATE INDEX IF NOT EXISTS idx_approvals_client_status ON approvals(client_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_message_id ON approvals(message_id);

-- Logs (activity log)
CREATE TABLE IF NOT EXISTS logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent VARCHAR(50) NOT NULL CHECK (agent IN ('research_beaver', 'sales_beaver', 'ranger', 'director', 'system')),
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_logs_client_id ON logs(client_id);
CREATE INDEX IF NOT EXISTS idx_logs_client_created ON logs(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_client_agent ON logs(client_id, agent);
CREATE INDEX IF NOT EXISTS idx_logs_action ON logs(action);

-- Calendar events
CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  title VARCHAR(300) NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  meeting_link TEXT,
  google_event_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_client_id ON calendar_events(client_id);
CREATE INDEX IF NOT EXISTS idx_calendar_client_start ON calendar_events(client_id, start_time);

-- Agent memory
CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agent VARCHAR(50) NOT NULL,
  memory_type VARCHAR(50) NOT NULL CHECK (memory_type IN ('icp', 'brand_voice', 'objection', 'pattern', 'preference', 'conversion_data')),
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_client_id ON agent_memory(client_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_client_agent ON agent_memory(client_id, agent);

-- Record this migration
INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING;
