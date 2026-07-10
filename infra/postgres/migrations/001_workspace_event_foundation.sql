-- Open Data Fusion PostgreSQL production foundation.
--
-- This migration is intentionally re-runnable. It takes a transaction-scoped
-- advisory lock so concurrent deploys cannot interleave DDL. Applied migration
-- files are immutable; make a new numbered file for every future change.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

CREATE SCHEMA IF NOT EXISTS odf;
REVOKE ALL ON SCHEMA odf FROM PUBLIC;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS odf.schema_migrations (
  version text PRIMARY KEY CHECK (length(btrim(version)) > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT session_user
);

CREATE TABLE IF NOT EXISTS odf.workspaces (
  id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (length(btrim(updated_by)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS odf.workspace_revisions (
  workspace_id text NOT NULL REFERENCES odf.workspaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version >= 1),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  change_summary text NOT NULL CHECK (length(btrim(change_summary)) > 0),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (workspace_id, version)
);

CREATE INDEX IF NOT EXISTS workspace_revisions_workspace_created_idx
  ON odf.workspace_revisions (workspace_id, created_at DESC, version DESC);

CREATE TABLE IF NOT EXISTS odf.workspace_members (
  workspace_id text NOT NULL REFERENCES odf.workspaces(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  user_id text NOT NULL CHECK (length(btrim(user_id)) > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'reviewer', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- The primary key covers workspace_id lookups; this covers the inverse lookup.
CREATE INDEX IF NOT EXISTS workspace_members_user_workspace_idx
  ON odf.workspace_members (user_id, workspace_id);

CREATE TABLE IF NOT EXISTS odf.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) > 0),
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_occurred_idx
  ON odf.audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_correlation_occurred_idx
  ON odf.audit_log (correlation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_occurred_idx
  ON odf.audit_log (occurred_at DESC);

CREATE TABLE IF NOT EXISTS odf.outbox_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (length(btrim(aggregate_type)) > 0),
  aggregate_id text NOT NULL CHECK (length(btrim(aggregate_id)) > 0),
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  topic text NOT NULL CHECK (length(btrim(topic)) > 0),
  message_key text NOT NULL CHECK (length(btrim(message_key)) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers) = 'object'),
  deduplication_key text NOT NULL CHECK (length(btrim(deduplication_key)) > 0),
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (lease_owner IS NULL OR length(btrim(lease_owner)) > 0),
  CHECK (published_at IS NULL OR (lease_owner IS NULL AND lease_expires_at IS NULL)),
  UNIQUE (aggregate_type, aggregate_id, event_type, deduplication_key)
);

-- Used by concurrent publisher workers with FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
  ON odf.outbox_events (available_at ASC, occurred_at ASC, event_id)
  WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_events_aggregate_occurred_idx
  ON odf.outbox_events (aggregate_type, aggregate_id, occurred_at DESC);

-- Revisions and audit rows are immutable recovery evidence. Application writes
-- may insert them, but accidental UPDATE/DELETE is rejected at the database.
CREATE OR REPLACE FUNCTION odf.reject_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = format('%I.%I is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME);
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'odf.workspace_revisions'::regclass
      AND tgname = 'workspace_revisions_append_only'
  ) THEN
    EXECUTE 'CREATE TRIGGER workspace_revisions_append_only
      BEFORE UPDATE OR DELETE ON odf.workspace_revisions
      FOR EACH ROW EXECUTE FUNCTION odf.reject_history_mutation()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'odf.audit_log'::regclass
      AND tgname = 'audit_log_append_only'
  ) THEN
    EXECUTE 'CREATE TRIGGER audit_log_append_only
      BEFORE UPDATE OR DELETE ON odf.audit_log
      FOR EACH ROW EXECUTE FUNCTION odf.reject_history_mutation()';
  END IF;
END;
$$;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('001_workspace_event_foundation', 'workspace revisions, membership, audit, and transactional outbox')
ON CONFLICT (version) DO NOTHING;

COMMIT;
