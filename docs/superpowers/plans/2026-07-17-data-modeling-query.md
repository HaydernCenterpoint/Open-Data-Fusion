# Data Modeling and Bounded Graph Query Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task with one-test-at-a-time red/green/refactor TDD.

**Goal:** Deliver the first clean-room CDF-parity slice: versioned data models and views, atomic model-managed node/edge upserts, bounded query/traversal/aggregation, and a four-tab Model Explorer on both SQLite and PostgreSQL without dual-write or fallback.

**Architecture:** Add public model-graph contracts and pure validation to the existing shared packages. Route every REST call through one selected ModelGraphPersistence; SQLite owns local tables, while PostgreSQL adapts the normalized PostgresModelRepository. Extend existing PostgreSQL model tables with one additive migration, harden project RLS, and retire only model methods from the legacy compatibility adapter. Keep REST-first behavior, existing OIDC/project-role boundaries, audit/outbox patterns, and current React navigation.

**Tech Stack:** TypeScript 7, Node.js 24, Express 5, Zod 3, React 18, SQLite DatabaseSync, PostgreSQL JSONB/recursive CTE/RLS, Vitest 4, Testing Library, Prometheus, shell/Compose smoke tests.

**Scope guard:** Do not add GraphQL, Neo4j or another graph database, a schema canvas, graph visualization, microservices, or a third-party dependency. SQLite records existing atomic audit evidence; PostgreSQL records audit plus transactional outbox. The next parity slice remains transformations/workflows.

---

## Contract locked by this plan

Use these public types and JSON shapes in both persistence profiles.

The route module owns exactly these endpoints:

- GET /api/v1/platform/data-models
- POST /api/v1/platform/data-models/:modelId/versions
- GET /api/v1/platform/data-models/:modelId/versions
- GET /api/v1/platform/data-models/:modelId/versions/:version
- GET /api/v1/platform/data-models/:modelId/versions/:version/views
- POST /api/v1/platform/data-models/:modelId/versions/:version/views
- POST /api/v1/platform/data-models/:modelId/versions/:version/publish
- POST /api/v1/platform/data-models/:modelId/versions/:version/instances/upsert
- POST /api/v1/platform/data-models/:modelId/versions/:version/instances/query
- POST /api/v1/platform/data-models/:modelId/versions/:version/instances/traverse
- POST /api/v1/platform/data-models/:modelId/versions/:version/instances/aggregate

Create/view writes return 201. Publish and reads return 200. A first upsert returns 201 and an exact replay returns 200. Validation is 400, missing model/view/endpoint is 404, immutable/idempotency/concurrency conflict is 409, and existing authentication/authorization behavior remains 401/403.

~~~ts
export type ModelPropertyType =
  | "text"
  | "int64"
  | "float64"
  | "boolean"
  | "timestamp"
  | "date"
  | "json"
  | "direct";

export interface InstanceKey {
  space: string;
  externalId: string;
}

export interface ModelPropertyDefinition {
  type: ModelPropertyType;
  required?: boolean;
  nullable?: boolean;
  list?: boolean;
}

export interface ModelViewDefinition {
  externalId: string;
  name: string;
  usedFor: "node" | "edge";
  properties: Record<string, ModelPropertyDefinition>;
}

export interface ModelVersion {
  tenantId: string;
  projectId: string;
  id: string;
  version: number;
  name: string;
  schema: Record<string, unknown>;
  status: "draft" | "published";
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface ModelView extends ModelViewDefinition {
  modelId: string;
  modelVersion: number;
  createdAt: string;
}

export interface ModelGraphInstance extends InstanceKey {
  kind: "node" | "edge";
  viewExternalId: string;
  source?: InstanceKey;
  target?: InstanceKey;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
~~~

Use this filter grammar.

~~~ts
export type ModelFilter =
  | { equals: { property: string; value: unknown } }
  | { in: { property: string; values: unknown[] } }
  | { range: { property: string; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown } }
  | { exists: { property: string } }
  | { and: ModelFilter[] }
  | { or: ModelFilter[] }
  | { not: ModelFilter };

export interface InstanceQueryRequest {
  viewExternalId: string;
  projection?: string[];
  filter?: ModelFilter;
  sort?: { property: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string;
}

export interface InstanceTraverseRequest {
  starts: InstanceKey[];
  direction: "in" | "out" | "both";
  edgeViewExternalId?: string;
  maxHops?: number;
  limit?: number;
}

export interface InstanceAggregateRequest {
  viewExternalId: string;
  filter?: ModelFilter;
  groupBy?: string[];
  metrics: Array<{
    name: string;
    operation: "count" | "min" | "max" | "sum" | "avg";
    property?: string;
  }>;
  limit?: number;
}
~~~

Query returns { items, nextCursor }. Traversal returns { paths, truncated }, with bounded instance-key and edge-key arrays. Aggregation returns { groups, truncated }, with group and metrics objects. Upsert returns { modelId, version, total, created, updated, replayed, requestHash } and never echoes complete properties.

---

### Task 1: Record the architecture decision and publish contracts

**Files:**

- Create: docs/architecture/0007-data-modeling-and-bounded-graph-query.md
- Create: packages/contracts/src/model-graph.ts
- Modify: packages/contracts/src/index.ts
- Modify: README.md

**Step 1: Write ADR 0007 before code**

Record: clean-room functional parity; REST-first; one selected persistence port; normalized PostgreSQL tables; SQLite contract mirror; oldest provisioned model space ordered by created_at then space_id as deterministic public-model default; immutable published models; required model view for managed instances; bounded grammar; no graph database.

Add ADR 0007 to the README ADR table. Public API and persistence changes require this ADR under repository policy.

**Step 2: Add complete request/response types**

In addition to the locked types above, add:

~~~ts
export interface CreateModelVersionRequest {
  name: string;
  schema: Record<string, unknown>;
  status?: "draft" | "published";
  views?: ModelViewDefinition[];
}

export interface InstanceUpsertItem extends InstanceKey {
  kind: "node" | "edge";
  viewExternalId: string;
  source?: InstanceKey;
  target?: InstanceKey;
  properties: Record<string, unknown>;
}

export interface InstanceUpsertRequest {
  idempotencyKey: string;
  instances: InstanceUpsertItem[];
}

export interface InstanceUpsertResult {
  modelId: string;
  version: number;
  total: number;
  created: number;
  updated: number;
  replayed: boolean;
  requestHash: string;
}

export interface InstancePath {
  instances: InstanceKey[];
  edges: InstanceKey[];
}

export interface InstanceTraverseResult {
  paths: InstancePath[];
  truncated: boolean;
}

export interface InstanceAggregateGroup {
  group: Record<string, unknown>;
  metrics: Record<string, number | null>;
}

export interface InstanceAggregateResult {
  groups: InstanceAggregateGroup[];
  truncated: boolean;
}
~~~

Export the module from packages/contracts/src/index.ts.

**Step 3: Compile**

Run: npm run typecheck --workspace @open-data-fusion/contracts

Expected: PASS with no duplicate export.

**Step 4: Commit**

~~~bash
git add docs/architecture/0007-data-modeling-and-bounded-graph-query.md packages/contracts/src/model-graph.ts packages/contracts/src/index.ts README.md
git commit -m "docs: record bounded model graph architecture"
~~~

---

### Task 2: Build pure model/view/instance validation

**Files:**

- Create: packages/platform-core/src/modeling.ts
- Create: packages/platform-core/tests/modeling.test.ts
- Modify: packages/platform-core/src/index.ts

**Step 1: Write one failing view test**

~~~ts
it("normalizes a strict bounded view definition", () => {
  expect(normalizeModelView({
    externalId: "Equipment",
    name: "Equipment",
    usedFor: "node",
    properties: {
      name: { type: "text", required: true },
      ratedPressure: { type: "float64", nullable: true },
    },
  })).toEqual({
    externalId: "Equipment",
    name: "Equipment",
    usedFor: "node",
    properties: {
      name: { type: "text", required: true, nullable: false, list: false },
      ratedPressure: { type: "float64", required: false, nullable: true, list: false },
    },
  });
});
~~~

Run: npm test --workspace @open-data-fusion/platform-core -- --run tests/modeling.test.ts

Expected: FAIL because normalizeModelView is absent.

**Step 2: Implement only view normalization**

Create ModelValidationError with safe issues shaped as { path, message }. Reuse the platform identifier grammar. Accept exactly eight approved types. Materialize boolean flags. Enforce 100 views and 200 properties. Reject unknown definition keys. Rerun and expect PASS.

**Step 3: Add one failing scalar/list/reference test at a time**

Cover required/nullable/unknown fields; safe int64; finite float64; booleans; normalized ISO timestamps; real YYYY-MM-DD dates; JSON values; direct keys; homogeneous lists up to 1,000; serialized properties up to 256 KiB; node endpoint rejection; edge endpoint requirement.

Expose:

~~~ts
export function normalizeModelInstance(
  view: ModelViewDefinition,
  input: InstanceUpsertItem,
): InstanceUpsertItem;
~~~

Database existence checks remain in persistence.

**Step 4: Add failing filter and aggregate tests**

Expose normalizeInstanceQuery and normalizeInstanceAggregate. Prove: depth 5; 20 leaves; non-empty and/or; in up to 100; projection up to 50; results up to 200; group-by up to 3; metrics up to 10; groups up to 200; no range on invalid/list types; numeric-only min/max/sum/avg.

**Step 5: Add deterministic canonical JSON**

Expose canonicalModelGraphJson(value). Recursively sort object keys and preserve array order. Test equal objects with different insertion order and different strings for changed values or batch order. Node adapters perform SHA-256 so platform-core stays dependency-free.

**Step 6: Export and verify**

~~~bash
npm test --workspace @open-data-fusion/platform-core -- --run tests/modeling.test.ts
npm run typecheck --workspace @open-data-fusion/platform-core
~~~

Expected: PASS.

**Step 7: Commit**

~~~bash
git add packages/platform-core/src/modeling.ts packages/platform-core/src/index.ts packages/platform-core/tests/modeling.test.ts
git commit -m "feat: validate bounded model graph contracts"
~~~

---

### Task 3: Add strict REST schemas and rollout switch

**Files:**

- Create: apps/api/src/model-graph-schemas.ts
- Create: apps/api/src/model-graph-config.ts
- Create: apps/api/tests/model-graph-schemas.test.ts
- Create: apps/api/tests/model-graph-config.test.ts

**Step 1: Write failing schema tests**

Test recursive filter shape, strict unknown-key rejection, optional views, positive integer version paths, empty publish body, 1-100 upsert items, 1-20 traversal starts, 1-3 hops, and aggregate metrics.

Export: modelVersionPathSchema, modelViewDefinitionSchema, createModelVersionSchema, instanceUpsertSchema, instanceQuerySchema, instanceTraverseSchema, instanceAggregateSchema, emptyBodySchema.

Run: npm test --workspace @open-data-fusion/api -- --run tests/model-graph-schemas.test.ts

Expected: FAIL.

**Step 2: Implement syntax/coarse bounds**

Reuse platformIdSchema, z.lazy, and strict objects. View-aware type checks remain in platform-core after the view is resolved. Rerun and expect PASS.

**Step 3: Write failing configuration tests**

Expose modelGraphApiEnabled(environment).

- Non-production unset: true.
- Explicit true: true.
- Explicit false: false.
- Production unset: startup error.
- Invalid value: startup error.

Implement and rerun to PASS.

**Step 4: Commit**

~~~bash
git add apps/api/src/model-graph-schemas.ts apps/api/src/model-graph-config.ts apps/api/tests/model-graph-schemas.test.ts apps/api/tests/model-graph-config.test.ts
git commit -m "feat: define model graph REST validation"
~~~

---

### Task 4: Add migration 015 and harden normalized storage

**Files:**

- Create: infra/postgres/migrations/015_model_graph_query.sql
- Modify: infra/postgres/migrations/SHA256SUMS
- Modify: infra/postgres/scripts/validate_static.py

**Step 1: Make static validation fail first**

Require migration 015, three nullable graph columns, same-project endpoint FKs, model_graph_batch_keys, project-aware forced RLS, guarded draft-to-published transition, model-managed endpoint validation, least privileges, no DELETE, required indexes, public search projection, and legacy-model backfill.

Run: npm run infra:validate

Expected: FAIL because migration 015 is absent.

**Step 2: Implement the additive migration**

The migration must:

1. Use existing transaction, advisory lock, lock timeout, and statement timeout pattern.
2. Add model_view_id, source_instance_id, target_instance_id to graph_instances.
3. Add guarded FKs to model_views and same-project graph endpoints.
4. Create model_graph_batch_keys keyed by tenant/project/data_model/idempotency_key, with a lowercase 64-character hash, bounded JSON summary, actor, timestamp, and no properties.
5. Replace data_models_append_only with a trigger allowing only draft to published while setting published_at.
6. Validate that bound views belong to the model; nodes have no endpoints; edges have two existing node endpoints in the same project.
7. Replace tenant-only policies with current-tenant and current-project policies for data_models, model_views, graph_instances, and batch keys.
8. Grant only required SELECT/INSERT/UPDATE to odf_app and SELECT to odf_readonly.
9. Add model-view/update, source, target, and JSONB GIN indexes.
10. Backfill legacy model versions into normalized data_models using the deterministic oldest space; fail when a legacy model has no model space.
11. Replace only the data_models search trigger with a public modelId@version projection and remove obsolete legacy model projections.
12. Record 015_model_graph_query and commit.

Historical published models without views remain readable but cannot accept instances.

**Step 3: Update checksum**

Generate LF-canonical SHA-256 and append exactly one sorted manifest line. Do not alter prior checksums.

**Step 4: Verify**

~~~bash
npm run infra:validate
git diff --check
~~~

Expected: PASS and 15 migrations.

**Step 5: Commit**

~~~bash
git add infra/postgres/migrations/015_model_graph_query.sql infra/postgres/migrations/SHA256SUMS infra/postgres/scripts/validate_static.py
git commit -m "feat: add model graph query migration"
~~~

---

### Task 5: Implement PostgreSQL lifecycle and views

**Files:**

- Modify: packages/postgres-runtime/package.json
- Modify: package-lock.json
- Modify: packages/postgres-runtime/src/platform-types.ts
- Modify: packages/postgres-runtime/src/platform-mappers.ts
- Modify: packages/postgres-runtime/src/model-repository.ts
- Create: packages/postgres-runtime/tests/model-repository.test.ts

**Step 1: Add only the local workspace dependency**

Add @open-data-fusion/platform-core version 0.1.0 to postgres-runtime and update the lockfile with npm install --ignore-scripts. Add no third-party dependency.

**Step 2: Write a failing default-space/version test**

Using RecordingClient, prove policy runs before BEGIN; model transactions set statement_timeout to 5000ms; default space orders by created_at, space_id; advisory lock is tenant/project/model scoped; numeric allocation ignores non-numeric internal versions.

Run the focused test and expect FAIL.

**Step 3: Extend ModelRepository**

Add: listModelVersions, listVersionsForModel, getModelVersion, createModelVersion, listModelViews, public createModelView, publishModelVersion.

Keep internal createDataModel/listDataModels/createGraphInstance callers type-safe. Rename the old low-level view method to createModelViewRecord if needed.

**Step 4: Implement lifecycle**

Validate views before writes; create model/views atomically; permit direct published creation only with at least one view; add views only to drafts; publish once with at least one view; never expose UUIDs. Append platform.model_version_created, platform.model_view_created, and platform.model_version_published only after successful writes.

**Step 5: Add immutability/audit tests**

Test published mutation conflict, second publish conflict, missing version 404 mapping input, scoped SQL, and audit/outbox ordering before COMMIT.

**Step 6: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/postgres-runtime -- --run tests/model-repository.test.ts
npm run typecheck --workspace @open-data-fusion/postgres-runtime
git add packages/postgres-runtime/package.json package-lock.json packages/postgres-runtime/src/platform-types.ts packages/postgres-runtime/src/platform-mappers.ts packages/postgres-runtime/src/model-repository.ts packages/postgres-runtime/tests/model-repository.test.ts
git commit -m "feat: add postgres model lifecycle"
~~~

---

### Task 6: Implement PostgreSQL atomic upsert

**Files:**

- Create: packages/postgres-runtime/src/model-instance-helpers.ts
- Modify: packages/postgres-runtime/src/model-repository.ts
- Modify: packages/postgres-runtime/src/platform-types.ts
- Modify: packages/postgres-runtime/src/platform-mappers.ts
- Modify: packages/postgres-runtime/tests/model-repository.test.ts

**Step 1: Write failing two-node/one-edge test**

Assert one transaction resolves published model, views, spaces, direct references, endpoints; writes all rows; writes one bounded replay summary; appends audit/outbox without properties.

Expected method:

~~~ts
upsertModelInstances(
  scope: ProjectScope,
  modelId: string,
  version: number,
  input: InstanceUpsertRequest,
  correlationId: string,
): Promise<InstanceUpsertResult>;
~~~

**Step 2: Implement minimal atomic behavior**

Normalize through platform-core; collect unique keys; resolve before mutation; reject missing/cross-project direct references and missing/non-node endpoints; reject collision with legacy unbound graph rows; replace complete properties and bindings; count inserts/updates; hash canonical model/version/instances; persist only bounded summary.

**Step 3: Add replay and rollback tests**

Same key/body returns replayed true with no write/audit/outbox. Changed body conflicts. Invalid item rolls back. A 100-item batch succeeds. API schema rejects 101.

**Step 4: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/postgres-runtime -- --run tests/model-repository.test.ts
npm run typecheck --workspace @open-data-fusion/postgres-runtime
git add packages/postgres-runtime/src/model-instance-helpers.ts packages/postgres-runtime/src/model-repository.ts packages/postgres-runtime/src/platform-types.ts packages/postgres-runtime/src/platform-mappers.ts packages/postgres-runtime/tests/model-repository.test.ts
git commit -m "feat: add atomic postgres graph upsert"
~~~

---

### Task 7: Implement parameterized PostgreSQL query/traverse/aggregate

**Files:**

- Create: packages/postgres-runtime/src/model-query-sql.ts
- Create: packages/postgres-runtime/tests/model-query-sql.test.ts
- Modify: packages/postgres-runtime/src/model-repository.ts
- Modify: packages/postgres-runtime/src/platform-types.ts
- Modify: packages/postgres-runtime/tests/model-repository.test.ts

**Step 1: Test compiler operator by operator**

Expose compilePostgresModelQuery and compilePostgresModelAggregate. Assert all property keys and request values are parameters; no model, tenant, project, property, filter, or key value appears in SQL text.

Run focused compiler test and expect FAIL, then implement to PASS.

**Step 2: Implement stable keyset query**

Scope exact model/view. Default externalId ascending. Property sort key is (isNull, typedValue, spaceExternalId, externalId), nulls last. Cursor is opaque base64url JSON with only typed sort/key fields. Fetch limit plus one. Projection omitted returns all; present returns requested fields only.

**Step 3: Implement bounded recursive traversal**

Use a recursive CTE, max three hops, limit plus one, exact model, optional edge view, requested direction, visited instance/depth state. Return key paths only.

**Step 4: Implement bounded aggregation**

Render only normalized group and metric expressions, cap 200, return number or null. Test count and grouped average.

**Step 5: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/postgres-runtime -- --run tests/model-query-sql.test.ts tests/model-repository.test.ts
npm run typecheck --workspace @open-data-fusion/postgres-runtime
git add packages/postgres-runtime/src/model-query-sql.ts packages/postgres-runtime/src/model-repository.ts packages/postgres-runtime/src/platform-types.ts packages/postgres-runtime/tests/model-query-sql.test.ts packages/postgres-runtime/tests/model-repository.test.ts
git commit -m "feat: add bounded postgres model queries"
~~~

---

### Task 8: Create the selected persistence port and SQLite lifecycle

**Files:**

- Create: apps/api/src/model-graph-persistence.ts
- Create: apps/api/src/sqlite-model-graph.ts
- Create: apps/api/tests/sqlite-model-graph.test.ts
- Modify: apps/api/src/platform.ts

**Step 1: Define one port**

ModelGraphPersistence receives tenant/project/user scope and exposes every REST operation plus mode sqlite or postgres. It has no fallback or dual-store method.

~~~ts
export interface ModelGraphPersistence {
  readonly mode: "sqlite" | "postgres";
  listModelVersions(scope: ModelGraphScope, query: CursorListQuery): Promise<CursorPage<ModelVersion>>;
  listVersionsForModel(scope: ModelGraphScope, modelId: string, query: CursorListQuery): Promise<CursorPage<ModelVersion>>;
  getModelVersion(scope: ModelGraphScope, modelId: string, version: number): Promise<ModelVersion>;
  createModelVersion(scope: ModelGraphScope, modelId: string, input: CreateModelVersionRequest, correlationId: string): Promise<ModelVersion>;
  listModelViews(scope: ModelGraphScope, modelId: string, version: number): Promise<ModelView[]>;
  createModelView(scope: ModelGraphScope, modelId: string, version: number, input: ModelViewDefinition, correlationId: string): Promise<ModelView>;
  publishModelVersion(scope: ModelGraphScope, modelId: string, version: number, correlationId: string): Promise<ModelVersion>;
  upsertModelInstances(scope: ModelGraphScope, modelId: string, version: number, input: InstanceUpsertRequest, correlationId: string): Promise<InstanceUpsertResult>;
  queryModelInstances(scope: ModelGraphScope, modelId: string, version: number, input: InstanceQueryRequest): Promise<CursorPage<ModelGraphInstance>>;
  traverseModelInstances(scope: ModelGraphScope, modelId: string, version: number, input: InstanceTraverseRequest): Promise<InstanceTraverseResult>;
  aggregateModelInstances(scope: ModelGraphScope, modelId: string, version: number, input: InstanceAggregateRequest): Promise<InstanceAggregateResult>;
}
~~~

**Step 2: Write failing draft/view/publish test**

Test owner/editor writes, viewer reads, draft creation, view creation, publish, reads, and post-publish conflict.

Run focused test and expect FAIL.

**Step 3: Move SQLite model ownership**

Delete only current platform_data_models initializer/mappers/list/create from PlatformCatalog. Recreate that table idempotently in SqliteModelGraphStore and add platform_model_views, platform_graph_instances, platform_graph_batch_keys, and scoped indexes. Preserve old rows. Use PlatformCatalog.assertProjectAccess and existing audit_log within one BEGIN IMMEDIATE. Do not create an unused SQLite outbox.

**Step 4: Implement lifecycle parity**

Match PostgreSQL responses and transitions, including optional atomic views and direct published creation. Old published rows without views are read-only historical records.

**Step 5: Add upgrade/isolation tests**

Initialize twice over an old database and prove no data loss. Prove a second project cannot read the first.

**Step 6: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/api -- --run tests/sqlite-model-graph.test.ts
npm run typecheck --workspace @open-data-fusion/api
git add apps/api/src/model-graph-persistence.ts apps/api/src/sqlite-model-graph.ts apps/api/tests/sqlite-model-graph.test.ts apps/api/src/platform.ts
git commit -m "feat: add sqlite model lifecycle store"
~~~

---

### Task 9: Complete SQLite operation parity

**Files:**

- Create: apps/api/src/sqlite-model-query.ts
- Create: apps/api/tests/model-graph-fixture.ts
- Modify: apps/api/src/sqlite-model-graph.ts
- Modify: apps/api/tests/sqlite-model-graph.test.ts

**Step 1: Write failing atomic upsert test**

Put the shared model/views/two-node/one-edge request and expected public responses in model-graph-fixture.ts. Use it here and later in PostgreSQL route/adapter tests. Assert replacement, counts, audit redaction, replay, changed-key conflict, missing endpoint rollback, and no failure audit.

**Step 2: Implement upsert**

Normalize/canonicalize, resolve all keys before writes, persist summary/audit in one BEGIN IMMEDIATE, store explicit source/target keys.

**Step 3: Write failing query/cursor tests**

Compile JSON1 expressions from normalized input. Bind property names and values. Match PostgreSQL null ordering, typed comparison, projection, tie-breakers, and limit-plus-one cursor.

**Step 4: Add recursive traversal and aggregate**

Use bounded recursive CTEs, visited state, model/edge-view scope, and one-to-three hops. Use JSON1 typed group/metric expressions. Return identical shapes.

**Step 5: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/api -- --run tests/sqlite-model-graph.test.ts
npm run typecheck --workspace @open-data-fusion/api
git add apps/api/src/sqlite-model-query.ts apps/api/src/sqlite-model-graph.ts apps/api/tests/model-graph-fixture.ts apps/api/tests/sqlite-model-graph.test.ts
git commit -m "feat: add bounded sqlite model queries"
~~~

---

### Task 10: Cut public routes to one normalized backend

**Files:**

- Create: apps/api/src/postgres-model-graph.ts
- Create: apps/api/src/model-graph-routes.ts
- Create: apps/api/tests/model-graph-routes.test.ts
- Create: apps/api/tests/postgres-model-graph.test.ts
- Modify: apps/api/src/app.ts
- Modify: apps/api/src/server.ts
- Modify: apps/api/src/platform-schemas.ts
- Modify: apps/api/src/platform-routes.ts
- Modify: apps/api/src/postgres-platform-compatibility-routes.ts
- Modify: apps/api/src/postgres-platform-compatibility.ts
- Modify: apps/api/tests/postgres-platform-compatibility.test.ts
- Modify: apps/api/tests/postgres-platform-compatibility-store.test.ts

**Step 1: Add thin PostgreSQL adapter**

Implement ModelGraphPersistence via runtime.models. assertReady verifies migration 015 relations/columns/grants. It never falls back. In postgres-model-graph.test.ts, reuse the shared fixture and assert the adapter returns the same public shapes as SQLite while forwarding exact scope, IDs, versions, correlation IDs, and normalized requests.

**Step 2: Write failing route tests**

Cover all eleven endpoints, statuses, permissions, roles, strict parsing, empty publish body, exact persistence calls, and safe ModelValidationError to 400 mapping without properties/filter/SQL.

**Step 3: Implement routes once**

Authenticate data:read or data:ingest, parse paths/body, build scope, delegate. Persistence enforces project roles. Register only when feature enabled; disabled routes use existing 404.

**Step 4: Wire exactly one store**

Add modelGraphPersistence and modelGraphApiEnabled options. SQLite defaults to SqliteModelGraphStore. Enabled PostgreSQL without an explicit PostgreSQL store throws at app construction. Server parses the flag, builds/asserts PostgresModelGraphStore, and passes it.

**Step 5: Remove legacy model ownership**

Delete only two model routes and two model methods from compatibility files. Delete the now-unused dataModelVersionCreateSchema and inferred type from platform-schemas.ts. Keep the historical table/migration; migration 015 backfills it. Keep pipeline/quality/context/writeback tests.

**Step 6: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/api -- --run tests/model-graph-routes.test.ts tests/postgres-model-graph.test.ts tests/platform.test.ts tests/postgres-platform-compatibility.test.ts tests/postgres-platform-compatibility-store.test.ts
npm run typecheck --workspace @open-data-fusion/api
git add apps/api/src/postgres-model-graph.ts apps/api/src/model-graph-routes.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/src/platform-schemas.ts apps/api/src/platform-routes.ts apps/api/src/postgres-platform-compatibility-routes.ts apps/api/src/postgres-platform-compatibility.ts apps/api/tests/model-graph-routes.test.ts apps/api/tests/postgres-model-graph.test.ts apps/api/tests/postgres-platform-compatibility.test.ts apps/api/tests/postgres-platform-compatibility-store.test.ts
git commit -m "feat: route models to selected graph backend"
~~~

---

### Task 11: Add low-cardinality observability

**Files:**

- Create: apps/api/src/model-graph-metrics.ts
- Modify: apps/api/src/observability.ts
- Modify: apps/api/src/model-graph-routes.ts
- Modify: apps/api/tests/observability.test.ts
- Modify: apps/api/tests/model-graph-routes.test.ts

**Step 1: Write failing metric/redaction tests**

Require duration by operation/outcome, result count by operation/outcome, successful upsert instance count by outcome, rejected upsert count by fixed reason. Assert no tenant/project/model/view/property/instance/key labels and no payload/filter values in logs/errors.

**Step 2: Implement recorder on existing registry**

Use fixed error classes: validation, not_found, conflict, forbidden, timeout, internal. Instrument persistence calls without payload logging.

**Step 3: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/api -- --run tests/observability.test.ts tests/model-graph-routes.test.ts
git add apps/api/src/model-graph-metrics.ts apps/api/src/observability.ts apps/api/src/model-graph-routes.ts apps/api/tests/observability.test.ts apps/api/tests/model-graph-routes.test.ts
git commit -m "feat: observe model graph operations"
~~~

---

### Task 12: Add typed web API client

**Files:**

- Modify: apps/web/src/types.ts
- Modify: apps/web/src/lib/api.ts
- Create: apps/web/src/lib/api.model-graph.test.ts

**Step 1: Align web types**

Add publishedAt, views/properties, instances, filters, paths, aggregates. Keep browser-local serializable types; do not add a runtime contracts dependency.

**Step 2: Write failing request tests**

Assert URL encoding, scope headers, abort signal, JSON body, and response shape for list/get/create/publish/views/upsert/query/traverse/aggregate.

**Step 3: Add focused helpers**

Reuse request, platformHeaders, and listPlatformScoped. Add one function per endpoint and one internal version-path builder. Do not add a client class.

**Step 4: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/web -- --run src/lib/api.model-graph.test.ts
npm run typecheck --workspace @open-data-fusion/web
git add apps/web/src/types.ts apps/web/src/lib/api.ts apps/web/src/lib/api.model-graph.test.ts
git commit -m "feat: add model graph web client"
~~~

---

### Task 13: Extract Models workspace; deliver Versions and Views

**Files:**

- Create: apps/web/src/components/ModelsWorkspace.tsx
- Create: apps/web/src/components/ModelsWorkspace.test.tsx
- Modify: apps/web/src/components/PlatformWorkspaces.tsx
- Modify: apps/web/src/App.tsx
- Modify: apps/web/src/App.test.tsx
- Modify: apps/web/src/styles.css

**Step 1: Lock current behavior**

Move current model assertions into a focused component test and prove they pass before code movement.

**Step 2: Extract only model code**

Move ModelVersionRegistrationForm and ModelsWorkspace. Keep pipeline/quality code in place. Update App import. Prove current test still passes.

**Step 3: Write failing four-tab shell test**

Assert tablist/tab semantics, Versions default, selected version, and full reset on tenant/project change.

**Step 4: Implement Versions and Views**

Versions: list/pagination/selection/create/publish state. Views: list, strict JSON authoring for draft, readable validation, immutable published message. Abort every request and clear state before scope reload. Add only required responsive/accessibility CSS.

**Step 5: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/web -- --run src/components/ModelsWorkspace.test.tsx src/App.test.tsx
npm run typecheck --workspace @open-data-fusion/web
git add apps/web/src/components/ModelsWorkspace.tsx apps/web/src/components/ModelsWorkspace.test.tsx apps/web/src/components/PlatformWorkspaces.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat: add model versions and views explorer"
~~~

---

### Task 14: Complete Instances and Query tabs

**Files:**

- Modify: apps/web/src/components/ModelsWorkspace.tsx
- Modify: apps/web/src/components/ModelsWorkspace.test.tsx
- Modify: apps/web/src/styles.css

**Step 1: Write failing Instances test**

Select published model/view; load first and cursor page; open accessible drawer/dialog; inspect bounded in/out paths. Assert no client-side cross-project join.

**Step 2: Implement Instances**

Use query endpoint for rows. Add view selector, node/edge state, pagination, detail drawer, one-hop in/out traversal. Abort/clear on scope/model/version/view change.

**Step 3: Write failing Query test**

Build equals/range/exists, projection, sort, aggregate, and three-hop traversal. Assert exact request bodies and result table/group/path UI; test accessible errors and empty results.

**Step 4: Implement smallest bounded builder**

Provide one visual leaf editor and advanced JSON input for nested and/or/not. Use selected view definitions for valid properties/operators. Do not add graph visualization.

**Step 5: Verify and commit**

~~~bash
npm test --workspace @open-data-fusion/web -- --run src/components/ModelsWorkspace.test.tsx
npm run typecheck --workspace @open-data-fusion/web
npm run build --workspace @open-data-fusion/web
git add apps/web/src/components/ModelsWorkspace.tsx apps/web/src/components/ModelsWorkspace.test.tsx apps/web/src/styles.css
git commit -m "feat: complete model instance explorer"
~~~

---

### Task 15: Prove production-like replica and RLS behavior

**Files:**

- Modify: docker-compose.production-like.yml
- Modify: infra/ci/production-like-smoke.sh
- Modify: .github/workflows/production-like-integration.yml
- Modify: infra/postgres/scripts/validate_static.py

**Step 1: Make production flag explicit**

Set ODF_MODEL_GRAPH_API_ENABLED true on both production-like replicas. Require it in static validation.

**Step 2: Replace old compatibility-model smoke only**

Keep compatibility pipeline/run smoke. Model sequence: create draft with Equipment and ContainedBy views; publish; API A upserts two nodes/one edge; API B replays; API B queries/traverses/aggregates; search uses public model@version key; unauthorized project receives 403.

First write returns 201; replay returns 200.

**Step 3: Prove RLS without adapter predicate**

Seed a same-tenant unauthorized-project graph row using migrator. Connect as least-privilege CI API login, set authorized tenant/project/user transaction context, execute deliberately project-unfiltered SELECT, and assert only authorized row is visible.

**Step 4: Verify**

~~~bash
npm run infra:validate
bash -n infra/ci/production-like-smoke.sh
~~~

If Docker is available, run the existing workflow-equivalent sequence. If unavailable, record the gap; CI must close it before merge.

**Step 5: Commit**

~~~bash
git add docker-compose.production-like.yml infra/ci/production-like-smoke.sh .github/workflows/production-like-integration.yml infra/postgres/scripts/validate_static.py
git commit -m "test: prove model graph production boundary"
~~~

---

### Task 16: Document and run the complete gate

**Files:**

- Modify: .env.example
- Modify: README.md
- Modify: apps/api/README.md
- Modify: packages/postgres-runtime/README.md
- Modify: docs/operations/postgres-canvas-production-like.md

**Step 1: Document**

Cover all eleven endpoints/bounds; feature flag default/production/rollback; selected backend/no fallback; migration 015; project RLS; 5-second timeout; four-tab UI; SQLite audit vs PostgreSQL audit/outbox; clean-room independence. Mark this parity slice complete and add unchecked Transformations/Workflows as next.

**Step 2: Run targeted checks**

~~~bash
npm test --workspace @open-data-fusion/platform-core -- --run tests/modeling.test.ts
npm test --workspace @open-data-fusion/postgres-runtime -- --run tests/model-query-sql.test.ts tests/model-repository.test.ts
npm test --workspace @open-data-fusion/api -- --run tests/model-graph-schemas.test.ts tests/model-graph-config.test.ts tests/sqlite-model-graph.test.ts tests/model-graph-routes.test.ts tests/postgres-model-graph.test.ts tests/observability.test.ts
npm test --workspace @open-data-fusion/web -- --run src/lib/api.model-graph.test.ts src/components/ModelsWorkspace.test.tsx src/App.test.tsx
npm run infra:validate
~~~

Expected: all PASS.

**Step 3: Run full fresh gate**

~~~bash
npm run check
git diff --check
git status --short
~~~

Expected: typecheck, all tests, builds, and infra validation PASS; no unintended files.

**Step 4: Review acceptance evidence**

Confirm: one backend; immutable lifecycle; atomic idempotent 100 items; invalid references without success evidence; bounded scoped operations; independent project RLS; four-tab UI with cancellation; payload-safe logs/errors/metrics/outbox; non-destructive disabled-route rollback; no forbidden scope additions.

**Step 5: Commit docs**

~~~bash
git add .env.example README.md apps/api/README.md packages/postgres-runtime/README.md docs/operations/postgres-canvas-production-like.md
git commit -m "docs: publish model graph slice"
~~~

**Step 6: Final evidence**

Run git log --oneline --decorate -16 and git status --short --branch. Report exact tests/skips, smoke status, migration checksum, remaining risk. Claim only this approved parity slice, not full Cognite Data Fusion equivalence.

---

## Stop condition

Stop only when Task 16 is green, or an external prerequisite such as Docker cannot run after all local checks pass. A Docker gap cannot be called a passed smoke. Any failing test, typecheck, build, static validator, RLS proof, or unintended dirty file means continue fixing.
