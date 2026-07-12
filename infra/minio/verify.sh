#!/bin/sh
# Verifies the private versioned/encrypted bucket and proves the API identity
# cannot escape its object prefix or alter the bucket. It runs only in the
# short-lived bootstrap/CI utility container, never in API replicas.

set -eu

mode="${1:?usage: verify.sh admin|application}"
bucket="${ODF_MINIO_BUCKET:-odf-objects}"
endpoint="${ODF_MINIO_ENDPOINT:-http://odf-minio:9000}"

root_user="$(cat /run/secrets/odf_minio_root_user)"
root_password="$(cat /run/secrets/odf_minio_root_password)"
api_access_key="$(cat /run/secrets/odf_minio_api_access_key)"
api_secret_key="$(cat /run/secrets/odf_minio_api_secret_key)"

require_json_field() {
  json="$1"
  field="$2"
  expected="$3"
  if ! printf '%s' "$json" | grep -Eq "\"${field}\"[[:space:]]*:[[:space:]]*\"${expected}\""; then
    echo "Expected ${field}=${expected} in MinIO JSON response" >&2
    exit 1
  fi
}

expect_denied() {
  if "$@" >/dev/null 2>&1; then
    echo "Unexpectedly permitted: $*" >&2
    exit 1
  fi
}

case "$mode" in
  admin)
    mc alias set --quiet odf-admin "$endpoint" "$root_user" "$root_password"
    versioning="$(mc version info --json "odf-admin/${bucket}")"
    encryption="$(mc encrypt info --json "odf-admin/${bucket}")"
    anonymous="$(mc anonymous get --json "odf-admin/${bucket}")"
    require_json_field "$versioning" status Enabled
    require_json_field "$encryption" algorithm AES256
    require_json_field "$anonymous" permission private
    ;;
  application)
    object_key="${ODF_MINIO_VERIFY_OBJECT_KEY:?ODF_MINIO_VERIFY_OBJECT_KEY is required for application verification}"
    case "$object_key" in
      odf/v1/*) ;;
      *)
        echo "Application verification object must be under odf/v1/" >&2
        exit 1
        ;;
    esac
    mc alias set --quiet odf-app "$endpoint" "$api_access_key" "$api_secret_key"
    printf '%s' 'prefix-escape-probe' >/tmp/odf-prefix-escape-probe
    # No ListBucket, no writes outside odf/v1, no immutable-object deletion,
    # and no bucket-policy/versioning/encryption administration are permitted.
    expect_denied mc ls "odf-app/${bucket}"
    expect_denied mc cp /tmp/odf-prefix-escape-probe "odf-app/${bucket}/outside-odf-prefix/probe"
    expect_denied mc rm --force "odf-app/${bucket}/${object_key}"
    expect_denied mc version suspend "odf-app/${bucket}"
    expect_denied mc anonymous set public "odf-app/${bucket}"
    expect_denied mc encrypt clear "odf-app/${bucket}"
    ;;
  *)
    echo "Unknown MinIO verification mode: ${mode}" >&2
    exit 1
    ;;
esac
