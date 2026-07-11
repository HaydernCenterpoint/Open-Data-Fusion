-- Least-privilege role for a one-way SQLite workspace-history cutover.
--
-- Operators create a separate LOGIN role through their secret manager and grant
-- odf_cutover only for the maintenance window. The role can inspect and insert
-- the four legacy workspace-history tables, but cannot update/delete history,
-- publish outbox events, or access the tenant industrial data plane.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_cutover') THEN
    CREATE ROLE odf_cutover NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

ALTER ROLE odf_cutover WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;

-- Converge an existing role back to the narrow cutover permission set before
-- adding the grants required by the importer.
REVOKE ALL PRIVILEGES ON SCHEMA odf FROM odf_cutover;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_cutover;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA odf FROM odf_cutover;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_cutover;

GRANT USAGE ON SCHEMA odf TO odf_cutover;
GRANT SELECT ON odf.schema_migrations TO odf_cutover;
GRANT SELECT, INSERT ON
  odf.workspaces,
  odf.workspace_revisions,
  odf.workspace_members,
  odf.audit_log
TO odf_cutover;
GRANT SELECT, UPDATE ON SEQUENCE odf.audit_log_id_seq TO odf_cutover;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('004_sqlite_cutover_role', 'least-privilege SQLite workspace-history cutover role')
ON CONFLICT (version) DO NOTHING;

COMMIT;
