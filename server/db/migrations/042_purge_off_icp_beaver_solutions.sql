-- Migration 042: Clean up off-ICP leads for Beaver Solutions
--
-- Beaver Solutions ICP (per clients/beaver-solutions/config.md):
--   Malaysia-based digital/marketing agencies, content studios, PR firms,
--   creative houses. 5-20 employees, owner-managed.
--
-- Prior sourcing runs put many US/UK sales-training, sales-coaching, and
-- B2B SaaS companies into the DB. These pollute the uncontacted pool and
-- get pulled by Captain's search_internal_leads tool, leading to off-ICP
-- outreach (MJ rejected B2Linked, MTD Training, Outbound Squad, Mediafly,
-- Seven Figure Agency, Paperballad during the first kickoff test).
--
-- This migration soft-deletes uncontacted leads that are clearly off-ICP:
--   (a) Explicit non-Malaysia location in metadata
--   (b) Known non-Malaysia companies from the rejected-approvals review
--
-- Safety guards (do NOT remove):
--   • Scoped to beaver-solutions only (single client, via slug lookup)
--   • Only touches leads with NO active message — preserves any lead that's
--     currently in the pipeline at any stage (pending_ranger, pending_approval,
--     approved, pending_send, sending, sent, linkedin_requested). Leads whose
--     only messages are rejected (rejected/ranger_rejected/skipped/failed) are
--     eligible because those messages are terminal — no further action on them.
--   • Soft-delete only (sets deleted_at). Recoverable if ever needed.
--   • Leads with NULL or Malaysia location are NOT touched — conservative.

UPDATE leads
SET deleted_at = NOW(),
    updated_at = NOW()
WHERE client_id = (SELECT id FROM clients WHERE slug = 'beaver-solutions')
  AND deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages m
    WHERE m.lead_id = leads.id
      AND m.status IN (
        'sent', 'pending_send', 'sending',
        'pending_ranger', 'pending_approval', 'approved',
        'linkedin_requested'
      )
  )
  AND (
    -- (a) Non-Malaysia location in metadata
    (
      metadata ? 'location'
      AND metadata->>'location' IS NOT NULL
      AND metadata->>'location' <> ''
      AND LOWER(metadata->>'location') NOT LIKE '%malaysia%'
      AND LOWER(metadata->>'location') NOT LIKE '%kuala lumpur%'
      AND LOWER(metadata->>'location') NOT LIKE '%penang%'
      AND LOWER(metadata->>'location') NOT LIKE '%selangor%'
      AND LOWER(metadata->>'location') NOT LIKE '%johor%'
      AND LOWER(metadata->>'location') NOT LIKE '%sabah%'
      AND LOWER(metadata->>'location') NOT LIKE '%sarawak%'
    )
    -- (b) Known non-Malaysia companies from rejected approvals
    OR company IN (
      'B2Linked',
      'Seven Figure Agency',
      'MTD Training',
      'Outbound Squad',
      'Mediafly',
      'Paperballad & Co.',
      'Paperballad',
      'ANNUITAS',
      'Annuitas'
    )
  );
