-- Membership-scoped tenant/project discovery for the PostgreSQL API.
--
-- Tenant discovery necessarily crosses the tenant RLS boundary. Keep that
-- boundary behind two parameter-minimal SECURITY DEFINER functions which read
-- the authenticated identity from transaction-local settings. Callers cannot
-- supply a different user (or tenant for project discovery) as an argument.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

DO $$
DECLARE
  member_role name;
  granted_role name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_project_discovery_owner') THEN
    CREATE ROLE odf_project_discovery_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;

  -- The function owner is never an assumable operational role.
  FOR member_role IN
    SELECT member.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'odf_project_discovery_owner'
  LOOP
    EXECUTE format('REVOKE odf_project_discovery_owner FROM %I', member_role);
  END LOOP;

  -- It also cannot inherit any broader role through a previous deployment.
  FOR granted_role IN
    SELECT granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'odf_project_discovery_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM odf_project_discovery_owner', granted_role);
  END LOOP;
END;
$$;

ALTER ROLE odf_project_discovery_owner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA odf FROM odf_project_discovery_owner;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_project_discovery_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA odf FROM odf_project_discovery_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_project_discovery_owner;

GRANT USAGE ON SCHEMA odf TO odf_project_discovery_owner;
GRANT SELECT ON
  odf.tenants,
  odf.projects,
  odf.tenant_members,
  odf.project_members
TO odf_project_discovery_owner;

-- FORCE RLS remains enabled. Only the non-login function owner gets a
-- cross-tenant SELECT policy, and it receives no write privileges.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants',
    'projects',
    'tenant_members',
    'project_members'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS project_discovery_owner_read ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY project_discovery_owner_read ON odf.%I FOR SELECT TO odf_project_discovery_owner USING (true)',
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION odf.discover_accessible_tenants(
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  name text,
  created_by text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_user_id text := NULLIF(btrim(current_setting('odf.user_id', true)), '');
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'discovery limit must be between 1 and 101';
  END IF;
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    tenant.tenant_id,
    tenant.name,
    COALESCE(creator.created_by, access.created_by),
    tenant.created_at
  FROM odf.tenants AS tenant
  JOIN LATERAL (
    SELECT member.created_by
    FROM odf.project_members AS member
    JOIN odf.projects AS project
      ON project.tenant_id = member.tenant_id
     AND project.project_id = member.project_id
    WHERE member.tenant_id = tenant.tenant_id
      AND member.user_id = v_user_id
      AND project.status = 'active'
    ORDER BY member.created_at, member.project_id
    LIMIT 1
  ) AS access ON true
  LEFT JOIN LATERAL (
    SELECT member.created_by
    FROM odf.tenant_members AS member
    WHERE member.tenant_id = tenant.tenant_id
    ORDER BY member.created_at, member.user_id
    LIMIT 1
  ) AS creator ON true
  WHERE tenant.status = 'active'
    AND (p_after IS NULL OR tenant.tenant_id > p_after)
  ORDER BY tenant.tenant_id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION odf.discover_accessible_projects(
  p_after uuid,
  p_limit integer
)
RETURNS TABLE (
  tenant_id uuid,
  id uuid,
  name text,
  description text,
  created_by text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_user_id text := NULLIF(btrim(current_setting('odf.user_id', true)), '');
  v_tenant_setting text := NULLIF(btrim(current_setting('odf.tenant_id', true)), '');
  v_tenant_id uuid;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'discovery limit must be between 1 and 101';
  END IF;
  IF v_user_id IS NULL OR v_tenant_setting IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    v_tenant_id := v_tenant_setting::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN;
  END;

  RETURN QUERY
  SELECT
    project.tenant_id,
    project.project_id,
    project.name,
    project.description,
    creator.created_by,
    project.created_at
  FROM odf.projects AS project
  JOIN odf.tenants AS tenant
    ON tenant.tenant_id = project.tenant_id
   AND tenant.status = 'active'
  JOIN odf.project_members AS access
    ON access.tenant_id = project.tenant_id
   AND access.project_id = project.project_id
   AND access.user_id = v_user_id
  JOIN LATERAL (
    SELECT member.created_by
    FROM odf.project_members AS member
    WHERE member.tenant_id = project.tenant_id
      AND member.project_id = project.project_id
    ORDER BY member.created_at, member.user_id
    LIMIT 1
  ) AS creator ON true
  WHERE project.tenant_id = v_tenant_id
    AND project.status = 'active'
    AND (p_after IS NULL OR project.project_id > p_after)
  ORDER BY project.project_id
  LIMIT p_limit;
END;
$$;

ALTER FUNCTION odf.discover_accessible_tenants(uuid, integer)
  OWNER TO odf_project_discovery_owner;
ALTER FUNCTION odf.discover_accessible_projects(uuid, integer)
  OWNER TO odf_project_discovery_owner;

REVOKE ALL PRIVILEGES ON FUNCTION odf.discover_accessible_tenants(uuid, integer)
  FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.discover_accessible_projects(uuid, integer)
  FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
GRANT EXECUTE ON FUNCTION odf.discover_accessible_tenants(uuid, integer) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.discover_accessible_projects(uuid, integer) TO odf_app;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('009_membership_scoped_project_discovery', 'membership-scoped PostgreSQL tenant/project discovery functions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
