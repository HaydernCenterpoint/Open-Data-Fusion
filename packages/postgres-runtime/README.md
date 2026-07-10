# PostgreSQL runtime

`@open-data-fusion/postgres-runtime` is the typed PostgreSQL boundary for the
workspace/event foundation and tenant data plane created by migrations 001–003.
It is intended to be injected into an API or worker, not exposed directly to
untrusted request input.

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
connection. To opt into the small live probe against a database where
migrations 001–003 are already applied, set `ODF_TEST_POSTGRES_URL` before
running the package tests.
