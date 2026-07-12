BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

-- Migration 014 deliberately keeps the public v1 platform contracts in
-- PostgreSQL instead of attempting lossy JSON wrappers around the normalized
-- industrial tables. These tables are compatibility records, not a second
-- source of truth: a PostgreSQL process never reads or writes the embedded
-- SQLite catalog for these surfaces.

CREATE TABLE IF NOT EXISTS odf.platform_legacy_model_versions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  model_id text NOT NULL CHECK (length(model_id) BETWEEN 1 AND 255),
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  schema_json jsonb NOT NULL CHECK (jsonb_typeof(schema_json) = 'object'),
  status text NOT NULL CHECK (status IN ('draft', 'published')),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, model_id, version),
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_pipelines (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  pipeline_id text NOT NULL CHECK (length(pipeline_id) BETWEEN 1 AND 255),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  source_id text CHECK (source_id IS NULL OR length(btrim(source_id)) BETWEEN 1 AND 255),
  dataset_id text CHECK (dataset_id IS NULL OR length(btrim(dataset_id)) BETWEEN 1 AND 255),
  definition_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(definition_json) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, pipeline_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, source_id)
    REFERENCES odf.source_connections(project_id, external_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (project_id, dataset_id)
    REFERENCES odf.datasets(project_id, external_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_pipeline_runs (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 255),
  pipeline_id text NOT NULL CHECK (length(pipeline_id) BETWEEN 1 AND 255),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_json) = 'object'),
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_json) = 'object'),
  triggered_by text NOT NULL CHECK (length(triggered_by) BETWEEN 1 AND 512),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, project_id, run_id),
  UNIQUE (tenant_id, project_id, pipeline_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id, pipeline_id)
    REFERENCES odf.platform_legacy_pipelines(tenant_id, project_id, pipeline_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_quality_rules (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  rule_id text NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 255),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 100),
  check_json jsonb NOT NULL CHECK (jsonb_typeof(check_json) = 'object'),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, rule_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_quality_results (
  result_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  rule_id text NOT NULL CHECK (length(rule_id) BETWEEN 1 AND 255),
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 255),
  passed boolean NOT NULL,
  observed_json jsonb NOT NULL CHECK (jsonb_typeof(observed_json) = 'object'),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, rule_id, run_id),
  FOREIGN KEY (tenant_id, project_id, rule_id)
    REFERENCES odf.platform_legacy_quality_rules(tenant_id, project_id, rule_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES odf.platform_legacy_pipeline_runs(tenant_id, project_id, run_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_context_candidates (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  candidate_id text NOT NULL CHECK (length(candidate_id) BETWEEN 1 AND 255),
  source_type text NOT NULL CHECK (length(source_type) BETWEEN 1 AND 100),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 255),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 100),
  target_id text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 255),
  relation_type text NOT NULL CHECK (length(relation_type) BETWEEN 1 AND 100),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence_json) = 'object'),
  status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
  reviewed_by text,
  review_comment text,
  reviewed_at timestamptz,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, candidate_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_writeback_requests (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 255),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 255),
  target_external_id text NOT NULL CHECK (length(target_external_id) BETWEEN 1 AND 255),
  operation text NOT NULL CHECK (length(operation) BETWEEN 1 AND 255),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  state text NOT NULL CHECK (state IN ('draft', 'pending_approval', 'approved', 'executing', 'succeeded', 'failed', 'cancelled')),
  dry_run_json jsonb NOT NULL CHECK (jsonb_typeof(dry_run_json) = 'object'),
  blocked_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocked_reasons_json) = 'array'),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 512),
  requested_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  execution_result_json jsonb CHECK (execution_result_json IS NULL OR jsonb_typeof(execution_result_json) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, request_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, source_id)
    REFERENCES odf.source_connections(project_id, external_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_writeback_approvals (
  approval_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 255),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 512),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, request_id, actor),
  FOREIGN KEY (tenant_id, project_id, request_id)
    REFERENCES odf.platform_legacy_writeback_requests(tenant_id, project_id, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS odf.platform_legacy_writeback_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 255),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 512),
  details_json jsonb NOT NULL CHECK (jsonb_typeof(details_json) = 'object'),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id, request_id)
    REFERENCES odf.platform_legacy_writeback_requests(tenant_id, project_id, request_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES odf.projects(tenant_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS platform_legacy_model_versions_cursor_idx
  ON odf.platform_legacy_model_versions (tenant_id, project_id, model_id, version);
CREATE INDEX IF NOT EXISTS platform_legacy_pipelines_cursor_idx
  ON odf.platform_legacy_pipelines (tenant_id, project_id, pipeline_id);
CREATE INDEX IF NOT EXISTS platform_legacy_pipeline_runs_cursor_idx
  ON odf.platform_legacy_pipeline_runs (tenant_id, project_id, run_id);
CREATE INDEX IF NOT EXISTS platform_legacy_quality_rules_cursor_idx
  ON odf.platform_legacy_quality_rules (tenant_id, project_id, rule_id);
CREATE INDEX IF NOT EXISTS platform_legacy_quality_results_cursor_idx
  ON odf.platform_legacy_quality_results (tenant_id, project_id, result_id);
CREATE INDEX IF NOT EXISTS platform_legacy_context_candidates_cursor_idx
  ON odf.platform_legacy_context_candidates (tenant_id, project_id, candidate_id);
CREATE INDEX IF NOT EXISTS platform_legacy_writeback_requests_cursor_idx
  ON odf.platform_legacy_writeback_requests (tenant_id, project_id, request_id);
CREATE INDEX IF NOT EXISTS platform_legacy_writeback_events_cursor_idx
  ON odf.platform_legacy_writeback_events (tenant_id, project_id, request_id, event_id);

CREATE OR REPLACE FUNCTION odf.reject_platform_legacy_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'platform legacy history is immutable';
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_platform_legacy_pipeline_run_initial_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF NEW.status <> 'processing' OR NEW.completed_at IS NOT NULL OR NEW.result_json <> '{}'::jsonb THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy pipeline runs must start in processing without a result',
      CONSTRAINT = 'platform_legacy_pipeline_run_initial_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_platform_legacy_candidate_initial_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF NEW.status <> 'proposed'
     OR NEW.reviewed_by IS NOT NULL
     OR NEW.review_comment IS NOT NULL
     OR NEW.reviewed_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy contextual candidates must start proposed and unreviewed',
      CONSTRAINT = 'platform_legacy_candidate_initial_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_platform_legacy_writeback_initial_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF NEW.state NOT IN ('draft', 'pending_approval', 'cancelled')
     OR NEW.executed_at IS NOT NULL
     OR NEW.execution_result_json IS NOT NULL
     OR NEW.updated_at <> NEW.requested_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy write-back requests must start draft, pending, or safely cancelled without execution evidence',
      CONSTRAINT = 'platform_legacy_writeback_initial_state';
  END IF;
  IF NEW.state = 'pending_approval' AND jsonb_array_length(NEW.blocked_reasons_json) <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'pending legacy write-back requests cannot contain blocking reasons',
      CONSTRAINT = 'platform_legacy_writeback_pending_block_reasons';
  END IF;
  IF NEW.state IN ('draft', 'cancelled') AND jsonb_array_length(NEW.blocked_reasons_json) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'initially draft or cancelled legacy write-back requests require blocking evidence',
      CONSTRAINT = 'platform_legacy_writeback_cancelled_evidence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_platform_legacy_independent_writeback_approval()
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
  FROM odf.platform_legacy_writeback_requests
  WHERE tenant_id = NEW.tenant_id
    AND project_id = NEW.project_id
    AND request_id = NEW.request_id;

  IF requester IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'legacy write-back request does not exist';
  END IF;
  IF requester = NEW.actor THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'requester cannot approve their own legacy write-back request',
      CONSTRAINT = 'platform_legacy_writeback_approval_independent_actor';
  END IF;
  IF request_state <> 'pending_approval' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'legacy write-back approvals are accepted only while pending approval',
      CONSTRAINT = 'platform_legacy_writeback_approval_request_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_platform_legacy_candidate_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF OLD.status <> 'proposed'
     OR NEW.status NOT IN ('accepted', 'rejected')
     OR NEW.reviewed_by IS NULL
     OR NEW.reviewed_at IS NULL THEN
    RAISE EXCEPTION 'legacy contextual candidates may be reviewed exactly once from proposed';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.project_id <> OLD.project_id
     OR NEW.candidate_id <> OLD.candidate_id OR NEW.source_type <> OLD.source_type
     OR NEW.source_id <> OLD.source_id OR NEW.target_type <> OLD.target_type
     OR NEW.target_id <> OLD.target_id OR NEW.relation_type <> OLD.relation_type
     OR NEW.confidence <> OLD.confidence OR NEW.evidence_json <> OLD.evidence_json
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'legacy contextual candidate evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_platform_legacy_pipeline_run_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
BEGIN
  IF OLD.status <> 'processing' OR NEW.status NOT IN ('completed', 'failed') OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'legacy pipeline runs may transition only once from processing';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.project_id <> OLD.project_id
     OR NEW.run_id <> OLD.run_id OR NEW.pipeline_id <> OLD.pipeline_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.input_hash <> OLD.input_hash
     OR NEW.input_json <> OLD.input_json OR NEW.triggered_by <> OLD.triggered_by
     OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'legacy pipeline-run evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION odf.enforce_platform_legacy_writeback_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = odf, pg_catalog
AS $$
DECLARE
  approval_count integer;
BEGIN
  IF NOT (
    (OLD.state = 'draft' AND NEW.state IN ('pending_approval', 'cancelled'))
    OR (OLD.state = 'pending_approval' AND NEW.state IN ('approved', 'cancelled'))
    OR (OLD.state = 'approved' AND NEW.state = 'executing')
    OR (OLD.state = 'executing' AND NEW.state IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid legacy write-back state transition from % to %', OLD.state, NEW.state;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.project_id <> OLD.project_id
     OR NEW.request_id <> OLD.request_id OR NEW.source_id <> OLD.source_id
     OR NEW.target_external_id <> OLD.target_external_id OR NEW.operation <> OLD.operation
     OR NEW.payload_json <> OLD.payload_json OR NEW.risk <> OLD.risk
     OR NEW.dry_run_json <> OLD.dry_run_json OR NEW.requested_by <> OLD.requested_by
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'legacy write-back request evidence is immutable';
  END IF;
  IF OLD.state <> 'draft' AND NEW.blocked_reasons_json <> OLD.blocked_reasons_json THEN
    RAISE EXCEPTION 'legacy write-back blocking evidence is immutable';
  END IF;
  IF OLD.state = 'draft' AND NEW.state = 'pending_approval'
     AND jsonb_array_length(NEW.blocked_reasons_json) <> 0 THEN
    RAISE EXCEPTION 'submitted legacy write-back requests cannot retain blocking evidence';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'legacy write-back updated_at cannot move backwards';
  END IF;

  IF NEW.state IN ('draft', 'approved', 'executing', 'cancelled')
     AND (NEW.executed_at IS NOT NULL OR NEW.execution_result_json IS NOT NULL) THEN
    RAISE EXCEPTION 'legacy write-back execution evidence is allowed only for a terminal execution state';
  END IF;
  IF NEW.state IN ('succeeded', 'failed')
     AND (NEW.executed_at IS NULL OR NEW.execution_result_json IS NULL OR NEW.executed_at < NEW.requested_at) THEN
    RAISE EXCEPTION 'terminal legacy write-back requests require valid execution evidence';
  END IF;

  IF NEW.state = 'cancelled'
     AND jsonb_array_length(NEW.blocked_reasons_json) = 0
     AND NOT EXISTS (
       SELECT 1
       FROM odf.platform_legacy_writeback_approvals AS approval
       WHERE approval.tenant_id = NEW.tenant_id
         AND approval.project_id = NEW.project_id
         AND approval.request_id = NEW.request_id
         AND approval.decision = 'rejected'
     ) THEN
    RAISE EXCEPTION 'cancelled legacy write-back requests require a rejection or blocking evidence';
  END IF;

  IF NEW.state IN ('approved', 'executing') THEN
    SELECT count(DISTINCT approval.actor)
    INTO approval_count
    FROM odf.platform_legacy_writeback_approvals AS approval
    WHERE approval.tenant_id = NEW.tenant_id
      AND approval.project_id = NEW.project_id
      AND approval.request_id = NEW.request_id
      AND approval.decision = 'approved'
      AND approval.actor <> NEW.requested_by;
    IF approval_count < (CASE WHEN NEW.risk IN ('high', 'critical') THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'legacy write-back request has insufficient independent approvals',
        CONSTRAINT = 'platform_legacy_writeback_requires_approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The migration-013 projection function intentionally rejects unknown source
-- tables. Compatibility records use a separate, narrowly-owned function so
-- they remain searchable without granting the application role projection
-- writes or widening that function's input surface.
CREATE OR REPLACE FUNCTION odf.sync_platform_legacy_search_index()
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
      WHEN 'platform_legacy_model_versions' THEN v_entity_type := 'dataModel'; v_entity_id := 'legacy:' || OLD.model_id || '@' || OLD.version::text;
      WHEN 'platform_legacy_pipelines' THEN v_entity_type := 'pipeline'; v_entity_id := 'legacy:' || OLD.pipeline_id;
      WHEN 'platform_legacy_quality_rules' THEN v_entity_type := 'qualityRule'; v_entity_id := 'legacy:' || OLD.rule_id;
      WHEN 'platform_legacy_context_candidates' THEN v_entity_type := 'contextCandidate'; v_entity_id := 'legacy:' || OLD.candidate_id;
      WHEN 'platform_legacy_writeback_requests' THEN v_entity_type := 'writebackRequest'; v_entity_id := 'legacy:' || OLD.request_id;
      ELSE RAISE EXCEPTION USING ERRCODE = '42883', MESSAGE = 'unsupported platform legacy search trigger source';
    END CASE;
    DELETE FROM odf.platform_search_index
    WHERE tenant_id = v_tenant_id AND project_id = v_project_id
      AND entity_type = v_entity_type AND entity_id = v_entity_id;
    RETURN OLD;
  END IF;

  v_tenant_id := NEW.tenant_id;
  v_project_id := NEW.project_id;
  CASE TG_TABLE_NAME
    WHEN 'platform_legacy_model_versions' THEN
      v_entity_type := 'dataModel'; v_entity_id := 'legacy:' || NEW.model_id || '@' || NEW.version::text;
      v_title := NEW.name; v_body := NEW.model_id || ' ' || NEW.status; v_updated_at := NEW.created_at;
    WHEN 'platform_legacy_pipelines' THEN
      v_entity_type := 'pipeline'; v_entity_id := 'legacy:' || NEW.pipeline_id;
      v_title := NEW.name; v_body := coalesce(NEW.source_id, '') || ' ' || coalesce(NEW.dataset_id, '') || ' ' || CASE WHEN NEW.enabled THEN 'enabled' ELSE 'disabled' END; v_updated_at := NEW.created_at;
    WHEN 'platform_legacy_quality_rules' THEN
      v_entity_type := 'qualityRule'; v_entity_id := 'legacy:' || NEW.rule_id;
      v_title := NEW.name; v_body := NEW.target_type || ' ' || NEW.severity; v_updated_at := NEW.created_at;
    WHEN 'platform_legacy_context_candidates' THEN
      v_entity_type := 'contextCandidate'; v_entity_id := 'legacy:' || NEW.candidate_id;
      v_title := NEW.relation_type || ': ' || NEW.source_id || ' -> ' || NEW.target_id;
      v_body := NEW.source_type || ' ' || NEW.target_type || ' ' || NEW.status; v_updated_at := coalesce(NEW.reviewed_at, NEW.created_at);
    WHEN 'platform_legacy_writeback_requests' THEN
      v_entity_type := 'writebackRequest'; v_entity_id := 'legacy:' || NEW.request_id;
      v_title := NEW.operation; v_body := NEW.target_external_id || ' ' || NEW.risk || ' ' || NEW.state; v_updated_at := NEW.updated_at;
    ELSE RAISE EXCEPTION USING ERRCODE = '42883', MESSAGE = 'unsupported platform legacy search trigger source';
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

ALTER FUNCTION odf.sync_platform_legacy_search_index() OWNER TO odf_platform_search_projection_owner;
REVOKE ALL PRIVILEGES ON FUNCTION odf.sync_platform_legacy_search_index()
  FROM PUBLIC, odf_app, odf_readonly, odf_outbox_publisher, odf_cutover,
    odf_tenant_provisioner, odf_project_discovery_owner, odf_workspace_bootstrap_owner;

DROP TRIGGER IF EXISTS platform_legacy_model_versions_immutable ON odf.platform_legacy_model_versions;
CREATE TRIGGER platform_legacy_model_versions_immutable
  BEFORE UPDATE OR DELETE ON odf.platform_legacy_model_versions
  FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_legacy_history_mutation();
DROP TRIGGER IF EXISTS platform_legacy_quality_rules_immutable ON odf.platform_legacy_quality_rules;
CREATE TRIGGER platform_legacy_quality_rules_immutable
  BEFORE UPDATE OR DELETE ON odf.platform_legacy_quality_rules
  FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_legacy_history_mutation();
DROP TRIGGER IF EXISTS platform_legacy_quality_results_immutable ON odf.platform_legacy_quality_results;
CREATE TRIGGER platform_legacy_quality_results_immutable
  BEFORE UPDATE OR DELETE ON odf.platform_legacy_quality_results
  FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_legacy_history_mutation();
DROP TRIGGER IF EXISTS platform_legacy_writeback_approvals_immutable ON odf.platform_legacy_writeback_approvals;
CREATE TRIGGER platform_legacy_writeback_approvals_immutable
  BEFORE UPDATE OR DELETE ON odf.platform_legacy_writeback_approvals
  FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_legacy_history_mutation();
DROP TRIGGER IF EXISTS platform_legacy_writeback_events_immutable ON odf.platform_legacy_writeback_events;
CREATE TRIGGER platform_legacy_writeback_events_immutable
  BEFORE UPDATE OR DELETE ON odf.platform_legacy_writeback_events
  FOR EACH ROW EXECUTE FUNCTION odf.reject_platform_legacy_history_mutation();
DROP TRIGGER IF EXISTS platform_legacy_context_candidates_transition ON odf.platform_legacy_context_candidates;
CREATE TRIGGER platform_legacy_context_candidates_transition
  BEFORE UPDATE ON odf.platform_legacy_context_candidates
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_legacy_candidate_transition();
DROP TRIGGER IF EXISTS platform_legacy_context_candidates_initial_state ON odf.platform_legacy_context_candidates;
CREATE TRIGGER platform_legacy_context_candidates_initial_state
  BEFORE INSERT ON odf.platform_legacy_context_candidates
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_legacy_candidate_initial_state();
DROP TRIGGER IF EXISTS platform_legacy_pipeline_runs_transition ON odf.platform_legacy_pipeline_runs;
CREATE TRIGGER platform_legacy_pipeline_runs_transition
  BEFORE UPDATE ON odf.platform_legacy_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_legacy_pipeline_run_transition();
DROP TRIGGER IF EXISTS platform_legacy_pipeline_runs_initial_state ON odf.platform_legacy_pipeline_runs;
CREATE TRIGGER platform_legacy_pipeline_runs_initial_state
  BEFORE INSERT ON odf.platform_legacy_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_legacy_pipeline_run_initial_state();
DROP TRIGGER IF EXISTS platform_legacy_writeback_requests_transition ON odf.platform_legacy_writeback_requests;
CREATE TRIGGER platform_legacy_writeback_requests_transition
  BEFORE UPDATE ON odf.platform_legacy_writeback_requests
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_legacy_writeback_transition();
DROP TRIGGER IF EXISTS platform_legacy_writeback_requests_initial_state ON odf.platform_legacy_writeback_requests;
CREATE TRIGGER platform_legacy_writeback_requests_initial_state
  BEFORE INSERT ON odf.platform_legacy_writeback_requests
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_legacy_writeback_initial_state();
DROP TRIGGER IF EXISTS platform_legacy_writeback_approvals_independent_actor ON odf.platform_legacy_writeback_approvals;
CREATE TRIGGER platform_legacy_writeback_approvals_independent_actor
  BEFORE INSERT ON odf.platform_legacy_writeback_approvals
  FOR EACH ROW EXECUTE FUNCTION odf.enforce_platform_legacy_independent_writeback_approval();

CREATE TRIGGER platform_legacy_model_versions_search_projection
  AFTER INSERT OR UPDATE OR DELETE ON odf.platform_legacy_model_versions
  FOR EACH ROW EXECUTE FUNCTION odf.sync_platform_legacy_search_index();
CREATE TRIGGER platform_legacy_pipelines_search_projection
  AFTER INSERT OR UPDATE OR DELETE ON odf.platform_legacy_pipelines
  FOR EACH ROW EXECUTE FUNCTION odf.sync_platform_legacy_search_index();
CREATE TRIGGER platform_legacy_quality_rules_search_projection
  AFTER INSERT OR UPDATE OR DELETE ON odf.platform_legacy_quality_rules
  FOR EACH ROW EXECUTE FUNCTION odf.sync_platform_legacy_search_index();
CREATE TRIGGER platform_legacy_context_candidates_search_projection
  AFTER INSERT OR UPDATE OR DELETE ON odf.platform_legacy_context_candidates
  FOR EACH ROW EXECUTE FUNCTION odf.sync_platform_legacy_search_index();
CREATE TRIGGER platform_legacy_writeback_requests_search_projection
  AFTER INSERT OR UPDATE OR DELETE ON odf.platform_legacy_writeback_requests
  FOR EACH ROW EXECUTE FUNCTION odf.sync_platform_legacy_search_index();

ALTER TABLE odf.platform_legacy_model_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_model_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_pipelines FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_pipeline_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_quality_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_quality_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_quality_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_quality_results FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_context_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_context_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_writeback_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_writeback_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_writeback_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_writeback_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_writeback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE odf.platform_legacy_writeback_events FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_legacy_model_versions_scope ON odf.platform_legacy_model_versions
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_pipelines_scope ON odf.platform_legacy_pipelines
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_pipeline_runs_scope ON odf.platform_legacy_pipeline_runs
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_quality_rules_scope ON odf.platform_legacy_quality_rules
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_quality_results_scope ON odf.platform_legacy_quality_results
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_context_candidates_scope ON odf.platform_legacy_context_candidates
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_writeback_requests_scope ON odf.platform_legacy_writeback_requests
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_writeback_approvals_scope ON odf.platform_legacy_writeback_approvals
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());
CREATE POLICY platform_legacy_writeback_events_scope ON odf.platform_legacy_writeback_events
  TO odf_app, odf_readonly
  USING (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id())
  WITH CHECK (tenant_id = odf.current_tenant_id() AND project_id = odf.current_project_id());

GRANT SELECT, INSERT ON odf.platform_legacy_model_versions,
  odf.platform_legacy_pipelines, odf.platform_legacy_quality_rules,
  odf.platform_legacy_quality_results, odf.platform_legacy_writeback_approvals,
  odf.platform_legacy_writeback_events TO odf_app;
GRANT SELECT, INSERT, UPDATE ON odf.platform_legacy_pipeline_runs,
  odf.platform_legacy_context_candidates, odf.platform_legacy_writeback_requests TO odf_app;
GRANT SELECT ON odf.platform_legacy_model_versions, odf.platform_legacy_pipelines,
  odf.platform_legacy_pipeline_runs, odf.platform_legacy_quality_rules,
  odf.platform_legacy_quality_results, odf.platform_legacy_context_candidates,
  odf.platform_legacy_writeback_requests, odf.platform_legacy_writeback_approvals,
  odf.platform_legacy_writeback_events TO odf_readonly;
GRANT USAGE, SELECT ON SEQUENCE odf.platform_legacy_quality_results_result_id_seq,
  odf.platform_legacy_writeback_approvals_approval_id_seq,
  odf.platform_legacy_writeback_events_event_id_seq TO odf_app;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('014_platform_legacy_compatibility', 'RLS-protected PostgreSQL compatibility records for the public v1 platform contract')
ON CONFLICT (version) DO NOTHING;

COMMIT;
