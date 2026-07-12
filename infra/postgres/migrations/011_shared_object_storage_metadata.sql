-- Shared object-storage metadata for PostgreSQL API replicas.
--
-- Blob bytes live in an immutable, private S3-compatible store.  This
-- migration persists only server-generated locators and scoped metadata; it
-- never stores a bucket endpoint, signed URL, credential, or local path.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

CREATE TABLE IF NOT EXISTS odf.raw_landing_objects (
  landing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_system text NOT NULL CHECK (length(btrim(source_system)) > 0),
  run_id text NOT NULL CHECK (length(btrim(run_id)) > 0),
  storage_profile text NOT NULL CHECK (storage_profile = 'primary'),
  object_key text NOT NULL CHECK (length(btrim(object_key)) > 0),
  object_version_id text NOT NULL CHECK (length(btrim(object_version_id)) > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (length(btrim(content_type)) > 0),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (tenant_id, landing_id),
  UNIQUE (tenant_id, project_id, landing_id),
  UNIQUE (tenant_id, project_id, run_id),
  UNIQUE (tenant_id, project_id, object_key, object_version_id)
);
CREATE INDEX IF NOT EXISTS raw_landing_objects_scope_created_idx
  ON odf.raw_landing_objects (tenant_id, project_id, created_at DESC, landing_id DESC);

CREATE TABLE IF NOT EXISTS odf.raw_landing_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  landing_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('received', 'accepted', 'failed', 'quarantined', 'replayed')),
  error_summary text,
  replay_run_id text,
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, landing_id)
    REFERENCES odf.raw_landing_objects(tenant_id, project_id, landing_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (
    (event_type IN ('failed', 'quarantined') AND error_summary IS NOT NULL)
    OR (event_type NOT IN ('failed', 'quarantined'))
  ),
  CHECK (
    (event_type = 'replayed' AND replay_run_id IS NOT NULL)
    OR (event_type <> 'replayed' AND replay_run_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS raw_landing_events_scope_landing_idx
  ON odf.raw_landing_events (tenant_id, project_id, landing_id, event_id DESC);
CREATE INDEX IF NOT EXISTS raw_landing_events_recovery_idx
  ON odf.raw_landing_events (tenant_id, project_id, occurred_at DESC, event_id DESC)
  WHERE event_type IN ('failed', 'quarantined');

CREATE TABLE IF NOT EXISTS odf.governed_objects (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  object_id text NOT NULL CHECK (object_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  current_version integer NOT NULL CHECK (current_version > 0),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, object_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES odf.projects(tenant_id, project_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.governed_object_versions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  object_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  version_id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
  mime_type text NOT NULL CHECK (length(btrim(mime_type)) > 0),
  storage_profile text NOT NULL CHECK (storage_profile = 'primary'),
  object_key text NOT NULL CHECK (length(btrim(object_key)) > 0),
  object_version_id text NOT NULL CHECK (length(btrim(object_version_id)) > 0),
  storage_etag text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  extracted_text text,
  text_indexed boolean NOT NULL,
  text_truncated boolean NOT NULL,
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, object_id, version),
  UNIQUE (version_id),
  UNIQUE (tenant_id, project_id, object_id, version_id),
  UNIQUE (tenant_id, project_id, object_key, object_version_id),
  FOREIGN KEY (tenant_id, project_id, object_id)
    REFERENCES odf.governed_objects(tenant_id, project_id, object_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS governed_object_versions_scope_created_idx
  ON odf.governed_object_versions (tenant_id, project_id, created_at DESC, version_id DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'odf.governed_objects'::regclass
      AND conname = 'governed_objects_current_version_fk'
  ) THEN
    ALTER TABLE odf.governed_objects
      ADD CONSTRAINT governed_objects_current_version_fk
      FOREIGN KEY (tenant_id, project_id, object_id, current_version)
      REFERENCES odf.governed_object_versions(tenant_id, project_id, object_id, version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS odf.governed_object_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  object_id text NOT NULL,
  version integer,
  event_type text NOT NULL CHECK (event_type IN ('version.created', 'content.downloaded')),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, object_id)
    REFERENCES odf.governed_objects(tenant_id, project_id, object_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, object_id, version)
    REFERENCES odf.governed_object_versions(tenant_id, project_id, object_id, version) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS governed_object_events_scope_object_idx
  ON odf.governed_object_events (tenant_id, project_id, object_id, event_id);

CREATE OR REPLACE FUNCTION odf.enforce_governed_object_version_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.project_id <> OLD.project_id
    OR NEW.object_id <> OLD.object_id
    OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'governed object identity and creation metadata are immutable';
  END IF;
  IF NEW.current_version <> OLD.current_version + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'governed object current version must advance by exactly one';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'governed object updated time cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS governed_objects_version_transition ON odf.governed_objects;
CREATE TRIGGER governed_objects_version_transition
  BEFORE UPDATE ON odf.governed_objects
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_governed_object_version_transition();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'raw_landing_objects',
    'raw_landing_events',
    'governed_object_versions',
    'governed_object_events'
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
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'raw_landing_objects',
    'raw_landing_events',
    'governed_objects',
    'governed_object_versions',
    'governed_object_events'
  ] LOOP
    EXECUTE format('ALTER TABLE odf.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE odf.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS shared_object_app_scope ON odf.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS shared_object_readonly_scope ON odf.%I', table_name);
    EXECUTE format(
      'CREATE POLICY shared_object_app_scope ON odf.%I FOR ALL TO odf_app '
      || 'USING (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id())) '
      || 'WITH CHECK (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY shared_object_readonly_scope ON odf.%I FOR SELECT TO odf_readonly '
      || 'USING (tenant_id = (SELECT odf.current_tenant_id()) AND project_id = (SELECT odf.current_project_id()))',
      table_name
    );
  END LOOP;
END;
$$;

GRANT SELECT, INSERT ON odf.raw_landing_objects, odf.raw_landing_events TO odf_app;
GRANT SELECT, INSERT, UPDATE ON odf.governed_objects TO odf_app;
GRANT SELECT, INSERT ON odf.governed_object_versions, odf.governed_object_events TO odf_app;
GRANT SELECT ON
  odf.raw_landing_objects,
  odf.raw_landing_events,
  odf.governed_objects,
  odf.governed_object_versions,
  odf.governed_object_events
TO odf_readonly;
GRANT USAGE, SELECT ON SEQUENCE
  odf.raw_landing_events_event_id_seq,
  odf.governed_object_events_event_id_seq
TO odf_app;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('011_shared_object_storage_metadata', 'shared S3-compatible object locators and PostgreSQL governed/raw metadata')
ON CONFLICT (version) DO NOTHING;

COMMIT;
