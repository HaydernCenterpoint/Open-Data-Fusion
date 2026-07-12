-- Governed first-workspace creation for real PostgreSQL projects.
--
-- The application role receives EXECUTE only. A non-login function owner has
-- the narrow table privileges required to cross the circular workspace/scope
-- RLS boundary after validating transaction-local tenant, project, user, and
-- active project-owner membership.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

DO $$
DECLARE
  member_role name;
  granted_role name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_workspace_bootstrap_owner') THEN
    CREATE ROLE odf_workspace_bootstrap_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;

  FOR member_role IN
    SELECT member.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'odf_workspace_bootstrap_owner'
  LOOP
    EXECUTE format('REVOKE odf_workspace_bootstrap_owner FROM %I', member_role);
  END LOOP;

  FOR granted_role IN
    SELECT granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'odf_workspace_bootstrap_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM odf_workspace_bootstrap_owner', granted_role);
  END LOOP;
END;
$$;

ALTER ROLE odf_workspace_bootstrap_owner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA odf FROM odf_workspace_bootstrap_owner;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_workspace_bootstrap_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA odf FROM odf_workspace_bootstrap_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_workspace_bootstrap_owner;

GRANT USAGE ON SCHEMA odf TO odf_workspace_bootstrap_owner;
GRANT SELECT ON odf.tenants, odf.projects, odf.project_members TO odf_workspace_bootstrap_owner;
GRANT SELECT, INSERT ON
  odf.workspaces,
  odf.workspace_scopes,
  odf.workspace_members,
  odf.workspace_revisions,
  odf.audit_log,
  odf.outbox_events
TO odf_workspace_bootstrap_owner;
GRANT USAGE ON SEQUENCE odf.audit_log_id_seq, odf.outbox_events_event_id_seq
TO odf_workspace_bootstrap_owner;

-- FORCE RLS remains enabled. These policies are usable only inside the
-- SECURITY DEFINER function because its owner is NOLOGIN and never granted.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants',
    'projects',
    'project_members',
    'workspaces',
    'workspace_scopes',
    'workspace_members',
    'workspace_revisions',
    'audit_log'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS workspace_bootstrap_owner_read ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_bootstrap_owner_read ON odf.%I FOR SELECT TO odf_workspace_bootstrap_owner USING (true)',
      table_name
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'workspaces',
    'workspace_scopes',
    'workspace_members',
    'workspace_revisions',
    'audit_log'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS workspace_bootstrap_owner_insert ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_bootstrap_owner_insert ON odf.%I FOR INSERT TO odf_workspace_bootstrap_owner WITH CHECK (true)',
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION odf.create_project_workspace(
  p_project_id uuid,
  p_workspace_id text,
  p_name text,
  p_correlation_id uuid
)
RETURNS TABLE (
  id text,
  name text,
  snapshot jsonb,
  version bigint,
  created_by text,
  created_at timestamptz,
  updated_by text,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_setting text := NULLIF(btrim(current_setting('odf.tenant_id', true)), '');
  v_project_setting text := NULLIF(btrim(current_setting('odf.project_id', true)), '');
  v_user_id text := NULLIF(btrim(current_setting('odf.user_id', true)), '');
  v_tenant_id uuid;
  v_project_id uuid;
  v_role text;
  v_snapshot jsonb := '{"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}'::jsonb;
  v_correlation_id uuid := p_correlation_id;
BEGIN
  IF v_tenant_setting IS NULL OR v_project_setting IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'tenant, project, and user context are required';
  END IF;
  BEGIN
    v_tenant_id := v_tenant_setting::uuid;
    v_project_id := v_project_setting::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'tenant and project context must be UUIDs';
  END;
  IF p_project_id IS NULL OR p_project_id <> v_project_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'workspace project does not match transaction scope';
  END IF;
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correlation ID is required';
  END IF;
  IF p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workspace ID is invalid';
  END IF;
  IF p_name IS NULL OR char_length(p_name) = 0 OR char_length(p_name) > 256
    OR p_name <> btrim(p_name) OR p_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'workspace name must be trimmed non-empty text';
  END IF;

  SELECT member.role INTO v_role
  FROM odf.project_members AS member
  JOIN odf.projects AS project
    ON project.tenant_id = member.tenant_id AND project.project_id = member.project_id
  JOIN odf.tenants AS tenant ON tenant.tenant_id = project.tenant_id
  WHERE member.tenant_id = v_tenant_id
    AND member.project_id = v_project_id
    AND member.user_id = v_user_id
    AND tenant.status = 'active'
    AND project.status = 'active';
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active project owner permission is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'odf:workspace-bootstrap:' || v_tenant_id::text || ':' || v_project_id::text || ':' || p_workspace_id,
    0
  ));
  IF EXISTS (SELECT 1 FROM odf.workspaces AS existing WHERE existing.id = p_workspace_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'workspace ID already exists';
  END IF;

  INSERT INTO odf.workspaces (id, name, snapshot, version, created_by, updated_by)
  VALUES (p_workspace_id, p_name, v_snapshot, 1, v_user_id, v_user_id);
  INSERT INTO odf.workspace_scopes (workspace_id, tenant_id, project_id, assigned_by)
  VALUES (p_workspace_id, v_tenant_id, v_project_id, v_user_id);
  INSERT INTO odf.workspace_members (workspace_id, user_id, display_name, role)
  VALUES (p_workspace_id, v_user_id, v_user_id, 'owner');
  INSERT INTO odf.workspace_revisions (
    workspace_id, version, snapshot, change_summary, actor, correlation_id
  ) VALUES (
    p_workspace_id, 1, v_snapshot, 'Initial workspace', v_user_id, v_correlation_id
  );
  INSERT INTO odf.audit_log (
    tenant_id, project_id, actor, action, entity_type, entity_id, details, correlation_id
  ) VALUES (
    v_tenant_id,
    v_project_id,
    v_user_id,
    'workspace.created',
    'workspace',
    p_workspace_id,
    jsonb_build_object(
      'tenantId', v_tenant_id::text,
      'projectId', v_project_id::text,
      'workspaceId', p_workspace_id,
      'name', p_name,
      'version', 1
    ),
    v_correlation_id
  );
  INSERT INTO odf.outbox_events (
    aggregate_type, aggregate_id, event_type, topic, message_key,
    payload, headers, deduplication_key, correlation_id
  ) VALUES (
    'workspace',
    p_workspace_id,
    'workspace.created',
    'workspace-events',
    p_workspace_id,
    jsonb_build_object(
      'tenantId', v_tenant_id::text,
      'projectId', v_project_id::text,
      'workspaceId', p_workspace_id,
      'name', p_name,
      'version', 1,
      'actor', v_user_id
    ),
    '{}'::jsonb,
    'workspace-created:' || p_workspace_id,
    v_correlation_id
  );

  RETURN QUERY
  SELECT workspace.id, workspace.name, workspace.snapshot, workspace.version,
    workspace.created_by, workspace.created_at, workspace.updated_by, workspace.updated_at
  FROM odf.workspaces AS workspace
  WHERE workspace.id = p_workspace_id;
END;
$$;

ALTER FUNCTION odf.create_project_workspace(uuid, text, text, uuid)
  OWNER TO odf_workspace_bootstrap_owner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.create_project_workspace(uuid, text, text, uuid)
  FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover,
    odf_tenant_provisioner, odf_project_discovery_owner;
GRANT EXECUTE ON FUNCTION odf.create_project_workspace(uuid, text, text, uuid) TO odf_app;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('010_project_workspace_bootstrap', 'governed active-project owner workspace creation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
