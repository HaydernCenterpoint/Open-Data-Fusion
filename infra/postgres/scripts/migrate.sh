#!/bin/sh
set -eu

: "${PGHOST:=odf-postgres}"
: "${PGPORT:=5432}"
: "${PGDATABASE:=odf}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD

if [ -f /migrations/SHA256SUMS ]; then
  (
    cd /migrations
    # Migration files and the manifest are text. Canonicalize both to LF so a
    # Windows checkout with core.autocrlf does not invalidate the release
    # manifest.
    for migration in [0-9][0-9][0-9]_*.sql; do
      [ -f "$migration" ] || continue
      checksum="$(sed 's/\r$//' "$migration" | sha256sum | awk '{ print $1 }')"
      printf '%s  %s\n' "$checksum" "$migration"
    done | sort -k 2 > /tmp/odf-migrations.actual
    sed 's/\r$//' SHA256SUMS | sort -k 2 > /tmp/odf-migrations.expected
    if ! cmp -s /tmp/odf-migrations.actual /tmp/odf-migrations.expected; then
      echo "SHA256SUMS must contain exactly the numbered migration files" >&2
      exit 1
    fi
  )
fi

psql --no-psqlrc --set=ON_ERROR_STOP=1 --command='SELECT 1;' >/dev/null

for migration in /migrations/[0-9][0-9][0-9]_*.sql; do
  [ -f "$migration" ] || continue
  version="$(basename "$migration" .sql)"
  # Keep the applied-version check and the migration in one PostgreSQL
  # session under a session-level advisory lock. A check in a separate psql
  # process races another migrator that can commit between the check and
  # `--file`, especially on independently deployed replicas.
  psql --no-psqlrc --set=ON_ERROR_STOP=1 <<SQL
SELECT pg_advisory_lock(hashtextextended('odf:postgres:migrations', 0));
SELECT to_regclass('odf.schema_migrations') IS NOT NULL AS odf_migration_registry_exists \gset
\if :odf_migration_registry_exists
  SELECT EXISTS (
    SELECT 1 FROM odf.schema_migrations WHERE version = '$version'
  ) AS odf_migration_already_applied \gset
\else
  \set odf_migration_already_applied false
\endif
\if :odf_migration_already_applied
  \echo Skipping $version (already recorded)
\else
  \echo Applying $(basename "$migration")
  \i $migration
\endif
SELECT pg_advisory_unlock(hashtextextended('odf:postgres:migrations', 0));
SQL
done
