-- Migration 048: change daily_kpi.target default from 80 to 50.
-- Per MJ direction 2026-04-30 — operational pacing target.
--
-- 80/day was inherited and never validated against actual capacity.
-- 50/day is what the autonomous loop can realistically push when ICP
-- filtering, Ranger QA, and approval discipline are running properly.
-- Every new daily_kpi row now defaults to 50; existing future-dated
-- rows are swept down. Past rows preserved as historical record.

ALTER TABLE daily_kpi ALTER COLUMN target SET DEFAULT 50;

UPDATE daily_kpi
SET target = 50, updated_at = NOW()
WHERE target = 80
  AND date >= CURRENT_DATE;
