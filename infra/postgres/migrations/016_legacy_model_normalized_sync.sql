BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

-- Migration 015 made odf.data_models the canonical search projection source
-- and intentionally removed the legacy model trigger. Backfill any legacy
-- versions created between that migration and the dual-write API rollout so
-- upgrades cannot leave valid compatibility records outside search/model graph.
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

INSERT INTO odf.schema_migrations (version, description)
VALUES ('016_legacy_model_normalized_sync', 'backfill and preserve canonical normalized search projection for compatibility model versions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
