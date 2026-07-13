-- PostgreSQL persistence for advanced contextualization metadata and the
-- cross-surface platform search projection.
--
-- Core catalog, industrial, governed-object, and write-back aggregates remain
-- in their existing normalized PostgreSQL tables. This migration adds only the
-- advanced records that have no canonical data-plane equivalent, then projects
-- selected project-scoped records into a rebuildable full-text index.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

CREATE TABLE IF NOT EXISTS odf.platform_diagram_extractions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  diagram_extraction_id text NOT NULL CHECK (diagram_extraction_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  document_external_id text NOT NULL CHECK (document_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  tags jsonb NOT NULL CHECK (jsonb_typeof(tags) = 'array'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, diagram_extraction_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS platform_diagram_extractions_scope_created_idx
  ON odf.platform_diagram_extractions (tenant_id, project_id, created_at DESC, diagram_extraction_id DESC);

CREATE TABLE IF NOT EXISTS odf.platform_matching_evaluations (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  matching_evaluation_id text NOT NULL CHECK (matching_evaluation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  threshold double precision NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  prediction_count integer NOT NULL CHECK (prediction_count >= 0),
  truth_count integer NOT NULL CHECK (truth_count >= 0),
  evaluation jsonb NOT NULL CHECK (jsonb_typeof(evaluation) = 'object'),
  proposals jsonb NOT NULL CHECK (jsonb_typeof(proposals) = 'array'),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, matching_evaluation_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS platform_matching_evaluations_scope_created_idx
  ON odf.platform_matching_evaluations (tenant_id, project_id, created_at DESC, matching_evaluation_id DESC);

CREATE TABLE IF NOT EXISTS odf.platform_spatial_asset_links (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  spatial_link_id text NOT NULL CHECK (spatial_link_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  asset_external_id text NOT NULL CHECK (asset_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  scene_external_id text NOT NULL CHECK (scene_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  node_external_id text NOT NULL CHECK (node_external_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'),
  transform jsonb NOT NULL CHECK (jsonb_typeof(transform) = 'array' AND jsonb_array_length(transform) = 16),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  review_state text NOT NULL CHECK (review_state IN ('proposed', 'accepted', 'rejected')),
  reviewed_by text,
  review_comment text,
  reviewed_at timestamptz,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, spatial_link_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (review_state = 'proposed' AND reviewed_by IS NULL AND review_comment IS NULL AND reviewed_at IS NULL)
    OR (review_state IN ('accepted', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS platform_spatial_asset_links_scope_state_idx
  ON odf.platform_spatial_asset_links (tenant_id, project_id, review_state, spatial_link_id);

CREATE TABLE IF NOT EXISTS odf.platform_search_index (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) > 0),
  entity_id text NOT NULL CHECK (length(btrim(entity_id)) > 0),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(body, ''))
  ) STORED,
  PRIMARY KEY (tenant_id, project_id, entity_type, entity_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS platform_search_index_scope_key_idx
  ON odf.platform_search_index (tenant_id, project_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS platform_search_index_scope_updated_idx
  ON odf.platform_search_index (tenant_id, project_id, updated_at DESC, entity_type DESC, entity_id DESC);
CREATE INDEX IF NOT EXISTS platform_search_index_vector_idx
  ON odf.platform_search_index USING gin (search_vector);

CREATE OR REPLACE FUNCTION odf.enforce_platform_spatial_link_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.spatial_link_id <> OLD.spatial_link_id
    OR NEW.asset_external_id <> OLD.asset_external_id
    OR NEW.scene_external_id <> OLD.scene_external_id
    OR NEW.node_external_id <> OLD.node_external_id
    OR NEW.transform <> OLD.transform
    OR NEW.confidence <> OLD.confidence
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'spatial link identity and proposed evidence are immutable';
  END IF;
  IF OLD.review_state <> 'proposed' OR NEW.review_state NOT IN ('accepted', 'rejected') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'spatial link review can transition once from proposed to accepted or rejected';
  END IF;
  IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'resolved spatial links require reviewer and timestamp';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_spatial_asset_links_review_transition ON odf.platform_spatial_asset_links;
CREATE TRIGGER platform_spatial_asset_links_review_transition
  BEFORE UPDATE ON odf.platform_spatial_asset_links
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_spatial_link_transition();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'platform_diagram_extractions',
    'platform_matching_evaluations'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = format('odf.%I', table_name)::regclass
        AND tgname = table_name || '_append_only'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON odf.%I FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_history_mutation()',
        table_name || '_append_only', table_name
      );
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  member_role name;
  granted_role name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_platform_search_projection_owner') THEN
    CREATE ROLE odf_platform_search_projection_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;

  FOR member_role IN
    SELECT member.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'odf_platform_search_projection_owner'
  LOOP
    EXECUTE format('REVOKE odf_platform_search_projection_owner FROM %I', member_role);
  END LOOP;

  FOR granted_role IN
    SELECT granted.rolname
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'odf_platform_search_projection_owner'
  LOOP
    EXECUTE format('REVOKE %I FROM odf_platform_search_projection_owner', granted_role);
  END LOOP;
END;
$$;

ALTER ROLE odf_platform_search_projection_owner WITH
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
REVOKE ALL PRIVILEGES ON SCHEMA odf FROM odf_platform_search_projection_owner;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_platform_search_projection_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA odf FROM odf_platform_search_projection_owner;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_platform_search_projection_owner;
GRANT USAGE ON SCHEMA odf TO odf_platform_search_projection_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON odf.platform_search_index TO odf_platform_search_projection_owner;

CREATE OR REPLACE FUNCTION odf.sync_platform_search_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  v_tenant_id uuid;
  v_project_id uuid;
  v_entity_type text;
  v_entity_id text;
  v_title text;
  v_body text;
  v_updated_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id;
    v_project_id := OLD.project_id;
    CASE TG_TABLE_NAME
      WHEN 'assets' THEN v_entity_type := 'asset'; v_entity_id := OLD.asset_id::text;
      WHEN 'documents' THEN v_entity_type := 'document'; v_entity_id := OLD.document_id::text;
      WHEN 'datasets' THEN v_entity_type := 'dataset'; v_entity_id := OLD.dataset_id::text;
      WHEN 'source_connections' THEN v_entity_type := 'sourceConnection'; v_entity_id := OLD.source_connection_id::text;
      WHEN 'data_models' THEN v_entity_type := 'dataModel'; v_entity_id := OLD.data_model_id::text;
      WHEN 'pipelines' THEN v_entity_type := 'pipeline'; v_entity_id := OLD.pipeline_id::text;
      WHEN 'quality_rules' THEN v_entity_type := 'qualityRule'; v_entity_id := OLD.quality_rule_id::text;
      WHEN 'writeback_requests' THEN v_entity_type := 'writebackRequest'; v_entity_id := OLD.writeback_request_id::text;
      WHEN 'governed_object_versions' THEN v_entity_type := 'governedObject'; v_entity_id := OLD.object_id;
      WHEN 'platform_diagram_extractions' THEN v_entity_type := 'diagramExtraction'; v_entity_id := OLD.diagram_extraction_id;
      WHEN 'platform_matching_evaluations' THEN v_entity_type := 'matchingEvaluation'; v_entity_id := OLD.matching_evaluation_id;
      WHEN 'platform_spatial_asset_links' THEN v_entity_type := 'spatialAssetLink'; v_entity_id := OLD.spatial_link_id;
      ELSE RAISE EXCEPTION USING ERRCODE = '42883', MESSAGE = 'unsupported platform search projection trigger source';
    END CASE;
    DELETE FROM odf.platform_search_index
    WHERE tenant_id = v_tenant_id AND project_id = v_project_id
      AND entity_type = v_entity_type AND entity_id = v_entity_id;
    RETURN OLD;
  END IF;

  v_tenant_id := NEW.tenant_id;
  v_project_id := NEW.project_id;
  CASE TG_TABLE_NAME
    WHEN 'assets' THEN
      v_entity_type := 'asset'; v_entity_id := NEW.asset_id::text; v_title := NEW.name;
      v_body := coalesce(NEW.description, '') || ' ' || NEW.asset_type || ' ' || coalesce(NEW.site, ''); v_updated_at := NEW.updated_at;
    WHEN 'documents' THEN
      v_entity_type := 'document'; v_entity_id := NEW.document_id::text; v_title := NEW.title;
      v_body := coalesce(NEW.mime_type, '') || ' ' || NEW.source_system; v_updated_at := NEW.updated_at;
    WHEN 'datasets' THEN
      v_entity_type := 'dataset'; v_entity_id := NEW.dataset_id::text; v_title := NEW.name;
      v_body := NEW.external_id || ' ' || coalesce(NEW.description, '') || ' ' || NEW.classification; v_updated_at := NEW.updated_at;
    WHEN 'source_connections' THEN
      v_entity_type := 'sourceConnection'; v_entity_id := NEW.source_connection_id::text; v_title := NEW.name;
      v_body := NEW.external_id || ' ' || NEW.connector_kind || ' ' || NEW.state; v_updated_at := NEW.updated_at;
    WHEN 'data_models' THEN
      v_entity_type := 'dataModel'; v_entity_id := NEW.data_model_id::text; v_title := NEW.name;
      v_body := NEW.external_id || ' ' || NEW.version || ' ' || NEW.state || ' ' || coalesce(NEW.description, ''); v_updated_at := NEW.created_at;
    WHEN 'pipelines' THEN
      v_entity_type := 'pipeline'; v_entity_id := NEW.pipeline_id::text; v_title := NEW.name;
      v_body := NEW.external_id || ' ' || coalesce(NEW.description, ''); v_updated_at := NEW.updated_at;
    WHEN 'quality_rules' THEN
      v_entity_type := 'qualityRule'; v_entity_id := NEW.quality_rule_id::text; v_title := NEW.name;
      v_body := NEW.external_id || ' ' || NEW.rule_kind || ' ' || NEW.target_model_external_id || ' ' || NEW.severity; v_updated_at := NEW.created_at;
    WHEN 'writeback_requests' THEN
      v_entity_type := 'writebackRequest'; v_entity_id := NEW.writeback_request_id::text; v_title := NEW.operation;
      v_body := NEW.target_external_id || ' ' || NEW.risk || ' ' || NEW.state; v_updated_at := NEW.updated_at;
    WHEN 'governed_object_versions' THEN
      v_entity_type := 'governedObject'; v_entity_id := NEW.object_id; v_title := NEW.title;
      v_body := NEW.file_name || ' ' || NEW.mime_type || ' ' || coalesce(NEW.extracted_text, ''); v_updated_at := NEW.created_at;
    WHEN 'platform_diagram_extractions' THEN
      v_entity_type := 'diagramExtraction'; v_entity_id := NEW.diagram_extraction_id; v_title := NEW.document_external_id;
      v_body := NEW.tags::text; v_updated_at := NEW.created_at;
    WHEN 'platform_matching_evaluations' THEN
      v_entity_type := 'matchingEvaluation'; v_entity_id := NEW.matching_evaluation_id; v_title := 'Matching evaluation ' || NEW.matching_evaluation_id;
      v_body := NEW.evaluation::text || ' ' || NEW.proposals::text; v_updated_at := NEW.created_at;
    WHEN 'platform_spatial_asset_links' THEN
      v_entity_type := 'spatialAssetLink'; v_entity_id := NEW.spatial_link_id; v_title := NEW.asset_external_id;
      v_body := NEW.scene_external_id || ' ' || NEW.node_external_id || ' ' || NEW.review_state; v_updated_at := coalesce(NEW.reviewed_at, NEW.created_at);
    ELSE RAISE EXCEPTION USING ERRCODE = '42883', MESSAGE = 'unsupported platform search projection trigger source';
  END CASE;

  INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
  VALUES (v_tenant_id, v_project_id, v_entity_type, v_entity_id, v_title, v_body, v_updated_at)
  ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$;

ALTER FUNCTION odf.sync_platform_search_index() OWNER TO odf_platform_search_projection_owner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.sync_platform_search_index()
  FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover,
    odf_tenant_provisioner, odf_project_discovery_owner, odf_workspace_bootstrap_owner;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'assets',
    'documents',
    'datasets',
    'source_connections',
    'data_models',
    'pipelines',
    'quality_rules',
    'writeback_requests',
    'governed_object_versions',
    'platform_diagram_extractions',
    'platform_matching_evaluations',
    'platform_spatial_asset_links'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS platform_search_projection ON odf.%I', table_name);
    EXECUTE format(
      'CREATE TRIGGER platform_search_projection AFTER INSERT OR UPDATE OR DELETE ON odf.%I FOR EACH ROW EXECUTE FUNCTION odf.sync_platform_search_index()',
      table_name
    );
  END LOOP;
END;
$$;

-- Backfill the existing cross-surface records before PostgreSQL API reads use
-- the projection. Later writes are maintained by the narrowly-owned trigger.
INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'asset', asset_id::text, name,
  coalesce(description, '') || ' ' || asset_type || ' ' || coalesce(site, ''), updated_at
FROM odf.assets
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'document', document_id::text, title,
  coalesce(mime_type, '') || ' ' || source_system, updated_at
FROM odf.documents
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'dataset', dataset_id::text, name,
  external_id || ' ' || coalesce(description, '') || ' ' || classification, updated_at
FROM odf.datasets
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'sourceConnection', source_connection_id::text, name,
  external_id || ' ' || connector_kind || ' ' || state, updated_at
FROM odf.source_connections
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'dataModel', data_model_id::text, name,
  external_id || ' ' || version || ' ' || state || ' ' || coalesce(description, ''), created_at
FROM odf.data_models
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'pipeline', pipeline_id::text, name,
  external_id || ' ' || coalesce(description, ''), updated_at
FROM odf.pipelines
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'qualityRule', quality_rule_id::text, name,
  external_id || ' ' || rule_kind || ' ' || target_model_external_id || ' ' || severity, created_at
FROM odf.quality_rules
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT tenant_id, project_id, 'writebackRequest', writeback_request_id::text, operation,
  target_external_id || ' ' || risk || ' ' || state, updated_at
FROM odf.writeback_requests
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

INSERT INTO odf.platform_search_index (tenant_id, project_id, entity_type, entity_id, title, body, updated_at)
SELECT version.tenant_id, version.project_id, 'governedObject', version.object_id, version.title,
  version.file_name || ' ' || version.mime_type || ' ' || coalesce(version.extracted_text, ''), version.created_at
FROM odf.governed_object_versions AS version
JOIN odf.governed_objects AS object
  ON object.tenant_id = version.tenant_id AND object.project_id = version.project_id
 AND object.object_id = version.object_id AND object.current_version = version.version
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'platform_diagram_extractions',
    'platform_matching_evaluations',
    'platform_spatial_asset_links',
    'platform_search_index'
  ] LOOP
    EXECUTE format('ALTER TABLE odf.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE odf.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS platform_advanced_app_scope ON odf.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS platform_advanced_readonly_scope ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY platform_advanced_app_scope ON odf.%I FOR ALL TO odf_app '
      || 'USING (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id())) '
      || 'WITH CHECK (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY platform_advanced_readonly_scope ON odf.%I FOR SELECT TO odf_readonly '
      || 'USING (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()))',
      table_name
    );
  END LOOP;
END;
$$;

DROP POLICY IF EXISTS platform_search_projection_owner_scope ON odf.platform_search_index;
CREATE POLICY platform_search_projection_owner_scope ON odf.platform_search_index
  FOR ALL TO odf_platform_search_projection_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON
  odf.platform_diagram_extractions,
  odf.platform_matching_evaluations
TO odf_app;
GRANT SELECT, INSERT, UPDATE ON odf.platform_spatial_asset_links TO odf_app;
GRANT SELECT ON odf.platform_search_index TO odf_app;
GRANT SELECT ON
  odf.platform_diagram_extractions,
  odf.platform_matching_evaluations,
  odf.platform_spatial_asset_links,
  odf.platform_search_index
TO odf_readonly;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('013_platform_advanced_search', 'advanced contextualization metadata and RLS-protected cross-surface full-text search')
ON CONFLICT (version) DO NOTHING;

COMMIT;
