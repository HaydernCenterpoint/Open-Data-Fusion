# Operational telemetry and SLOs

## Durable local evidence

Prometheus stores metrics on `odf-prometheus-data`. The OpenTelemetry Collector
writes bounded, rotating OTLP JSON trace and log buffers to `odf-otel-data`:
100 MiB per active file, seven days, and ten backups. These volumes support
credential-free incident rehearsal and provider outages; production should
also export to an authenticated, replicated telemetry backend.

The collector image runs as UID/GID `10001`; the one-shot
`otel-storage-init` service establishes ownership without running the collector
as root. The production-like APIs send OTLP traces and redacted Pino request
logs when the Collector profile is selected. The production-like Compose overlay explicitly
enables HTTP/protobuf OTLP log export for the outbox and pipeline workers. The
Pino and worker logging boundaries bound fields, redact credential-shaped values
before serialization, and omit automatically detected command, host, and
process metadata from the shared trace/log resource. The `file/logs` exporter
is therefore proven for API request logs and bounded worker health probes in
the local/CI rehearsal. It is not complete application-log storage: treat
telemetry as sensitive because paths, tenant identifiers, and error context may
appear even though credentials must be redacted.

## Production-like observability rehearsal

The production-like API and API replica export OTLP traces and redacted Pino
request logs to the Collector at `otel-collector:4318`. They deliberately do not
depend on the Collector, so migration and dependency bootstrap remain possible
before the optional `observability` profile is started. Select that profile for
the final rehearsal so the configured endpoint is available before traced and
logged requests are generated.

After completing the production-like role/bootstrap procedure, start the final
rehearsal with both profiles selected:

```bash
docker compose -f docker-compose.yml -f docker-compose.production-like.yml \
  --profile production-like --profile workers --profile observability up -d --wait
bash infra/ci/production-like-observability-smoke.sh
```

The smoke script does not start, stop, reconfigure, or delete services or
volumes. It uses Compose service names and `docker cp` from the Collector
container rather than assuming a Docker host-volume path. It sends a generated
UUID in the internal `x-odf-observability-probe` header to a worker health
endpoint; the worker emits one bounded, redacted `observability_probe` record,
without creating business data. It verifies that:

1. the Collector health endpoint is reachable inside the Compose network;
2. Prometheus reports its Collector, API, and outbox targets as `up`;
3. the Collector's `/var/lib/otel` mount is a Docker volume; and
4. a generated UUID probe sent to the outbox worker appears in durable
   `logs.json*` output; the pipeline worker receives the same proof when
   `ODF_OBSERVABILITY_REQUIRE_PIPELINE=true`;
5. unique W3C trace IDs from public `/health` requests to both API replicas
   appear in the durable `traces.json*` output; and
6. a generated UUID correlation ID from an API `/health` request appears in
   durable `logs.json*` output.

Successful output records the healthy target names, Collector volume name,
trace IDs, correlation ID, and matching trace/log files. Preserve that terminal
output with the rehearsal evidence. The files remain subject to the bounded
100 MiB active-file, seven-day, and ten-backup retention described above, so
capture required incident evidence before rotation. Set
`ODF_OBSERVABILITY_TARGET_TIMEOUT_SECONDS` (default `60`) or
`ODF_OBSERVABILITY_TRACE_TIMEOUT_SECONDS` (default `45`) only when a slower
environment needs a longer bounded wait; the latter bounds both trace and log
file searches.

This proves the checked-in Compose rehearsal's local trace/log buffers and
scrape path for API request logs plus redacted worker probe logs. It does
**not** establish external production trace/log durability, replication,
backup, retention compliance, alert delivery, or a managed telemetry backend.

## Initial objectives

| Surface | Indicator | Objective |
| --- | --- | --- |
| API availability | non-5xx / completed requests | 99.9% over 30 days |
| API latency | p95 request duration | below 1 second |
| Outbox freshness | oldest deliverable event | below 5 minutes |
| Outbox correctness | dead-letter rows | zero unresolved |
| Broker connectivity | Redis client ready | continuously ready |
| Pipeline worker liveness | fresh successful polling cycle | complete a healthy cycle within the configured heartbeat window |

The availability alerts implement 14x fast-burn and 6x slow-burn checks against
the 0.1% error budget. Low/no traffic produces no false error consumption.
Review route-specific objectives once production traffic establishes a useful
baseline; aggregate latency can hide a slow ingest or download route.

## Pipeline worker telemetry and response

When the `workers` and `observability` profiles run together, Prometheus scrapes
`pipeline-worker:9466/metrics` over the internal Compose network. The port is
not published to the host. Docker health checks call `/healthz`, which returns
`200` only after a successful polling cycle has written a fresh heartbeat; it
returns `503` during startup, after a failed/stalled cycle, or when the
heartbeat cannot be read.

`OdfPipelineWorkerDown` fires when a previously healthy metrics target is
unreachable for five minutes. This avoids a permanent critical alert when a
pipeline worker is intentionally not deployed; deployment readiness must still
confirm the target is `up` whenever the worker is enabled.
`OdfPipelineWorkerStale` fires when
`odf_pipeline_last_successful_cycle_timestamp_seconds` is more than 60 seconds
old for five minutes. The shipped threshold is intentionally stricter than the
default 30-second heartbeat age. If a deployment raises
`ODF_PIPELINE_POLL_MS` or `ODF_PIPELINE_HEALTH_MAX_AGE_MS`, keep the health-age
constraint of at least two poll intervals and deploy a matching staleness rule;
the checked-in alert is not dynamically reconfigured from container
environment variables.

For either alert, first verify `/healthz`, the scrape target, and the worker's
redacted JSON logs. Then investigate PostgreSQL reachability, the
least-privilege pipeline login, configured tenant/project scopes, and recent
`scope_claim_failed`, `poll_failed`, or `pipeline_run_failed` events before
restarting the worker. A transition conflict is recorded separately and is not
itself an unhealthy cycle.

These metrics are worker-wide and intentionally have no tenant, project,
pipeline, or run-ID labels. They show completed-cycle health and processed-run
outcomes, not queued-run depth or age; zero claimed runs does not prove that no
work is waiting outside the configured scopes.

## Incident use

1. Confirm scrape health before trusting an empty graph.
2. Correlate API request logs by correlation ID and outbox events by event ID.
3. Preserve the relevant Prometheus blocks and rotated OTLP JSON files before
   retention removes them.
4. Never include credentials, bearer tokens, raw payloads, or object-store
   signed URLs in telemetry.
5. After resolution, verify alert clearance, backlog drain, and the last
   successful outbox cycle timestamp.

Back up dashboard/rule configuration in Git and test rule syntax before deploy.
Named volumes are not a durable production backup; snapshot or remote-write
them under the organisation's retention policy.
