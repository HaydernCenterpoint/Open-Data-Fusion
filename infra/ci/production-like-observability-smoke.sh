#!/usr/bin/env bash
# Verifies the production-like Compose telemetry path without starting, stopping,
# reconfiguring, or altering any service or volume. It uses the Compose network
# and docker cp rather than assuming a Docker host volume path.

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd -- "${script_directory}/../.." && pwd)"
compose_base="${ODF_COMPOSE_BASE:-${repository_root}/docker-compose.yml}"
compose_production_like="${ODF_COMPOSE_PRODUCTION_LIKE:-${repository_root}/docker-compose.production-like.yml}"
target_timeout_seconds="${ODF_OBSERVABILITY_TARGET_TIMEOUT_SECONDS:-60}"
trace_timeout_seconds="${ODF_OBSERVABILITY_TRACE_TIMEOUT_SECONDS:-45}"
require_pipeline="${ODF_OBSERVABILITY_REQUIRE_PIPELINE:-false}"
collector_data_path="/var/lib/otel"

compose() {
  docker compose \
    -f "${compose_base}" \
    -f "${compose_production_like}" \
    --profile production-like \
    --profile workers \
    --profile observability \
    "$@"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' is not available"
}

require_positive_integer() {
  local name="$1"
  local value="$2"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || fail "${name} must be a positive integer"
}

require_boolean() {
  local name="$1"
  local value="$2"
  case "${value}" in
    true|false) ;;
    *) fail "${name} must be true or false" ;;
  esac
}

container_id_for_service() {
  local service="$1"
  local container_id

  container_id="$(compose ps -q "${service}")" || fail "Could not inspect Compose service '${service}'"
  [[ -n "${container_id}" && "${container_id}" != *$'\n'* ]] || fail "Expected exactly one existing '${service}' container; start production-like and observability services first"
  [[ "$(docker inspect --format '{{.State.Running}}' "${container_id}")" == "true" ]] || fail "Compose service '${service}' is not running"
  printf '%s\n' "${container_id}"
}

collector_health_report() {
  compose exec -T api node --input-type=module -e '
    const response = await fetch("http://otel-collector:13133/");
    if (!response.ok) throw new Error(`Collector health endpoint returned HTTP ${response.status}`);
    process.stdout.write("Collector health endpoint is ready\n");
  '
}

prometheus_target_report() {
  compose exec -T -e "ODF_SMOKE_REQUIRE_PIPELINE=${require_pipeline}" api node --input-type=module -e '
    const endpoint = new URL("/api/v1/targets", "http://prometheus:9090");
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`Prometheus targets API returned HTTP ${response.status}`);
    const payload = await response.json();
    const active = payload?.data?.activeTargets;
    if (!Array.isArray(active)) throw new Error("Prometheus targets API returned no activeTargets array");

    const requiredJobs = ["otel-collector", "open-data-fusion-api", "open-data-fusion-outbox"];
    if (process.env.ODF_SMOKE_REQUIRE_PIPELINE === "true") requiredJobs.push("open-data-fusion-pipeline");
    const statuses = requiredJobs.map((job) => {
      const target = active.find((candidate) => candidate?.labels?.job === job);
      if (!target) return { job, health: "missing", lastError: "target is absent" };
      return { job, health: target.health, lastError: target.lastError || "" };
    });
    const unhealthy = statuses.filter((status) => status.health !== "up");
    if (unhealthy.length > 0) {
      throw new Error(unhealthy.map((status) => `${status.job}=${status.health}${status.lastError ? ` (${status.lastError})` : ""}`).join("; "));
    }
    process.stdout.write(`${statuses.map((status) => `${status.job}=up`).join(", ")}\n`);
  '
}

wait_for_collector_health() {
  local attempt report=""
  for ((attempt = 1; attempt <= target_timeout_seconds; attempt += 1)); do
    if report="$(collector_health_report 2>&1)"; then
      printf '%s\n' "${report}"
      return 0
    fi
    sleep 1
  done
  fail "Collector health endpoint did not become ready within ${target_timeout_seconds}s. Last result: ${report:-no response}"
}

wait_for_prometheus_targets() {
  local attempt report=""
  for ((attempt = 1; attempt <= target_timeout_seconds; attempt += 1)); do
    if report="$(prometheus_target_report 2>&1)"; then
      printf 'Prometheus targets healthy: %s\n' "${report}"
      return 0
    fi
    sleep 1
  done
  fail "Prometheus did not report healthy Collector, API, and outbox targets within ${target_timeout_seconds}s. Last result: ${report:-no response}"
}

collector_volume_name() {
  local mount
  mount="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/otel"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "${collector_container_id}")"
  [[ "${mount}" == volume:* ]] || fail "Collector data path '${collector_data_path}' is not mounted from a Docker volume"
  local volume_name="${mount#volume:}"
  [[ -n "${volume_name}" ]] || fail "Collector data volume has no name"
  docker volume inspect "${volume_name}" >/dev/null || fail "Collector data volume '${volume_name}' cannot be inspected"
  printf '%s\n' "${volume_name}"
}

copy_collector_snapshot() {
  rm -rf -- "${collector_snapshot_directory}"
  mkdir -p -- "${collector_snapshot_directory}"
  docker cp "${collector_container_id}:${collector_data_path}/." "${collector_snapshot_directory}" >/dev/null \
    || fail "Could not copy Collector telemetry data from its mounted volume"
}

trace_file_for_id() {
  local trace_id="$1"
  local file
  for file in "${collector_snapshot_directory}"/traces.json*; do
    [[ -f "${file}" ]] || continue
    if grep -Fq -- "${trace_id}" "${file}"; then
      printf '%s\n' "${file##*/}"
      return 0
    fi
  done
  return 1
}

log_file_for_correlation_id() {
  local correlation_id="$1"
  local file
  for file in "${collector_snapshot_directory}"/logs.json*; do
    [[ -f "${file}" ]] || continue
    if grep -Fq -- "${correlation_id}" "${file}"; then
      printf '%s\n' "${file##*/}"
      return 0
    fi
  done
  return 1
}

trace_context() {
  compose exec -T api node -e '
    const { randomBytes } = require("node:crypto");
    const traceId = randomBytes(16).toString("hex");
    const parentSpanId = randomBytes(8).toString("hex");
    process.stdout.write(`${traceId} 00-${traceId}-${parentSpanId}-01\n`);
  '
}

generate_correlation_id() {
  compose exec -T api node -e '
    const { randomUUID } = require("node:crypto");
    process.stdout.write(`${randomUUID()}\n`);
  '
}

trigger_traced_health_request() {
  local service="$1"
  local context trace_id traceparent

  context="$(trace_context)" || fail "Could not create a W3C trace context"
  read -r trace_id traceparent <<< "${context}"
  [[ "${trace_id}" =~ ^[0-9a-f]{32}$ && "${traceparent}" =~ ^00-[0-9a-f]{32}-[0-9a-f]{16}-01$ ]] \
    || fail "Generated an invalid W3C trace context"

  compose exec -T -e "ODF_SMOKE_TRACEPARENT=${traceparent}" "${service}" node --input-type=module -e '
    const traceparent = process.env.ODF_SMOKE_TRACEPARENT;
    const port = process.env.PORT || "4310";
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { traceparent },
    });
    if (!response.ok) throw new Error(`API health request returned HTTP ${response.status}`);
  ' || fail "Traced health request through '${service}' failed"

  printf 'Triggered traced /health request through %s with trace ID %s\n' "${service}" "${trace_id}" >&2
  printf '%s\n' "${trace_id}"
}

trigger_logged_health_request() {
  local service="$1"
  local correlation_id="$2"

  [[ "${correlation_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || fail "Generated an invalid UUID correlation ID"

  compose exec -T -e "ODF_SMOKE_CORRELATION_ID=${correlation_id}" "${service}" node --input-type=module -e '
    const correlationId = process.env.ODF_SMOKE_CORRELATION_ID;
    const port = process.env.PORT || "4310";
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "x-correlation-id": correlationId },
    });
    if (!response.ok) throw new Error(`API health request returned HTTP ${response.status}`);
    if (response.headers.get("x-correlation-id") !== correlationId) {
      throw new Error("API did not preserve the generated correlation ID");
    }
  ' || fail "Logged health request through '${service}' failed"

  printf 'Triggered logged /health request through %s with correlation ID %s\n' "${service}" "${correlation_id}" >&2
}

trigger_worker_log_probe() {
  local service="$1"
  local port="$2"
  local probe_id="$3"

  [[ "${probe_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || fail "Generated an invalid worker observability probe ID"
  [[ "${service}" =~ ^[a-z0-9-]+$ && "${port}" =~ ^[1-9][0-9]*$ ]] \
    || fail "Worker observability probe has an invalid service or port"

  compose exec -T \
    -e "ODF_SMOKE_WORKER_SERVICE=${service}" \
    -e "ODF_SMOKE_WORKER_PORT=${port}" \
    -e "ODF_SMOKE_WORKER_PROBE_ID=${probe_id}" \
    api node --input-type=module -e '
      const service = process.env.ODF_SMOKE_WORKER_SERVICE;
      const port = process.env.ODF_SMOKE_WORKER_PORT;
      const probeId = process.env.ODF_SMOKE_WORKER_PROBE_ID;
      const response = await fetch(`http://${service}:${port}/healthz`, {
        headers: { "x-odf-observability-probe": probeId },
      });
      if (!response.ok) throw new Error(`Worker health probe returned HTTP ${response.status}`);
    ' || fail "Worker observability probe through '${service}' failed"

  printf 'Triggered worker observability probe through %s with probe ID %s\n' "${service}" "${probe_id}" >&2
}

wait_for_durable_trace() {
  local service="$1"
  local trace_id="$2"
  local attempt trace_file=""

  for ((attempt = 1; attempt <= trace_timeout_seconds; attempt += 1)); do
    copy_collector_snapshot
    if trace_file="$(trace_file_for_id "${trace_id}")"; then
      printf 'Durable trace evidence for %s: %s in volume %s\n' "${service}" "${trace_file}" "${collector_volume}"
      return 0
    fi
    sleep 1
  done
  fail "Trace ID ${trace_id} from '${service}' was not found in Collector traces.json output within ${trace_timeout_seconds}s"
}

wait_for_durable_log() {
  local service="$1"
  local correlation_id="$2"
  local attempt log_file=""

  for ((attempt = 1; attempt <= trace_timeout_seconds; attempt += 1)); do
    copy_collector_snapshot
    if log_file="$(log_file_for_correlation_id "${correlation_id}")"; then
      printf 'Durable API log evidence for %s: %s in volume %s\n' "${service}" "${log_file}" "${collector_volume}"
      return 0
    fi
    sleep 1
  done
  fail "Correlation ID ${correlation_id} from '${service}' was not found in Collector logs.json output within ${trace_timeout_seconds}s"
}

wait_for_durable_worker_log() {
  local service="$1"
  local probe_id="$2"
  local attempt log_file=""

  for ((attempt = 1; attempt <= trace_timeout_seconds; attempt += 1)); do
    copy_collector_snapshot
    if log_file="$(log_file_for_correlation_id "${probe_id}")"; then
      printf 'Durable worker log evidence for %s: %s in volume %s\n' "${service}" "${log_file}" "${collector_volume}"
      return 0
    fi
    sleep 1
  done
  fail "Worker observability probe ID ${probe_id} from '${service}' was not found in Collector logs.json output within ${trace_timeout_seconds}s"
}

require_command docker

require_positive_integer ODF_OBSERVABILITY_TARGET_TIMEOUT_SECONDS "${target_timeout_seconds}"
require_positive_integer ODF_OBSERVABILITY_TRACE_TIMEOUT_SECONDS "${trace_timeout_seconds}"
require_boolean ODF_OBSERVABILITY_REQUIRE_PIPELINE "${require_pipeline}"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/odf-observability-smoke.XXXXXX")"
collector_snapshot_directory="${temporary_directory}/collector"
cleanup() {
  rm -rf -- "${temporary_directory}"
}
trap cleanup EXIT INT TERM

api_container_id="$(container_id_for_service api)"
replica_container_id="$(container_id_for_service api-replica)"
outbox_container_id="$(container_id_for_service outbox-worker)"
collector_container_id="$(container_id_for_service otel-collector)"
prometheus_container_id="$(container_id_for_service prometheus)"
pipeline_container_id=""
if [[ "${require_pipeline}" == "true" ]]; then
  pipeline_container_id="$(container_id_for_service pipeline-worker)"
fi
# Keep the service checks above explicit: their IDs also make failures name the
# missing dependency before any network or trace assertion is attempted.
: "${api_container_id}" "${replica_container_id}" "${outbox_container_id}" "${prometheus_container_id}" "${pipeline_container_id}"

collector_volume="$(collector_volume_name)"
printf 'Collector durable telemetry volume: %s\n' "${collector_volume}"

wait_for_collector_health
wait_for_prometheus_targets

outbox_worker_probe_id="$(generate_correlation_id)"
trigger_worker_log_probe outbox-worker 9465 "${outbox_worker_probe_id}"
wait_for_durable_worker_log outbox-worker "${outbox_worker_probe_id}"

if [[ "${require_pipeline}" == "true" ]]; then
  pipeline_worker_probe_id="$(generate_correlation_id)"
  trigger_worker_log_probe pipeline-worker 9466 "${pipeline_worker_probe_id}"
  wait_for_durable_worker_log pipeline-worker "${pipeline_worker_probe_id}"
fi

api_trace_id="$(trigger_traced_health_request api)"
wait_for_durable_trace api "${api_trace_id}"

replica_trace_id="$(trigger_traced_health_request api-replica)"
wait_for_durable_trace api-replica "${replica_trace_id}"

api_log_correlation_id="$(generate_correlation_id)"
trigger_logged_health_request api "${api_log_correlation_id}"
wait_for_durable_log api "${api_log_correlation_id}"

printf 'Production-like observability rehearsal passed.\n'
