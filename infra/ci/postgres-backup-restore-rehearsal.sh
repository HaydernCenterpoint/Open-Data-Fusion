#!/usr/bin/env bash
# Rehearses a PostgreSQL logical backup and isolated restore against the
# production-like Compose topology. Writer services must be stopped first so
# the source and restored fingerprints describe the same recovery point.

set -euo pipefail

compose() {
  docker compose \
    -f "${ODF_COMPOSE_BASE:-docker-compose.yml}" \
    -f "${ODF_COMPOSE_PRODUCTION_LIKE:-docker-compose.production-like.yml}" \
    --profile production-like "$@"
}

require_environment() {
  if [ -z "${!1:-}" ]; then
    echo "$1 is required by the backup/restore rehearsal" >&2
    exit 1
  fi
}

require_environment ODF_POSTGRES_ADMIN_PASSWORD

source_database="${ODF_POSTGRES_DB:-odf}"
admin_user="${ODF_POSTGRES_ADMIN_USER:-odf_migrator}"
restore_database="${ODF_BACKUP_RESTORE_DATABASE:-odf_restore_rehearsal}"

if ! [[ "$source_database" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
  echo "ODF_POSTGRES_DB is not a safe PostgreSQL identifier" >&2
  exit 1
fi
if ! [[ "$restore_database" =~ ^odf_restore_rehearsal(_[A-Za-z0-9]+)?$ ]]; then
  echo "ODF_BACKUP_RESTORE_DATABASE must use the reserved odf_restore_rehearsal prefix" >&2
  exit 1
fi
if [ "$source_database" = "$restore_database" ]; then
  echo "The isolated restore database cannot equal the source database" >&2
  exit 1
fi

postgres() {
  compose exec -T -e "PGPASSWORD=${ODF_POSTGRES_ADMIN_PASSWORD}" odf-postgres "$@"
}

running_services="$(compose ps --services --status running)"
for writer in api api-replica outbox-worker pipeline-worker edge-agent; do
  if printf '%s\n' "$running_services" | grep -Fxq "$writer"; then
    echo "Writer service '$writer' is still running; stop all writers before taking the rehearsal snapshot" >&2
    exit 1
  fi
done

if [ "$(postgres psql --no-psqlrc --tuples-only --no-align --quiet --username "$admin_user" --dbname "$source_database" --command "SELECT to_regclass('odf.schema_migrations') IS NOT NULL")" != "t" ]; then
  echo "Source database does not contain the migrated ODF schema" >&2
  exit 1
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/odf-backup-restore.XXXXXX")"
chmod 700 "$temporary_directory"
dump_path="${temporary_directory}/odf.dump"
source_manifest="${temporary_directory}/source.manifest"
restore_manifest="${temporary_directory}/restore.manifest"
restore_created="false"

cleanup() {
  if [ "$restore_created" = "true" ]; then
    postgres dropdb --if-exists --force --username "$admin_user" "$restore_database" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT INT TERM

emit_manifest() {
  local database="$1"
  local destination="$2"
  postgres psql \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    --quiet \
    --username "$admin_user" \
    --dbname "$database" >"$destination" <<'SQL'
SELECT format(
  $statement$
    SELECT %L || count(*)::text || '|' || md5(COALESCE(string_agg(row_text, E'\n' ORDER BY row_text), ''))
    FROM (SELECT row_to_json(source_row)::text AS row_text FROM odf.%I AS source_row) AS canonical_rows;
  $statement$,
  'table|' || tablename || '|',
  tablename
)
FROM pg_catalog.pg_tables
WHERE schemaname = 'odf'
ORDER BY tablename
\gexec

SELECT format(
  $statement$
    SELECT %L || last_value::text || '|' || is_called::text FROM odf.%I;
  $statement$,
  'sequence|' || sequencename || '|',
  sequencename
)
FROM pg_catalog.pg_sequences
WHERE schemaname = 'odf'
ORDER BY sequencename
\gexec
SQL
}

echo "Creating a quiesced custom-format backup of '${source_database}'..."
postgres pg_dump \
  --username "$admin_user" \
  --dbname "$source_database" \
  --format=custom \
  --compress=6 \
  --no-owner \
  --serializable-deferrable >"$dump_path"
chmod 600 "$dump_path"

if [ ! -s "$dump_path" ]; then
  echo "pg_dump produced an empty backup" >&2
  exit 1
fi
sha256sum "$dump_path" >"${dump_path}.sha256"
postgres pg_restore --list <"$dump_path" >"${temporary_directory}/restore.list"
if ! grep -q 'odf' "${temporary_directory}/restore.list"; then
  echo "Backup catalog does not contain the ODF schema" >&2
  exit 1
fi

emit_manifest "$source_database" "$source_manifest"

postgres dropdb --if-exists --force --username "$admin_user" "$restore_database" >/dev/null
postgres createdb \
  --username "$admin_user" \
  --owner "$admin_user" \
  --template template0 \
  --encoding UTF8 \
  "$restore_database"
restore_created="true"

echo "Restoring into isolated database '${restore_database}'..."
postgres pg_restore \
  --username "$admin_user" \
  --dbname "$restore_database" \
  --exit-on-error \
  --single-transaction \
  --no-owner <"$dump_path"

emit_manifest "$restore_database" "$restore_manifest"
if ! cmp -s "$source_manifest" "$restore_manifest"; then
  echo "Restored PostgreSQL data/sequence fingerprint differs from the quiesced source" >&2
  diff -u "$source_manifest" "$restore_manifest" >&2 || true
  exit 1
fi

dump_sha256="$(cut -d ' ' -f 1 "${dump_path}.sha256")"
if [ -n "${ODF_BACKUP_REHEARSAL_ARTIFACT_DIR:-}" ]; then
  install -d -m 700 "$ODF_BACKUP_REHEARSAL_ARTIFACT_DIR"
  install -m 600 "$dump_path" "$ODF_BACKUP_REHEARSAL_ARTIFACT_DIR/odf-rehearsal.dump"
  install -m 600 "${dump_path}.sha256" "$ODF_BACKUP_REHEARSAL_ARTIFACT_DIR/odf-rehearsal.dump.sha256"
  install -m 600 "$restore_manifest" "$ODF_BACKUP_REHEARSAL_ARTIFACT_DIR/odf-rehearsal.manifest"
fi

echo "PostgreSQL backup/restore rehearsal passed (sha256=${dump_sha256})."
