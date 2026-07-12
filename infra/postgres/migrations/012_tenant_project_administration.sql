-- Governed tenant/project administration for the PostgreSQL application API.
--
-- Bootstrap remains a separate operational workflow (migration 007). After a
-- tenant exists, its owners/admins need a durable, user-facing way to create
-- and maintain projects and memberships without giving the API principal
-- broad INSERT/UPDATE/DELETE privileges on tenant tables. Every mutation is
-- therefore behind an explicit SECURITY DEFINER routine owned by a NOLOGIN,
-- non-assumable role. FORCE RLS remains enabled on every tenant relation.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

-- Tenant membership predates user-facing administration. Keep its original
-- creation evidence immutable and add a separate update time for role
-- changes, including deployments that already contain bootstrap memberships.
ALTER TABLE odf.tenant_members
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE odf.tenant_members
SET updated_at = created_at
WHERE updated_at IS NULL;
ALTER TABLE odf.tenant_members
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

-- Tenant-level changes cannot be represented by the project-scoped audit_log
-- without inventing an unrelated project. Keep a narrowly scoped, append-only
-- tenant ledger instead. Project changes continue to use audit_log plus the
-- transactional outbox in the same database transaction.
CREATE TABLE IF NOT EXISTS odf.tenant_administration_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES odf.tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) > 0),
  entity_id text NOT NULL CHECK (length(btrim(entity_id)) > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_administration_events_scope_occurred_idx
  ON odf.tenant_administration_events (tenant_id, occurred_at DESC, event_id DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'odf.tenant_administration_events'::regclass
      AND tgname = 'tenant_administration_events_append_only'
  ) THEN
    EXECUTE 'CREATE TRIGGER tenant_administration_events_append_only
      BEFORE UPDATE OR DELETE ON odf.tenant_administration_events
      FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_history_mutation()';
  END IF;
END;
$$;

-- Retain a tenant owner and a project owner under concurrent membership
-- changes. Advisory locks make the count check serial for each scope.
CREATE OR REPLACE FUNCTION odf.protect_last_tenant_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
DECLARE
  owner_count bigint;
BEGIN
  IF OLD.role <> 'owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('odf:tenant-owner:' || OLD.tenant_id::text, 0));
  SELECT count(*) INTO owner_count
  FROM odf.tenant_members
  WHERE tenant_id = OLD.tenant_id AND role = 'owner';

  IF owner_count <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('tenant %L must retain at least one owner', OLD.tenant_id),
      CONSTRAINT = 'tenant_must_retain_owner';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.protect_last_project_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
DECLARE
  owner_count bigint;
BEGIN
  IF OLD.role <> 'owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'odf:project-owner:' || OLD.tenant_id::text || ':' || OLD.project_id::text,
    0
  ));
  SELECT count(*) INTO owner_count
  FROM odf.project_members
  WHERE tenant_id = OLD.tenant_id AND project_id = OLD.project_id AND role = 'owner';

  IF owner_count <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('project %L must retain at least one owner', OLD.project_id),
      CONSTRAINT = 'project_must_retain_owner';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'odf.tenant_members'::regclass
      AND tgname = 'tenant_members_retain_owner'
  ) THEN
    EXECUTE 'CREATE TRIGGER tenant_members_retain_owner
      BEFORE UPDATE OF role OR DELETE ON odf.tenant_members
      FOR EACH ROW EXECUTE FUNCTION odf.protect_last_tenant_owner()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'odf.project_members'::regclass
      AND tgname = 'project_members_retain_owner'
  ) THEN
    EXECUTE 'CREATE TRIGGER project_members_retain_owner
      BEFORE UPDATE OF role OR DELETE ON odf.project_members
      FOR EACH ROW EXECUTE FUNCTION odf.protect_last_project_owner()';
  END IF;
END;
$$;

DO $$
DECLARE
  member_role name;
  granted_role name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_tenant_project_admin_owner') THEN
    CREATE ROLE odf_tenant_project_admin_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;

  -- The SECURITY DEFINER owner is deliberately not assumable by any login.
  FOR member_role IN
    SELECT member.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'odf_tenant_project_admin_owner'
  LOOP
    EXECUTE format('REVOKE odf_tenant_project_admin_owner FROM %I', member_role);
  END LOOP;

  -- It also must not acquire broad rights through a previous deployment.
  FOR granted_role IN
    SELECT granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'odf_tenant_project_admin_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM odf_tenant_project_admin_owner', granted_role);
  END LOOP;
END;
$$;

ALTER ROLE odf_tenant_project_admin_owner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON SCHEMA odf FROM odf_tenant_project_admin_owner;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_tenant_project_admin_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA odf FROM odf_tenant_project_admin_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_tenant_project_admin_owner;

GRANT USAGE ON SCHEMA odf TO odf_tenant_project_admin_owner;
GRANT SELECT, UPDATE ON odf.tenants TO odf_tenant_project_admin_owner;
GRANT SELECT, INSERT, UPDATE ON odf.projects TO odf_tenant_project_admin_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON odf.tenant_members, odf.project_members
TO odf_tenant_project_admin_owner;
GRANT SELECT, INSERT ON odf.audit_log, odf.tenant_administration_events, odf.outbox_events
TO odf_tenant_project_admin_owner;
GRANT USAGE ON SEQUENCE
  odf.audit_log_id_seq,
  odf.tenant_administration_events_event_id_seq,
  odf.outbox_events_event_id_seq
TO odf_tenant_project_admin_owner;

-- FORCE RLS stays enabled. The non-login function owner receives explicit,
-- role-specific policies only; the API principal gets EXECUTE but no new
-- direct mutation grants on these relations.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants',
    'projects',
    'tenant_members',
    'project_members',
    'tenant_administration_events'
  ] LOOP
    EXECUTE format('ALTER TABLE odf.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE odf.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_project_administration_owner_all ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_project_administration_owner_all ON odf.%I FOR ALL '
      || 'TO odf_tenant_project_admin_owner USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS tenant_administration_events_app_scope ON odf.tenant_administration_events;
CREATE POLICY tenant_administration_events_app_scope ON odf.tenant_administration_events
  FOR SELECT TO odf_app, odf_readonly
  USING (tenant_id = (SELECT odf.current_tenant_id()));

DROP POLICY IF EXISTS tenant_project_administration_owner_audit ON odf.audit_log;
CREATE POLICY tenant_project_administration_owner_audit ON odf.audit_log
  FOR ALL TO odf_tenant_project_admin_owner USING (true) WITH CHECK (true);

GRANT SELECT ON odf.tenant_administration_events TO odf_app, odf_readonly;

-- Internal helpers are not executable by callers. They read the transaction
-- context rather than accepting a caller-selected actor or scope.
CREATE OR REPLACE FUNCTION odf.administration_context(p_require_project boolean)
RETURNS TABLE (
  tenant_id uuid,
  project_id uuid,
  user_id text
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, odf
AS $$
DECLARE
  v_tenant_setting text := NULLIF(btrim(current_setting('odf.tenant_id', true)), '');
  v_project_setting text := NULLIF(btrim(current_setting('odf.project_id', true)), '');
  v_user_id text := NULLIF(btrim(current_setting('odf.user_id', true)), '');
  v_tenant_id uuid;
  v_project_id uuid;
BEGIN
  IF v_tenant_setting IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'tenant and user context are required';
  END IF;
  IF char_length(v_user_id) > 255 OR v_user_id ~ '[[:cntrl:]]' OR v_user_id ~ '[[:space:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'user context is invalid';
  END IF;
  BEGIN
    v_tenant_id := v_tenant_setting::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'tenant context must be a UUID';
  END;
  IF p_require_project THEN
    IF v_project_setting IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'project context is required';
    END IF;
    BEGIN
      v_project_id := v_project_setting::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'project context must be a UUID';
    END;
  END IF;
  RETURN QUERY SELECT v_tenant_id, v_project_id, v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION odf.administration_validate_user_id(p_user_id text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, odf
AS $$
BEGIN
  IF p_user_id IS NULL OR char_length(p_user_id) = 0 OR char_length(p_user_id) > 255
    OR p_user_id <> btrim(p_user_id) OR p_user_id ~ '[[:cntrl:]]' OR p_user_id ~ '[[:space:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'member user ID must be trimmed non-empty text without whitespace or control characters';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION odf.administration_require_tenant_owner(p_tenant_id uuid, p_user_id text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, odf
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT member.role INTO v_role
  FROM odf.tenant_members AS member
  WHERE member.tenant_id = p_tenant_id AND member.user_id = p_user_id;
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'tenant owner permission is required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION odf.administration_require_tenant_manager(p_tenant_id uuid, p_user_id text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, odf
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT member.role INTO v_role
  FROM odf.tenant_members AS member
  WHERE member.tenant_id = p_tenant_id AND member.user_id = p_user_id;
  IF v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'tenant owner or admin permission is required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION odf.administration_require_project_member(
  p_tenant_id uuid,
  p_project_id uuid,
  p_user_id text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, odf
AS $$
DECLARE
  v_tenant_role text;
BEGIN
  SELECT member.role INTO v_tenant_role
  FROM odf.tenant_members AS member
  WHERE member.tenant_id = p_tenant_id AND member.user_id = p_user_id;
  IF v_tenant_role IN ('owner', 'admin') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM odf.project_members AS member
    WHERE member.tenant_id = p_tenant_id
      AND member.project_id = p_project_id
      AND member.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'project membership is required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION odf.administration_require_project_manager(
  p_tenant_id uuid,
  p_project_id uuid,
  p_user_id text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, odf
AS $$
DECLARE
  v_tenant_role text;
  v_project_role text;
BEGIN
  SELECT member.role INTO v_tenant_role
  FROM odf.tenant_members AS member
  WHERE member.tenant_id = p_tenant_id AND member.user_id = p_user_id;
  IF v_tenant_role IN ('owner', 'admin') THEN
    RETURN;
  END IF;
  SELECT member.role INTO v_project_role
  FROM odf.project_members AS member
  WHERE member.tenant_id = p_tenant_id
    AND member.project_id = p_project_id
    AND member.user_id = p_user_id;
  IF v_project_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'project owner or tenant manager permission is required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION odf.append_tenant_administration_event(
  p_tenant_id uuid,
  p_actor text,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_details jsonb,
  p_correlation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, odf
AS $$
BEGIN
  INSERT INTO odf.tenant_administration_events (
    tenant_id, actor, action, entity_type, entity_id, details, correlation_id
  ) VALUES (
    p_tenant_id, p_actor, p_action, p_entity_type, p_entity_id,
    p_details || jsonb_build_object('tenantId', p_tenant_id::text), p_correlation_id
  );
  INSERT INTO odf.outbox_events (
    aggregate_type, aggregate_id, event_type, topic, message_key,
    payload, headers, deduplication_key, correlation_id
  ) VALUES (
    'tenant', p_tenant_id::text, p_action, 'platform-events', p_entity_id,
    jsonb_build_object(
      'tenantId', p_tenant_id::text,
      'entityType', p_entity_type,
      'entityId', p_entity_id,
      'action', p_action,
      'details', p_details
    ),
    '{}'::jsonb,
    'platform:' || p_action || ':' || p_entity_id || ':' || p_correlation_id::text,
    p_correlation_id
  ) ON CONFLICT (aggregate_type, aggregate_id, event_type, deduplication_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION odf.append_project_administration_event(
  p_tenant_id uuid,
  p_project_id uuid,
  p_actor text,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_details jsonb,
  p_correlation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, odf
AS $$
BEGIN
  INSERT INTO odf.audit_log (
    tenant_id, project_id, actor, action, entity_type, entity_id, details, correlation_id
  ) VALUES (
    p_tenant_id, p_project_id, p_actor, p_action, p_entity_type, p_entity_id,
    p_details || jsonb_build_object('tenantId', p_tenant_id::text, 'projectId', p_project_id::text),
    p_correlation_id
  );
  INSERT INTO odf.outbox_events (
    aggregate_type, aggregate_id, event_type, topic, message_key,
    payload, headers, deduplication_key, correlation_id
  ) VALUES (
    p_entity_type, p_entity_id, p_action, 'platform-events', p_entity_id,
    jsonb_build_object(
      'tenantId', p_tenant_id::text,
      'projectId', p_project_id::text,
      'entityType', p_entity_type,
      'entityId', p_entity_id,
      'action', p_action,
      'details', p_details
    ),
    '{}'::jsonb,
    'platform:' || p_action || ':' || p_entity_id || ':' || p_correlation_id::text,
    p_correlation_id
  ) ON CONFLICT (aggregate_type, aggregate_id, event_type, deduplication_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_update_tenant(
  p_name text,
  p_status text,
  p_correlation_id uuid
)
RETURNS TABLE (
  tenant_id uuid,
  slug text,
  name text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_actor text;
  v_tenant odf.tenants%ROWTYPE;
  v_next_name text;
  v_next_status text;
BEGIN
  SELECT context.tenant_id, context.user_id
  INTO v_tenant_id, v_actor
  FROM odf.administration_context(false) AS context;
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correlation ID is required';
  END IF;
  IF p_name IS NULL AND p_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'at least one tenant field is required';
  END IF;
  IF p_name IS NOT NULL AND (char_length(p_name) = 0 OR char_length(p_name) > 255
    OR p_name <> btrim(p_name) OR p_name ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'tenant name must be trimmed non-empty text';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'suspended', 'retired') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'tenant status is invalid';
  END IF;

  PERFORM odf.administration_require_tenant_owner(v_tenant_id, v_actor);
  SELECT tenant.* INTO v_tenant
  FROM odf.tenants AS tenant
  WHERE tenant.tenant_id = v_tenant_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'tenant was not found';
  END IF;
  v_next_name := COALESCE(p_name, v_tenant.name);
  v_next_status := COALESCE(p_status, v_tenant.status);
  IF v_tenant.name = v_next_name AND v_tenant.status = v_next_status THEN
    RETURN QUERY SELECT
      v_tenant.tenant_id, v_tenant.slug, v_tenant.name, v_tenant.status,
      v_tenant.created_at, v_tenant.updated_at, false;
    RETURN;
  END IF;

  UPDATE odf.tenants AS tenant
  SET name = v_next_name,
      status = v_next_status,
      updated_at = now()
  WHERE tenant.tenant_id = v_tenant_id
  RETURNING tenant.* INTO v_tenant;
  PERFORM odf.append_tenant_administration_event(
    v_tenant_id,
    v_actor,
    'platform.tenant_updated',
    'tenant',
    v_tenant_id::text,
    jsonb_build_object('name', v_tenant.name, 'status', v_tenant.status),
    p_correlation_id
  );
  RETURN QUERY SELECT
    v_tenant.tenant_id, v_tenant.slug, v_tenant.name, v_tenant.status,
    v_tenant.created_at, v_tenant.updated_at, true;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_create_project(
  p_project_id uuid,
  p_slug text,
  p_name text,
  p_description text,
  p_correlation_id uuid
)
RETURNS TABLE (
  project_id uuid,
  tenant_id uuid,
  slug text,
  name text,
  description text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_actor text;
  v_tenant_status text;
  v_existing odf.projects%ROWTYPE;
  v_description text := NULLIF(btrim(p_description), '');
BEGIN
  SELECT context.tenant_id, context.user_id
  INTO v_tenant_id, v_actor
  FROM odf.administration_context(false) AS context;
  IF p_project_id IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project ID and correlation ID are required';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project slug must be a lowercase slug';
  END IF;
  IF p_name IS NULL OR char_length(p_name) = 0 OR char_length(p_name) > 255
    OR p_name <> btrim(p_name) OR p_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project name must be trimmed non-empty text';
  END IF;
  IF v_description IS NOT NULL AND (char_length(v_description) > 4000 OR v_description ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project description is invalid';
  END IF;

  PERFORM odf.administration_require_tenant_manager(v_tenant_id, v_actor);
  SELECT tenant.status INTO v_tenant_status
  FROM odf.tenants AS tenant
  WHERE tenant.tenant_id = v_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'tenant was not found';
  END IF;
  IF v_tenant_status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active tenant status is required to create a project';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'odf:project-administration:' || v_tenant_id::text || ':' || p_project_id::text,
    0
  ));
  SELECT project.* INTO v_existing
  FROM odf.projects AS project
  WHERE project.project_id = p_project_id
     OR (project.tenant_id = v_tenant_id AND lower(project.slug) = lower(p_slug))
  LIMIT 1;

  IF FOUND THEN
    IF v_existing.tenant_id = v_tenant_id
      AND v_existing.project_id = p_project_id
      AND v_existing.slug = p_slug
      AND v_existing.name = p_name
      AND v_existing.description IS NOT DISTINCT FROM v_description
      AND v_existing.status = 'active'
      AND EXISTS (
        SELECT 1 FROM odf.project_members AS member
        WHERE member.tenant_id = v_tenant_id
          AND member.project_id = p_project_id
          AND member.user_id = v_actor
          AND member.role = 'owner'
      ) THEN
      RETURN QUERY SELECT
        v_existing.project_id, v_existing.tenant_id, v_existing.slug, v_existing.name,
        v_existing.description, v_existing.status, v_existing.created_at, v_existing.updated_at, false;
      RETURN;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'project identifier or slug is already bound to different input';
  END IF;

  INSERT INTO odf.projects (project_id, tenant_id, slug, name, description, status)
  VALUES (p_project_id, v_tenant_id, p_slug, p_name, v_description, 'active');
  INSERT INTO odf.project_members (tenant_id, project_id, user_id, role, created_by)
  VALUES (v_tenant_id, p_project_id, v_actor, 'owner', v_actor);
  PERFORM odf.append_project_administration_event(
    v_tenant_id,
    p_project_id,
    v_actor,
    'platform.project_created',
    'project',
    p_project_id::text,
    jsonb_build_object('slug', p_slug, 'name', p_name, 'description', v_description, 'status', 'active'),
    p_correlation_id
  );
  RETURN QUERY
  SELECT project.project_id, project.tenant_id, project.slug, project.name,
    project.description, project.status, project.created_at, project.updated_at, true
  FROM odf.projects AS project
  WHERE project.tenant_id = v_tenant_id AND project.project_id = p_project_id;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_update_project(
  p_project_id uuid,
  p_name text,
  p_description text,
  p_description_provided boolean,
  p_status text,
  p_correlation_id uuid
)
RETURNS TABLE (
  project_id uuid,
  tenant_id uuid,
  slug text,
  name text,
  description text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_context_project_id uuid;
  v_actor text;
  v_project odf.projects%ROWTYPE;
  v_next_name text;
  v_next_description text;
  v_next_status text;
BEGIN
  SELECT context.tenant_id, context.project_id, context.user_id
  INTO v_tenant_id, v_context_project_id, v_actor
  FROM odf.administration_context(true) AS context;
  IF p_project_id IS NULL OR p_project_id <> v_context_project_id OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'project and correlation context are required';
  END IF;
  IF p_name IS NOT NULL AND (char_length(p_name) = 0 OR char_length(p_name) > 255
    OR p_name <> btrim(p_name) OR p_name ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project name must be trimmed non-empty text';
  END IF;
  IF p_description_provided AND p_description IS NOT NULL
    AND (char_length(p_description) > 4000 OR p_description <> btrim(p_description) OR p_description ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project description is invalid';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active', 'suspended', 'archived') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project status is invalid';
  END IF;
  IF p_name IS NULL AND NOT p_description_provided AND p_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'at least one project field is required';
  END IF;

  PERFORM odf.administration_require_project_manager(v_tenant_id, p_project_id, v_actor);
  SELECT project.* INTO v_project
  FROM odf.projects AS project
  WHERE project.tenant_id = v_tenant_id AND project.project_id = p_project_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'project was not found';
  END IF;

  v_next_name := COALESCE(p_name, v_project.name);
  v_next_description := CASE
    WHEN p_description_provided THEN NULLIF(btrim(p_description), '')
    ELSE v_project.description
  END;
  v_next_status := COALESCE(p_status, v_project.status);
  IF v_project.name = v_next_name
    AND v_project.description IS NOT DISTINCT FROM v_next_description
    AND v_project.status = v_next_status THEN
    RETURN QUERY SELECT
      v_project.project_id, v_project.tenant_id, v_project.slug, v_project.name,
      v_project.description, v_project.status, v_project.created_at, v_project.updated_at, false;
    RETURN;
  END IF;

  UPDATE odf.projects AS project
  SET name = v_next_name,
      description = v_next_description,
      status = v_next_status,
      updated_at = now()
  WHERE project.tenant_id = v_tenant_id AND project.project_id = p_project_id
  RETURNING project.* INTO v_project;
  PERFORM odf.append_project_administration_event(
    v_tenant_id,
    p_project_id,
    v_actor,
    'platform.project_updated',
    'project',
    p_project_id::text,
    jsonb_build_object('name', v_project.name, 'description', v_project.description, 'status', v_project.status),
    p_correlation_id
  );
  RETURN QUERY SELECT
    v_project.project_id, v_project.tenant_id, v_project.slug, v_project.name,
    v_project.description, v_project.status, v_project.created_at, v_project.updated_at, true;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_list_tenant_members(p_after text, p_limit integer)
RETURNS TABLE (
  tenant_id uuid,
  user_id text,
  role text,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_actor text;
BEGIN
  SELECT context.tenant_id, context.user_id
  INTO v_tenant_id, v_actor
  FROM odf.administration_context(false) AS context;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 201 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'administration list limit must be between 1 and 201';
  END IF;
  PERFORM odf.administration_require_tenant_manager(v_tenant_id, v_actor);
  RETURN QUERY
  SELECT member.tenant_id, member.user_id, member.role, member.created_by, member.created_at, member.updated_at
  FROM odf.tenant_members AS member
  WHERE member.tenant_id = v_tenant_id
    AND (p_after IS NULL OR member.user_id > p_after)
  ORDER BY member.user_id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_upsert_tenant_member(
  p_member_user_id text,
  p_role text,
  p_correlation_id uuid
)
RETURNS TABLE (
  tenant_id uuid,
  user_id text,
  role text,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz,
  created boolean,
  changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_actor text;
  v_existing odf.tenant_members%ROWTYPE;
  v_created boolean := false;
  v_changed boolean := false;
  v_action text;
BEGIN
  SELECT context.tenant_id, context.user_id
  INTO v_tenant_id, v_actor
  FROM odf.administration_context(false) AS context;
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correlation ID is required';
  END IF;
  PERFORM odf.administration_validate_user_id(p_member_user_id);
  IF p_role NOT IN ('owner', 'admin', 'viewer') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'tenant member role is invalid';
  END IF;
  PERFORM odf.administration_require_tenant_owner(v_tenant_id, v_actor);
  SELECT member.* INTO v_existing
  FROM odf.tenant_members AS member
  WHERE member.tenant_id = v_tenant_id AND member.user_id = p_member_user_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.role IS DISTINCT FROM p_role THEN
      UPDATE odf.tenant_members AS member
      SET role = p_role, updated_at = now()
      WHERE member.tenant_id = v_tenant_id AND member.user_id = p_member_user_id
      RETURNING member.* INTO v_existing;
      v_changed := true;
      v_action := 'platform.tenant_member_updated';
    END IF;
  ELSE
    INSERT INTO odf.tenant_members (tenant_id, user_id, role, created_by)
    VALUES (v_tenant_id, p_member_user_id, p_role, v_actor)
    RETURNING * INTO v_existing;
    v_created := true;
    v_changed := true;
    v_action := 'platform.tenant_member_added';
  END IF;
  IF v_changed THEN
    PERFORM odf.append_tenant_administration_event(
      v_tenant_id,
      v_actor,
      v_action,
      'tenantMember',
      p_member_user_id,
      jsonb_build_object('role', v_existing.role, 'created', v_created),
      p_correlation_id
    );
  END IF;
  RETURN QUERY SELECT
    v_existing.tenant_id, v_existing.user_id, v_existing.role, v_existing.created_by,
    v_existing.created_at, v_existing.updated_at, v_created, v_changed;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_remove_tenant_member(
  p_member_user_id text,
  p_correlation_id uuid
)
RETURNS TABLE (removed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_actor text;
  v_removed odf.tenant_members%ROWTYPE;
BEGIN
  SELECT context.tenant_id, context.user_id
  INTO v_tenant_id, v_actor
  FROM odf.administration_context(false) AS context;
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correlation ID is required';
  END IF;
  PERFORM odf.administration_validate_user_id(p_member_user_id);
  PERFORM odf.administration_require_tenant_owner(v_tenant_id, v_actor);
  DELETE FROM odf.tenant_members AS member
  WHERE member.tenant_id = v_tenant_id AND member.user_id = p_member_user_id
  RETURNING member.* INTO v_removed;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  PERFORM odf.append_tenant_administration_event(
    v_tenant_id,
    v_actor,
    'platform.tenant_member_removed',
    'tenantMember',
    p_member_user_id,
    jsonb_build_object('removedRole', v_removed.role),
    p_correlation_id
  );
  RETURN QUERY SELECT true;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_list_project_members(p_after text, p_limit integer)
RETURNS TABLE (
  tenant_id uuid,
  project_id uuid,
  user_id text,
  role text,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_project_id uuid;
  v_actor text;
BEGIN
  SELECT context.tenant_id, context.project_id, context.user_id
  INTO v_tenant_id, v_project_id, v_actor
  FROM odf.administration_context(true) AS context;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 201 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'administration list limit must be between 1 and 201';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM odf.projects AS project
    WHERE project.tenant_id = v_tenant_id AND project.project_id = v_project_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'project was not found';
  END IF;
  PERFORM odf.administration_require_project_member(v_tenant_id, v_project_id, v_actor);
  RETURN QUERY
  SELECT member.tenant_id, member.project_id, member.user_id, member.role,
    member.created_by, member.created_at, member.updated_at
  FROM odf.project_members AS member
  WHERE member.tenant_id = v_tenant_id
    AND member.project_id = v_project_id
    AND (p_after IS NULL OR member.user_id > p_after)
  ORDER BY member.user_id
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_upsert_project_member(
  p_member_user_id text,
  p_role text,
  p_correlation_id uuid
)
RETURNS TABLE (
  tenant_id uuid,
  project_id uuid,
  user_id text,
  role text,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz,
  created boolean,
  changed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_project_id uuid;
  v_actor text;
  v_existing odf.project_members%ROWTYPE;
  v_created boolean := false;
  v_changed boolean := false;
  v_action text;
BEGIN
  SELECT context.tenant_id, context.project_id, context.user_id
  INTO v_tenant_id, v_project_id, v_actor
  FROM odf.administration_context(true) AS context;
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correlation ID is required';
  END IF;
  PERFORM odf.administration_validate_user_id(p_member_user_id);
  IF p_role NOT IN ('owner', 'editor', 'reviewer', 'viewer') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'project member role is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM odf.projects AS project
    WHERE project.tenant_id = v_tenant_id AND project.project_id = v_project_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'project was not found';
  END IF;
  PERFORM odf.administration_require_project_manager(v_tenant_id, v_project_id, v_actor);
  SELECT member.* INTO v_existing
  FROM odf.project_members AS member
  WHERE member.tenant_id = v_tenant_id
    AND member.project_id = v_project_id
    AND member.user_id = p_member_user_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.role IS DISTINCT FROM p_role THEN
      UPDATE odf.project_members AS member
      SET role = p_role, updated_at = now()
      WHERE member.tenant_id = v_tenant_id
        AND member.project_id = v_project_id
        AND member.user_id = p_member_user_id
      RETURNING member.* INTO v_existing;
      v_changed := true;
      v_action := 'platform.project_member_updated';
    END IF;
  ELSE
    INSERT INTO odf.project_members (tenant_id, project_id, user_id, role, created_by)
    VALUES (v_tenant_id, v_project_id, p_member_user_id, p_role, v_actor)
    RETURNING * INTO v_existing;
    v_created := true;
    v_changed := true;
    v_action := 'platform.project_member_added';
  END IF;
  IF v_changed THEN
    PERFORM odf.append_project_administration_event(
      v_tenant_id,
      v_project_id,
      v_actor,
      v_action,
      'projectMember',
      p_member_user_id,
      jsonb_build_object('role', v_existing.role, 'created', v_created),
      p_correlation_id
    );
  END IF;
  RETURN QUERY SELECT
    v_existing.tenant_id, v_existing.project_id, v_existing.user_id, v_existing.role,
    v_existing.created_by, v_existing.created_at, v_existing.updated_at, v_created, v_changed;
END;
$$;

CREATE OR REPLACE FUNCTION odf.admin_remove_project_member(
  p_member_user_id text,
  p_correlation_id uuid
)
RETURNS TABLE (removed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_project_id uuid;
  v_actor text;
  v_removed odf.project_members%ROWTYPE;
BEGIN
  SELECT context.tenant_id, context.project_id, context.user_id
  INTO v_tenant_id, v_project_id, v_actor
  FROM odf.administration_context(true) AS context;
  IF p_correlation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'correlation ID is required';
  END IF;
  PERFORM odf.administration_validate_user_id(p_member_user_id);
  PERFORM odf.administration_require_project_manager(v_tenant_id, v_project_id, v_actor);
  DELETE FROM odf.project_members AS member
  WHERE member.tenant_id = v_tenant_id
    AND member.project_id = v_project_id
    AND member.user_id = p_member_user_id
  RETURNING member.* INTO v_removed;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;
  PERFORM odf.append_project_administration_event(
    v_tenant_id,
    v_project_id,
    v_actor,
    'platform.project_member_removed',
    'projectMember',
    p_member_user_id,
    jsonb_build_object('removedRole', v_removed.role),
    p_correlation_id
  );
  RETURN QUERY SELECT true;
END;
$$;

-- Keep all helper and user-facing routines owned by the isolated role. The
-- only externally callable functions are explicitly granted to odf_app.
ALTER FUNCTION odf.administration_context(boolean) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.administration_validate_user_id(text) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.administration_require_tenant_owner(uuid, text) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.administration_require_tenant_manager(uuid, text) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.administration_require_project_member(uuid, uuid, text) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.administration_require_project_manager(uuid, uuid, text) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.append_tenant_administration_event(uuid, text, text, text, text, jsonb, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.append_project_administration_event(uuid, uuid, text, text, text, text, jsonb, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_update_tenant(text, text, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_create_project(uuid, text, text, text, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_update_project(uuid, text, text, boolean, text, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_list_tenant_members(text, integer) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_upsert_tenant_member(text, text, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_remove_tenant_member(text, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_list_project_members(text, integer) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_upsert_project_member(text, text, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.admin_remove_project_member(text, uuid) OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.protect_last_tenant_owner() OWNER TO odf_tenant_project_admin_owner;
ALTER FUNCTION odf.protect_last_project_owner() OWNER TO odf_tenant_project_admin_owner;

REVOKE ALL PRIVILEGES ON FUNCTION odf.administration_context(boolean) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.administration_validate_user_id(text) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.administration_require_tenant_owner(uuid, text) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.administration_require_tenant_manager(uuid, text) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.administration_require_project_member(uuid, uuid, text) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.administration_require_project_manager(uuid, uuid, text) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.append_tenant_administration_event(uuid, text, text, text, text, jsonb, uuid) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.append_project_administration_event(uuid, uuid, text, text, text, text, jsonb, uuid) FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.protect_last_tenant_owner() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION odf.protect_last_project_owner() FROM PUBLIC;

REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_update_tenant(text, text, uuid)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_create_project(uuid, text, text, text, uuid)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_update_project(uuid, text, text, boolean, text, uuid)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_list_tenant_members(text, integer)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_upsert_tenant_member(text, text, uuid)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_remove_tenant_member(text, uuid)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_list_project_members(text, integer)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_upsert_project_member(text, text, uuid)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.admin_remove_project_member(text, uuid)
  FROM PUBLIC, odf_readonly, odf_outbox_publisher, odf_cutover, odf_tenant_provisioner;

GRANT EXECUTE ON FUNCTION odf.admin_create_project(uuid, text, text, text, uuid) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_update_tenant(text, text, uuid) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_update_project(uuid, text, text, boolean, text, uuid) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_list_tenant_members(text, integer) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_upsert_tenant_member(text, text, uuid) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_remove_tenant_member(text, uuid) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_list_project_members(text, integer) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_upsert_project_member(text, text, uuid) TO odf_app;
GRANT EXECUTE ON FUNCTION odf.admin_remove_project_member(text, uuid) TO odf_app;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('012_tenant_project_administration', 'governed tenant/project and membership administration through isolated PostgreSQL routines')
ON CONFLICT (version) DO NOTHING;

COMMIT;
