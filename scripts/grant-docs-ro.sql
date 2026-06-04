-- One-time setup against the live docs DB.
--
-- Creates the docs_ro role (if missing) and grants SELECT on the two
-- documentation tables. Arm B's ./sql script and Arm A's pg.Pool both connect
-- as docs_ro via PG_CONNECTION_STRING; the Phase 1 smoke gate verifies that
-- INSERT under this role fails with SQLSTATE 42501.
--
-- Run as a privileged role (the DB owner / a superuser), once per DB:
--
--   psql -d <docs-db> -f scripts/grant-docs-ro.sql
--
-- The DB itself is not created or seeded by this repo. The Arize documentation
-- corpus is pre-loaded externally; this script only configures the read-only
-- role the harness expects.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docs_ro') THEN
    CREATE ROLE docs_ro WITH LOGIN PASSWORD 'docs_ro';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO docs_ro;
GRANT SELECT ON doc_paths, doc_chunks TO docs_ro;

-- Assumes default PUBLIC CONNECT on the database. On hardened clusters where
-- CONNECT was revoked from PUBLIC, an explicit grant is required:
--   GRANT CONNECT ON DATABASE <docs-db> TO docs_ro;
