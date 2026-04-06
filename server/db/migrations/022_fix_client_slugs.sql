-- Migration 022: Fix missing client slugs for pilot clients
--
-- Migration 014 only seeded slugs for beaver-solutions, trl, and mastercard.
-- GamerExchange was seeded instead of Mastercard and never got a slug,
-- so clientConfig.js couldn't load its config file.
-- MGMX and Emplifive were provisioned after 014 ran and also have NULL slugs.
-- This migration is idempotent: only updates rows where slug IS NULL.

UPDATE clients SET slug = 'the-gaming-company'
  WHERE slug IS NULL AND (name ILIKE '%gamer%' OR name ILIKE '%gaming%');

UPDATE clients SET slug = 'mgmax-sdn-bhd'
  WHERE slug IS NULL AND (name ILIKE '%mgm%' OR name ILIKE '%mgmax%');

UPDATE clients SET slug = 'emplifive'
  WHERE slug IS NULL AND name ILIKE '%empli%';

-- Safety net: ensure trl slug is set even if 014 missed it
UPDATE clients SET slug = 'trl'
  WHERE slug IS NULL AND name ILIKE '%trl%';
