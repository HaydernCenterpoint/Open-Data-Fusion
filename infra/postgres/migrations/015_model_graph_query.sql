BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

ALTER TABLE odf.graph_instances
  ADD COLUMN IF NOT EXISTS model_view_id uuid,
  ADD COLUMN IF NOT EXISTS source_instance_id uuid,
  ADD COLUMN IF NOT EXISTS target_instance_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'graph_instances_model_view_fk') THEN
    ALTER TABLE odf.graph_instances
      ADD CONSTRAINT graph_instances_model_view_fk
      FOREIGN KEY (tenant_id, model_view_id)
      REFERENCES odf.model_views(tenant_id, model_view_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'graph_instances_source_same_project_fk') THEN
    ALTER TABLE odf.graph_instances
      ADD CONSTRAINT graph_instances_source_same_project_fk
      FOREIGN KEY (tenant_id, project_id, source_instance_id)
      REFERENCES odf.graph_instances(tenant_id, project_id, instance_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'graph_instances_target_same_project_fk') THEN
    ALTER TABLE odf.graph_instances
      ADD CONSTRAINT graph_instances_target_same_project_fk
      FOREIGN KEY (tenant_id, project_id, target_instance_id)
      REFERENCES odf.graph_instances(tenant_id, project_id, instance_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS odf.model_graph_batch_keys (
  batch_key_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  data_model_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 255),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, data_model_id)
    REFERENCES odf.data_models(tenant_id, project_id, data_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, project_id, data_model_id, idempotency_key),
  CHECK (octet_length(summary::text) <= 8192),
  CHECK (NOT (summary ? 'properties'))
);

CREATE OR REPLACE FUNCTION odf.enforce_data_model_publication()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'odf.data_models is immutable';
  END IF;

  IF OLD.state = 'draft' AND NEW.state = 'published' THEN
    IF (to_jsonb(OLD) - ARRAY['state', 'published_at'])
      IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['state', 'published_at']) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'publishing may only change model state and published_at',
        CONSTRAINT = 'data_model_publication_immutable_fields';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM odf.model_views
      WHERE tenant_id = OLD.tenant_id AND data_model_id = OLD.data_model_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'a data model requires at least one view before publication',
        CONSTRAINT = 'data_model_publication_requires_view';
    END IF;
    NEW.published_at := now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'published data model versions are immutable',
    CONSTRAINT = 'data_model_publication_transition';
END;
$$;

DROP TRIGGER IF EXISTS data_models_append_only ON odf.data_models;
DROP TRIGGER IF EXISTS data_models_publish_only ON odf.data_models;
CREATE TRIGGER data_models_publish_only
  BEFORE UPDATE OR DELETE ON odf.data_models
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_data_model_publication();

CREATE OR REPLACE FUNCTION odf.validate_model_graph_instance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
DECLARE
  bound_view odf.model_views%ROWTYPE;
  source_kind text;
  target_kind text;
BEGIN
  IF NEW.model_view_id IS NULL THEN
    IF NEW.source_instance_id IS NOT NULL OR NEW.target_instance_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'model graph endpoints require a bound model view',
        CONSTRAINT = 'model_graph_instance_view_model';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.data_model_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'a bound model view requires a data model',
      CONSTRAINT = 'model_graph_instance_view_model';
  END IF;

  SELECT * INTO bound_view
  FROM odf.model_views
  WHERE tenant_id = NEW.tenant_id
    AND model_view_id = NEW.model_view_id
    AND data_model_id = NEW.data_model_id;
  IF NOT FOUND OR bound_view.definition->>'usedFor' IS DISTINCT FROM NEW.instance_kind THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'the bound view must belong to the model and match the instance kind',
      CONSTRAINT = 'model_graph_instance_view_model';
  END IF;

  IF NEW.instance_kind = 'node' THEN
    IF NEW.source_instance_id IS NOT NULL OR NEW.target_instance_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'model graph nodes cannot define endpoints',
        CONSTRAINT = 'model_graph_node_endpoints';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_instance_id IS NULL OR NEW.target_instance_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'model graph edges require source and target endpoints',
      CONSTRAINT = 'model_graph_edge_endpoints';
  END IF;

  SELECT instance_kind INTO source_kind
  FROM odf.graph_instances
  WHERE tenant_id = NEW.tenant_id
    AND project_id = NEW.project_id
    AND instance_id = NEW.source_instance_id;
  SELECT instance_kind INTO target_kind
  FROM odf.graph_instances
  WHERE tenant_id = NEW.tenant_id
    AND project_id = NEW.project_id
    AND instance_id = NEW.target_instance_id;
  IF source_kind IS DISTINCT FROM 'node' OR target_kind IS DISTINCT FROM 'node' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'model graph edge endpoints must be existing nodes in the same project',
      CONSTRAINT = 'model_graph_edge_endpoints';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS graph_instances_validate_model_graph ON odf.graph_instances;
CREATE TRIGGER graph_instances_validate_model_graph
  BEFORE INSERT OR UPDATE ON odf.graph_instances
  FOR EACH ROW EXECUTE FUNCTION odf.validate_model_graph_instance();

CREATE INDEX IF NOT EXISTS model_views_model_update_idx
  ON odf.model_views (tenant_id, data_model_id, external_id, version, created_at, model_view_id);
CREATE INDEX IF NOT EXISTS graph_instances_source_idx
  ON odf.graph_instances (tenant_id, project_id, source_instance_id)
  WHERE source_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS graph_instances_target_idx
  ON odf.graph_instances (tenant_id, project_id, target_instance_id)
  WHERE target_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS graph_instances_properties_gin_idx
  ON odf.graph_instances USING gin (properties jsonb_path_ops);
CREATE INDEX IF NOT EXISTS model_graph_batch_keys_created_idx
  ON odf.model_graph_batch_keys (tenant_id, project_id, data_model_id, created_at DESC, batch_key_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM odf.platform_legacy_model_versions legacy
    WHERE NOT EXISTS (
      SELECT 1 FROM odf.model_spaces model_spaces
      WHERE model_spaces.tenant_id = legacy.tenant_id
        AND model_spaces.project_id = legacy.project_id
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'legacy model version has no provisioned model space';
  END IF;
END;
$$;

INSERT INTO odf.data_models (
  tenant_id, project_id, space_id, external_id, version, name, definition,
  state, created_by, created_at, published_at
)
SELECT
  legacy.tenant_id,
  legacy.project_id,
  selected_space.space_id,
  legacy.model_id,
  legacy.version::text,
  legacy.name,
  legacy.schema_json,
  legacy.status,
  legacy.created_by,
  legacy.created_at,
  CASE WHEN legacy.status = 'published' THEN legacy.created_at ELSE NULL END
FROM odf.platform_legacy_model_versions legacy
CROSS JOIN LATERAL (
  SELECT model_spaces.space_id
  FROM odf.model_spaces model_spaces
  WHERE model_spaces.tenant_id = legacy.tenant_id
    AND model_spaces.project_id = legacy.project_id
  ORDER BY model_spaces.created_at, model_spaces.space_id
  LIMIT 1
) selected_space
ON CONFLICT (space_id, external_id, version) DO NOTHING;

ALTER TABLE odf.data_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.data_models FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.model_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.model_views FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.graph_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.graph_instances FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.model_graph_batch_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.model_graph_batch_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON odf.data_models;
DROP POLICY IF EXISTS data_models_model_graph_scope ON odf.data_models;
CREATE POLICY data_models_model_graph_scope ON odf.data_models FOR ALL TO odf_app, odf_readonly
  USING (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()))
  WITH CHECK (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()));

DROP POLICY IF EXISTS tenant_isolation ON odf.model_views;
DROP POLICY IF EXISTS model_views_model_graph_scope ON odf.model_views;
CREATE POLICY model_views_model_graph_scope ON odf.model_views FOR ALL TO odf_app, odf_readonly
  USING (
    tenant_id = (SELECT odf.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM odf.data_models
      WHERE data_models.tenant_id = model_views.tenant_id
        AND data_models.data_model_id = model_views.data_model_id
        AND data_models.project_id = (SELECT odf.current_project_id())
    )
  )
  WITH CHECK (
    tenant_id = (SELECT odf.current_tenant_id())
    AND EXISTS (
      SELECT 1 FROM odf.data_models
      WHERE data_models.tenant_id = model_views.tenant_id
        AND data_models.data_model_id = model_views.data_model_id
        AND data_models.project_id = (SELECT odf.current_project_id())
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON odf.graph_instances;
DROP POLICY IF EXISTS graph_instances_model_graph_scope ON odf.graph_instances;
CREATE POLICY graph_instances_model_graph_scope ON odf.graph_instances FOR ALL TO odf_app, odf_readonly
  USING (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()))
  WITH CHECK (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()));

DROP POLICY IF EXISTS model_graph_batch_keys_scope ON odf.model_graph_batch_keys;
CREATE POLICY model_graph_batch_keys_scope ON odf.model_graph_batch_keys FOR ALL TO odf_app, odf_readonly
  USING (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()))
  WITH CHECK (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()));

REVOKE ALL PRIVILEGES ON odf.data_models, odf.model_views, odf.graph_instances, odf.model_graph_batch_keys
  FROM odf_app, odf_readonly;
GRANT SELECT, INSERT, UPDATE ON odf.data_models, odf.graph_instances TO odf_app;
GRANT SELECT, INSERT ON odf.model_views, odf.model_graph_batch_keys TO odf_app;
GRANT SELECT ON odf.data_models, odf.model_views, odf.graph_instances, odf.model_graph_batch_keys TO odf_readonly;

CREATE OR REPLACE FUNCTION odf.sync_data_model_search_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, odf, pg_temp
SET row_security = on
AS $$
DECLARE
  source_row odf.data_models%ROWTYPE;
BEGIN
  source_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM odf.platform_search_index
    WHERE tenant_id = source_row.tenant_id
      AND project_id = source_row.project_id
      AND entity_type = 'dataModel'
      AND entity_id = source_row.external_id || '@' || source_row.version;
    RETURN OLD;
  END IF;

  INSERT INTO odf.platform_search_index (
    tenant_id, project_id, entity_type, entity_id, title, body, updated_at
  ) VALUES (
    NEW.tenant_id,
    NEW.project_id,
    'dataModel',
    NEW.external_id || '@' || NEW.version,
    NEW.name,
    NEW.external_id || ' ' || NEW.version || ' ' || NEW.state || ' ' || coalesce(NEW.description, ''),
    coalesce(NEW.published_at, NEW.created_at)
  )
  ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    updated_at = EXCLUDED.updated_at;
  RETURN NEW;
END;
$$;

ALTER FUNCTION odf.sync_data_model_search_index() OWNER TO odf_platform_search_projection_owner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.sync_data_model_search_index()
  FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover,
    odf_tenant_provisioner, odf_project_discovery_owner, odf_workspace_bootstrap_owner;

DROP TRIGGER IF EXISTS platform_search_projection ON odf.data_models;
CREATE TRIGGER platform_search_projection
  AFTER INSERT OR UPDATE OR DELETE ON odf.data_models
  FOR EACH ROW EXECUTE FUNCTION odf.sync_data_model_search_index();
DROP TRIGGER IF EXISTS platform_legacy_model_versions_search_projection ON odf.platform_legacy_model_versions;

DELETE FROM odf.platform_search_index
WHERE entity_type = 'dataModel';
INSERT INTO odf.platform_search_index (
  tenant_id, project_id, entity_type, entity_id, title, body, updated_at
)
SELECT
  tenant_id,
  project_id,
  'dataModel',
  external_id || '@' || version,
  name,
  external_id || ' ' || version || ' ' || state || ' ' || coalesce(description, ''),
  coalesce(published_at, created_at)
FROM odf.data_models
ON CONFLICT (tenant_id, project_id, entity_type, entity_id) DO UPDATE SET
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  updated_at = EXCLUDED.updated_at;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('015_model_graph_query', 'normalized model graph lifecycle, bounded query storage, and project RLS')
ON CONFLICT (version) DO NOTHING;

COMMIT;
