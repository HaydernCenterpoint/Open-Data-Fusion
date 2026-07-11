-- Tenant/project membership and workspace scope for the production runtime.
--
-- Migration 003 intentionally left authorization to an external resolver while
-- the API was SQLite-backed.  The PostgreSQL API adapter needs a durable,
-- tenant-scoped policy source before it can serve tenant data directly.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

CREATE TABLE IF NOT EXISTS odf.tenant_members (
  tenant_id uuid NOT NULL REFERENCES odf.tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id text NOT NULL CHECK (length(btrim(user_id)) > 0),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS tenant_members_user_tenant_idx
  ON odf.tenant_members (user_id, tenant_id);

CREATE TABLE IF NOT EXISTS odf.project_members (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id text NOT NULL CHECK (length(btrim(user_id)) > 0),
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'reviewer', 'viewer')),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, user_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_members_user_project_idx
  ON odf.project_members (user_id, tenant_id, project_id);

-- Workspace tables predate tenant scope.  A scope row is the explicit gate
-- that makes a cut-over workspace visible to tenant-scoped application roles.
-- Legacy rows remain inaccessible until the cutover tool assigns a scope.
CREATE TABLE IF NOT EXISTS odf.workspace_scopes (
  workspace_id text PRIMARY KEY REFERENCES odf.workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  assigned_by text NOT NULL CHECK (length(btrim(assigned_by)) > 0),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS workspace_scopes_tenant_project_idx
  ON odf.workspace_scopes (tenant_id, project_id, workspace_id);

CREATE OR REPLACE FUNCTION odf.reject_workspace_scope_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'workspace scope is immutable once assigned';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'odf.workspace_scopes'::regclass
      AND tgname = 'workspace_scopes_immutable'
  ) THEN
    EXECUTE 'CREATE TRIGGER workspace_scopes_immutable
      BEFORE UPDATE OR DELETE ON odf.workspace_scopes
      FOR EACH ROW EXECUTE FUNCTION odf.reject_workspace_scope_mutation()';
  END IF;
END;
$$;

-- Membership and scope records are tenant data; application connections only
-- see rows for the transaction-local tenant context.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_members',
    'project_members',
    'workspace_scopes'
  ] LOOP
    EXECUTE format('ALTER TABLE odf.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE odf.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON odf.%I FOR ALL TO odf_app, odf_readonly USING (tenant_id = (SELECT odf.current_tenant_id())) WITH CHECK (tenant_id = (SELECT odf.current_tenant_id()))',
      table_name
    );
  END LOOP;
END;
$$;

-- The purpose-specific cutover role has no UPDATE/DELETE grants.  It needs
-- these narrow RLS policies solely to import a frozen legacy workspace and
-- assign its immutable scope in one serializable transaction.
DROP POLICY IF EXISTS workspace_scopes_cutover_import ON odf.workspace_scopes;
CREATE POLICY workspace_scopes_cutover_import ON odf.workspace_scopes FOR ALL TO odf_cutover
  USING (true) WITH CHECK (true);

-- The workspace/history tables do not store tenant_id directly.  Scope them
-- through the immutable mapping above, which also makes unscoped legacy rows
-- fail closed for application and read-only roles.
ALTER TABLE odf.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.workspace_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.workspace_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.workspace_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_tenant_isolation ON odf.workspaces;
CREATE POLICY workspace_tenant_isolation ON odf.workspaces FOR ALL TO odf_app, odf_readonly
  USING (EXISTS (
    SELECT 1 FROM odf.workspace_scopes AS scope
    WHERE scope.workspace_id = id
      AND scope.tenant_id = (SELECT odf.current_tenant_id())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM odf.workspace_scopes AS scope
    WHERE scope.workspace_id = id
      AND scope.tenant_id = (SELECT odf.current_tenant_id())
  ));

DROP POLICY IF EXISTS workspace_revision_tenant_isolation ON odf.workspace_revisions;
CREATE POLICY workspace_revision_tenant_isolation ON odf.workspace_revisions FOR ALL TO odf_app, odf_readonly
  USING (EXISTS (
    SELECT 1 FROM odf.workspace_scopes AS scope
    WHERE scope.workspace_id = workspace_id
      AND scope.tenant_id = (SELECT odf.current_tenant_id())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM odf.workspace_scopes AS scope
    WHERE scope.workspace_id = workspace_id
      AND scope.tenant_id = (SELECT odf.current_tenant_id())
  ));

DROP POLICY IF EXISTS workspace_member_tenant_isolation ON odf.workspace_members;
CREATE POLICY workspace_member_tenant_isolation ON odf.workspace_members FOR ALL TO odf_app, odf_readonly
  USING (EXISTS (
    SELECT 1 FROM odf.workspace_scopes AS scope
    WHERE scope.workspace_id = workspace_id
      AND scope.tenant_id = (SELECT odf.current_tenant_id())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM odf.workspace_scopes AS scope
    WHERE scope.workspace_id = workspace_id
      AND scope.tenant_id = (SELECT odf.current_tenant_id())
  ));

DROP POLICY IF EXISTS workspaces_cutover_import ON odf.workspaces;
CREATE POLICY workspaces_cutover_import ON odf.workspaces FOR ALL TO odf_cutover
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS workspace_revisions_cutover_import ON odf.workspace_revisions;
CREATE POLICY workspace_revisions_cutover_import ON odf.workspace_revisions FOR ALL TO odf_cutover
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS workspace_members_cutover_import ON odf.workspace_members;
CREATE POLICY workspace_members_cutover_import ON odf.workspace_members FOR ALL TO odf_cutover
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  odf.tenant_members,
  odf.project_members,
  odf.workspace_scopes
TO odf_app;
GRANT SELECT ON
  odf.tenant_members,
  odf.project_members,
  odf.workspace_scopes
TO odf_readonly;

-- The cutover principal assigns scope inside the same serializable import
-- transaction.  It cannot mutate application tenant data otherwise.
GRANT SELECT, INSERT ON odf.workspace_scopes TO odf_cutover;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('005_tenant_membership_and_workspace_scope', 'tenant/project memberships and immutable tenant scope for cutover workspaces')
ON CONFLICT (version) DO NOTHING;

COMMIT;
