# PostgreSQL runtime

`@open-data-fusion/postgres-runtime` is the typed PostgreSQL boundary for the
workspace/event foundation and tenant data plane created by migrations 001-003.
It is intended to be injected into an API or worker, not exposed directly to
untrusted request input.

## Platform data plane

`PostgresRuntime` exposes typed repositories as `catalog`, `models`,
`pipelines`, `industrial`, `writeback`, and `search`, alongside the original
`workspaces`, `ingestion`, and `queues` repositories. They cover the actual
migration-003 tables: projects/datasets/source connections, immutable model and
pipeline versions, graph-backed assets/documents/time series, contextual
relations, quality evidence, and the write-back ledger.

Project authorization is intentionally external to this package because
migration 003 has no `project_members` table. Inject a resolver when creating a
runtime; without it, every project-scoped call fails closed before `BEGIN`:

```ts
const runtime = PostgresRuntime.connect(poolOptions, {
  projectAccessResolver: myIdentityPolicy,
});
```

The resolver can perform remote identity work because it runs before the
database transaction. A transaction receives only a scoped `ProjectScope`, so
all repository SQL still sets the RLS tenant context and filters by tenant and
project with parameters.

Some product concepts do not have dedicated persistence in migration 003. The
repository maps diagram artifacts to `documents.metadata`, matching and spatial
proposals to `relation_candidates.evidence`, and write-back history to
append-only `audit_log` plus the transactional outbox. Unified search is a
bounded RLS-scoped `UNION`, not a search-index table.

Create migration 004 before adding any of these as first-class contracts:

- Tenant-admin and project-membership persistence, including tenant creation
  grants and last-owner policy.
- Diagram extraction, matching-evaluation, and spatial-link tables when their
  domain-specific fields or lifecycle need durable querying.
- A write-back event-stream table when audit/outbox retention is insufficient.
- A materialized/`tsvector` search projection and index for large-scale search.
- Explicit idempotency columns for autonomous quality or pipeline workloads
  whose caller cannot retain a stable UUID/correlation ID.

## Operational contract

- Use a dedicated, least-privilege login role; never connect application code
  as the migration owner or a superuser.
- Every repository operation runs inside a short transaction. The runtime sets
  `odf.tenant_id`, `odf.user_id`, and `odf.platform_admin` with parameterized,
  transaction-local `set_config` calls before tenant-scoped access.
- Treat `platformAdmin` as trusted server-side worker context only. Never map
  it from an HTTP request, token claim, or other caller-controlled input.
- Complete network or storage I/O before entering a transaction. Durable
  follow-up work belongs in `odf.outbox_events` and is claimed separately.
- The migration grants `odf_app` only the tenant data-plane, audit, and outbox
  permissions. Workspace repository methods also require an explicitly
  provisioned application role with the minimum necessary grants on the legacy
  `odf.workspaces`, `odf.workspace_members`, and `odf.workspace_revisions`
  tables; grant no broader schema privileges.

## Validation

```powershell
npm run typecheck --workspace @open-data-fusion/postgres-runtime
npm test --workspace @open-data-fusion/postgres-runtime
npm run build --workspace @open-data-fusion/postgres-runtime
```

The default test suite uses a recording PostgreSQL client and makes no network
connection. To opt into the live relation probe against a database where
migrations 001-003 are already applied, set `ODF_TEST_POSTGRES_URL` before
running the package tests.
