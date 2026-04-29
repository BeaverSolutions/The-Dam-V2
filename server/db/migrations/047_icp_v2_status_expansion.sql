-- Migration 047: ICP v2 status expansion
-- Per MJ direction 2026-04-29 — Research Beaver hard-reject statuses + channel router blocked path.
--
-- Adds rejection statuses to leads.status so that ICP-rejected candidates can be
-- persisted with audit trail (status='rejected_*', deleted_at=NOW()) instead of
-- being dropped silently. Validation SQL queries leads WHERE status LIKE 'rejected_%'.
--
-- Adds 'blocked_no_email' to messages.status so kickoff can hold messages waiting
-- for email enrichment instead of falling through to LinkedIn at touch 1.
--
-- Backward compatible: only ADDS values to existing CHECK constraints.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN (
    'new', 'contacted', 'replied', 'meeting_booked', 'closed_won', 'closed_lost',
    'rejected_country', 'rejected_unresolved_country',
    'rejected_size', 'rejected_unresolved_size',
    'rejected_persona', 'rejected_vertical',
    'rejected_low_score', 'rejected_data_integrity'
  ));

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN (
    'draft', 'pending_ranger', 'ranger_rejected',
    'pending_approval', 'approved', 'pending_send',
    'sending', 'sent', 'failed', 'rejected', 'replied',
    'linkedin_requested', 'blocked_no_email'
  ));

INSERT INTO schema_migrations (version) VALUES (47) ON CONFLICT (version) DO NOTHING;
