-- Tenant-scoped industrial data plane.
--
-- This migration establishes the PostgreSQL boundary for the production data
-- plane. It is intentionally additive: 001/002 remain immutable and this file
-- is applied only once by the migration runner. Application code must set the
-- tenant context with `SELECT odf.set_tenant_context(<tenant UUID>)` inside
-- every transaction before accessing tenant-scoped tables.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_app') THEN
    CREATE ROLE odf_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_outbox_publisher') THEN
    CREATE ROLE odf_outbox_publisher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_readonly') THEN
    CREATE ROLE odf_readonly NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA odf FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA odf FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA odf FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA odf REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA odf REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA odf REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE OR REPLACE FUNCTION odf.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = odf, pg_catalog
AS $$
DECLARE
  configured_tenant text;
BEGIN
  configured_tenant := current_setting('odf.tenant_id', true);
  IF configured_tenant IS NULL OR btrim(configured_tenant) = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'odf.tenant_id must be set with SET LOCAL before accessing tenant-scoped data';
  END IF;
  RETURN configured_tenant::uuid;
END;
$$;

CREATE OR REPLACE FUNCTION odf.set_tenant_context(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = odf, pg_catalog
AS $$
BEGIN
  PERFORM set_config('odf.tenant_id', p_tenant_id::text, true);
END;
$$;

CREATE TABLE IF NOT EXISTS odf.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_lower_key
  ON odf.tenants (lower(slug));

CREATE TABLE IF NOT EXISTS odf.projects (
  project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES odf.tenants(tenant_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS projects_tenant_created_idx
  ON odf.projects (tenant_id, created_at DESC, project_id);

CREATE TABLE IF NOT EXISTS odf.datasets (
  dataset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  classification text NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, dataset_id),
  UNIQUE (tenant_id, project_id, dataset_id),
  UNIQUE (project_id, external_id)
);
CREATE INDEX IF NOT EXISTS datasets_tenant_project_created_idx
  ON odf.datasets (tenant_id, project_id, created_at DESC, dataset_id);

CREATE TABLE IF NOT EXISTS odf.model_spaces (
  space_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, space_id),
  UNIQUE (tenant_id, project_id, space_id),
  UNIQUE (project_id, external_id)
);
CREATE INDEX IF NOT EXISTS model_spaces_tenant_project_idx
  ON odf.model_spaces (tenant_id, project_id, space_id);

CREATE TABLE IF NOT EXISTS odf.source_connections (
  source_connection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  connector_kind text NOT NULL CHECK (connector_kind IN ('opcua', 'jdbc', 'csv', 'http')),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'ready', 'running', 'degraded', 'disabled')),
  endpoint text,
  secret_ref text,
  connector_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(connector_config) = 'object'),
  last_successful_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, dataset_id)
    REFERENCES odf.datasets(tenant_id, project_id, dataset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, source_connection_id),
  UNIQUE (tenant_id, project_id, source_connection_id),
  UNIQUE (project_id, external_id)
);
CREATE INDEX IF NOT EXISTS source_connections_tenant_project_state_idx
  ON odf.source_connections (tenant_id, project_id, state, source_connection_id);

CREATE TABLE IF NOT EXISTS odf.raw_ingest_objects (
  raw_object_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid,
  source_connection_id uuid NOT NULL,
  storage_uri text NOT NULL CHECK (length(btrim(storage_uri)) > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_type text,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz,
  encryption_key_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, dataset_id)
    REFERENCES odf.datasets(tenant_id, project_id, dataset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, source_connection_id)
    REFERENCES odf.source_connections(tenant_id, project_id, source_connection_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, raw_object_id),
  UNIQUE (tenant_id, project_id, raw_object_id),
  UNIQUE (tenant_id, source_connection_id, content_sha256)
);
CREATE INDEX IF NOT EXISTS raw_ingest_objects_tenant_project_received_idx
  ON odf.raw_ingest_objects (tenant_id, project_id, received_at DESC, raw_object_id);

CREATE TABLE IF NOT EXISTS odf.ingestion_runs (
  ingestion_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid,
  source_connection_id uuid NOT NULL,
  raw_object_id uuid,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'quarantined')),
  checkpoint_before jsonb CHECK (checkpoint_before IS NULL OR jsonb_typeof(checkpoint_before) = 'object'),
  checkpoint_after jsonb CHECK (checkpoint_after IS NULL OR jsonb_typeof(checkpoint_after) = 'object'),
  accepted_records bigint NOT NULL DEFAULT 0 CHECK (accepted_records >= 0),
  rejected_records bigint NOT NULL DEFAULT 0 CHECK (rejected_records >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_code text,
  error_summary text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, dataset_id)
    REFERENCES odf.datasets(tenant_id, project_id, dataset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, source_connection_id)
    REFERENCES odf.source_connections(tenant_id, project_id, source_connection_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, raw_object_id)
    REFERENCES odf.raw_ingest_objects(tenant_id, project_id, raw_object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, ingestion_run_id),
  UNIQUE (tenant_id, project_id, ingestion_run_id),
  UNIQUE (tenant_id, source_connection_id, idempotency_key),
  CHECK (
    (state IN ('succeeded', 'partially_succeeded', 'failed', 'quarantined') AND completed_at IS NOT NULL)
    OR (state IN ('queued', 'running') AND completed_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS ingestion_runs_tenant_project_started_idx
  ON odf.ingestion_runs (tenant_id, project_id, started_at DESC, ingestion_run_id);
CREATE INDEX IF NOT EXISTS ingestion_runs_active_queue_idx
  ON odf.ingestion_runs (tenant_id, state, started_at, ingestion_run_id)
  WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS odf.ingestion_run_events (
  ingestion_run_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ingestion_run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'quarantined')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  FOREIGN KEY (tenant_id, ingestion_run_id)
    REFERENCES odf.ingestion_runs(tenant_id, ingestion_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ingestion_run_events_tenant_run_occurred_idx
  ON odf.ingestion_run_events (tenant_id, ingestion_run_id, occurred_at DESC, ingestion_run_event_id);

CREATE TABLE IF NOT EXISTS odf.source_checkpoints (
  source_checkpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_connection_id uuid NOT NULL,
  checkpoint_key text NOT NULL CHECK (length(btrim(checkpoint_key)) > 0),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  ingestion_run_id uuid,
  FOREIGN KEY (tenant_id, source_connection_id)
    REFERENCES odf.source_connections(tenant_id, source_connection_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, ingestion_run_id)
    REFERENCES odf.ingestion_runs(tenant_id, ingestion_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, source_connection_id, checkpoint_key, sequence)
);
CREATE INDEX IF NOT EXISTS source_checkpoints_latest_idx
  ON odf.source_checkpoints (tenant_id, source_connection_id, checkpoint_key, sequence DESC);

CREATE TABLE IF NOT EXISTS odf.quarantined_records (
  quarantine_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  ingestion_run_id uuid NOT NULL,
  raw_object_id uuid NOT NULL,
  record_key text NOT NULL CHECK (length(btrim(record_key)) > 0),
  reason_code text NOT NULL CHECK (length(btrim(reason_code)) > 0),
  reason_summary text NOT NULL CHECK (length(btrim(reason_summary)) > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'reprocessing', 'resolved', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, ingestion_run_id)
    REFERENCES odf.ingestion_runs(tenant_id, project_id, ingestion_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, raw_object_id)
    REFERENCES odf.raw_ingest_objects(tenant_id, project_id, raw_object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, quarantine_id),
  UNIQUE (tenant_id, ingestion_run_id, record_key),
  CHECK (
    (state IN ('resolved', 'discarded') AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    OR (state IN ('open', 'reprocessing') AND resolved_at IS NULL AND resolved_by IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS quarantined_records_open_idx
  ON odf.quarantined_records (tenant_id, project_id, created_at, quarantine_id)
  WHERE state IN ('open', 'reprocessing');

CREATE TABLE IF NOT EXISTS odf.quarantine_events (
  quarantine_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  quarantine_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'reprocessing', 'resolved', 'discarded')),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, quarantine_id)
    REFERENCES odf.quarantined_records(tenant_id, quarantine_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS quarantine_events_tenant_case_occurred_idx
  ON odf.quarantine_events (tenant_id, quarantine_id, occurred_at DESC, quarantine_event_id);

CREATE TABLE IF NOT EXISTS odf.data_models (
  data_model_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  space_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  version text NOT NULL CHECK (length(btrim(version)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'deprecated')),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, space_id)
    REFERENCES odf.model_spaces(tenant_id, project_id, space_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, data_model_id),
  UNIQUE (tenant_id, project_id, data_model_id),
  UNIQUE (space_id, external_id, version),
  CHECK (
    (state = 'draft' AND published_at IS NULL)
    OR (state IN ('published', 'deprecated') AND published_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS data_models_tenant_project_state_idx
  ON odf.data_models (tenant_id, project_id, state, created_at DESC, data_model_id);

CREATE TABLE IF NOT EXISTS odf.model_views (
  model_view_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  data_model_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  version text NOT NULL CHECK (length(btrim(version)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, data_model_id)
    REFERENCES odf.data_models(tenant_id, data_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, model_view_id),
  UNIQUE (data_model_id, external_id, version)
);
CREATE INDEX IF NOT EXISTS model_views_tenant_model_idx
  ON odf.model_views (tenant_id, data_model_id, model_view_id);

CREATE TABLE IF NOT EXISTS odf.graph_instances (
  instance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid,
  space_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  instance_kind text NOT NULL CHECK (instance_kind IN ('node', 'edge')),
  data_model_id uuid,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(properties) = 'object'),
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, dataset_id)
    REFERENCES odf.datasets(tenant_id, project_id, dataset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, space_id)
    REFERENCES odf.model_spaces(tenant_id, project_id, space_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, data_model_id)
    REFERENCES odf.data_models(tenant_id, project_id, data_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, instance_id),
  UNIQUE (tenant_id, project_id, instance_id),
  UNIQUE (project_id, space_id, external_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS graph_instances_tenant_project_updated_idx
  ON odf.graph_instances (tenant_id, project_id, updated_at DESC, instance_id);
CREATE INDEX IF NOT EXISTS graph_instances_tenant_space_kind_idx
  ON odf.graph_instances (tenant_id, space_id, instance_kind, instance_id);

CREATE TABLE IF NOT EXISTS odf.assets (
  asset_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  parent_asset_id uuid,
  asset_kind text NOT NULL CHECK (asset_kind IN ('site', 'system', 'equipment', 'instrument', 'location')),
  asset_type text NOT NULL CHECK (length(btrim(asset_type)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  site text,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, asset_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, parent_asset_id)
    REFERENCES odf.assets(tenant_id, project_id, asset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, asset_id),
  UNIQUE (tenant_id, project_id, asset_id),
  CHECK (parent_asset_id IS NULL OR parent_asset_id <> asset_id)
);
CREATE INDEX IF NOT EXISTS assets_tenant_project_parent_idx
  ON odf.assets (tenant_id, project_id, parent_asset_id, asset_id);
CREATE INDEX IF NOT EXISTS assets_tenant_project_updated_idx
  ON odf.assets (tenant_id, project_id, updated_at DESC, asset_id);

CREATE TABLE IF NOT EXISTS odf.time_series (
  time_series_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid,
  asset_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  unit text,
  value_type text NOT NULL DEFAULT 'numeric' CHECK (value_type IN ('numeric', 'string', 'state')),
  interpolation text NOT NULL DEFAULT 'linear' CHECK (interpolation IN ('linear', 'step', 'none')),
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, time_series_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, dataset_id)
    REFERENCES odf.datasets(tenant_id, project_id, dataset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, asset_id)
    REFERENCES odf.assets(tenant_id, project_id, asset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, time_series_id),
  UNIQUE (tenant_id, project_id, time_series_id)
);
CREATE INDEX IF NOT EXISTS time_series_tenant_project_asset_idx
  ON odf.time_series (tenant_id, project_id, asset_id, time_series_id);

CREATE TABLE IF NOT EXISTS odf.time_series_points (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  time_series_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  numeric_value double precision,
  text_value text,
  quality text NOT NULL DEFAULT 'good' CHECK (quality IN ('good', 'uncertain', 'bad', 'unknown')),
  source_connection_id uuid,
  ingestion_run_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (time_series_id, observed_at, sequence),
  FOREIGN KEY (tenant_id, project_id, time_series_id)
    REFERENCES odf.time_series(tenant_id, project_id, time_series_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, source_connection_id)
    REFERENCES odf.source_connections(tenant_id, project_id, source_connection_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, ingestion_run_id)
    REFERENCES odf.ingestion_runs(tenant_id, project_id, ingestion_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (((numeric_value IS NOT NULL)::integer + (text_value IS NOT NULL)::integer) = 1)
);
CREATE INDEX IF NOT EXISTS time_series_points_tenant_series_observed_idx
  ON odf.time_series_points (tenant_id, project_id, time_series_id, observed_at DESC, sequence DESC);

CREATE TABLE IF NOT EXISTS odf.documents (
  document_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid,
  raw_object_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  mime_type text,
  storage_uri text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, document_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, dataset_id)
    REFERENCES odf.datasets(tenant_id, project_id, dataset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, raw_object_id)
    REFERENCES odf.raw_ingest_objects(tenant_id, project_id, raw_object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, document_id),
  UNIQUE (tenant_id, project_id, document_id)
);
CREATE INDEX IF NOT EXISTS documents_tenant_project_updated_idx
  ON odf.documents (tenant_id, project_id, updated_at DESC, document_id);

CREATE TABLE IF NOT EXISTS odf.document_asset_links (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  relation_type text NOT NULL DEFAULT 'documents' CHECK (length(btrim(relation_type)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, asset_id, relation_type),
  FOREIGN KEY (tenant_id, project_id, document_id)
    REFERENCES odf.documents(tenant_id, project_id, document_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, asset_id)
    REFERENCES odf.assets(tenant_id, project_id, asset_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS document_asset_links_tenant_asset_idx
  ON odf.document_asset_links (tenant_id, project_id, asset_id, document_id);

CREATE TABLE IF NOT EXISTS odf.relations (
  relation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  dataset_id uuid,
  source_instance_id uuid NOT NULL,
  target_instance_id uuid NOT NULL,
  relation_type text NOT NULL CHECK (length(btrim(relation_type)) > 0),
  state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'superseded')),
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, dataset_id)
    REFERENCES odf.datasets(tenant_id, project_id, dataset_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, source_instance_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, target_instance_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, relation_id),
  UNIQUE (tenant_id, project_id, relation_id),
  UNIQUE (project_id, source_instance_id, target_instance_id, relation_type),
  CHECK (source_instance_id <> target_instance_id),
  CHECK (
    (state = 'accepted' AND superseded_at IS NULL)
    OR (state = 'superseded' AND superseded_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS relations_tenant_source_idx
  ON odf.relations (tenant_id, source_instance_id, created_at DESC, relation_id);
CREATE INDEX IF NOT EXISTS relations_tenant_target_idx
  ON odf.relations (tenant_id, target_instance_id, created_at DESC, relation_id);

CREATE TABLE IF NOT EXISTS odf.relation_candidates (
  relation_candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_instance_id uuid NOT NULL,
  target_instance_id uuid NOT NULL,
  relation_type text NOT NULL CHECK (length(btrim(relation_type)) > 0),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  rule_version text,
  model_version text,
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'accepted', 'rejected', 'superseded')),
  reviewer text,
  reviewed_at timestamptz,
  review_comment text,
  accepted_relation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, source_instance_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, target_instance_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, accepted_relation_id)
    REFERENCES odf.relations(tenant_id, project_id, relation_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, relation_candidate_id),
  UNIQUE (tenant_id, project_id, relation_candidate_id),
  CHECK (
    (state = 'proposed' AND reviewed_at IS NULL AND reviewer IS NULL AND accepted_relation_id IS NULL)
    OR (state IN ('accepted', 'rejected') AND reviewed_at IS NOT NULL AND reviewer IS NOT NULL)
    OR state = 'superseded'
  ),
  CHECK ((state = 'accepted') = (accepted_relation_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS relation_candidates_review_queue_idx
  ON odf.relation_candidates (tenant_id, project_id, confidence DESC, relation_candidate_id)
  WHERE state = 'proposed';
CREATE INDEX IF NOT EXISTS relation_candidates_source_target_idx
  ON odf.relation_candidates (tenant_id, source_instance_id, target_instance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS odf.provenance_records (
  provenance_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  raw_object_id uuid,
  ingestion_run_id uuid,
  data_model_id uuid,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  source_record_id text,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  transaction_time timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, instance_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, raw_object_id)
    REFERENCES odf.raw_ingest_objects(tenant_id, project_id, raw_object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, ingestion_run_id)
    REFERENCES odf.ingestion_runs(tenant_id, project_id, ingestion_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, data_model_id)
    REFERENCES odf.data_models(tenant_id, project_id, data_model_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS provenance_records_tenant_instance_time_idx
  ON odf.provenance_records (tenant_id, instance_id, transaction_time DESC, provenance_id);
CREATE INDEX IF NOT EXISTS provenance_records_tenant_run_idx
  ON odf.provenance_records (tenant_id, ingestion_run_id, provenance_id);

CREATE TABLE IF NOT EXISTS odf.pipelines (
  pipeline_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, pipeline_id),
  UNIQUE (tenant_id, project_id, pipeline_id),
  UNIQUE (project_id, external_id)
);
CREATE INDEX IF NOT EXISTS pipelines_tenant_project_enabled_idx
  ON odf.pipelines (tenant_id, project_id, enabled, pipeline_id);

CREATE TABLE IF NOT EXISTS odf.pipeline_versions (
  pipeline_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  schedule text,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, pipeline_id)
    REFERENCES odf.pipelines(tenant_id, project_id, pipeline_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, pipeline_version_id),
  UNIQUE (tenant_id, project_id, pipeline_version_id),
  UNIQUE (tenant_id, project_id, pipeline_id, version)
);
CREATE INDEX IF NOT EXISTS pipeline_versions_tenant_pipeline_idx
  ON odf.pipeline_versions (tenant_id, pipeline_id, version DESC);

CREATE TABLE IF NOT EXISTS odf.pipeline_runs (
  pipeline_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  pipeline_version integer NOT NULL CHECK (pipeline_version >= 1),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'schedule', 'event')),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  started_at timestamptz,
  completed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, pipeline_id)
    REFERENCES odf.pipelines(tenant_id, project_id, pipeline_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, pipeline_id, pipeline_version)
    REFERENCES odf.pipeline_versions(tenant_id, project_id, pipeline_id, version) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, pipeline_run_id),
  UNIQUE (tenant_id, project_id, pipeline_run_id),
  CHECK (
    (state IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
    OR (state IN ('queued', 'running') AND completed_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS pipeline_runs_tenant_project_started_idx
  ON odf.pipeline_runs (tenant_id, project_id, started_at DESC NULLS LAST, pipeline_run_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_active_queue_idx
  ON odf.pipeline_runs (tenant_id, state, pipeline_run_id)
  WHERE state IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS odf.pipeline_run_events (
  pipeline_run_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  pipeline_run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, pipeline_run_id)
    REFERENCES odf.pipeline_runs(tenant_id, pipeline_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS pipeline_run_events_tenant_run_occurred_idx
  ON odf.pipeline_run_events (tenant_id, pipeline_run_id, occurred_at DESC, pipeline_run_event_id);

CREATE TABLE IF NOT EXISTS odf.quality_rules (
  quality_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  rule_kind text NOT NULL CHECK (rule_kind IN ('required', 'range', 'regex', 'unique', 'reference')),
  target_model_external_id text NOT NULL CHECK (length(btrim(target_model_external_id)) > 0),
  field_name text,
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, quality_rule_id),
  UNIQUE (tenant_id, project_id, quality_rule_id),
  UNIQUE (project_id, external_id, version)
);
CREATE INDEX IF NOT EXISTS quality_rules_tenant_project_enabled_idx
  ON odf.quality_rules (tenant_id, project_id, enabled, quality_rule_id);

CREATE TABLE IF NOT EXISTS odf.quality_results (
  quality_result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  quality_rule_id uuid NOT NULL,
  pipeline_run_id uuid,
  passed boolean NOT NULL,
  checked_records bigint NOT NULL CHECK (checked_records >= 0),
  failed_records bigint NOT NULL CHECK (failed_records >= 0),
  sample_failures jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sample_failures) = 'array'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, quality_rule_id)
    REFERENCES odf.quality_rules(tenant_id, project_id, quality_rule_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, pipeline_run_id)
    REFERENCES odf.pipeline_runs(tenant_id, project_id, pipeline_run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (failed_records <= checked_records)
);
CREATE INDEX IF NOT EXISTS quality_results_tenant_rule_occurred_idx
  ON odf.quality_results (tenant_id, quality_rule_id, occurred_at DESC, quality_result_id);
CREATE INDEX IF NOT EXISTS quality_results_failures_idx
  ON odf.quality_results (tenant_id, project_id, occurred_at DESC, quality_result_id)
  WHERE passed = false;

CREATE TABLE IF NOT EXISTS odf.writeback_requests (
  writeback_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_connection_id uuid NOT NULL,
  target_instance_id uuid,
  target_external_id text NOT NULL CHECK (length(btrim(target_external_id)) > 0),
  operation text NOT NULL CHECK (length(btrim(operation)) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'pending_approval', 'approved', 'executing', 'succeeded', 'failed', 'cancelled')),
  requested_by text NOT NULL CHECK (length(btrim(requested_by)) > 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  dry_run_result jsonb CHECK (dry_run_result IS NULL OR jsonb_typeof(dry_run_result) = 'object'),
  executed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, source_connection_id)
    REFERENCES odf.source_connections(tenant_id, project_id, source_connection_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, target_instance_id)
    REFERENCES odf.graph_instances(tenant_id, project_id, instance_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, writeback_request_id),
  UNIQUE (tenant_id, project_id, writeback_request_id),
  CHECK (
    (state IN ('succeeded', 'failed') AND executed_at IS NOT NULL)
    OR (state NOT IN ('succeeded', 'failed') AND executed_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS writeback_requests_pending_idx
  ON odf.writeback_requests (tenant_id, project_id, requested_at, writeback_request_id)
  WHERE state IN ('pending_approval', 'approved');

CREATE TABLE IF NOT EXISTS odf.writeback_approvals (
  writeback_approval_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  writeback_request_id uuid NOT NULL,
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, writeback_request_id)
    REFERENCES odf.writeback_requests(tenant_id, writeback_request_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (writeback_request_id, actor)
);
CREATE INDEX IF NOT EXISTS writeback_approvals_tenant_request_idx
  ON odf.writeback_approvals (tenant_id, writeback_request_id, occurred_at DESC, writeback_approval_id);

CREATE OR REPLACE FUNCTION odf.reject_platform_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%I.%I is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_writeback_approval_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
DECLARE
  approval_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('draft', 'pending_approval') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'writeback requests must start as draft or pending approval',
        CONSTRAINT = 'writeback_request_initial_state';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.requested_by IS DISTINCT FROM NEW.requested_by THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'writeback requester is immutable',
      CONSTRAINT = 'writeback_request_requester_immutable';
  END IF;

  IF OLD.state <> 'draft' AND (
    OLD.source_connection_id IS DISTINCT FROM NEW.source_connection_id
    OR OLD.target_instance_id IS DISTINCT FROM NEW.target_instance_id
    OR OLD.target_external_id IS DISTINCT FROM NEW.target_external_id
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.payload IS DISTINCT FROM NEW.payload
    OR OLD.risk IS DISTINCT FROM NEW.risk
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'writeback target, payload, and risk are immutable after submission',
      CONSTRAINT = 'writeback_request_submitted_payload_immutable';
  END IF;

  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'terminal writeback requests are immutable',
      CONSTRAINT = 'writeback_request_terminal_immutable';
  END IF;

  IF OLD.state <> NEW.state THEN
    IF (OLD.state = 'draft' AND NEW.state NOT IN ('pending_approval', 'cancelled'))
      OR (OLD.state = 'pending_approval' AND NEW.state NOT IN ('approved', 'cancelled'))
      OR (OLD.state = 'approved' AND NEW.state NOT IN ('executing', 'cancelled'))
      OR (OLD.state = 'executing' AND NEW.state NOT IN ('succeeded', 'failed')) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('invalid writeback state transition from %s to %s', OLD.state, NEW.state),
        CONSTRAINT = 'writeback_request_state_transition';
    END IF;
  END IF;

  IF NEW.state IN ('approved', 'executing') THEN
    SELECT count(DISTINCT actor)
    INTO approval_count
    FROM odf.writeback_approvals
    WHERE tenant_id = NEW.tenant_id
      AND writeback_request_id = NEW.writeback_request_id
      AND decision = 'approved';

    IF approval_count < CASE WHEN NEW.risk IN ('high', 'critical') THEN 2 ELSE 1 END THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'writeback request has insufficient independent approvals',
        CONSTRAINT = 'writeback_request_requires_approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_independent_writeback_approval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
DECLARE
  requester text;
  request_state text;
BEGIN
  SELECT requested_by, state
  INTO requester, request_state
  FROM odf.writeback_requests
  WHERE tenant_id = NEW.tenant_id
    AND writeback_request_id = NEW.writeback_request_id;

  IF requester IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'writeback request does not exist';
  END IF;
  IF requester = NEW.actor THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'requester cannot approve their own writeback request',
      CONSTRAINT = 'writeback_approval_independent_actor';
  END IF;
  IF request_state <> 'pending_approval' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'writeback approvals are only accepted while a request is pending approval',
      CONSTRAINT = 'writeback_approval_request_state';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'raw_ingest_objects',
    'ingestion_run_events',
    'source_checkpoints',
    'quarantine_events',
    'data_models',
    'model_views',
    'time_series_points',
    'provenance_records',
    'pipeline_versions',
    'pipeline_run_events',
    'quality_results',
    'writeback_approvals'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = format('odf.%I', table_name)::regclass
        AND tgname = table_name || '_append_only'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON odf.%I FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_history_mutation()',
        table_name || '_append_only',
        table_name
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'odf.writeback_requests'::regclass
      AND tgname = 'writeback_requests_require_approval'
  ) THEN
    EXECUTE 'CREATE TRIGGER writeback_requests_require_approval
      BEFORE INSERT OR UPDATE ON odf.writeback_requests
      FOR EACH ROW EXECUTE FUNCTION odf.enforce_writeback_approval_transition()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'odf.writeback_approvals'::regclass
      AND tgname = 'writeback_approvals_independent_actor'
  ) THEN
    EXECUTE 'CREATE TRIGGER writeback_approvals_independent_actor
      BEFORE INSERT ON odf.writeback_approvals
      FOR EACH ROW EXECUTE FUNCTION odf.enforce_independent_writeback_approval()';
  END IF;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants',
    'projects',
    'datasets',
    'model_spaces',
    'source_connections',
    'raw_ingest_objects',
    'ingestion_runs',
    'ingestion_run_events',
    'source_checkpoints',
    'quarantined_records',
    'quarantine_events',
    'data_models',
    'model_views',
    'graph_instances',
    'assets',
    'time_series',
    'time_series_points',
    'documents',
    'document_asset_links',
    'relations',
    'relation_candidates',
    'provenance_records',
    'pipelines',
    'pipeline_versions',
    'pipeline_runs',
    'pipeline_run_events',
    'quality_rules',
    'quality_results',
    'writeback_requests',
    'writeback_approvals'
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

GRANT USAGE ON SCHEMA odf TO odf_app, odf_outbox_publisher, odf_readonly;
GRANT EXECUTE ON FUNCTION odf.current_tenant_id() TO odf_app, odf_readonly;
GRANT EXECUTE ON FUNCTION odf.set_tenant_context(uuid) TO odf_app, odf_readonly;

GRANT SELECT ON odf.tenants TO odf_app, odf_readonly;
GRANT SELECT, INSERT, UPDATE ON
  odf.projects,
  odf.datasets,
  odf.model_spaces,
  odf.source_connections,
  odf.ingestion_runs,
  odf.quarantined_records,
  odf.graph_instances,
  odf.assets,
  odf.time_series,
  odf.documents,
  odf.document_asset_links,
  odf.relations,
  odf.relation_candidates,
  odf.pipelines,
  odf.pipeline_runs,
  odf.quality_rules,
  odf.writeback_requests
TO odf_app;
GRANT SELECT, INSERT ON
  odf.raw_ingest_objects,
  odf.ingestion_run_events,
  odf.source_checkpoints,
  odf.quarantine_events,
  odf.data_models,
  odf.model_views,
  odf.time_series_points,
  odf.provenance_records,
  odf.pipeline_versions,
  odf.pipeline_run_events,
  odf.quality_results,
  odf.writeback_approvals
TO odf_app;
GRANT SELECT ON
  odf.projects,
  odf.datasets,
  odf.model_spaces,
  odf.source_connections,
  odf.raw_ingest_objects,
  odf.ingestion_runs,
  odf.ingestion_run_events,
  odf.source_checkpoints,
  odf.quarantined_records,
  odf.quarantine_events,
  odf.data_models,
  odf.model_views,
  odf.graph_instances,
  odf.assets,
  odf.time_series,
  odf.time_series_points,
  odf.documents,
  odf.document_asset_links,
  odf.relations,
  odf.relation_candidates,
  odf.provenance_records,
  odf.pipelines,
  odf.pipeline_versions,
  odf.pipeline_runs,
  odf.pipeline_run_events,
  odf.quality_rules,
  odf.quality_results,
  odf.writeback_requests,
  odf.writeback_approvals
TO odf_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA odf TO odf_app;

GRANT SELECT, UPDATE ON odf.outbox_events TO odf_outbox_publisher;
GRANT SELECT, INSERT ON odf.audit_log, odf.outbox_events TO odf_app;
GRANT SELECT ON odf.audit_log TO odf_readonly;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('003_tenant_industrial_data_plane', 'tenant-scoped industrial data plane, RLS policies, and least-privilege roles')
ON CONFLICT (version) DO NOTHING;

COMMIT;
