-- Production hardening for the dual-backend industrial API.
--
-- Audit scope becomes structural and RLS-enforced, document associations can
-- be detached by the application role, and substring asset search receives
-- indexes suitable for non-demo catalog sizes.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION odf.current_project_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('odf.project_id', true), '')::uuid
$$;

ALTER TABLE odf.audit_log
  ADD COLUMN IF NOT EXISTS tenant_id uuid,
  ADD COLUMN IF NOT EXISTS project_id uuid;

-- Only backfill rows whose referenced project actually exists. Legacy
-- workspace audit imported from SQLite remains intentionally unscoped and is
-- invisible to tenant application roles until a separate cutover maps it.
ALTER TABLE odf.audit_log DISABLE TRIGGER audit_log_append_only;
UPDATE odf.audit_log AS audit
SET tenant_id = project.tenant_id,
    project_id = project.project_id
FROM odf.projects AS project
WHERE audit.tenant_id IS NULL
  AND audit.project_id IS NULL
  AND audit.details->>'tenantId' = project.tenant_id::text
  AND audit.details->>'projectId' = project.project_id::text;
ALTER TABLE odf.audit_log ENABLE TRIGGER audit_log_append_only;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'odf.audit_log'::regclass
      AND conname = 'audit_log_project_scope_fk'
  ) THEN
    ALTER TABLE odf.audit_log
      ADD CONSTRAINT audit_log_project_scope_fk
      FOREIGN KEY (tenant_id, project_id)
      REFERENCES odf.projects(tenant_id, project_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION odf.populate_audit_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
DECLARE
  requested_tenant text;
  requested_project text;
  resolved_tenant uuid;
  resolved_project uuid;
BEGIN
  requested_tenant := NEW.details->>'tenantId';
  requested_project := NEW.details->>'projectId';

  IF NEW.tenant_id IS NULL AND NEW.project_id IS NULL
    AND requested_tenant IS NOT NULL AND requested_project IS NOT NULL THEN
    SELECT project.tenant_id, project.project_id
    INTO resolved_tenant, resolved_project
    FROM odf.projects AS project
    WHERE project.tenant_id::text = requested_tenant
      AND project.project_id::text = requested_project;
    IF FOUND THEN
      NEW.tenant_id := resolved_tenant;
      NEW.project_id := resolved_project;
    END IF;
  END IF;

  IF (NEW.tenant_id IS NULL) <> (NEW.project_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit tenant and project scope must be supplied together';
  END IF;

  IF NEW.tenant_id IS NOT NULL THEN
    NEW.details := NEW.details || jsonb_build_object(
      'tenantId', NEW.tenant_id::text,
      'projectId', NEW.project_id::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_populate_scope ON odf.audit_log;
CREATE TRIGGER audit_log_populate_scope
  BEFORE INSERT ON odf.audit_log
  FOR EACH ROW EXECUTE FUNCTION odf.populate_audit_scope();

CREATE INDEX IF NOT EXISTS audit_log_tenant_project_occurred_idx
  ON odf.audit_log (tenant_id, project_id, occurred_at DESC, id DESC)
  WHERE tenant_id IS NOT NULL AND project_id IS NOT NULL;

ALTER TABLE odf.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_app_scope ON odf.audit_log;
CREATE POLICY audit_log_app_scope ON odf.audit_log FOR ALL TO odf_app
  USING (
    tenant_id = (SELECT odf.current_tenant_id())
    AND project_id IS NOT NULL
    AND (
      (SELECT odf.current_project_id()) IS NULL
      OR project_id = (SELECT odf.current_project_id())
    )
  )
  WITH CHECK (
    tenant_id = (SELECT odf.current_tenant_id())
    AND project_id IS NOT NULL
    AND (
      (SELECT odf.current_project_id()) IS NULL
      OR project_id = (SELECT odf.current_project_id())
    )
  );

DROP POLICY IF EXISTS audit_log_readonly_scope ON odf.audit_log;
CREATE POLICY audit_log_readonly_scope ON odf.audit_log FOR SELECT TO odf_readonly
  USING (
    tenant_id = (SELECT odf.current_tenant_id())
    AND project_id IS NOT NULL
    AND (
      (SELECT odf.current_project_id()) IS NULL
      OR project_id = (SELECT odf.current_project_id())
    )
  );

-- Purpose-specific maintenance roles keep only the operations already granted
-- by migrations 004 and 007. RLS does not broaden those table privileges.
DROP POLICY IF EXISTS audit_log_cutover_read ON odf.audit_log;
DROP POLICY IF EXISTS audit_log_cutover_insert ON odf.audit_log;
CREATE POLICY audit_log_cutover_read ON odf.audit_log FOR SELECT TO odf_cutover USING (true);
CREATE POLICY audit_log_cutover_insert ON odf.audit_log FOR INSERT TO odf_cutover WITH CHECK (true);

DROP POLICY IF EXISTS audit_log_provision_owner_read ON odf.audit_log;
DROP POLICY IF EXISTS audit_log_provision_owner_insert ON odf.audit_log;
CREATE POLICY audit_log_provision_owner_read ON odf.audit_log FOR SELECT TO odf_tenant_provision_owner USING (true);
CREATE POLICY audit_log_provision_owner_insert ON odf.audit_log FOR INSERT TO odf_tenant_provision_owner WITH CHECK (true);

GRANT EXECUTE ON FUNCTION odf.current_project_id() TO odf_app, odf_readonly;
GRANT DELETE ON odf.document_asset_links TO odf_app;

CREATE INDEX IF NOT EXISTS graph_instances_external_id_trgm_idx
  ON odf.graph_instances USING gin (external_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS assets_name_trgm_idx
  ON odf.assets USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS assets_description_trgm_idx
  ON odf.assets USING gin ((COALESCE(description, '')) gin_trgm_ops);

INSERT INTO odf.schema_migrations (version, description)
VALUES ('008_industrial_runtime_hardening', 'structural audit scope, document detach privilege, and industrial search indexes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
