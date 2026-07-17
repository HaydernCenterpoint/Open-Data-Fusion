<p align="center">
  <img src="apps/web/public/favicon.svg" alt="Open Data Fusion logo" width="168" />
</p>

<h1 align="center">Open Data Fusion</h1>

<p align="center">
  <strong>Governed industrial data integration, contextualization, and visual collaboration.</strong>
</p>

<p align="center">
  Connect source data, preserve provenance, review semantic relationships, explore telemetry,
  and compose operational context on a versioned Industrial Canvas.
</p>

<p align="center">
  <a href="https://github.com/HaydernCenterpoint/Open-Data-Fusion/actions/workflows/ci.yml"><img src="https://github.com/HaydernCenterpoint/Open-Data-Fusion/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
  <a href="https://github.com/HaydernCenterpoint/Open-Data-Fusion/actions/workflows/infra-validate.yml"><img src="https://github.com/HaydernCenterpoint/Open-Data-Fusion/actions/workflows/infra-validate.yml/badge.svg" alt="Infrastructure validation status" /></a>
  <a href="https://github.com/HaydernCenterpoint/Open-Data-Fusion/actions/workflows/security.yml"><img src="https://github.com/HaydernCenterpoint/Open-Data-Fusion/actions/workflows/security.yml/badge.svg" alt="Security workflow status" /></a>
  <img src="https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24 or newer" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-0B6FFB" alt="Apache 2.0 license" /></a>
  <img src="https://img.shields.io/badge/status-pre--release-C77A08" alt="Pre-release status" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#product-capabilities">Capabilities</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#security">Security</a> ·
  <a href="#sqlite-to-postgresql-cutover">Cutover</a> ·
  <a href="#roadmap-and-product-boundaries">Roadmap</a>
</p>

> [!WARNING]
> Open Data Fusion is pre-release software. Do not connect it to a production OT network or use it to execute industrial control actions without an independent security, safety, and operational review.

> [!IMPORTANT]
> Open Data Fusion is independently designed and implemented. It is not affiliated with, endorsed by, or compatible by default with Cognite Data Fusion.

## Overview

Open Data Fusion is an open-source platform for building trustworthy industrial data products. Its current vertical slice connects:

- read-only, checkpointed source collection;
- idempotent ingestion and immutable raw evidence;
- assets, time series, documents, and provenance;
- reviewable contextualization candidates and accepted relations;
- governed project catalogs, pipelines, and quality evidence;
- an accessible Asset Explorer and responsive Industrial Canvas;
- immutable workspace revisions, audit history, and collaboration events;
- OIDC authentication, server-side authorization, and least-privilege infrastructure foundations.

The project is deliberately **local-first**, but it no longer requires demonstration data. A clean start creates an empty, durable SQLite database; `ODF_SEED=true` is an explicit opt-in for the legacy UI/collaboration fixture. `ODF_DATA_PERSISTENCE=sqlite|postgres` selects one authoritative backend per process. In the PostgreSQL profile, the industrial core, Canvas, tenant/project administration, catalog compatibility contracts, advanced product records, cross-surface search projection, and write-back records all use PostgreSQL with forced row-level security where applicable. The profile never falls through to a replica-local SQLite store or dual-writes an authoritative product record.

Tenant bootstrap remains intentionally separate: creating an initial tenant is
an audited provisioning workflow, while governed tenant/project updates and
membership administration run through the PostgreSQL administration boundary.
PostgreSQL replicas also use tenant/project-scoped raw-landing and
governed-object metadata with a shared private S3-compatible object store;
they never use a replica-local filesystem for those bytes. Industrial
write-back execution remains deliberately gated by allowlisted policy,
independent approvals, and an externally supplied executor; PostgreSQL stores
the request, approval, safety, and event evidence even when execution is not
configured.

### Design principles

1. **Evidence before convenience** — accepted writes retain source identity, correlation, provenance, model version, and audit evidence.
2. **Review before truth** — contextualization and matching produce candidates; they do not silently become trusted facts.
3. **One source of truth** — projections are rebuildable, and application code must not independently dual-write authoritative stores.
4. **Fail closed** — missing identity, project scope, policy, approvals, secrets, or executors blocks the operation.
5. **Local-first, production-aware** — the development profile is simple, while contracts and migrations preserve a path to a multi-instance deployment.
6. **Clean-room implementation** — code, contracts, UI, branding, examples, and tests are independently created.

## Product preview

### Asset Explorer

Search the industrial hierarchy, inspect timestamp-aware telemetry, review properties and contextualization evidence, and navigate related time series, documents, and relations.

![Open Data Fusion Asset Explorer](docs/design/open-data-fusion-explorer-implementation.jpg)

### Industrial Canvas

Compose assets, telemetry, documents, and diagrams on a semantic workspace with edit operations, immutable revisions, optimistic concurrency, role-aware collaboration, inspection, and rollback.

![Open Data Fusion Industrial Canvas](docs/design/open-data-fusion-canvas-implementation.jpg)

The Explorer and Canvas adapt to narrow screens with drawer navigation, bottom-sheet inspection, scroll-safe charts, keyboard controls, and preserved access to review and revision actions.

## Product capabilities

Status legend:

- **Available** — implemented and exercised in the default local profile.
- **Optional** — implemented but requires explicit infrastructure or identity configuration.
- **Foundation** — schema/runtime components exist, but the main product runtime is not fully cut over.
- **Gated** — intentionally constrained by review, policy, or safety boundaries.

| Area | Status | Current capability |
| --- | --- | --- |
| Asset Explorer | **Available** | Hierarchy search, asset details, telemetry, documents, relations, lineage, and related-data drawers |
| Industrial Canvas | **Available** | Move, add, edit, resize, connect, delete, undo/redo, keyboard positioning, inspector, layers, revisions, and rollback |
| Collaboration | **Available** | Owner/editor/reviewer/viewer roles, owner-managed membership, optimistic concurrency, presence, and committed SSE updates |
| Ingestion | **Available** | Project-scoped, atomic, idempotent asset, time-series, data-point, document, and relation bundles with provenance and audit on SQLite or PostgreSQL |
| Governed objects | **Available** | Immutable versions, streamed upload/download, SHA-256, strong ETags, bounded ranges, scoped access, audit events, and required server-side encryption; PostgreSQL uses shared versioned S3-compatible bytes plus forced-RLS metadata |
| Telemetry serving | **Available** | SQLite- or PostgreSQL-backed raw, latest/as-of, and bounded aggregate queries with timestamp-derived charts and quality propagation |
| Tenant/project discovery | **Available** | Backend-aligned, membership-scoped tenant/project selection; PostgreSQL returns active UUID scopes only |
| Platform administration and catalogs | **Optional** | PostgreSQL governs project/tenant administration, memberships, datasets, sources, connectors, legacy model/pipeline/quality/context records, and write-back ledgers without SQLite fallback; initial tenant bootstrap remains operator-controlled |
| Contextualization | **Gated** | Candidate assertions, confidence/evidence, explicit accept/reject review, and immutable review evidence |
| Diagrams, matching, spatial | **Gated** | Text/tag extraction, proposal-ranked matching evaluation, and reviewable 4×4 spatial links |
| Industrial write-back | **Gated** | Dry-run evidence, allowlisted operations, separation of duties, risk-based approvals, and external executor injection |
| OIDC and Keycloak | **Optional** | Authorization Code + PKCE, JWT verification, authenticated SSE, permission claims, and a reproducible local realm |
| Edge collection | **Optional** | Read-only CSV, PostgreSQL, and OPC UA collection with checkpoints, durable local queueing, OAuth delivery, and retry |
| PostgreSQL industrial core | **Optional** | Tenant/project-scoped assets, telemetry, relations, audit, and bundle ingest through a least-privilege API role with forced RLS |
| PostgreSQL Canvas persistence | **Optional** | Tenant/project-scoped workspace reads and writes, immutable revisions/audit, transactional outbox, and Redis-backed committed events |
| PostgreSQL product surfaces | **Optional** | Migration-gated PostgreSQL adapters cover administration, catalog compatibility, diagrams, matching, spatial links, cross-surface search, and write-back records; live connector and deployment rehearsal remain separate gates |
| Workers and broker | **Optional** | Outbox worker publishes committed PostgreSQL events to Redis Streams; API replicas fan out shared Canvas events and the pipeline remains explicitly scoped/gated |
| Observability | **Optional** | Redacted structured API logs, Prometheus metrics, optional OTLP traces, collector, alerts, Prometheus, and Grafana baseline |
| SQLite workspace cutover | **Foundation** | Deterministic Canvas-history preflight, transactional dry-run import, frozen-source verification, checksums, and explicit apply gate |

## Architecture

```mermaid
flowchart TB
    Browser[Browser] --> Web[React and Vite web app]
    Web --> API[TypeScript REST API]

    Sources[CSV, PostgreSQL, OPC UA sources] --> Edge[Read-only edge agent]
    Edge --> API

    subgraph Selected[One selected authoritative data backend]
        SQLite[(SQLite product records)]
        PG[(PostgreSQL industrial, Canvas, platform surfaces, RLS, and outbox)]
    end

    API -->|ODF_DATA_PERSISTENCE=sqlite| SQLite
    API -->|ODF_DATA_PERSISTENCE=postgres| PG

    API --> SSE[In-process SSE and presence]

    subgraph SharedObjects[PostgreSQL shared object boundary]
        ObjectMetadata[(PostgreSQL raw/governed metadata and RLS)]
        Objects[(Private versioned S3-compatible objects)]
    end
    PG --> ObjectMetadata
    API --> Objects

    subgraph SharedEvents[PostgreSQL multi-instance delivery]
        Pipeline[Pipeline worker] --> PG
        PG --> Outbox[Outbox worker]
        Outbox --> Redis[(Redis Streams)]
        Redis --> API
    end

    API -. OTLP traces .-> Collector[OpenTelemetry Collector]
    API -. protected metrics .-> Prometheus[Prometheus]
    Collector --> Prometheus
    Prometheus --> Grafana[Grafana]
```

### Data integrity model

```mermaid
flowchart TD
    A[Read source batch] --> B[Archive immutable raw evidence]
    B --> C[Apply idempotency and schema checks]
    C --> D[Write canonical state and provenance]
    D --> E[Create immutable audit evidence]
    E -. PostgreSQL mutation .-> J[Create transactional outbox intent]
    D --> F[Generate contextualization candidates]
    F --> G{Explicit review}
    G -->|Accept| H[Trusted relation]
    G -->|Reject| I[Retained rejection evidence]
```

Key invariants:

- ingest `runId` values are idempotency keys; omitted keys are deterministically derived from normalized bundle content;
- accepted writes carry source, model, correlation, provenance, and audit metadata;
- workspace mutations target a `baseVersion` or `expectedVersion` and reject stale writes with HTTP 409;
- rollback appends a new revision and never rewrites earlier history;
- candidate relations remain separate from accepted relations;
- tenant-scoped PostgreSQL tables force row-level security;
- Redis is a delivery mechanism, not the source of truth;
- historical outbox events are not synthesized during the SQLite workspace cutover.

## Technology stack

| Layer | Technology |
| --- | --- |
| Web | React 18, TypeScript, Vite 8, Testing Library, Lucide |
| API | Node.js 24, TypeScript, Express 5, Zod, built-in `node:sqlite` |
| Identity | OIDC/OAuth 2.0, `jose`, Keycloak development realm |
| Production persistence foundation | PostgreSQL 17, JSONB, forced RLS, transactional outbox, private versioned S3-compatible object storage |
| Shared event delivery | Redis Streams with AOF and `noeviction` |
| Edge | CSV, read-only PostgreSQL, OPC UA, SQLite store-and-forward queue |
| Observability | Pino, Prometheus client, OpenTelemetry, Prometheus, Grafana |
| Quality and supply chain | Vitest, TypeScript, CodeQL, dependency review, npm audit, SPDX SBOM |
| License | Apache License 2.0 |

## Quick start

### Prerequisites

| Requirement | Version | Needed for |
| --- | ---: | --- |
| Node.js | 24 or newer | API, web app, workers, tests |
| npm | 11 or newer | Workspace installation and scripts |
| Python | 3.x | Static infrastructure validation |
| Docker + Compose | Optional | PostgreSQL, Redis, Keycloak, workers, and observability profiles |

### 1. Clone and install

```bash
git clone https://github.com/HaydernCenterpoint/Open-Data-Fusion.git
cd Open-Data-Fusion
npm ci
```

Create the local environment file:

```bash
# macOS or Linux
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

### 2. Select the SQLite real-data profile

Set the following value in `.env`:

```text
ODF_DATA_PERSISTENCE=sqlite
```

Leave `ODF_SEED` unset for a clean database. SQLite is the supported embedded,
single-API-instance profile; it persists data at `ODF_DATABASE_PATH` and does
not require Docker.

### 3. Start the application

```bash
npm run dev
```

| Service | URL |
| --- | --- |
| Web application | <http://localhost:5173> |
| API | <http://localhost:4310> |
| Health | <http://localhost:4310/health> |
| Readiness | <http://localhost:4310/ready> |
| Metrics | <http://localhost:4310/metrics> |

The first run on a new `ODF_DATABASE_PATH` creates the schema only. It does not
create sample tenants, projects, assets, telemetry, or workspaces. Disabling
`ODF_SEED` does not erase records from a database that was seeded previously;
use a new path or an explicit reviewed data-retention/migration procedure.

### 4. Create a tenant and project

The development identity has the permissions needed for local bootstrap. These
example identifiers are ordinary user-created records, not built-in demo data:

```bash
curl -fsS -X POST http://localhost:4310/api/v1/platform/tenants \
  -H "content-type: application/json" \
  -H "x-odf-user: local-user" \
  --data '{"id":"acme-industries","name":"Acme Industries"}'

curl -fsS -X POST http://localhost:4310/api/v1/platform/tenants/acme-industries/projects \
  -H "content-type: application/json" \
  -H "x-odf-user: local-user" \
  --data '{"id":"site-a","name":"Site A","description":"Primary production site"}'
```

Create the project's first empty, versioned Canvas. The caller becomes its
owner and the operation writes scope, revision, and audit evidence atomically:

```bash
curl -fsS -X POST http://localhost:4310/api/v1/workspaces \
  -H "content-type: application/json" \
  -H "x-odf-user: local-user" \
  -H "x-odf-tenant-id: acme-industries" \
  -H "x-odf-project-id: site-a" \
  --data '{"id":"site-a-operations","name":"Site A operations"}'
```

Set `VITE_WORKSPACE_ID=site-a-operations` in the root `.env` and restart the
web process to open that real Canvas. PostgreSQL exposes the same API to an
active project owner through a narrowly scoped database bootstrap function;
no demo seed or direct workspace-table write is required.

### 5. Ingest a real measurement bundle

Every industrial data request is tenant/project scoped. Replace the source,
external IDs, timestamp, and value with records from your connector or source
system. Use a new stable `runId` for each source batch:

```bash
curl -fsS -X POST http://localhost:4310/api/v1/ingest/bundle \
  -H "content-type: application/json" \
  -H "x-odf-user: local-user" \
  -H "x-odf-tenant-id: acme-industries" \
  -H "x-odf-project-id: site-a" \
  --data '{
    "source":{"system":"site-a-opcua","runId":"site-a-opcua-2026-07-12T10:00:00Z"},
    "assets":[{"externalId":"COMPRESSOR-101","name":"Main air compressor","type":"compressor"}],
    "timeSeries":[{"externalId":"COMPRESSOR-101-DISCHARGE-PRESSURE","assetExternalId":"COMPRESSOR-101","name":"Discharge pressure","unit":"bar"}],
    "dataPoints":[{"timeSeriesExternalId":"COMPRESSOR-101-DISCHARGE-PRESSURE","timestamp":"2026-07-12T10:00:00Z","value":7.42,"quality":"good"}]
  }'
```

Replaying the same `runId` and payload is idempotent. Reusing a `runId` with a
different payload is rejected with HTTP 409. If `runId` is omitted, the API
derives a stable `content-<sha256>` key, making an identical connector retry
idempotent without inventing a time-based identifier.

For PostgreSQL, do not reuse the SQLite catalog bootstrap above. Follow the
[production-like runbook](docs/operations/postgres-canvas-production-like.md)
to apply migrations, provision UUID tenant/project membership, register the
active source connection, and run the same scoped ingest/read-back check.

### 6. Open the ingested asset

```text
http://localhost:5173/?view=explorer&asset=COMPRESSOR-101&tenant=acme-industries&project=site-a
```

Supported `view` values:

```text
canvas | explorer | sources | pipelines | models | context |
diagrams | matching | spatial | writeback | audit
```

The route keeps the active surface, selected asset, tenant, and project synchronized with browser history. Unknown query parameters are preserved for the OIDC flow.

### Optional demonstration fixture

In the SQLite profile, set `ODF_SEED=true` only when you intentionally need the
repository's legacy tenant/Canvas fixture for UI or role testing. The scoped
industrial adapter deliberately does not reinterpret legacy demo asset tables;
populate Explorer data through the real bundle-ingest path above. The legacy
Canvas fixture supports these development identities:

| Query parameter | Workspace role | Capability |
| --- | --- | --- |
| `?user=harper.dennis` | Owner | Edit and manage members |
| `?user=riley.chen` | Editor | Edit workspace content |
| `?user=monica.reyes` | Reviewer | Read and review history |
| `?user=samantha.lee` | Viewer | Read only |

> [!CAUTION]
> `?user=` and `x-odf-user` are development-only identity mechanisms. OIDC mode ignores them and requires a verified bearer token.

## Product surfaces

| Surface | Purpose |
| --- | --- |
| Canvas | Build a versioned industrial view from assets, time series, documents, diagrams, and semantic links |
| Explorer | Search and inspect assets, telemetry, documents, relations, lineage, and provenance |
| Sources | Register governed source systems and secret references |
| Pipelines | Define versions, trigger runs, and inspect deterministic run history |
| Models | Manage canonical model definitions and immutable model versions |
| Context | Review contextualization candidates before they become accepted relations |
| Diagrams | Extract and retain evidence for text-based P&ID tag candidates |
| Matching | Evaluate ranked proposals with precision, recall, and F1 without automatic acceptance |
| Spatial | Review asset-to-space links with validated 4×4 transforms |
| Write-back | Request, approve, and externally execute policy-gated industrial actions |
| Audit | Inspect append-only operational and governance history |

## API and data model

The API exposes four main groups:

| Group | Examples |
| --- | --- |
| Industrial data | Assets, time series, raw/latest/aggregate telemetry, documents, relations, provenance |
| Ingestion and evidence | Idempotent bundle ingest, immutable raw landing records, replay, quarantine, audit |
| Canvas collaboration | Workspaces, semantic operations, members, revisions, rollback, SSE events |
| Governed platform | Tenants, projects, datasets, sources, connectors, models, pipelines, quality, diagrams, matching, spatial, write-back, objects, and search |

Project-scoped platform routes require both `x-odf-tenant-id` and `x-odf-project-id`. The API verifies the authenticated identity's permissions and project membership before data access.

> [!NOTE]
> In the PostgreSQL profile, `GET /api/v1/platform/tenants` and
> `GET /api/v1/platform/tenants/:tenantId/projects` read PostgreSQL through
> membership-scoped discovery, so Explorer can select scopes created by
> `tenant:provision`. Initial tenant creation remains fail-closed at the API,
> while governed tenant/project administration, catalogs, compatibility
> records, advanced surfaces, search, and governed objects use PostgreSQL
> without SQLite fallback.

See [`apps/api/README.md`](apps/api/README.md) for the endpoint catalog, request contracts, ingest example, storage behavior, and write-back policy variables.

## Authentication and authorization

Authentication and authorization are separate boundaries:

1. the identity provider verifies the caller and resolves a `userId` plus permissions;
2. project membership scopes platform data;
3. workspace membership grants an owner/editor/reviewer/viewer role;
4. write-back permissions and approval policy are checked independently.

### Local development

The default local profile uses `ODF_AUTH_MODE=development`. It is intended only for local testing.

### OIDC resource server

Minimal API configuration:

```text
ODF_AUTH_MODE=oidc
ODF_OIDC_ISSUER=https://identity.example.com/realms/open-data-fusion
ODF_OIDC_AUDIENCE=open-data-fusion-api
ODF_OIDC_JWKS_URI=https://identity.example.com/realms/open-data-fusion/protocol/openid-connect/certs
```

Minimal browser configuration:

```text
VITE_OIDC_AUTHORITY=https://identity.example.com/realms/open-data-fusion
VITE_OIDC_CLIENT_ID=open-data-fusion-web
VITE_OIDC_SCOPE=openid profile email data:read relations:review audit:read
VITE_OIDC_USER_CLAIM=sub
```

| Permission | Capability |
| --- | --- |
| `data:read` | Read assets, telemetry, objects, and relations |
| `data:ingest` | Submit governed ingest and object data |
| `relations:review` | Accept or reject contextualization candidates |
| `audit:read` | Read audit and ingestion evidence |
| `platform:admin` | Create tenant/project boundaries in SQLite; PostgreSQL uses the separate provisioning workflow |
| `writeback:request` | Create a governed write-back request |
| `writeback:approve` | Approve or reject another identity's request |
| `writeback:execute` | Execute only after every policy and approval gate passes |

After injecting `KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME`,
`KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD`, `ODF_DEMO_USER_PASSWORD`, and
`ODF_CONNECTOR_CLIENT_SECRET` from a local secret source, start the reproducible
development Keycloak realm with:

```bash
npm run infra:identity
```

Full configuration and threat-boundary notes are in [`docs/security/authentication.md`](docs/security/authentication.md) and [`infra/keycloak/README.md`](infra/keycloak/README.md).

## Configuration overview

The root `.env` is read by the API and Vite development processes. Important variables include:

| Variable | Purpose |
| --- | --- |
| `PORT` | API port; defaults to `4310` |
| `ODF_DATABASE_PATH` | SQLite database path for the embedded profile |
| `ODF_DATA_PERSISTENCE` | Select exactly one authoritative product backend: `sqlite` or `postgres`; required explicitly in production |
| `ODF_SEED` | Set to `true` to opt into the legacy SQLite UI/Canvas fixture; unset/false starts clean |
| `ODF_AUTH_MODE` | `development` or `oidc` |
| `ODF_RAW_LANDING_PATH` | Local immutable raw landing directory |
| `ODF_OBJECT_STORE_PATH` | Governed object storage path; required in production mode |
| `ODF_OBJECT_STORE_MAX_BYTES` | Maximum object upload size |
| `ODF_METRICS_TOKEN` | Optional locally; required by the production API profile |
| `ODF_OTEL_ENABLED` | Process-level switch; set to `false` to disable configured OTLP tracing |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Process-level OpenTelemetry Collector endpoint |
| `VITE_API_URL` | Browser API base URL; same-origin when empty |
| `VITE_WORKSPACE_USER` | Default development workspace identity |
| `VITE_WORKSPACE_ID` | Optional configured Canvas workspace ID; no demonstration workspace is selected by default |
| `ODF_WORKSPACE_PERSISTENCE` | Legacy compatibility setting; if supplied, it must equal `ODF_DATA_PERSISTENCE` |
| `ODF_API_POSTGRES_URL` | Dedicated non-superuser PostgreSQL API login inheriting `odf_app` only |
| `ODF_SHARED_EVENTS_REQUIRED` | Require Redis shared delivery; set `true` for multi-instance PostgreSQL Canvas use |
| `ODF_OUTBOX_POSTGRES_URL` | Dedicated outbox-publisher login inheriting `odf_outbox_publisher` only |
| `ODF_TENANT_PROVISION_POSTGRES_URL` | Dedicated bootstrap login with migration-read plus security-definer execute only (inherits `odf_tenant_provisioner`); used by `tenant:provision` |
| `ODF_REDIS_URL` | Authenticated Redis URL for the API shared-event transport and outbox worker |

API tracing initializes before the server loads the repository-root `.env`. Export `ODF_OTEL_ENABLED` and `OTEL_EXPORTER_OTLP_ENDPOINT` in the shell/container environment (or provide an API-workspace environment file) rather than relying only on the root `.env` for these two values.

Never commit `.env`, tokens, passwords, client secrets, certificates, customer data, or production connection strings.

## Optional infrastructure profiles

Docker Compose is a reproducible development and validation baseline, not a highly available production topology.

| Profile/service | Purpose | Command |
| --- | --- | --- |
| PostgreSQL | Start the PostgreSQL 17 foundation | `npm run infra:postgres` |
| Migrations | Verify checksums and apply numbered migrations | `npm run infra:migrate` |
| Identity | Start the local Keycloak realm | `npm run infra:identity` |
| `workers` | Run the migration gate and explicitly configured outbox/pipeline workers | [Configure worker identities, URLs, scopes, and executor first](#running-workers) |
| `edge` | Run the configured read-only edge agent with its required preview API dependency | [Configure source, identity, and delivery endpoints first](#edge-ingestion) |
| `observability` | Start collector, Prometheus, and Grafana | `docker compose --profile observability up -d` |
| `application-preview` | Build preview API/web containers; an ingress or reverse proxy is still required | `docker compose --profile application-preview up -d` |
| `production-like` | PostgreSQL industrial core and Canvas + Redis Streams + Keycloak + two API replicas + outbox worker | [Bootstrap roles, then run the profile](docs/operations/postgres-canvas-production-like.md) |

Before starting infrastructure, supply unique secrets through the environment or a secret manager. Runtime workers must use dedicated login roles; never reuse the migrator or superuser URL.

> [!NOTE]
> `application-preview` explicitly uses `ODF_DATA_PERSISTENCE=sqlite` and starts without demonstration data. The static web image has no `/api` reverse proxy, so the browser UI cannot reach the API until an ingress/proxy routes `/api` to port `4310`. The profile proves container build contexts and service startup; it is not a functional standalone deployment or the PostgreSQL production cutover.

The [`production-like` runbook](docs/operations/postgres-canvas-production-like.md) documents the separate least-privilege API/outbox logins, required tenant/project UUID headers for industrial-core and Canvas calls, a real bundle-ingest check, and the multi-instance outbox/Redis/SSE rehearsal. The [Production Pilot Gate runbook](docs/operations/production-pilot-gate.md) explains how a managed-staging operator and independent reviewer record and evaluate immutable read-only pilot evidence. The [shared object-storage runbook](docs/operations/shared-object-storage.md) covers the versioned S3-compatible boundary, recovery, and credential rotation. Local/CI validation alone does not certify an internet-facing production deployment.

### Running workers

The `workers` profile is intentionally fail-closed. Do not start it with the default empty URLs/scopes or disabled executor: the processes will terminate and Compose will restart them.

After migrations and purpose-specific login roles are provisioned, supply at least:

```powershell
# Login inheriting only odf_outbox_publisher.
$env:ODF_POSTGRES_URL = "postgresql://odf_outbox_login:password@odf-postgres:5432/odf"
$env:ODF_REDIS_URL = "redis://:password@odf-redis:6379/0"

# Separate application login with the required tenant-scoped PostgreSQL grants.
$env:ODF_PIPELINE_POSTGRES_URL = "postgresql://odf_pipeline_login:password@odf-postgres:5432/odf"
$env:ODF_PIPELINE_SCOPES = '[{"tenantId":"00000000-0000-4000-8000-000000000001","projectId":"00000000-0000-4000-8000-000000000002"}]'
$env:ODF_PIPELINE_EXECUTOR = "builtin"

docker compose --profile workers up -d
```

Replace the example UUIDs with real migration-003 tenant/project IDs authorized for the pipeline identity. `builtin` explicitly enables the bounded built-in DAG executor; `disabled` remains the safe default.

## Edge ingestion

The edge agent reads bounded batches without mutating the source, archives raw records, atomically advances a local checkpoint with its queued bundle, and delivers outbound with OAuth 2.0 client credentials.

Supported connector profiles:

- **CSV** — file identity, processed-row checkpoint, and boundary hash detect replacement, truncation, or rewriting;
- **PostgreSQL** — one deterministic read-only `SELECT`/`WITH` query with checkpoint and limit parameters;
- **OPC UA** — configurable security, environment-backed credentials, node mapping/scaling, quality conversion, and per-node timestamp checkpoints.

If the API is unavailable, archived bundles and checkpoints remain in the local SQLite queue. Delivery retries use bounded exponential backoff and graceful shutdown retains unfinished work.

The Compose edge service depends on the preview API, so enable both profiles after replacing the example API/token/source endpoints and supplying every referenced credential:

```powershell
docker compose --profile application-preview --profile edge up -d api edge-agent
```

The checked-in `config.example.json` contains documentation-only hostnames and is not runnable unchanged. See [`apps/edge-agent/README.md`](apps/edge-agent/README.md) and [`apps/edge-agent/config.example.json`](apps/edge-agent/config.example.json).

## SQLite-to-PostgreSQL cutover

`ODF_DATA_PERSISTENCE` switches the industrial core and Canvas together; a
process cannot run a SQLite industrial core with a PostgreSQL Canvas, or vice
versa. New installations can start directly on either backend. The repository
also includes a one-way, rehearsable **workspace-history-only** import described
by [ADR 0005](docs/architecture/0005-postgresql-cutover-and-transactional-outbox.md).

> [!CAUTION]
> The importer below does not migrate existing SQLite assets, time series,
> telemetry points, relations, platform catalog records, governed objects, or
> advanced-product records. Before switching an established system to
> `ODF_DATA_PERSISTENCE=postgres`, separately rehearse a source replay/backfill
> for industrial data and retain SQLite for the surfaces that still require it.
> Do not enable dual-write as a migration shortcut.

### 1. Create a deterministic preflight bundle

From the repository root:

```powershell
npm run cutover:preflight --workspace @open-data-fusion/api -- `
  --database data/open-data-fusion.db `
  --output "$env:TEMP\odf-cutover-preflight.json"
```

The source is opened read-only. Workspace, revision, membership, and audit reads run inside one SQLite read transaction. The bundle is written only after schema, JSON, timestamp, owner, revision, count, and checksum validation succeeds.

The v1 format applies one operator-supplied target project to every imported
workspace. It therefore refuses any source that already contains immutable
SQLite `workspace_scopes`; this prevents scoped workspaces from being silently
coalesced into the wrong PostgreSQL project. Extend and rehearse a scope-aware
bundle format before cutting over such a deployment.

### 2. Apply PostgreSQL migrations

```powershell
$env:ODF_POSTGRES_ADMIN_PASSWORD = "use-a-secret-manager-generated-value"
npm run infra:postgres
npm run infra:migrate
```

Migration 004 creates the non-login `odf_cutover` role. Provision a separate login that inherits only this role for the maintenance window.

### 3. Run the rollback-only rehearsal

```powershell
$env:ODF_POSTGRES_URL = "postgresql://odf_cutover_login:password-from-secret-manager@localhost:5432/odf"
npm run cutover:import --workspace @open-data-fusion/api -- `
  --bundle "$env:TEMP\odf-cutover-preflight.json" `
  --database data/open-data-fusion.db
```

Dry-run is the default. The importer:

- rejects superusers and principals with privileges outside `odf_cutover`;
- verifies required migrations and an empty target;
- rereads and compares the SQLite source when `--database` is supplied;
- uses a serializable PostgreSQL transaction and advisory lock;
- inserts all source datasets and validates counts, owners, current revisions, and canonical checksums;
- rolls back every inserted row;
- does not call non-transactional `setval` during rehearsal.

### 4. Apply only inside the frozen maintenance window

Regenerate and rehearse a final bundle after the SQLite writer is read-only. Then run:

```powershell
npm run cutover:import --workspace @open-data-fusion/api -- `
  --bundle "$env:TEMP\odf-cutover-preflight.json" `
  --database data/open-data-fusion.db `
  --apply
```

`--database` is mandatory with `--apply`. Any schema, count, or checksum drift is rejected before PostgreSQL is opened. Legacy non-UUID correlation IDs use the versioned deterministic mapping `open-data-fusion.uuidv8.sha256.v1`.

The importer does **not** generate historical outbox events. Configure
`ODF_DATA_PERSISTENCE=postgres` only after the final workspace import,
industrial-data backfill plan, migration/role verification, and outbox delivery
rehearsal succeed. If `ODF_WORKSPACE_PERSISTENCE` remains in deployment
configuration, set it to `postgres` as well. Remove the cutover login's role
membership after evidence and validation are retained.

## Development and validation

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start API and web development servers |
| `npm run dev:edge` | Start the edge agent in watch mode |
| `npm run dev:outbox` | Start the outbox worker in watch mode |
| `npm run dev:pipeline` | Start the pipeline worker in watch mode |
| `npm run typecheck` | Type-check every workspace |
| `npm test` | Run every workspace test suite |
| `npm run build` | Build every workspace and the production web bundle |
| `npm run infra:validate` | Verify migration checksums, RLS, Compose, Docker, and observability guardrails |
| `npm run pilot:gate -- <command>` | Validate, initialize, record, attest, and evaluate a managed-staging Production Pilot Gate |
| `npm run infra:production-like` | Start the PostgreSQL industrial-core/Canvas, Redis, Keycloak, two-replica validation topology (requires explicit secrets and dedicated URLs) |
| `npm run check` | Run typecheck, tests, builds, and infrastructure validation |
| `npm run check:release` | Add dependency audit and full dependency-tree validation |
| `npm run sbom` | Generate an SPDX software bill of materials |

Before opening a pull request, run:

```bash
npm run check
```

CI also performs:

- Node.js 24 workspace verification;
- migration and Compose validation;
- PostgreSQL migration idempotency and live runtime probes;
- production-like PostgreSQL scope discovery, industrial bundle ingest/idempotency, cross-replica asset/telemetry read-back, scoped raw/audit evidence, Canvas update, outbox-to-Redis delivery, OIDC, replica SSE, and least-privilege role smoke;
- API, web, outbox-worker, and edge-agent container builds;
- dependency license policy checks;
- `npm audit` at high severity;
- CodeQL analysis and pull-request dependency review;
- SPDX SBOM generation.

## Repository layout

```text
apps/
  api/                 Express API, SQLite/PostgreSQL product adapters, compatibility stores, cutover tooling, auth
  web/                 React/Vite Explorer, Canvas, and governed product surfaces
  edge-agent/          Read-only connectors and durable store-and-forward delivery
  outbox-worker/       PostgreSQL outbox to Redis Streams publisher
  pipeline-worker/     Scoped PostgreSQL pipeline and quality worker

packages/
  contracts/           Shared domain and API contracts
  platform-core/       Context, quality, matching, spatial, merge, and safety logic
  postgres-runtime/    Typed PostgreSQL repositories and transaction boundary

infra/
  keycloak/            Reproducible local OIDC realm and clients
  postgres/            Numbered migrations, role policy, and static validator
  observability/       OTel Collector, Prometheus, Grafana, and alert configuration

docs/
  architecture/        Architecture decision records
  design/              Design system and implementation screenshots
  operations/          Production-like validation and recovery runbooks
  security/            Authentication and authorization documentation

scripts/               Dependency and release guardrails
```

## Architecture decisions

| ADR | Decision |
| --- | --- |
| [0001](docs/architecture/0001-local-first-vertical-slice.md) | Start with a real local-first vertical slice |
| [0002](docs/architecture/0002-source-of-truth-and-projections.md) | Separate immutable evidence, canonical truth, and rebuildable projections |
| [0003](docs/architecture/0003-clean-room-branding.md) | Maintain independent product, branding, contracts, and implementation |
| [0004](docs/architecture/0004-collaborative-canvas-operations.md) | Use semantic operations, immutable revisions, and optimistic concurrency |
| [0005](docs/architecture/0005-postgresql-cutover-and-transactional-outbox.md) | Use a rehearsed one-way cutover and transactional outbox |
| [0006](docs/architecture/0006-tenant-data-plane-and-operations-baseline.md) | Establish tenant RLS, industrial data plane, and operations baseline |

Additional references:

- [API documentation](apps/api/README.md)
- [PostgreSQL runtime contract](packages/postgres-runtime/README.md)
- [PostgreSQL industrial-core and Canvas production-like runbook](docs/operations/postgres-canvas-production-like.md)
- [Production Pilot Gate managed-staging runbook](docs/operations/production-pilot-gate.md)
- [Shared PostgreSQL object-storage runbook](docs/operations/shared-object-storage.md)
- [Design system](docs/design/design-system.md)
- [Authentication profiles](docs/security/authentication.md)
- [Technical direction and pilot criteria](open-data-fusion-technical-report-source.md)

## Roadmap and product boundaries

### Current vertical slice

- [x] Local persistent ingest, provenance, contextualization, audit, and telemetry
- [x] Project-scoped SQLite and PostgreSQL adapters for assets, telemetry, relations, audit, and atomic bundle ingest
- [x] Backend-aligned tenant/project discovery with active membership filtering in PostgreSQL
- [x] Responsive Explorer and semantic Canvas
- [x] Versioned collaboration, roles, presence, SSE, and rollback
- [x] OIDC resource-server and browser PKCE flows
- [x] Edge connectors with durable checkpointing and delivery
- [x] Governed objects, search, latest/aggregate telemetry, and raw replay
- [x] Tenant PostgreSQL schema, forced RLS, typed repositories, industrial-core and Canvas adapters, shared Redis event delivery, worker implementations, and workspace cutover rehearsal
- [x] PostgreSQL tenant/project administration, catalog compatibility, advanced product records, cross-surface search projection, and write-back evidence with no SQLite fallback
- [x] CI, security workflows, SBOM, container builds, and observability baseline

### Next production gates

- [x] Switch Canvas/workspace reads and writes together to the PostgreSQL runtime, with Redis-backed multi-instance event delivery
- [x] Switch asset, telemetry, relation, audit, and ingest reads/writes to PostgreSQL with `ODF_DATA_PERSISTENCE=postgres`, without dual-write
- [x] Add an audited, least-privilege tenant/project bootstrap workflow with an explicit dry-run/apply gate
- [x] Move raw landing and governed-object metadata/content to PostgreSQL plus shared versioned S3-compatible storage without dual-write
- [x] Persist governed PostgreSQL tenant/project administration and project membership workflows; retain initial tenant bootstrap as a separate operator boundary
- [x] Move platform catalog compatibility, cross-surface search/indexing, advanced-product API records, and write-back ledgers to PostgreSQL without SQLite fallback
- [x] Add a provider-neutral Production Pilot Gate runner, immutable evidence contract, and managed-staging operator runbook
- [ ] Rehearse backup/restore, broker failure, dead-letter, and multi-instance concurrency beyond the CI industrial/Canvas/outbox smoke
- [ ] Complete production ingress, TLS/mTLS, secret-manager, and network-isolation design
- [ ] Add durable trace/log storage, worker telemetry, SLOs, and operational runbooks
  - The local/CI Collector rehearsal proves redacted API and worker log delivery; replicated or managed retention, backup, compliance retention, and alert delivery remain required to close this gate.
- [ ] Validate live design-partner CSV, JDBC/PostgreSQL, and OPC UA connector backfill, resume, authentication, and schema-evolution behavior in the target deployment

### Intentionally gated

- critical write-back requests remain non-executable;
- other write-back requests require an external executor, allowlisted policy, dry-run evidence, and independent approvals;
- matching output remains proposal-only;
- diagram extraction is currently text/tag based rather than full P&ID computer vision;
- Spatial is a lightweight review workflow rather than a production 3D engine;
- high-contention collaborative editing uses optimistic conflict handling rather than CRDT/OT;
- offline merge logic is not integrated into the product runtime;
- autonomous ML acceptance, full P&ID parsing, and production 3D remain pilot-gated.

## Security

Read [`SECURITY.md`](SECURITY.md) before deploying or reporting a vulnerability.

Security defaults include:

- read-only connectors and outbound-only edge delivery;
- no inline connector credentials;
- verified OIDC bearer tokens for exposed deployments;
- independent data-plane permissions and workspace roles;
- forced PostgreSQL tenant RLS;
- append-only audit and revision history;
- redacted structured logs and protected metrics;
- fail-closed write-back policy and separation of duties;
- dependency review, CodeQL, license policy, audit, and SBOM workflows.

Report vulnerabilities privately to the maintainers. Do not publish credentials, exploit details, customer data, plant data, or unsafe reproduction steps in a public issue.

## Contributing

Contributions are welcome when they preserve the project's clean-room, provenance, safety, and governance boundaries.

1. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and the relevant ADRs.
2. Create a focused branch.
3. Add tests for behavior, malformed inputs, authorization boundaries, duplicate delivery, and schema evolution where relevant.
4. Run `npm run check`.
5. Open a pull request describing behavior changes, risks, and validation evidence.

Public API, persistence, security-boundary, model, and license changes require an ADR.

## License and independence

Open Data Fusion is licensed under the [Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for attribution information.

The project name, brand mark, source code, contracts, UI, documentation, sample data, and test corpus are independently created. Public comparisons may discuss industrial outcomes, but must not imply affiliation, endorsement, shared implementation, or API compatibility with Cognite or any other vendor.
