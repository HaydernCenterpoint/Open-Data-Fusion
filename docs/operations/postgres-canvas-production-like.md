# PostgreSQL Canvas production-like validation runbook

This runbook validates the PostgreSQL Canvas cutover boundary with PostgreSQL,
Redis Streams, Keycloak, two API instances, and the outbox worker. It is a
local/CI rehearsal only: services bind to loopback, Keycloak uses `start-dev`,
and local filesystem storage remains in use for non-Canvas data. It is not an
internet-facing production deployment.

## Preconditions and credential separation

Use a secret manager or the deployment platform to inject every value below.
There are no usable password defaults in either Compose profile.

| Variable | Principal / purpose |
| --- | --- |
| `ODF_POSTGRES_ADMIN_PASSWORD` | Migrator only; never supplied to API or workers |
| `ODF_API_POSTGRES_URL` | Dedicated login inheriting `odf_app` only, used by all stateless API replicas |
| `ODF_OUTBOX_POSTGRES_URL` | Dedicated login inheriting `odf_outbox_publisher` only |
| `ODF_REDIS_PASSWORD` | Redis Streams authentication |
| `ODF_METRICS_TOKEN` | API/Prometheus metrics bearer secret |
| `ODF_GRAFANA_ADMIN_PASSWORD` | Required by the shared Compose configuration even when the observability profile is not started |
| `KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME` / `KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD` | Local/CI identity bootstrap only |
| `ODF_DEMO_USER_PASSWORD` / `ODF_CONNECTOR_CLIENT_SECRET` | Imported local-realm secrets; never browser values |

The application login must be `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, and `NOBYPASSRLS`. It receives membership in `odf_app`, not
the migrator, cutover, or outbox-publisher role. Use a separate password and
connection URL for the outbox login.

Tenant/project creation is a separate bootstrap boundary. Use a dedicated
operator login inheriting `odf_tenant_provisioner`; it has migration-read plus
execute on the one security-definer bootstrap routine, not direct tenant,
project, membership, model-space, or audit-table inserts. The routine's
isolated NOLOGIN owner performs either a complete initial bootstrap or an exact
no-op; neither the API nor the outbox login should receive those provisioning
privileges. The operator must inherit only that role, and its connection URL belongs only in
`ODF_TENANT_PROVISION_POSTGRES_URL` for the controlled CLI.

Create the login roles after migrations with the production identity/secret
workflow. This illustrates the role boundary; replace all placeholders at
deployment time and do not store the commands with passwords in source control.

```sql
CREATE ROLE odf_api_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<managed-secret>';
GRANT odf_app TO odf_api_login;

CREATE ROLE odf_outbox_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<managed-secret>';
GRANT odf_outbox_publisher TO odf_outbox_login;

CREATE ROLE odf_tenant_provision_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<managed-secret>';
GRANT odf_tenant_provisioner TO odf_tenant_provision_login;
```

## Bootstrap and bring up a fresh rehearsal

From the repository root, inject the required values. A new PostgreSQL volume
does not contain the dedicated API/outbox login roles, so do **not** start the
full profile first. `ODF_API_POSTGRES_URL` and `ODF_OUTBOX_POSTGRES_URL` may
remain unset for steps 1-2 only; the API and worker reject empty URLs if they
are started. Bootstrap in this order:

```powershell
# 1. Start only the durable dependencies.
npm run infra:production-like:dependencies

# 2. Apply and verify the migration manifest.
npm run infra:production-like:migrate

# 3. Create the two LOGIN roles through the operator/secret-manager workflow,
#    grant odf_app and odf_outbox_publisher as shown above, and inject the
#    resulting ODF_API_POSTGRES_URL and ODF_OUTBOX_POSTGRES_URL.

# 4. Start Keycloak, two API replicas, and the outbox publisher.
npm run infra:production-like
```

The final command reruns the idempotent migration gate before API startup. A
missing app/outbox connection URL, Redis password, metrics token, Keycloak
secret, or provisioned login fails Compose/API startup instead of falling back
to SQLite or in-memory events.

`api` listens on `127.0.0.1:4310` and `api-replica` on
`127.0.0.1:4311` by default. The overlay configures:

- `ODF_WORKSPACE_PERSISTENCE=postgres` and `ODF_API_POSTGRES_URL`;
- `ODF_SHARED_EVENTS_REQUIRED=true` and authenticated Redis Streams;
- OIDC verification using the Keycloak service hostname inside Compose; and
- an outbox publisher with its own least-privilege database URL.

The normal `application-preview` profile explicitly sets
`ODF_WORKSPACE_PERSISTENCE=sqlite`. It is useful for local UI/container work,
but must not be mistaken for PostgreSQL validation.

## Validate the Canvas boundary

1. Check both API instances report `/ready` and the workspace persistence
   health reports PostgreSQL.
2. Obtain an OIDC token from the local Keycloak realm and call a Canvas
   endpoint with all three required request boundaries:

   ```text
   Authorization: Bearer <OIDC access token>
   x-odf-tenant-id: <tenant UUID>
   x-odf-project-id: <project UUID>
   x-correlation-id: <request UUID, optional>
   ```

   PostgreSQL Canvas endpoints reject absent/malformed tenant or project UUID
   headers. Both headers select the tenant/project scope; a valid token alone
   does not grant project access. If supplied, `x-correlation-id` must also be
   a UUID; if omitted the API generates one and returns it in the response.
3. Make a versioned Canvas update through `api` and hold an SSE connection to
   the same workspace through `api-replica`. Verify the replica receives the
   committed `workspace.updated` event.
4. Verify one matching `odf.outbox_events` row has `published_at` set and
   Redis stream `odf:workspace-events` contains the event. Duplicate delivery
   is expected-safe; consumers deduplicate by event identifier/key and reload
   the durable workspace version when needed.
5. Validate a stale expected version returns HTTP 409, a tenant/project scope
   mismatch returns HTTP 403/404 without disclosing the workspace, and a
   connection using the outbox role cannot alter Canvas tables.

The GitHub Actions `Production-like PostgreSQL Canvas integration` workflow
performs the first four checks against fresh containers on each relevant pull
request.

## Failure response and recovery

- **Migration or readiness failure:** do not start API replicas. Inspect the
  migration manifest and PostgreSQL logs; correct forward with a new numbered
  migration rather than editing an applied file.
- **Redis unavailable:** API startup is blocked because shared delivery is
  required. A Redis failure after startup makes the affected API instance
  unready; remove it from traffic. Do not switch to in-memory events in a
  multi-instance environment. Restore Redis, replace or restart the unready
  API instance, then let the publisher retry unacknowledged PostgreSQL outbox
  rows.
- **Outbox backlog:** inspect `published_at`, `attempt_count`, `available_at`,
  and sanitized `last_error`; an outbox worker whose PostgreSQL/Redis heartbeat
  becomes stale is marked unhealthy. Restore the dependency before replacing
  the worker. PostgreSQL remains the source of truth.
- **OIDC failure:** stop external traffic, verify issuer/audience/JWKS and the
  service identity; do not enable development authentication on a deployed
  profile.
- **Post-cutover database error:** place writes in maintenance mode and apply
  a forward fix or restore to a controlled target. After PostgreSQL accepts
  writes, do not silently replay them into SQLite.

Retain evidence from the rehearsal: migration versions/checksums, API readiness
responses, OIDC issuer/audience validation, outbox/stream counts, and restore
test results. Run PostgreSQL-native backup/restore drills separately before a
pilot; never use `pg_restore --clean` against an unknown production target.
