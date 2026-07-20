# ADR 0006: Tenant data plane and operations baseline

- Status: Accepted
- Date: 2026-07-11

## Context

The local-first runtime is intentionally SQLite-backed and process-local. ADR
0005 added a PostgreSQL workspace/history/audit/outbox foundation, but an
industrial production pilot also needs a tenant boundary, durable ingest
evidence, a canonical data model, quality evidence, and a safe path for any
future write-back action.

This decision is additive infrastructure only. It does not switch the current
API runtime to PostgreSQL, enable write-back, or change the public API. Those
changes require their own implementation and cutover tests.

## Decision

### Tenant scope and database context

Migration `003_tenant_industrial_data_plane.sql` introduces tenants, projects,
datasets, model spaces and a tenant-scoped industrial data plane. Every new
data-plane row has `tenant_id`; relevant rows also carry `project_id` and an
optional `dataset_id`. Composite foreign keys ensure a child cannot point at a
parent in a different tenant or project.

Tenant-scoped tables have RLS enabled and forced for the `odf_app` and
`odf_readonly` roles. A pooled application connection must use a short
transaction and set context transaction-locally:

```sql
BEGIN;
SET ROLE odf_app;
SELECT odf.set_tenant_context('00000000-0000-0000-0000-000000000000'::uuid);
-- tenant-scoped reads or writes
COMMIT;
```

`SET LOCAL` semantics are mandatory: a tenant setting must never leak from one
pooled connection request to another. The migrator and a future tenant
provisioning workflow are separate from application login roles. Existing
workspace/audit/outbox rows predate tenant scope; their API adapter/cutover must
add explicit tenant mapping before they are exposed in a multitenant runtime.

### Storage, replay and integrity

The data plane separates current state from immutable evidence:

- `raw_ingest_objects` references immutable object-storage bytes by URI and
  SHA-256; the database never stores an unbounded source payload inline.
- `ingestion_runs` and `quarantined_records` provide current operational state,
  while run events, checkpoint versions, time-series observations, quarantine
  events and provenance are append-only. A corrected observation is recorded
  with a new sequence rather than overwriting historical evidence.
- graph instances provide typed identities for assets, time series, documents
  and contextual relations. Candidate relations remain separate from accepted
  facts.
- model definitions/views, pipeline versions, pipeline run events and quality
  results are immutable history. Current pipeline and source configuration is
  deliberately mutable and auditable through the application/outbox layer.

The API must archive raw bytes before transform, write an idempotency key for
each source run, and make replay/quarantine resolution append events rather than
overwriting history. This implements the replay and quarantine obligations in
ADR 0002.

### Least privilege and write-back safety

The migration creates non-login roles:

- `odf_app`: tenant-scoped application reads/writes, no table deletion;
- `odf_readonly`: tenant-scoped read access; and
- `odf_outbox_publisher`: only reads/updates the outbox delivery state.

Operators create login roles in their secret manager/identity system and grant
one of these roles explicitly; no password is embedded in SQL. Future grants
must stay table-specific and must not use a superuser for the runtime.

Write-back is represented only as a request and immutable approval history.
The requester cannot approve their own request. Medium/low-risk requests need
one independent approval before entering `approved` or `executing`; high and
critical risk require two. A worker may execute only an already-approved
request, outside the database transaction that records its state.

### Broker and observability baseline

The primary Compose profile adds Redis with AOF persistence and `noeviction`,
which is suitable for a Redis Streams-backed outbox delivery worker. The
optional `workers` profile runs `outbox-worker` only after its dependent
`migrate` service has completed successfully. It requires `ODF_POSTGRES_URL`
for a dedicated login that inherits `odf_outbox_publisher`, plus
`ODF_REDIS_URL`; it must never receive the migrator/superuser database URL.
Redis is a delivery mechanism, not the source of truth: PostgreSQL outbox rows
remain authoritative until a publisher receives broker acknowledgement as
defined in ADR 0005.

The optional `observability` Compose profile provides an OpenTelemetry Collector
with OTLP receivers, Prometheus scrape/export configuration, a baseline
collector-down alert, and Grafana datasource provisioning. Prometheus uses a
mounted secret file as the Bearer credential for the API's `/metrics` endpoint.
For local Compose, `odf_metrics_token` reads `ODF_METRICS_TOKEN` from the host
environment; production must map an equivalent file from its secret manager.
The same secret is mounted into the API container and loaded at startup, rather
than being embedded in the Compose file.

When `ODF_OTEL_ENABLED` and an OTLP endpoint are configured, the API exports
auto-instrumented OTLP traces and redacted Pino request logs; the
production-like Compose overlay explicitly selects the Collector's HTTP/protobuf log
export for both API replicas and the outbox/pipeline workers. The API disables
automatic resource detection so logs and traces do not carry command arguments,
host data, or process-owner metadata; the explicit service name remains
available for correlation. The workers emit bounded redacted JSON logs through
process-local OTLP log emitters and expose Prometheus metrics plus
heartbeat-backed health checks. The production-like rehearsal sends a UUID
probe to each worker's internal health endpoint and requires that exact probe
to appear in the Collector's durable log buffer; it does not create business
data. Before production promotion, complete worker trace coverage, replace
local Grafana credentials, and configure durable external trace/log storage or
a managed collector backend.

`application-preview` is intentionally not a production profile. It builds
API/web containers to prove build contexts, but the API continues to use its
SQLite repository until the PostgreSQL adapter exists, and the static web image
needs an ingress to route `/api` to the API service.

## Operations

The minimum local infrastructure sequence is:

```powershell
$env:ODF_POSTGRES_ADMIN_PASSWORD = "secret-from-a-manager"
$env:ODF_REDIS_PASSWORD = "separate-secret-from-a-manager"
$env:ODF_METRICS_TOKEN = "separate-metrics-secret"
docker compose up -d odf-postgres odf-redis
docker compose --profile migrate run --rm migrate
# Use a dedicated login that is a member of odf_outbox_publisher. The host
# name must be resolvable from the worker container; use odf-postgres for this
# Compose topology and URL-encode special characters.
$env:ODF_POSTGRES_URL = "postgresql://odf_outbox_login:password@odf-postgres:5432/odf"
$env:ODF_REDIS_URL = "redis://:url-encoded-password@odf-redis:6379/0"
docker compose --profile workers up -d
docker compose --profile application-preview --profile observability up -d
python infra/postgres/scripts/validate_static.py
```

Production deployment must supply unique secret values, a network-isolated
PostgreSQL service, encrypted/object-versioned raw storage, TLS/mTLS at ingress
and edge boundaries, backup/restore drills, and broker lag/dead-letter alerting.
Compose is a reproducible baseline, not the HA deployment topology.

## Consequences

- The future PostgreSQL adapter has a concrete target schema and enforced
  tenant context rather than relying solely on API filters.
- Raw ingest and quality/context evidence can be replayed and audited without
  treating serving tables or Redis as the source of truth.
- Product work can add a model API, connector workers, search projections and
  an outbox publisher independently without revising the persistence boundary.
- The initial operational footprint is larger; production promotion now also
  requires role provisioning, RLS tests, object-storage policy, collector
  instrumentation and broker failure tests.
