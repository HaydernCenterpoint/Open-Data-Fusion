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
    # Migration files are text. Hash their LF-canonical form so a Windows
    # checkout with core.autocrlf does not invalidate the release manifest.
    for migration in [0-9][0-9][0-9]_*.sql; do
      [ -f "$migration" ] || continue
      checksum="$(sed 's/\r$//' "$migration" | sha256sum | awk '{ print $1 }')"
      printf '%s  %s\n' "$checksum" "$migration"
    done | sort -k 2 > /tmp/odf-migrations.actual
    sort -k 2 SHA256SUMS > /tmp/odf-migrations.expected
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
  if psql --no-psqlrc --tuples-only --no-align --quiet \
    --command="SELECT version FROM odf.schema_migrations WHERE version = '$version';" \
    2>/dev/null | grep -Fxq "$version"; then
    echo "Skipping $version (already recorded)"
    continue
  fi
  echo "Applying $(basename "$migration")"
  psql --no-psqlrc --set=ON_ERROR_STOP=1 --file="$migration"
done
