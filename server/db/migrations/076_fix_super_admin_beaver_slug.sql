-- Migration 076: repair canonical Beaver Solutions slug for super-admin gate
--
-- The UI can still identify Beaver by client name, but the backend super-admin
-- gate intentionally checks the canonical client identity. If an old production
-- row lost or never received the slug, admin creation fails with 403.
-- Idempotent, forward-only.

UPDATE clients
   SET slug = 'beaver-solutions',
       updated_at = NOW()
 WHERE id = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
    OR lower(email) = 'admin@beaversolutions.com';

INSERT INTO schema_migrations (version) VALUES (76) ON CONFLICT (version) DO NOTHING;
