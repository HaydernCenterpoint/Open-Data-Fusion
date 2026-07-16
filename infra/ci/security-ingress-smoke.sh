#!/usr/bin/env bash
# Validates the local/CI connector mTLS ingress on an already-running
# production-like security-rehearsal Compose stack. It never starts, stops, or
# mutates services, and it sends no authenticated ingest payload.

set -euo pipefail
umask 077

readonly REQUIRED_CONFIRMATION="local-security-ingress"
readonly DEFAULT_CONNECT_TIMEOUT_SECONDS=5
readonly DEFAULT_MAX_TIME_SECONDS=15

base_compose="${ODF_COMPOSE_BASE:-docker-compose.yml}"
production_like_compose="${ODF_COMPOSE_PRODUCTION_LIKE:-docker-compose.production-like.yml}"
security_rehearsal_compose="${ODF_COMPOSE_SECURITY_REHEARSAL:-docker-compose.security-rehearsal.yml}"
connector_mtls_port="${ODF_CONNECTOR_MTLS_PORT:-9443}"
connect_timeout_seconds="${ODF_SECURITY_INGRESS_SMOKE_CONNECT_TIMEOUT_SECONDS:-${DEFAULT_CONNECT_TIMEOUT_SECONDS}}"
max_time_seconds="${ODF_SECURITY_INGRESS_SMOKE_MAX_TIME_SECONDS:-${DEFAULT_MAX_TIME_SECONDS}}"
temporary_directory=""

fail() {
  echo "security ingress smoke: $*" >&2
  exit 1
}

require_environment() {
  if [[ -z "${!1:-}" ]]; then
    fail "$1 is required by the local/CI security ingress smoke test"
  fi
}

require_readable_file() {
  local variable_name="$1"
  local file_path="$2"

  if [[ ! -f "$file_path" || ! -r "$file_path" ]]; then
    fail "$variable_name must reference a readable regular file"
  fi
}

require_bounded_integer() {
  local variable_name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"

  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < minimum || 10#$value > maximum )); then
    fail "$variable_name must be an integer between ${minimum} and ${maximum}"
  fi
}

compose() {
  docker compose \
    -f "$base_compose" \
    -f "$production_like_compose" \
    -f "$security_rehearsal_compose" \
    --profile production-like \
    --profile security-rehearsal "$@"
}

cleanup() {
  local status="$?"
  trap - EXIT
  if [[ -n "$temporary_directory" ]]; then
    rm -rf "$temporary_directory" || true
  fi
  exit "$status"
}

if [[ "$base_compose" != "docker-compose.yml" || "$production_like_compose" != "docker-compose.production-like.yml" || "$security_rehearsal_compose" != "docker-compose.security-rehearsal.yml" ]]; then
  fail "only docker-compose.yml, docker-compose.production-like.yml, and docker-compose.security-rehearsal.yml are permitted"
fi
if [[ "${ODF_SECURITY_INGRESS_SMOKE_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
  fail "set ODF_SECURITY_INGRESS_SMOKE_CONFIRM=${REQUIRED_CONFIRMATION} to confirm this local/CI-only smoke test"
fi

for required_compose_file in "$base_compose" "$production_like_compose" "$security_rehearsal_compose"; do
  [[ -f "$required_compose_file" ]] || fail "required Compose file '${required_compose_file}' is missing"
done

for required_command in docker curl dirname mktemp; do
  command -v "$required_command" >/dev/null 2>&1 || fail "${required_command} is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

require_environment ODF_ENVOY_IMAGE
require_environment ODF_INGRESS_TLS_CERT_FILE
require_environment ODF_INGRESS_TLS_KEY_FILE
require_environment ODF_INGRESS_CLIENT_CA_FILE

if [[ ! "$ODF_ENVOY_IMAGE" =~ ^[^[:space:]@]+@sha256:[[:xdigit:]]{64}$ ]]; then
  fail "ODF_ENVOY_IMAGE must be pinned to an image digest using @sha256:<64-hex-digits>"
fi

require_bounded_integer ODF_CONNECTOR_MTLS_PORT "$connector_mtls_port" 1 65535
require_bounded_integer ODF_SECURITY_INGRESS_SMOKE_CONNECT_TIMEOUT_SECONDS "$connect_timeout_seconds" 1 30
require_bounded_integer ODF_SECURITY_INGRESS_SMOKE_MAX_TIME_SECONDS "$max_time_seconds" 2 60
if (( 10#$connect_timeout_seconds > 10#$max_time_seconds )); then
  fail "ODF_SECURITY_INGRESS_SMOKE_CONNECT_TIMEOUT_SECONDS cannot exceed ODF_SECURITY_INGRESS_SMOKE_MAX_TIME_SECONDS"
fi

require_readable_file ODF_INGRESS_TLS_CERT_FILE "$ODF_INGRESS_TLS_CERT_FILE"
require_readable_file ODF_INGRESS_TLS_KEY_FILE "$ODF_INGRESS_TLS_KEY_FILE"
require_readable_file ODF_INGRESS_CLIENT_CA_FILE "$ODF_INGRESS_CLIENT_CA_FILE"

# The existing rehearsal PKI generator places client.crt and client.key beside
# the client CA. Explicit overrides support an equivalent externally supplied
# local/CI PKI layout without placing private material in the Compose files.
pki_directory="$(dirname "$ODF_INGRESS_CLIENT_CA_FILE")"
client_certificate_file="${ODF_INGRESS_CLIENT_CERT_FILE:-${pki_directory}/client.crt}"
client_key_file="${ODF_INGRESS_CLIENT_KEY_FILE:-${pki_directory}/client.key}"
require_readable_file ODF_INGRESS_CLIENT_CERT_FILE "$client_certificate_file"
require_readable_file ODF_INGRESS_CLIENT_KEY_FILE "$client_key_file"

docker_endpoint="${DOCKER_HOST:-}"
if [[ -z "$docker_endpoint" ]]; then
  docker_context="$(docker context show 2>/dev/null)" || fail "could not determine the Docker context"
  docker_endpoint="$(docker context inspect "$docker_context" --format '{{ .Endpoints.docker.Host }}' 2>/dev/null)" \
    || fail "could not inspect the Docker context"
fi
case "$docker_endpoint" in
  unix://*|npipe://*|tcp://127.0.0.1:*|tcp://localhost:*) ;;
  tcp://docker:*)
    [[ -n "${CI:-}" ]] || fail "the Docker endpoint must be local; refusing '${docker_endpoint}'"
    ;;
  *) fail "the Docker endpoint must be local; refusing '${docker_endpoint}'" ;;
esac

compose config --quiet
configured_services="$(compose config --services)"
for required_service in api odf-mtls-gateway; do
  if ! printf '%s\n' "$configured_services" | grep -Fxq "$required_service"; then
    fail "security-rehearsal Compose configuration is missing '${required_service}'"
  fi
done

running_services="$(compose ps --services --status running)"
for required_service in api odf-mtls-gateway; do
  if ! printf '%s\n' "$running_services" | grep -Fxq "$required_service"; then
    fail "'${required_service}' must already be running; this script does not bootstrap a stack"
  fi
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/odf-security-ingress-smoke.XXXXXX")" || fail "could not create a temporary directory"
chmod 700 "$temporary_directory"
trap 'exit 130' INT TERM
trap cleanup EXIT

curl_options=(
  --silent
  --show-error
  --noproxy '*'
  --tlsv1.2
  --connect-timeout "$connect_timeout_seconds"
  --max-time "$max_time_seconds"
)
gateway_base="https://127.0.0.1:${connector_mtls_port}"
ingest_url="${gateway_base}/api/v1/ingest/bundle"
non_ingest_url="${gateway_base}/ready"

# A successful HTTP response here would mean Envoy accepted a connection
# without a client certificate. The later valid-certificate probe confirms
# that this failure is not caused by an unavailable local gateway.
if no_client_certificate_status="$(curl "${curl_options[@]}" \
  --cacert "$ODF_INGRESS_CLIENT_CA_FILE" \
  --output "$temporary_directory/no-client-certificate.body" \
  --write-out '%{http_code}' \
  "$ingest_url" 2>"$temporary_directory/no-client-certificate.stderr")"; then
  fail "gateway accepted a TLS request without a client certificate (HTTP ${no_client_certificate_status:-unknown})"
fi

if ! unauthenticated_ingest_status="$(curl "${curl_options[@]}" \
  --cert "$client_certificate_file" \
  --key "$client_key_file" \
  --cacert "$ODF_INGRESS_CLIENT_CA_FILE" \
  --request POST \
  --header 'content-length: 0' \
  --output "$temporary_directory/unauthenticated-ingest.body" \
  --write-out '%{http_code}' \
  "$ingest_url" 2>"$temporary_directory/unauthenticated-ingest.stderr")"; then
  fail "valid mTLS ingest request did not complete"
fi
case "$unauthenticated_ingest_status" in
  401|403) ;;
  *) fail "expected unauthenticated mTLS ingest to return 401 or 403, received ${unauthenticated_ingest_status}" ;;
esac

if ! non_ingest_status="$(curl "${curl_options[@]}" \
  --cert "$client_certificate_file" \
  --key "$client_key_file" \
  --cacert "$ODF_INGRESS_CLIENT_CA_FILE" \
  --output "$temporary_directory/non-ingest.body" \
  --write-out '%{http_code}' \
  "$non_ingest_url" 2>"$temporary_directory/non-ingest.stderr")"; then
  fail "valid mTLS non-ingest request did not complete"
fi
if [[ "$non_ingest_status" != "404" ]]; then
  fail "expected non-ingest mTLS route to return gateway 404, received ${non_ingest_status}"
fi

echo "Security ingress mTLS smoke passed: client authentication is required, unauthenticated ingest is denied, and non-ingest routes are blocked."
