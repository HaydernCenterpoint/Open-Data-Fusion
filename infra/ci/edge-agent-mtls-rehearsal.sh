#!/usr/bin/env bash
# Verifies that an already-running local/CI production-like security rehearsal
# delivered the checked-in edge CSV fixture through the mTLS gateway. This script
# never starts, stops, executes in, or otherwise mutates a Compose service.

set -euo pipefail
umask 077

readonly REQUIRED_CONFIRMATION="local-ci-edge-mtls-rehearsal"
readonly FIXTURE_SOURCE_SYSTEM="ci-edge-mtls"
readonly DEFAULT_TIMEOUT_SECONDS=60

base_compose="${ODF_COMPOSE_BASE:-docker-compose.yml}"
production_like_compose="${ODF_COMPOSE_PRODUCTION_LIKE:-docker-compose.production-like.yml}"
security_rehearsal_compose="${ODF_COMPOSE_SECURITY_REHEARSAL:-docker-compose.security-rehearsal.yml}"
rehearsal_timeout_seconds="${ODF_EDGE_MTLS_REHEARSAL_TIMEOUT_SECONDS:-${DEFAULT_TIMEOUT_SECONDS}}"

fail() {
  echo "edge mTLS rehearsal: $*" >&2
  exit 1
}

require_environment() {
  if [[ -z "${!1:-}" ]]; then
    fail "$1 is required by the local/CI edge mTLS rehearsal"
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
    --profile security-rehearsal \
    --profile edge "$@"
}

service_container_id() {
  local service="$1"
  local container_id

  container_id="$(compose ps -q "$service")" || fail "could not inspect Compose service '$service'"
  if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
    fail "expected exactly one existing '$service' container"
  fi
  printf '%s\n' "$container_id"
}

agent_delivered_fixture() {
  local started_at="$1"
  local logs

  logs="$(compose logs --no-color --since "$started_at" edge-agent 2>&1)" || return 1
  [[ "$logs" == *"Queued ingest batch delivered"* && "$logs" == *"sourceSystem:"*"$FIXTURE_SOURCE_SYSTEM"* ]]
}

if [[ "$base_compose" != "docker-compose.yml" || "$production_like_compose" != "docker-compose.production-like.yml" || "$security_rehearsal_compose" != "docker-compose.security-rehearsal.yml" ]]; then
  fail "only docker-compose.yml, docker-compose.production-like.yml, and docker-compose.security-rehearsal.yml are permitted"
fi
if [[ "${ODF_EDGE_MTLS_REHEARSAL_CONFIRM:-}" != "$REQUIRED_CONFIRMATION" ]]; then
  fail "set ODF_EDGE_MTLS_REHEARSAL_CONFIRM=${REQUIRED_CONFIRMATION} to confirm this local/CI-only delivery verification"
fi

for required_compose_file in "$base_compose" "$production_like_compose" "$security_rehearsal_compose"; do
  [[ -f "$required_compose_file" ]] || fail "required Compose file '$required_compose_file' is missing"
done

for required_command in docker grep sleep; do
  command -v "$required_command" >/dev/null 2>&1 || fail "$required_command is required"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

require_environment ODF_ENVOY_IMAGE
require_environment ODF_CONNECTOR_CLIENT_SECRET
require_environment ODF_INGRESS_TLS_CERT_FILE
require_environment ODF_INGRESS_TLS_KEY_FILE
require_environment ODF_INGRESS_CLIENT_CA_FILE
require_environment ODF_INGRESS_CLIENT_CERT_FILE
require_environment ODF_INGRESS_CLIENT_KEY_FILE

if [[ ! "$ODF_ENVOY_IMAGE" =~ ^[^[:space:]@]+@sha256:[[:xdigit:]]{64}$ ]]; then
  fail "ODF_ENVOY_IMAGE must be pinned to an image digest using @sha256:<64-hex-digits>"
fi
require_bounded_integer ODF_EDGE_MTLS_REHEARSAL_TIMEOUT_SECONDS "$rehearsal_timeout_seconds" 10 180

require_readable_file ODF_INGRESS_TLS_CERT_FILE "$ODF_INGRESS_TLS_CERT_FILE"
require_readable_file ODF_INGRESS_TLS_KEY_FILE "$ODF_INGRESS_TLS_KEY_FILE"
require_readable_file ODF_INGRESS_CLIENT_CA_FILE "$ODF_INGRESS_CLIENT_CA_FILE"
require_readable_file ODF_INGRESS_CLIENT_CERT_FILE "$ODF_INGRESS_CLIENT_CERT_FILE"
require_readable_file ODF_INGRESS_CLIENT_KEY_FILE "$ODF_INGRESS_CLIENT_KEY_FILE"

docker_endpoint="${DOCKER_HOST:-}"
if [[ -z "$docker_endpoint" ]]; then
  docker_context="$(docker context show 2>/dev/null)" || fail "could not determine the Docker context"
  docker_endpoint="$(docker context inspect "$docker_context" --format '{{ .Endpoints.docker.Host }}' 2>/dev/null)" \
    || fail "could not inspect the Docker context"
fi
case "$docker_endpoint" in
  unix://*|npipe://*|tcp://127.0.0.1:*|tcp://localhost:*) ;;
  tcp://docker:*)
    [[ -n "${CI:-}" ]] || fail "the Docker endpoint must be local; refusing '$docker_endpoint'"
    ;;
  *) fail "the Docker endpoint must be local; refusing '$docker_endpoint'" ;;
esac

compose config --quiet
configured_services="$(compose config --services)"
for required_service in api keycloak odf-mtls-gateway edge-agent; do
  if ! printf '%s\n' "$configured_services" | grep -Fxq "$required_service"; then
    fail "edge mTLS rehearsal Compose configuration is missing '$required_service'"
  fi
done

running_services="$(compose ps --services --status running)"
for required_service in api keycloak odf-mtls-gateway edge-agent; do
  if ! printf '%s\n' "$running_services" | grep -Fxq "$required_service"; then
    fail "'$required_service' must already be running; this script does not bootstrap a stack"
  fi
done

edge_agent_container="$(service_container_id edge-agent)"
edge_agent_started_at="$(docker inspect --format '{{.State.StartedAt}}' "$edge_agent_container")" \
  || fail "could not inspect the edge-agent container start time"
if [[ -z "$edge_agent_started_at" || "$edge_agent_started_at" == "0001-01-01T00:00:00Z" ]]; then
  fail "edge-agent container has no valid start time"
fi

for ((attempt = 0; attempt < rehearsal_timeout_seconds; attempt += 1)); do
  if agent_delivered_fixture "$edge_agent_started_at"; then
    echo "Edge-agent mTLS rehearsal passed: the running agent delivered the checked-in ${FIXTURE_SOURCE_SYSTEM} fixture through the local mTLS gateway."
    exit 0
  fi
  sleep 1
done

compose logs --no-color --tail=200 edge-agent odf-mtls-gateway >&2 || true
fail "timed out after ${rehearsal_timeout_seconds}s waiting for edge-agent to deliver the checked-in ${FIXTURE_SOURCE_SYSTEM} fixture"
