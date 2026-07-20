# Data Modeling and Graph Query Design

**Date:** 2026-07-17

**Status:** Approved design; pending written-spec review

**Branch:** `feat/data-modeling-query`

## Decision

Build the first clean-room functional-parity slice after the Production Pilot
Gate by turning the existing model registry and PostgreSQL graph foundation
into a usable, selected-backend Data Modeling service. The slice will support
versioned models and views, schema-validated node and edge upserts, bounded REST
query/traversal/aggregation, and a Model Explorer UI.

The implementation extends the existing API, authorization, persistence,
audit, outbox, and web patterns. It adds no graph database, microservice,
GraphQL runtime, or third-party dependency. PostgreSQL remains the production
foundation; SQLite exposes the same public REST behavior for the local profile.
Neither backend dual-writes to the other.

This is clean-room functional parity. Public behavior is designed from the
project's own contracts and outcome requirements; it is not an API, UI, text,
or branding clone of another product.

## Goals

1. Let a project owner or editor create an immutable model version, add typed
   node/edge views while it is a draft, and publish it.
2. Let an authorized ingest identity atomically upsert a bounded batch of
   instances that conform to an exact published model/view version.
3. Let project readers filter, project, sort, page, aggregate, and traverse
   those instances without submitting SQL or an unbounded graph program.
4. Preserve identical scope, authorization, idempotency, audit, and event
   behavior across the SQLite and PostgreSQL profiles.
5. Make the complete model-to-instance-to-query flow inspectable from the
   existing Models workspace.

## Non-goals

- GraphQL, a GraphQL compatibility layer, or arbitrary client-defined schemas.
- A visual schema designer or graph visualization engine.
- Neo4j, another graph database, or a separate graph service.
- Arbitrary SQL, regular-expression filters, user-defined functions, graph
  algorithms, or traversals deeper than three hops.
- Instance deletion, schema migration, automatic breaking-change repair, or
  cross-model joins in this slice.
- Transformations, scheduled workflows, Functions, P&ID vision, 3D processing,
  simulations, robotics, or AI agents. Those remain separate parity slices.

## Existing foundation

The PostgreSQL schema already contains project-scoped `data_models`,
`model_views`, and `graph_instances` tables under forced RLS. The runtime
already provides immutable model/view creation and an idempotent graph-instance
anchor. The public platform API and web app already expose append-only model
versions through compatibility records. The new slice connects and extends
these foundations instead of adding a parallel model store.

The current SQLite `PlatformStore` remains the local authoritative catalog. It
will gain only the additional view, graph-instance, and batch-idempotency tables
needed to implement the same REST contract.

## Architecture

### Selected-backend boundary

Add a `ModelGraphPersistence` contract at the existing API persistence
boundary. It has two implementations:

- PostgreSQL delegates to the existing PostgreSQL runtime and extends
  `PostgresModelRepository` with retrieval, publication, view listing,
  instance upsert, query, traversal, and aggregate operations.
- SQLite extends `PlatformStore` with equivalent operations and tables.

Application startup selects exactly one implementation from
`ODF_DATA_PERSISTENCE`. A PostgreSQL process never falls back to SQLite, and no
request writes both implementations.

Shared validation and query-contract parsing live with the existing platform
core/contracts code. Backend adapters receive a validated bounded query rather
than raw request JSON. PostgreSQL compiles that query to parameterized SQL;
SQLite compiles the same contract to parameterized SQLite SQL.

### Public and internal identities

The public model key is `(project, modelId, version)`, where `modelId` uses the
existing platform identifier grammar and `version` is a server-assigned
positive integer. A view is keyed by `(modelId, version, externalId)`.
Instances use stable `(space, externalId)` keys within a project.

PostgreSQL may continue using UUID primary keys internally. The adapter resolves
the project's existing default model space, stores `modelId` as the model
external ID, and stores the public integer version as text in the normalized
model table. Every instance `space` is likewise resolved from the project's
existing model-space external IDs before a transaction writes or queries an
instance. Internal UUIDs never leak through the REST contract.

### Model lifecycle

A model version starts as `draft`. Views may be added only while it is a draft.
Publishing is a one-way state transition. A published version, its views, and
their property definitions are immutable. A changed schema requires a new
model version.

The existing create-version request is extended with an optional `views` array.
For backward compatibility it may include `status: "published"` only when that
array contains the complete view set and model plus views can be created
atomically. Otherwise the caller creates a draft, adds views, and calls the
publish endpoint.

## View and instance contract

### View definition

A view contains:

```json
{
  "externalId": "Equipment",
  "name": "Equipment",
  "usedFor": "node",
  "properties": {
    "name": { "type": "text", "required": true },
    "ratedPressure": { "type": "float64", "nullable": true },
    "commissionedAt": { "type": "timestamp", "nullable": true },
    "parent": { "type": "direct", "nullable": true }
  }
}
```

`usedFor` is `node` or `edge`. A model version contains at most 100 views, a
view contains at most 200 uniquely named properties, and publication requires
at least one view. Property names follow the existing bounded field name
grammar. Supported types are `text`, `int64`, `float64`, `boolean`,
`timestamp`, `date`, `json`, and `direct`. Each property may set `required`,
`nullable`, and `list`; absent flags are false. Unknown definition fields are
rejected.

`int64` values use JSON safe integers in this slice. `float64` values must be
finite. Timestamps are normalized ISO-8601 instants, dates are `YYYY-MM-DD`,
and `direct` values are `{ "space": "...", "externalId": "..." }` keys.
Lists contain only the declared scalar/reference type and are bounded to 1,000
entries. Each instance's serialized properties are bounded to 256 KiB.

### Instance upsert

The batch request contains an idempotency key and 1-100 complete instances:

```json
{
  "idempotencyKey": "equipment-import-20260717-001",
  "instances": [
    {
      "space": "north-plant",
      "externalId": "pump-101",
      "kind": "node",
      "viewExternalId": "Equipment",
      "properties": { "name": "Pump 101", "ratedPressure": 16.5 }
    },
    {
      "space": "north-plant",
      "externalId": "pump-101-contained-by-area-a",
      "kind": "edge",
      "viewExternalId": "ContainedBy",
      "source": { "space": "north-plant", "externalId": "pump-101" },
      "target": { "space": "north-plant", "externalId": "area-a" },
      "properties": {}
    }
  ]
}
```

Upsert replaces the complete property set for an existing instance key; callers
must send every retained property. The exact model version and view validate
the replacement. Nodes cannot have source/target. Edges require existing node
endpoints in the same project and cannot cross project scope.

The whole batch runs in one transaction. The idempotency key is bound to a
canonical request hash. Replaying the same key and body returns the prior
summary; reusing the key with a different body returns `409`. One invalid item
rejects the complete batch, and no audit/outbox event is emitted.

## REST API

All routes use the existing `x-odf-tenant-id` and `x-odf-project-id` scope.

- `GET /api/v1/platform/data-models`
- `POST /api/v1/platform/data-models/:modelId/versions`
- `GET /api/v1/platform/data-models/:modelId/versions`
- `GET /api/v1/platform/data-models/:modelId/versions/:version`
- `GET /api/v1/platform/data-models/:modelId/versions/:version/views`
- `POST /api/v1/platform/data-models/:modelId/versions/:version/views`
- `POST /api/v1/platform/data-models/:modelId/versions/:version/publish`
- `POST /api/v1/platform/data-models/:modelId/versions/:version/instances/upsert`
- `POST /api/v1/platform/data-models/:modelId/versions/:version/instances/query`
- `POST /api/v1/platform/data-models/:modelId/versions/:version/instances/traverse`
- `POST /api/v1/platform/data-models/:modelId/versions/:version/instances/aggregate`

The create-version body retains `name`, `schema`, and `status`, and adds only
the optional bounded `views` array. A view POST accepts exactly the view
definition contract above. Publish has no request body. Instance endpoints
resolve model and view external IDs to backend-internal identifiers inside the
same scoped transaction.

Model and view reads require `data:read` plus active project membership. Model
and view authoring requires `data:ingest` plus owner/editor role. Instance
upsert uses the same ingest boundary. Query, traversal, and aggregation are
read-only.

Validation failures return `400`; missing models, views, or edge endpoints
return `404`; immutable, idempotency, or concurrent-write conflicts return
`409`; authorization failures retain the existing `401`/`403` behavior.

## Bounded query grammar

The query endpoint accepts one view, optional property projection, filter,
sort, limit, and cursor. Limit defaults to 50 and cannot exceed 200. Projection
contains at most 50 declared properties. Sort accepts `externalId`, `updatedAt`,
or one declared scalar property plus a stable instance-key tie-breaker.

Filters support:

- `equals` for any declared scalar or direct property;
- `in` with at most 100 values;
- `range` with `gt`, `gte`, `lt`, or `lte` for numeric/date/time properties;
- `exists` for any declared property;
- nested `and`, `or`, and `not` with at most 20 leaf clauses and depth five.

Unknown properties, type-mismatched values, non-finite numbers, empty boolean
groups, unsupported operators, excessive depth, or excessive clauses return
`400`. Backends parameterize every value; no request fragment becomes SQL.

Traversal accepts 1-20 start instance keys, `in`, `out`, or `both` direction,
an optional edge view, 1-3 hops, and a result limit up to 200. The backend
tracks visited `(instance, depth)` pairs to bound cycles. Results include the
path's instance keys and edge keys, not unbounded nested objects.

Aggregation accepts one node or edge view, the same filter grammar, up to three
group-by scalar properties, and up to ten metrics. Supported metrics are
`count`, `min`, `max`, `sum`, and `avg`; numeric metrics require numeric
properties. Output is capped at 200 groups.

PostgreSQL operations use a five-second transaction-local statement timeout.
SQLite operations inherit the API request timeout and the same logical bounds.

## Persistence changes

### PostgreSQL

Add one forward-only migration that:

- adds nullable `model_view_id`, `source_instance_id`, and
  `target_instance_id` columns to `odf.graph_instances` for model-managed
  instances while preserving legacy graph anchors;
- adds foreign keys and project-consistency triggers for model-managed edge
  endpoints;
- adds indexes for `(tenant_id, project_id, model_view_id, updated_at,
  instance_id)`, source traversal, target traversal, and a GIN property index;
- adds a scoped batch-idempotency table containing only key, canonical hash,
  bounded result summary, actor, and timestamps;
- extends forced RLS, grants, migration manifests, and static validation for
  every new column/table.

Legacy assets, documents, relations, and graph anchors remain valid. The new
REST path requires a model view, but the database columns remain nullable so
the migration does not invent bindings for historical records.

### SQLite

Add `platform_model_views`, `platform_graph_instances`, and
`platform_graph_batch_keys` tables under the existing project foreign keys.
Edges store source and target keys explicitly. Add scoped indexes matching the
query and traversal access paths. SQLite schema initialization remains
idempotent and existing local databases upgrade without deleting data.

## Audit, events, and observability

Successful lifecycle and mutation operations append existing-style audit and
outbox records:

- `platform.model_version_created`
- `platform.model_view_created`
- `platform.model_version_published`
- `platform.graph_instances_upserted`

Batch events contain model/view identifiers, counts, idempotency key, and a
request hash; they never contain complete instance properties. Application
logs follow the same rule.

Add low-cardinality metrics for model query duration, query outcome/result
count, successful upsert count, and rejected upsert count. Metrics use
operation/outcome labels only; tenant, project, model, view, instance, and
property values are prohibited labels.

## Model Explorer

Extend the current `ModelsWorkspace`; do not add another top-level route. It
contains four tabs:

1. **Versions** preserves the current immutable version list and authoring
   form, adding explicit draft/publish state.
2. **Views** lists definitions for the selected version and provides the
   existing JSON-first authoring pattern with strict validation feedback.
3. **Instances** lists node/edge rows with cursor pagination, opens a detail
   drawer, and shows bounded incoming/outgoing relations.
4. **Query** selects a view, constructs common filters/sorts/aggregates, renders
   a result table, and starts a bounded traversal from a selected result.

Changing tenant or project aborts in-flight requests and clears models, views,
instances, cursors, selections, and query results before loading the new scope.
The UI never performs client-side cross-project joins. It exposes no arbitrary
SQL and no graph visualization in this slice.

## Failure handling and rollout

Model writes, view writes, publication, and batch upserts are transactionally
atomic. A database timeout or serialization conflict returns a bounded error
and writes neither partial state nor a success event. Query failures do not
mutate state. Error responses do not echo properties, filter values, database
text, or credentials.

`ODF_MODEL_GRAPH_API_ENABLED` is the single rollout switch. It defaults to
`true` outside production and must be set explicitly in production. Rollout
order is migration, static validation, API deployment with the switch disabled,
API readiness verification, route enablement, then web deployment. Disabling
the routes is the rollback; the additive schema remains and existing product
surfaces continue to work. No rollback step drops model or instance data.

## Test strategy

Implementation follows one-test-at-a-time red/green/refactor TDD.

1. Contract tests cover view grammar, scalar/list/reference validation, filter
   grammar, query bounds, instance size, and canonical idempotency hashing.
2. SQLite repository tests cover lifecycle, immutable publication, atomic
   replacement upserts, replay/conflict behavior, query, cursor, aggregate,
   traversal, and cross-project denial.
3. PostgreSQL repository integration tests exercise the same behavior under
   forced RLS, including endpoint project consistency and statement timeout.
4. API tests cover permissions, roles, status codes, response redaction, and
   selected-backend equivalence.
5. Web tests cover the four tabs, scope cancellation, pagination, filter and
   aggregate construction, relation inspection, and accessible error states.
6. Production-like CI creates a model/view, upserts two nodes and one edge,
   queries and traverses them through one API replica, reads through the other,
   and proves a synthetic project cannot read the pilot project's instances.

No new test framework or dependency is required.

## Acceptance criteria

1. Both persistence profiles expose the same documented model/view/instance
   contract with no dual-write or fallback.
2. A draft model accepts valid views, rejects invalid views, publishes once,
   and rejects every subsequent mutation to that version.
3. A 100-instance batch is atomic and idempotent; a changed replay fails with
   `409`.
4. Invalid properties, cross-project direct references, and missing edge
   endpoints fail before any state, audit, or outbox write.
5. Query, cursor, aggregate, and three-hop traversal return only scoped,
   schema-compatible results within their documented bounds.
6. PostgreSQL forced RLS independently denies another tenant/project even if an
   adapter query omits an application filter.
7. Model Explorer completes the version-to-view-to-instance-to-query workflow
   and clears stale state on scope changes.
8. Typecheck, workspace tests, build, infrastructure validation, and the
   production-like graph smoke all pass.

## Follow-on parity slices

After this slice is verified, the next planned design cycle is Transformations
and Workflows: a bounded SQL transformation runtime, versioned schedules and
triggers, retries, lineage, and task execution beyond the current
`noop`/`validate`/`quality` executor. GraphQL, broader schema evolution, visual
modeling, richer connector families, diagram/3D processing, Functions,
simulations, and AI remain separate evidence-driven slices.
