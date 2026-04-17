-- Migration 045: Create non-superuser app role for RLS enforcement
--
-- PostgreSQL bypasses ALL RLS policies for superusers (BYPASSRLS is implicit).
-- The app connects as 'postgres' (superuser), so the 26 tenant-isolation policies
-- in migrations 002/017/023/027 have been dormant — any query runs without checks.
--
-- Fix: create beavrdam_app (NOSUPERUSER, NOBYPASSRLS). pool.withTenant() now
-- issues SET LOCAL ROLE beavrdam_app at the start of every tenant transaction.
-- RLS activates for that transaction; role reverts to postgres at COMMIT/ROLLBACK.
--
-- Migrations still run as postgres (no withTenant() call) so DDL is unaffected.

-- Idempotent: only create if role doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'beavrdam_app') THEN
    EXECUTE 'CREATE ROLE beavrdam_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOLOGIN NOBYPASSRLS';
  END IF;
END
$$;

-- Schema access
GRANT USAGE ON SCHEMA public TO beavrdam_app;

-- DML on all current tables (includes schema_migrations — harmless)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO beavrdam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO beavrdam_app;

-- Future tables created by later migrations inherit the same grants automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO beavrdam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO beavrdam_app;
