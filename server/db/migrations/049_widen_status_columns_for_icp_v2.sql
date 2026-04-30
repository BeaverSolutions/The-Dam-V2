-- Migration 049: widen leads.status and messages.status from varchar(20) to varchar(50).
-- Per debug 2026-04-30 — migration 047 added long values to the CHECK constraint
-- (e.g. 'rejected_unresolved_country' = 27 chars) but didn't widen the column.
-- Any soft-reject INSERT silently failed on length validation, which is why
-- zero leads carried rejected_* status despite kickoff designed to write them.

ALTER TABLE leads ALTER COLUMN status TYPE VARCHAR(50);
ALTER TABLE messages ALTER COLUMN status TYPE VARCHAR(50);
