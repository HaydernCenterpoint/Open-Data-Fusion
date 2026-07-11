-- Least-privilege grants for the PostgreSQL Canvas API adapter.
--
-- Migration 005 adds tenant-scoped RLS policies to the legacy workspace
-- tables.  Roles also need explicit table privileges; PostgreSQL does not
-- treat a matching RLS policy as permission to read or write a table.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

-- The API may read and mutate only the current workspace snapshot. Immutable
-- revisions and audit evidence may be inserted but never updated or deleted.
GRANT SELECT, UPDATE ON odf.workspaces TO odf_app;
GRANT SELECT, INSERT ON odf.workspace_revisions TO odf_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON odf.workspace_members TO odf_app;
GRANT SELECT ON odf.workspaces, odf.workspace_revisions, odf.workspace_members TO odf_readonly;

-- A workspace scope is created by the cutover/provisioning boundary, never by
-- normal API traffic. Preserve read access for RLS predicates and explicitly
-- remove the broader temporary grant introduced with the scope table.
REVOKE INSERT, UPDATE, DELETE ON odf.workspace_scopes FROM odf_app;
GRANT SELECT ON odf.workspace_scopes TO odf_app, odf_readonly;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('006_workspace_application_role_grants', 'least-privilege workspace grants for the PostgreSQL Canvas API adapter')
ON CONFLICT (version) DO NOTHING;

COMMIT;
