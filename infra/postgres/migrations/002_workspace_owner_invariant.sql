-- Prevent concurrent membership changes from leaving a workspace ownerless.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('odf:postgres:migrations', 0));

CREATE OR REPLACE FUNCTION odf.protect_last_workspace_owner()
RETURNS trigger
LANGUAGE plpgsql
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

  -- Serialize owner removal/demotion per workspace. The second concurrent
  -- transaction observes the first commit before it evaluates the count.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('odf:workspace-owner:' || OLD.workspace_id, 0)
  );

  SELECT count(*)
  INTO owner_count
  FROM odf.workspace_members
  WHERE workspace_id = OLD.workspace_id
    AND role = 'owner';

  IF owner_count <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('workspace %L must retain at least one owner', OLD.workspace_id),
      CONSTRAINT = 'workspace_must_retain_owner';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'odf.workspace_members'::regclass
      AND tgname = 'workspace_members_retain_owner'
  ) THEN
    EXECUTE 'CREATE TRIGGER workspace_members_retain_owner
      BEFORE UPDATE OF role OR DELETE ON odf.workspace_members
      FOR EACH ROW EXECUTE FUNCTION odf.protect_last_workspace_owner()';
  END IF;
END;
$$;

INSERT INTO odf.schema_migrations (version, description)
VALUES ('002_workspace_owner_invariant', 'serialize owner demotion and removal per workspace')
ON CONFLICT (version) DO NOTHING;

COMMIT;
