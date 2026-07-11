# Open Data Fusion API

Backend vertical slice for industrial asset context, telemetry, ingestion, provenance, relation review, audit, and versioned Canvas workspaces.

## Run

Node.js 24 or newer is required because the database uses the built-in `node:sqlite` module.

```sh
npm install
npm run dev
```

The API listens on `http://localhost:4310` by default. Set `PORT`,
`ODF_DATABASE_PATH`, `ODF_OBJECT_STORE_PATH`, or `ODF_SEED=false` to override
runtime defaults. Production requires an explicit `ODF_OBJECT_STORE_PATH`.
Authentication profiles and OIDC variables are documented in
[`docs/security/authentication.md`](../../docs/security/authentication.md).

## SQLite workspace cutover

Generate the read-only source bundle first:

```powershell
npm run cutover:preflight -- `
  --database data/open-data-fusion.db `
  --output "$env:TEMP\odf-cutover-preflight.json"
```

Apply PostgreSQL migrations 001–004 and use a dedicated login that inherits the
non-login `odf_cutover` role. `ODF_POSTGRES_URL` is required and is deliberately
not accepted as a CLI argument. The command rejects superusers and verifies the
login's table and audit-sequence privileges. Rehearsal is non-destructive by
default:

```powershell
$env:ODF_POSTGRES_URL = "postgresql://odf_cutover_login:secret@localhost:5432/odf"
npm run cutover:import -- `
  --bundle "$env:TEMP\odf-cutover-preflight.json" `
  --database data/open-data-fusion.db
```

The importer verifies the bundle, current SQLite source, required migrations,
empty target tables, row counts, owner/revision invariants, and canonical target
checksums inside one transaction, then rolls back. `--database` is mandatory
with `--apply`, so the frozen source is checked again immediately before the
PostgreSQL connection opens. Add `--apply` to commit that same transaction in
the maintenance window. It preserves valid UUID correlation IDs and maps legacy
text IDs with `open-data-fusion.uuidv8.sha256.v1`, reporting a mapping checksum
for evidence.
Historical outbox events are intentionally not synthesized. This command does
not switch the API runtime to PostgreSQL.

## API

- `GET /health` and `GET /api/health`
- `GET /api/v1/assets?q=&type=&limit=&offset=`
- `GET /api/v1/assets/:externalId`
- `GET /api/v1/assets/:externalId/telemetry?from=&to=&timeSeriesExternalId=&limit=`
- `GET /api/v1/assets/:externalId/telemetry/latest?timeSeriesExternalId=&at=`
- `GET /api/v1/assets/:externalId/telemetry/aggregate?from=&to=&timeSeriesExternalId=&bucketMs=&aggregation=&limit=`
- `POST /api/ingest` and `POST /api/v1/ingest/bundle`
- `GET /api/v1/relations?status=proposed`
- `POST /api/v1/relations/:id/review`
- `GET /api/v1/audit?action=&entityType=&entityId=&limit=&offset=`
- `GET /api/v1/workspaces/:id`
- `PUT /api/v1/workspaces/:id` with `expectedVersion`, `actor`, `changeSummary`, and `snapshot`
- `GET /api/v1/workspaces/:id/revisions?limit=&offset=`
- `POST /api/v1/workspaces/:id/rollback` with `expectedVersion`, `targetVersion`, and `actor`
- `GET /api/v1/workspaces/:id/members`
- `PUT /api/v1/workspaces/:id/members/:userId` with owner-only `displayName` and `role`
- `DELETE /api/v1/workspaces/:id/members/:userId` (owner-only)
- `POST /api/v1/workspaces/:id/operations` with `baseVersion`, `changeSummary`, and semantic operations
- `GET /api/v1/workspaces/:id/events?user=` as a Server-Sent Events stream

### Platform catalog APIs

Project-scoped platform routes require both `x-odf-tenant-id` and
`x-odf-project-id`. The API verifies the authenticated user is a member of that
project before reading or writing any resource. New list endpoints use opaque
keyset cursors through `?limit=&cursor=` and return `nextCursor`.

- `GET|POST /api/v1/platform/tenants`
- `GET|POST /api/v1/platform/tenants/:tenantId/projects`
- `GET|POST /api/v1/platform/datasets`
- `GET|POST /api/v1/platform/sources`
- `GET|POST /api/v1/platform/connectors`
- `GET /api/v1/platform/data-models`
- `POST /api/v1/platform/data-models/:modelId/versions`
- `GET|POST /api/v1/platform/pipelines`
- `POST /api/v1/platform/pipelines/:pipelineId/runs`
- `GET /api/v1/platform/pipeline-runs`
- `GET|POST /api/v1/platform/quality-rules`
- `GET /api/v1/platform/quality-results`
- `GET|POST /api/v1/platform/contextualization/candidates`
- `POST /api/v1/platform/contextualization/candidates/:candidateId/review`
- `GET|POST /api/v1/platform/diagrams/tag-extractions`
- `GET|POST /api/v1/platform/matching/evaluations`
- `GET|POST /api/v1/platform/spatial/asset-links`
- `POST /api/v1/platform/spatial/asset-links/:linkId/review`
- `GET /api/v1/platform/project/members`
- `PUT|DELETE /api/v1/platform/project/members/:userId` (project owner plus `platform:admin`)
- `GET|POST /api/v1/platform/writeback/requests`
- `POST /api/v1/platform/writeback/requests/:requestId/approvals`
- `POST /api/v1/platform/writeback/requests/:requestId/execute`
- `GET /api/v1/platform/writeback/requests/:requestId/events`
- `GET /api/v1/platform/objects?limit=&cursor=`
- `POST /api/v1/platform/objects/:objectId/versions` with the raw request body
- `GET /api/v1/platform/objects/:objectId`
- `GET /api/v1/platform/objects/:objectId/versions`
- `GET|HEAD /api/v1/platform/objects/:objectId/content`
- `GET|HEAD /api/v1/platform/objects/:objectId/versions/:version/content`
- `GET /api/v1/platform/objects/:objectId/events`
- `GET /api/v1/platform/search?q=`

`data:read` allows project reads, `data:ingest` plus project owner/editor
allows catalog writes and pipeline triggers, and `relations:review` plus
owner/editor/reviewer allows candidate review. Creating tenants or projects
requires the global `platform:admin` permission. Connector configuration rejects
inline credential-shaped fields; store only secret references.

The local seed creates tenant `demo`, project `north-plant`, and mirrors the
four Canvas demo users into project roles. Existing seeded and newly ingested
assets are projected into unified search for that project. Other projects do
not inherit those assets.

### Advanced contextualization and industrial write-back

Diagram extraction stores the source-text SHA-256 and extracted P&ID tags, not
the submitted text. Matching evaluation persists precision/recall/F1 plus
score-ranked proposals; every ranked result remains `proposed` until a separate
review workflow accepts it. Spatial links require a finite 4x4 transform with a
non-zero homogeneous scale and permit one reviewer transition from `proposed`
to `accepted` or `rejected`.

Write-back uses independent verified permissions: `writeback:request`,
`writeback:approve`, and `writeback:execute`. All requests require non-empty
dry-run evidence. Operations must be allowlisted; the requester cannot approve
their own request; high-risk operations require at least two distinct
non-requester approvers; critical operations are always cancelled and cannot be
executed. Approval and event ledgers are append-only at the database layer.

The server profile is disabled by default. Configure policy with:

- `ODF_WRITEBACK_ENABLED=true`
- `ODF_WRITEBACK_ALLOWED_OPERATIONS=set.control_mode,reset.trip`
- `ODF_WRITEBACK_MAXIMUM_RISK=high`
- `ODF_WRITEBACK_REQUIRE_DRY_RUN=true` (cannot be disabled)
- `ODF_WRITEBACK_APPROVALS_LOW=1`, `ODF_WRITEBACK_APPROVALS_MEDIUM=1`,
  `ODF_WRITEBACK_APPROVALS_HIGH=2`

Enabling policy does not enable execution. `createApp` must also receive an
explicit `IndustrialWritebackExecutor`; otherwise the execution endpoint logs
the blocked attempt, leaves an approved request retryable, and returns HTTP 503.

### Governed objects and time-series serving

Object uploads are streamed directly to a mode-`0600` temporary file under the
configured store. The service enforces `ODF_OBJECT_STORE_MAX_BYTES`, calculates
SHA-256 while streaming, calls `fsync`, and atomically renames the completed
file to a server-generated scoped path. Client object IDs and file names never
become filesystem paths. Each upload creates an immutable numbered version and
append-only audit event; previous bytes remain addressable.

Upload metadata is supplied through `Content-Type`, `x-odf-file-name`, and
`x-odf-title`. Downloads return a strong hash ETag, support one bounded `bytes`
Range (including suffix ranges), and require both `data:read` and project
membership. Uploads require `data:ingest` plus project owner/editor role.

Only conservative passive MIME types (`text/plain`, CSV/TSV, and JSON/NDJSON)
are incrementally decoded as UTF-8 for search. HTML, SVG, scripts, XML, and
other active formats are stored as opaque bytes and are never executed or
parsed. Search uses SQLite FTS5 when available and automatically falls back to
the existing scoped `LIKE` index.

Latest and aggregate telemetry routes require `x-odf-tenant-id`,
`x-odf-project-id`, verified `data:read`, and project membership. Aggregation
uses epoch-aligned buckets and returns the selected `avg|min|max|sum|count`
value together with count, min/max/avg/sum, first/last values, and worst bucket
quality. The original raw telemetry endpoint and response remain unchanged.

Example bundle:

```json
{
  "source": {
    "system": "opcua-north-plant",
    "runId": "opcua-2026-07-10T14:00:00Z",
    "actor": "edge-connector"
  },
  "dataPoints": [
    {
      "timeSeriesExternalId": "P-101-PRESSURE",
      "timestamp": "2026-07-10T14:00:00Z",
      "value": 111.2,
      "quality": "good"
    }
  ]
}
```

`runId` is an idempotency key. Replaying the same run and payload returns `already_processed`; reusing it with a different payload returns HTTP 409.

## Workspace revisions

The seeded `cooling-water-system` workspace starts at version 1. Every successful `PUT` requires the caller's `expectedVersion`, writes a new immutable revision, and increments the current version. A stale save receives HTTP 409 instead of overwriting another user's changes.

Rollback is append-only: restoring revision 1 while the workspace is at version 4 creates version 5 containing revision 1's snapshot. Revisions 1–4 remain available for audit and future rollback.

### Collaborative editing

The development profile resolves the current workspace identity from `x-odf-user` and defaults to `harper.dennis`. Seeded members demonstrate four roles: owner, editor, reviewer, and viewer. Only owner/editor may mutate the Canvas; reviewer/viewer remain read-only. Owners can add, change, or remove members; the database rejects any change that would leave a workspace without an owner.

`POST /operations` accepts atomic batches of `moveNode`, `addNode`, `updateNode`, `removeNode`, `addEdge`, `updateEdge`, and `removeEdge`. Every batch must target the current `baseVersion`, produces one immutable revision and audit event, then publishes `workspace.updated` after commit. Stale batches return HTTP 409; invalid graph references return HTTP 422.

The SSE endpoint publishes committed workspace versions and best-effort online presence. Clients reconnect by reloading the workspace and comparing version numbers. The in-memory hub is a local single-process profile; production horizontal scaling requires a shared event transport. In OIDC mode the API verifies bearer signature, issuer, audience, expiry, algorithm, and the configured identity claim; development header/query identities are ignored.

## Verify

```sh
npm run typecheck
npm test
npm run build
```

The default suite uses a recording transaction client. To exercise the exact
import SQL against a migrated, empty PostgreSQL database and a non-superuser
cutover login, set `ODF_TEST_CUTOVER_POSTGRES_URL`; the live test still uses the
rollback-only rehearsal path.
