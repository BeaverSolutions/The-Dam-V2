-- Migration 014: Add slug to clients for file-based config system
ALTER TABLE clients ADD COLUMN IF NOT EXISTS slug VARCHAR(80);

-- Seed slugs for existing clients
UPDATE clients SET slug = 'beaver-solutions' WHERE name ILIKE '%beaver%';
UPDATE clients SET slug = 'trl'              WHERE name ILIKE '%trl%';
UPDATE clients SET slug = 'mastercard'       WHERE name ILIKE '%mastercard%';

-- Unique index so no two clients share a slug
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_slug ON clients(slug) WHERE slug IS NOT NULL;
