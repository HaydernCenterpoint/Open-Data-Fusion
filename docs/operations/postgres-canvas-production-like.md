# PostgreSQL industrial-core and Canvas production-like validation runbook

This runbook validates `ODF_DATA_PERSISTENCE=postgres` for the project-scoped
industrial core (assets, telemetry, relations, audit, and bundle ingest) and
Canvas with PostgreSQL, Redis Streams, Keycloak, two API instances, and the
outbox worker. It is a local/CI rehearsal only: services bind to loopback,
Keycloak uses `start-dev`, and local filesystem/SQLite storage remains in use
for raw-landing metadata, platform catalog, governed objects, and advanced
product surfaces. It is not an internet-facing production deployment.

The API selects one authoritative industrial/Canvas backend. This profile does
not dual-write authoritative industrial/Canvas state to SQLite and PostgreSQL,
and `ODF_WORKSPACE_PERSISTENCE` cannot be set to a different value from
`ODF_DATA_PERSISTENCE`.

## Preconditions and credential separation

Use a secret manager or the deployment platform to inject every value below.
There are no usable password defaults in either Compose profile.

| Variable | Principal / purpose |
| --- | --- |
| `ODF_POSTGRES_ADMIN_PASSWORD` | Migrator only; never supplied to API or workers |
| `ODF_API_POSTGRES_URL` | Dedicated login inheriting `odf_app` only, used by all API replicas for PostgreSQL-backed boundaries; local raw/object/advanced surfaces remain replica-local |
| `ODF_OUTBOX_POSTGRES_URL` | Dedicated login inheriting `odf_outbox_publisher` only |
| `ODF_REDIS_PASSWORD` | Redis Streams authentication |
| `ODF_METRICS_TOKEN` | API/Prometheus metrics bearer secret |
| `ODF_GRAFANA_ADMIN_PASSWORD` | Required by the shared Compose configuration even when the observability profile is not started |
| `KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME` / `KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD` | Local/CI identity bootstrap only |
| `ODF_DEMO_USER_PASSWORD` / `ODF_CONNECTOR_CLIENT_SECRET` | Imported local-realm secrets; never browser values |

The application login must be `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`,
`NOREPLICATION`, and `NOBYPASSRLS`. It receives membership in `odf_app`, not
the migrator, cutover, or outbox-publisher role. That role serves both the
industrial core and Canvas under forced RLS. Use a separate password and
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
does not contain the purpose-specific API, outbox, or provisioning logins, so
do **not** start the full profile first. Their connection URLs may remain unset
for steps 1-2 only; each caller rejects a missing URL when used. Bootstrap in
this order:

```powershell
# 1. Start only the durable dependencies.
npm run infra:production-like:dependencies

# 2. Apply and verify the migration manifest.
npm run infra:production-like:migrate

# 3. Create the API, outbox, and tenant-provision LOGIN roles through the
#    operator/secret-manager workflow, grant only the roles shown above, and
#    inject their three purpose-specific connection URLs.

# 4. Provision the real tenant/project and initial owner. The command rehearses
#    and rolls back unless --apply is explicit.
$env:ODF_TENANT_PROVISION_POSTGRES_URL = "postgresql://<tenant-provision-login>:<managed-secret>@127.0.0.1:5432/odf"
npm run tenant:provision --workspace @open-data-fusion/api -- `
  --tenant-id 8f45343a-bcd4-4f6f-9a77-50e385bb47c0 `
  --tenant-slug acme-industries --tenant-name "Acme Industries" `
  --project-id 14e09a33-e58f-4aaa-a66d-9ca86c040db1 `
  --project-slug site-a --project-name "Site A" `
  --owner-user-id service-account-open-data-fusion-connector `
  --model-space-id 2f702a61-03bd-46ab-b521-8b92f996ea8c `
  --model-space-slug default --model-space-name "Default model space" `
  --provisioned-by local-platform-operator --apply

# 5. Register an active source connection whose external_id exactly matches the
#    ingest bundle's source.system. Run this as the odf_app login, under RLS.
@'
BEGIN;
SELECT odf.set_tenant_context('8f45343a-bcd4-4f6f-9a77-50e385bb47c0'::uuid);
SELECT set_config('odf.project_id', '14e09a33-e58f-4aaa-a66d-9ca86c040db1', true);
INSERT INTO odf.source_connections (
  source_connection_id, tenant_id, project_id, external_id, name,
  connector_kind, state, endpoint, secret_ref, connector_config
) VALUES (
  '5ee92aa6-a412-459f-80c6-64ec32993bed'::uuid,
  '8f45343a-bcd4-4f6f-9a77-50e385bb47c0'::uuid,
  '14e09a33-e58f-4aaa-a66d-9ca86c040db1'::uuid,
  'site-a-opcua', 'Site A OPC UA', 'opcua', 'ready',
  'opc.tcp://opcua.site-a.example:4840',
  'secret://open-data-fusion/site-a-opcua',
  '{"readOnly":true}'::jsonb
);
COMMIT;
'@ | docker compose -f docker-compose.yml -f docker-compose.production-like.yml `
  --profile production-like exec -T odf-postgres `
  psql "$env:ODF_API_POSTGRES_URL" --no-psqlrc --set=ON_ERROR_STOP=1

# 6. Start Keycloak, two API replicas, and the outbox publisher.
npm run infra:production-like
```

`service-account-open-data-fusion-connector` is the subject used by the bundled
local Keycloak connector client. Replace it with the exact verified token
subject when rehearsing against another identity provider.

The final command reruns the idempotent migration gate before API startup. A
missing app/outbox connection URL, Redis password, metrics token, Keycloak
secret, or provisioned application login fails Compose/API startup instead of
falling back to SQLite or in-memory events. The tenant provisioning CLI fails
independently if its dedicated URL is absent.

`api` listens on `127.0.0.1:4310` and `api-replica` on
`127.0.0.1:4311` by default. The overlay configures:

- `ODF_DATA_PERSISTENCE=postgres` as the authoritative industrial/Canvas mode;
- `ODF_WORKSPACE_PERSISTENCE=postgres` only as a matching compatibility value;
- `ODF_API_POSTGRES_URL` for the least-privilege application login;
- `ODF_SHARED_EVENTS_REQUIRED=true` and authenticated Redis Streams;
- OIDC verification using the Keycloak service hostname inside Compose; and
- an outbox publisher with its own least-privilege database URL.

The normal `application-preview` profile explicitly sets both
`ODF_DATA_PERSISTENCE=sqlite` and `ODF_WORKSPACE_PERSISTENCE=sqlite`. It is
useful for local UI/container work, but must not be mistaken for PostgreSQL
validation. Both profiles start with `ODF_SEED=false`; real tenant/project and
source data must be created or ingested explicitly.

The two tenant/project GET discovery routes use PostgreSQL in this profile and
return only active scopes where the authenticated identity has project
membership. Tenant/project POST routes fail closed and require the controlled
provisioning workflow. Other platform catalog routes remain SQLite-backed; in
particular, posting a platform source/connector does not create an
`odf.source_connections` row. PostgreSQL bundle ingest therefore requires the
controlled source-registration transaction above (or an equivalent reviewed
operator workflow) until that administration surface is cut over.

Tenant provisioning creates the active project owner and default model space;
it does not manufacture a Canvas fixture. After authentication, that project
owner creates the first real workspace through `POST /api/v1/workspaces` as
shown below. PostgreSQL migration 010 performs the circular workspace/scope
bootstrap behind a narrowly granted `SECURITY DEFINER` function and records
revision 1, audit, and outbox evidence. Do not turn on `ODF_SEED` in this
profile.

## Validate the industrial-core and Canvas boundaries

1. Check both API instances return HTTP 200 from `/ready`. Confirm
   `industrialPersistence.mode` is `postgres`, the industrial and workspace
   health statuses are `ok`, and required shared event delivery is healthy.
2. Obtain an OIDC token for the exact user ID provisioned as project owner. The
   token must include the permission required by each operation. Send all three
   request boundaries on industrial-core and Canvas calls:

   ```text
   Authorization: Bearer <OIDC access token>
   x-odf-tenant-id: <tenant UUID>
   x-odf-project-id: <project UUID>
   x-correlation-id: <request UUID, optional>
   ```

   PostgreSQL endpoints reject absent/malformed tenant or project UUID headers.
   Both headers select the scope; a valid token alone does not grant project
   access. If supplied, `x-correlation-id` must also be a UUID; if omitted the
   API generates one and returns it in the response.
3. Verify backend-aligned discovery before opening Explorer. The tenant list and
   project list must include the provisioned active scope for this identity and
   must not expose scopes where it lacks project membership:

   ```powershell
   $authHeaders = @{ Authorization = "Bearer <OIDC-access-token>" }
   Invoke-RestMethod -Uri "http://127.0.0.1:4310/api/v1/platform/tenants" `
     -Headers $authHeaders
   Invoke-RestMethod `
     -Uri "http://127.0.0.1:4310/api/v1/platform/tenants/8f45343a-bcd4-4f6f-9a77-50e385bb47c0/projects" `
     -Headers $authHeaders
   ```

   Tenant/project POST requests must fail closed in this profile; provisioning
   remains the audited operational workflow.
4. Create the first empty Canvas workspace through the first API instance:

   ```powershell
   $headers = @{
     Authorization = "Bearer <OIDC-access-token>"
     "x-odf-tenant-id" = "8f45343a-bcd4-4f6f-9a77-50e385bb47c0"
     "x-odf-project-id" = "14e09a33-e58f-4aaa-a66d-9ca86c040db1"
   }
   $workspace = @{ id = "site-a-operations"; name = "Site A operations" } |
     ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4310/api/v1/workspaces" `
     -Headers $headers -ContentType "application/json" -Body $workspace
   ```

   Expect HTTP 201, version 1, an empty node/edge snapshot, and the caller as
   owner. Set `VITE_WORKSPACE_ID=site-a-operations` for the web deployment.
   Reusing the ID returns HTTP 409.
5. Submit a complete source bundle through the first API instance. Its
   `source.system` must match the active PostgreSQL source connection registered
   during bootstrap:

   ```powershell
   $headers = @{
     Authorization = "Bearer <OIDC-access-token>"
     "x-odf-tenant-id" = "8f45343a-bcd4-4f6f-9a77-50e385bb47c0"
     "x-odf-project-id" = "14e09a33-e58f-4aaa-a66d-9ca86c040db1"
   }
   $bundle = @{
     source = @{ system = "site-a-opcua"; runId = "site-a-opcua-20260712T100000Z" }
     assets = @(
       @{ externalId = "COMPRESSOR-101"; name = "Main air compressor"; type = "compressor" }
     )
     timeSeries = @(
       @{
         externalId = "COMPRESSOR-101-DISCHARGE-PRESSURE"
         assetExternalId = "COMPRESSOR-101"
         name = "Discharge pressure"
         unit = "bar"
       }
     )
     dataPoints = @(
       @{
         timeSeriesExternalId = "COMPRESSOR-101-DISCHARGE-PRESSURE"
         timestamp = "2026-07-12T10:00:00Z"
         value = 7.42
         quality = "good"
       }
     )
   } | ConvertTo-Json -Depth 8

   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4310/api/v1/ingest/bundle" `
     -Headers $headers -ContentType "application/json" -Body $bundle
   ```

   Expect HTTP 201 and `status: completed`. Read the result through the second
   API instance and verify the returned timestamp, value, unit, and quality:

   ```powershell
   Invoke-RestMethod `
     -Uri "http://127.0.0.1:4311/api/v1/assets/COMPRESSOR-101/telemetry/latest?timeSeriesExternalId=COMPRESSOR-101-DISCHARGE-PRESSURE" `
     -Headers $headers
   ```

6. Replay the exact bundle and expect HTTP 200 with
   `status: already_processed`. Change the payload while retaining the same
   `runId` and expect HTTP 409. Verify the original measurement is unchanged.
7. Make a versioned Canvas update through `api` and hold an SSE connection to
   the same workspace through `api-replica`. Verify the replica receives the
   committed `workspace.updated` event.
8. Verify one matching `odf.outbox_events` row has `published_at` set and
   Redis stream `odf:workspace-events` contains the event. Duplicate delivery
   is expected-safe; consumers deduplicate by event identifier/key and reload
   the durable workspace version when needed.
9. Validate a stale Canvas version returns HTTP 409, a tenant/project scope
   mismatch returns HTTP 403/404 without disclosing industrial or Canvas data,
   the API role cannot bypass RLS, and the outbox role cannot alter application
   tables.

The GitHub Actions `Production-like PostgreSQL Canvas integration and industrial data smoke` workflow
currently automates readiness, OIDC, membership-scoped tenant/project
discovery, active source registration, real bundle ingest, cross-replica
idempotency and asset/telemetry read-back, scoped raw/audit evidence,
wrong-scope denial, Canvas/outbox/SSE, and role-boundary checks against fresh
containers. Run the environment-specific steps above as deployment rehearsal;
CI is evidence for the checked-in topology, not a substitute for a pilot drill.

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
responses, OIDC issuer/audience validation, ingest/idempotency results,
tenant-isolation checks, outbox/stream counts, and restore test results. Run
PostgreSQL-native backup/restore drills separately before a pilot; never use
`pg_restore --clean` against an unknown production target.
