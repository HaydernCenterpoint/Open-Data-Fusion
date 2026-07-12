# Operational telemetry and SLOs

## Durable local evidence

Prometheus stores metrics on `odf-prometheus-data`. The OpenTelemetry Collector
writes bounded, rotating OTLP JSON trace and log buffers to `odf-otel-data`:
100 MiB per active file, seven days, and ten backups. These volumes support
credential-free incident rehearsal and provider outages; production should
also export to an authenticated, replicated telemetry backend.

The collector image runs as UID/GID `10001`; the one-shot
`otel-storage-init` service establishes ownership without running the collector
as root. Treat telemetry as sensitive because paths, tenant identifiers, and
error context may appear even though credentials must be redacted.

## Initial objectives

| Surface | Indicator | Objective |
| --- | --- | --- |
| API availability | non-5xx / completed requests | 99.9% over 30 days |
| API latency | p95 request duration | below 1 second |
| Outbox freshness | oldest deliverable event | below 5 minutes |
| Outbox correctness | dead-letter rows | zero unresolved |
| Broker connectivity | Redis client ready | continuously ready |

The availability alerts implement 14x fast-burn and 6x slow-burn checks against
the 0.1% error budget. Low/no traffic produces no false error consumption.
Review route-specific objectives once production traffic establishes a useful
baseline; aggregate latency can hide a slow ingest or download route.

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
