-- Security-definer tenant/project bootstrap boundary.
--
-- Tenant creation is an operational workflow, not an application capability.
-- A dedicated LOGIN identity inherits only odf_tenant_provisioner, which has
-- no direct data-plane privileges. It may execute one narrowly parameterized
-- function. That function is owned by a separate NOLOGIN role whose only
-- powers are the reads/inserts needed to create one complete bootstrap set.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

DO $$
DECLARE
  member_role name;
  granted_role name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_tenant_provisioner') THEN
    CREATE ROLE odf_tenant_provisioner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_tenant_provision_owner') THEN
    CREATE ROLE odf_tenant_provision_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;

  -- The function owner must never be assumable by an operational login. This
  -- also repairs any accidental grant made before a migration retry.
  FOR member_role IN
    SELECT member.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted_role.rolname = 'odf_tenant_provision_owner'
  LOOP
    EXECUTE format('REVOKE odf_tenant_provision_owner FROM %I', member_role);
  END LOOP;

  -- Also ensure the owner itself cannot inherit a broad operational role.
  FOR granted_role IN
    SELECT granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'odf_tenant_provision_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM odf_tenant_provision_owner', granted_role);
  END LOOP;
END;
$$;

ALTER ROLE odf_tenant_provisioner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
ALTER ROLE odf_tenant_provision_owner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;

-- The provisioner retains only readiness inspection and a single EXECUTE
-- capability. In particular, it cannot globally read or insert tenant data,
-- write an audit row, or discover the function owner's data privileges.
REVOKE ALL PRIVILEGES ON SCHEMA odf FROM odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA odf FROM odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_tenant_provisioner;

GRANT USAGE ON SCHEMA odf TO odf_tenant_provisioner;
GRANT SELECT ON odf.schema_migrations TO odf_tenant_provisioner;

-- The non-login function owner is deliberately separate from the provisioner.
-- Its RLS policies are usable only while the SECURITY DEFINER routine is
-- active; no ordinary login receives this role or these table grants.
REVOKE ALL PRIVILEGES ON SCHEMA odf FROM odf_tenant_provision_owner;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_tenant_provision_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA odf FROM odf_tenant_provision_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_tenant_provision_owner;

GRANT USAGE ON SCHEMA odf TO odf_tenant_provision_owner;
GRANT SELECT, INSERT ON
  odf.tenants,
  odf.projects,
  odf.tenant_members,
  odf.project_members,
  odf.model_spaces,
  odf.audit_log
TO odf_tenant_provision_owner;
GRANT USAGE ON SEQUENCE odf.audit_log_id_seq TO odf_tenant_provision_owner;

-- Tenant and project administration is an operational workflow, not a normal
-- application request capability. The API retains scoped reads, while this
-- migration removes the broad membership/project mutation grants inherited
-- from the initial data-plane foundation.
REVOKE INSERT, UPDATE, DELETE ON odf.projects FROM odf_app;
REVOKE INSERT, UPDATE, DELETE ON odf.tenant_members, odf.project_members FROM odf_app;

-- The database keeps FORCE ROW LEVEL SECURITY enabled. The function owner
-- needs narrowly scoped, role-specific read/insert policies to make the
-- bounded routine work; the externally usable provisioner role receives none.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants',
    'projects',
    'tenant_members',
    'project_members',
    'model_spaces'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_provisioner_read ON odf.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_provisioner_insert ON odf.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_provision_owner_read ON odf.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_provision_owner_insert ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_provision_owner_read ON odf.%I FOR SELECT TO odf_tenant_provision_owner USING (true)',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY tenant_provision_owner_insert ON odf.%I FOR INSERT TO odf_tenant_provision_owner WITH CHECK (true)',
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION odf.provision_tenant_project(
  p_tenant_id uuid,
  p_tenant_slug text,
  p_tenant_name text,
  p_project_id uuid,
  p_project_slug text,
  p_project_name text,
  p_owner_user_id text,
  p_model_space_id uuid,
  p_model_space_slug text,
  p_model_space_name text,
  p_provisioned_by text
)
RETURNS TABLE (
  tenant_created boolean,
  project_created boolean,
  tenant_owner_created boolean,
  project_owner_created boolean,
  model_space_created boolean,
  audit_recorded boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_count bigint;
  v_project_count bigint;
  v_tenant_owner_count bigint;
  v_project_owner_count bigint;
  v_model_space_count bigint;
  v_bootstrap_audit_count bigint;
  v_exact_audit_count bigint;
  v_tenant record;
  v_project record;
  v_tenant_owner record;
  v_project_owner record;
  v_model_space record;
  v_expected_details jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_project_id IS NULL OR p_model_space_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'tenant, project, and model-space IDs are required';
  END IF;
  IF p_tenant_slug IS NULL OR p_tenant_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
    OR p_project_slug IS NULL OR p_project_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
    OR p_model_space_slug IS NULL OR p_model_space_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'tenant, project, and model-space slugs must be lowercase slugs';
  END IF;
  IF p_tenant_name IS NULL OR char_length(p_tenant_name) = 0 OR char_length(p_tenant_name) > 256
    OR p_tenant_name <> btrim(p_tenant_name) OR p_tenant_name ~ '[[:cntrl:]]'
    OR p_project_name IS NULL OR char_length(p_project_name) = 0 OR char_length(p_project_name) > 256
    OR p_project_name <> btrim(p_project_name) OR p_project_name ~ '[[:cntrl:]]'
    OR p_model_space_name IS NULL OR char_length(p_model_space_name) = 0 OR char_length(p_model_space_name) > 256
    OR p_model_space_name <> btrim(p_model_space_name) OR p_model_space_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'tenant, project, and model-space names must be trimmed non-empty text';
  END IF;
  IF p_owner_user_id IS NULL OR char_length(p_owner_user_id) = 0 OR char_length(p_owner_user_id) > 512
    OR p_owner_user_id <> btrim(p_owner_user_id) OR p_owner_user_id ~ '[[:cntrl:]]'
    OR p_provisioned_by IS NULL OR char_length(p_provisioned_by) = 0 OR char_length(p_provisioned_by) > 512
    OR p_provisioned_by <> btrim(p_provisioned_by) OR p_provisioned_by ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'owner and provisioner identities must be trimmed non-empty text';
  END IF;

  -- One gate makes the all-or-nothing identity check deterministic even when
  -- several operational sessions attempt the same bootstrap concurrently.
  PERFORM pg_advisory_xact_lock(hashtextextended('odf:tenant-project-provision', 0));

  v_expected_details := jsonb_build_object(
    'tenantId', p_tenant_id::text,
    'tenantSlug', p_tenant_slug,
    'projectId', p_project_id::text,
    'projectSlug', p_project_slug,
    'ownerUserId', p_owner_user_id,
    'modelSpaceId', p_model_space_id::text,
    'modelSpaceSlug', p_model_space_slug,
    'created', jsonb_build_object(
      'tenantCreated', true,
      'projectCreated', true,
      'tenantOwnerCreated', true,
      'projectOwnerCreated', true,
      'modelSpaceCreated', true
    )
  );

  SELECT count(*) INTO v_tenant_count
  FROM odf.tenants
  WHERE tenant_id = p_tenant_id OR lower(slug) = lower(p_tenant_slug);
  SELECT count(*) INTO v_project_count
  FROM odf.projects
  WHERE project_id = p_project_id
    OR (tenant_id = p_tenant_id AND lower(slug) = lower(p_project_slug));
  SELECT count(*) INTO v_tenant_owner_count
  FROM odf.tenant_members
  WHERE tenant_id = p_tenant_id AND user_id = p_owner_user_id;
  SELECT count(*) INTO v_project_owner_count
  FROM odf.project_members
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND user_id = p_owner_user_id;
  SELECT count(*) INTO v_model_space_count
  FROM odf.model_spaces
  WHERE space_id = p_model_space_id
    OR (tenant_id = p_tenant_id AND project_id = p_project_id AND external_id = p_model_space_slug);
  SELECT count(*) INTO v_bootstrap_audit_count
  FROM odf.audit_log
  WHERE action = 'tenant_project_bootstrap.applied'
    AND entity_type = 'tenantProjectBootstrap'
    AND entity_id = p_project_id::text;
  SELECT count(*) INTO v_exact_audit_count
  FROM odf.audit_log
  WHERE action = 'tenant_project_bootstrap.applied'
    AND entity_type = 'tenantProjectBootstrap'
    AND entity_id = p_project_id::text
    AND actor = p_provisioned_by
    AND details = v_expected_details;

  IF v_tenant_count = 0 THEN
    -- Nothing about the requested identity may already exist. Creating a
    -- missing member/project below an established tenant would be privilege
    -- escalation, so partial targets fail rather than being repaired here.
    IF v_project_count <> 0 OR v_tenant_owner_count <> 0 OR v_project_owner_count <> 0
      OR v_model_space_count <> 0 OR v_bootstrap_audit_count <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'tenant/project bootstrap target is partially occupied';
    END IF;

    INSERT INTO odf.tenants (tenant_id, slug, name, status)
    VALUES (p_tenant_id, p_tenant_slug, p_tenant_name, 'active');
    INSERT INTO odf.projects (project_id, tenant_id, slug, name, status)
    VALUES (p_project_id, p_tenant_id, p_project_slug, p_project_name, 'active');
    INSERT INTO odf.tenant_members (tenant_id, user_id, role, created_by)
    VALUES (p_tenant_id, p_owner_user_id, 'owner', p_provisioned_by);
    INSERT INTO odf.project_members (tenant_id, project_id, user_id, role, created_by)
    VALUES (p_tenant_id, p_project_id, p_owner_user_id, 'owner', p_provisioned_by);
    INSERT INTO odf.model_spaces (space_id, tenant_id, project_id, external_id, name)
    VALUES (p_model_space_id, p_tenant_id, p_project_id, p_model_space_slug, p_model_space_name);
    INSERT INTO odf.audit_log (actor, action, entity_type, entity_id, details)
    VALUES (
      p_provisioned_by,
      'tenant_project_bootstrap.applied',
      'tenantProjectBootstrap',
      p_project_id::text,
      v_expected_details
    );

    RETURN QUERY SELECT true, true, true, true, true, true;
    RETURN;
  END IF;

  -- There is a tenant collision. It is an idempotent no-op only when every
  -- bootstrap record, creator identity, and original audit payload matches.
  -- In particular, an existing tenant plus a requested new owner is rejected.
  IF v_tenant_count <> 1 OR v_project_count <> 1 OR v_tenant_owner_count <> 1
    OR v_project_owner_count <> 1 OR v_model_space_count <> 1
    OR v_bootstrap_audit_count <> 1 OR v_exact_audit_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'tenant/project bootstrap target already exists but is not an exact completed bootstrap';
  END IF;

  SELECT tenant_id, slug, name, status INTO v_tenant
  FROM odf.tenants
  WHERE tenant_id = p_tenant_id OR lower(slug) = lower(p_tenant_slug);
  SELECT project_id, tenant_id, slug, name, status INTO v_project
  FROM odf.projects
  WHERE project_id = p_project_id
    OR (tenant_id = p_tenant_id AND lower(slug) = lower(p_project_slug));
  SELECT tenant_id, user_id, role, created_by INTO v_tenant_owner
  FROM odf.tenant_members
  WHERE tenant_id = p_tenant_id AND user_id = p_owner_user_id;
  SELECT tenant_id, project_id, user_id, role, created_by INTO v_project_owner
  FROM odf.project_members
  WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND user_id = p_owner_user_id;
  SELECT space_id, tenant_id, project_id, external_id, name INTO v_model_space
  FROM odf.model_spaces
  WHERE space_id = p_model_space_id
    OR (tenant_id = p_tenant_id AND project_id = p_project_id AND external_id = p_model_space_slug);

  IF v_tenant.tenant_id <> p_tenant_id OR v_tenant.slug <> p_tenant_slug
    OR v_tenant.name <> p_tenant_name OR v_tenant.status <> 'active'
    OR v_project.project_id <> p_project_id OR v_project.tenant_id <> p_tenant_id
    OR v_project.slug <> p_project_slug OR v_project.name <> p_project_name OR v_project.status <> 'active'
    OR v_tenant_owner.tenant_id <> p_tenant_id OR v_tenant_owner.user_id <> p_owner_user_id
    OR v_tenant_owner.role <> 'owner' OR v_tenant_owner.created_by <> p_provisioned_by
    OR v_project_owner.tenant_id <> p_tenant_id OR v_project_owner.project_id <> p_project_id
    OR v_project_owner.user_id <> p_owner_user_id OR v_project_owner.role <> 'owner'
    OR v_project_owner.created_by <> p_provisioned_by
    OR v_model_space.space_id <> p_model_space_id OR v_model_space.tenant_id <> p_tenant_id
    OR v_model_space.project_id <> p_project_id OR v_model_space.external_id <> p_model_space_slug
    OR v_model_space.name <> p_model_space_name THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'tenant/project bootstrap target already exists but conflicts with the requested identity';
  END IF;

  RETURN QUERY SELECT false, false, false, false, false, false;
END;
$$;

ALTER FUNCTION odf.provision_tenant_project(
  uuid, text, text, uuid, text, text, text, uuid, text, text, text
) OWNER TO odf_tenant_provision_owner;

REVOKE ALL PRIVILEGES ON FUNCTION odf.provision_tenant_project(
  uuid, text, text, uuid, text, text, text, uuid, text, text, text
) FROM PUBLIC, odf_app, odf_outbox_publisher, odf_readonly, odf_cutover;
GRANT EXECUTE ON FUNCTION odf.provision_tenant_project(
  uuid, text, text, uuid, text, text, text, uuid, text, text, text
) TO odf_tenant_provisioner;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('007_tenant_project_provisioning_role', 'security-definer tenant/project bootstrap boundary')
ON CONFLICT (version) DO NOTHING;

COMMIT;
