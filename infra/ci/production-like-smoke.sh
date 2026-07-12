#!/usr/bin/env sh
# Validates the production-like Compose profile after migrations, isolated
# database logins, and a minimal tenant/project/source/workspace fixture exist.
# It exercises the real PostgreSQL asset/telemetry ingest API before Canvas.
# The script intentionally proves the transactional outbox by matching its
# PostgreSQL event_id to the Redis Streams eventId; an SSE event alone is not
# enough evidence because a direct publisher could otherwise hide a dead worker.

set -eu

compose() {
  docker compose \
    -f "${ODF_COMPOSE_BASE:-docker-compose.yml}" \
    -f "${ODF_COMPOSE_PRODUCTION_LIKE:-docker-compose.production-like.yml}" \
    --profile production-like "$@"
}

require_environment() {
  value="$(printenv "$1" 2>/dev/null || true)"
  if [ -z "$value" ]; then
    echo "${1} is required by the production-like smoke test" >&2
    exit 1
  fi
}

wait_for_file_text() {
  file="$1"
  expected="$2"
  attempts=0
  while [ "$attempts" -lt 40 ]; do
    if [ -f "$file" ] && grep -Fq "$expected" "$file"; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  echo "Timed out waiting for '${expected}' in ${file}" >&2
  return 1
}

postgres_value() {
  query="$1"
  result="$(compose exec -T odf-postgres psql \
    --no-psqlrc \
    --tuples-only \
    --no-align \
    --username "${ODF_POSTGRES_ADMIN_USER:-odf_migrator}" \
    --dbname "${ODF_POSTGRES_DB:-odf}" \
    --command "$query")"
  printf '%s' "$result" | tr -d '\r\n'
}

require_environment ODF_REDIS_PASSWORD
require_environment ODF_CONNECTOR_CLIENT_SECRET
require_environment ODF_METRICS_TOKEN

tmp_dir="${TMPDIR:-/tmp}/odf-production-like-smoke-$$"
mkdir -p "$tmp_dir"
sse_pid=""
cleanup() {
  if [ -n "$sse_pid" ]; then
    kill "$sse_pid" 2>/dev/null || true
    wait "$sse_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

api_port="${ODF_API_PORT:-4310}"
replica_port="${ODF_API_REPLICA_PORT:-4311}"
keycloak_port="${ODF_KEYCLOAK_PORT:-8080}"
keycloak_management_port="${ODF_KEYCLOAK_MANAGEMENT_PORT:-9000}"
api_base="http://127.0.0.1:${api_port}"
replica_base="http://127.0.0.1:${replica_port}"
keycloak_base="http://keycloak:${keycloak_port}"
tenant_id="11111111-1111-4111-8111-111111111111"
project_id="22222222-2222-4222-8222-222222222222"
unauthorized_project_id="33333333-3333-4333-8333-333333333333"
workspace_id="ci-production-like-workspace"
correlation_id="44444444-4444-4444-8444-444444444444"

curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 \
  "http://127.0.0.1:${keycloak_management_port}/health/ready" >/dev/null
curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 \
  "${api_base}/ready" >"${tmp_dir}/ready.json"
curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-delay 1 \
  "${replica_base}/ready" >"${tmp_dir}/replica-ready.json"

node -e '
const fs = require("node:fs");
for (const path of process.argv.slice(1)) {
  const health = JSON.parse(fs.readFileSync(path, "utf8"));
  if (health.readiness !== "ready" || health.workspacePersistence?.status !== "ok"
      || health.industrialPersistence?.status !== "ok" || health.industrialPersistence?.mode !== "postgres") {
    throw new Error(`${path} did not report ready PostgreSQL workspace and industrial persistence boundaries`);
  }
}
' "${tmp_dir}/ready.json" "${tmp_dir}/replica-ready.json"

# Use the Compose-internal hostname as the Host header while resolving it to
# the runner loopback port. This keeps the token issuer equal to the API's
# configured internal issuer without requiring a host DNS entry.
curl --fail --silent --show-error --noproxy '*' \
  --resolve "keycloak:${keycloak_port}:127.0.0.1" \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id=open-data-fusion-connector \
  --data-urlencode "client_secret=${ODF_CONNECTOR_CLIENT_SECRET}" \
  "${keycloak_base}/realms/open-data-fusion/protocol/openid-connect/token" \
  >"${tmp_dir}/token.json"
token="$(node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).access_token;
if (typeof value !== "string" || value.length < 20) throw new Error("Keycloak response lacks an access token");
process.stdout.write(value);
' "${tmp_dir}/token.json")"

auth_header="Authorization: Bearer ${token}"
tenant_header="x-odf-tenant-id: ${tenant_id}"
project_header="x-odf-project-id: ${project_id}"

# The web bootstrap path must discover the real PostgreSQL fixture without a
# parallel SQLite catalog or caller-selected user id.
curl --fail --silent --show-error \
  -H "$auth_header" \
  "${api_base}/api/v1/platform/tenants?limit=100" >"${tmp_dir}/tenants.json"
curl --fail --silent --show-error \
  -H "$auth_header" \
  "${api_base}/api/v1/platform/tenants/${tenant_id}/projects?limit=100" >"${tmp_dir}/projects.json"
node -e '
const fs = require("node:fs");
const tenants = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const projects = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (tenants.items.length !== 1 || tenants.items[0].id !== process.argv[3]) {
  throw new Error("authenticated PostgreSQL tenant discovery did not return the CI tenant");
}
if (projects.items.length !== 1 || projects.items[0].tenantId !== process.argv[3] || projects.items[0].id !== process.argv[4]) {
  throw new Error("authenticated PostgreSQL project discovery did not return the CI project");
}
' "${tmp_dir}/tenants.json" "${tmp_dir}/projects.json" "$tenant_id" "$project_id"

# A clean real project must be able to create its first Canvas without demo
# seed data or operator SQL. This crosses the workspace/scope RLS boundary only
# through the governed owner-only PostgreSQL function.
workspace_create_status="$(curl --silent --show-error --output "${tmp_dir}/workspace-created.json" --write-out '%{http_code}' \
  -X POST "${api_base}/api/v1/workspaces" \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  -H "x-correlation-id: 55555555-5555-4555-8555-555555555555" \
  -H "content-type: application/json" \
  --data '{"id":"ci-production-like-workspace","name":"CI production-like workspace"}')"
if [ "$workspace_create_status" != "201" ]; then
  echo "Expected governed first-workspace creation to return 201, received ${workspace_create_status}" >&2
  exit 1
fi
node -e '
const fs = require("node:fs");
const workspace = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (workspace.id !== "ci-production-like-workspace" || workspace.version !== 1
    || workspace.snapshot?.nodes?.length !== 0 || workspace.snapshot?.edges?.length !== 0) {
  throw new Error("governed first-workspace bootstrap returned an invalid initial Canvas");
}
' "${tmp_dir}/workspace-created.json"

cat >"${tmp_dir}/industrial-bundle.json" <<'JSON'
{
  "source": { "system": "ci-opcua", "runId": "ci-industrial-run-1", "actor": "ignored-by-oidc" },
  "assets": [
    { "externalId": "CI-PUMP-201", "name": "CI cooling pump 201", "type": "Pump", "metadata": { "area": "utilities" } }
  ],
  "timeSeries": [
    { "externalId": "CI-PUMP-201-PRESSURE", "assetExternalId": "CI-PUMP-201", "name": "Discharge pressure", "unit": "bar" }
  ],
  "dataPoints": [
    { "timeSeriesExternalId": "CI-PUMP-201-PRESSURE", "timestamp": "2026-07-12T04:00:00.000Z", "value": 7.25, "quality": "good" },
    { "timeSeriesExternalId": "CI-PUMP-201-PRESSURE", "timestamp": "2026-07-12T04:01:00.000Z", "value": 7.4, "quality": "good" }
  ],
  "documents": [
    { "externalId": "CI-PUMP-201-MANUAL", "assetExternalId": "CI-PUMP-201", "title": "CI pump 201 manual", "mimeType": "application/pdf", "uri": "s3://ci-evidence/pump-201.pdf" }
  ],
  "relations": [
    { "sourceType": "asset", "sourceExternalId": "CI-PUMP-201", "targetType": "document", "targetExternalId": "CI-PUMP-201-MANUAL", "relationType": "documentedBy", "status": "proposed", "confidence": 0.98, "evidence": { "method": "ci-smoke" } }
  ]
}
JSON

industrial_correlation_id="88888888-8888-4888-8888-888888888888"
curl --fail --silent --show-error \
  -X POST "${api_base}/api/v1/ingest/bundle" \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  -H "x-correlation-id: ${industrial_correlation_id}" \
  -H "content-type: application/json" \
  --data-binary "@${tmp_dir}/industrial-bundle.json" \
  >"${tmp_dir}/industrial-first.json"

industrial_retry_status="$(curl --silent --show-error --output "${tmp_dir}/industrial-retry.json" --write-out '%{http_code}' \
  -X POST "${replica_base}/api/v1/ingest/bundle" \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  -H "x-correlation-id: 99999999-9999-4999-8999-999999999999" \
  -H "content-type: application/json" \
  --data-binary "@${tmp_dir}/industrial-bundle.json")"
if [ "$industrial_retry_status" != "200" ]; then
  echo "Expected idempotent cross-replica ingest retry to return 200, received ${industrial_retry_status}" >&2
  exit 1
fi

curl --fail --silent --show-error \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  "${api_base}/api/v1/assets/CI-PUMP-201" >"${tmp_dir}/industrial-asset.json"
curl --fail --silent --show-error \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  "${replica_base}/api/v1/assets/CI-PUMP-201/telemetry?from=2026-07-12T03%3A59%3A00.000Z&to=2026-07-12T04%3A02%3A00.000Z" \
  >"${tmp_dir}/industrial-telemetry.json"

node -e '
const fs = require("node:fs");
const first = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const retry = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const asset = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const telemetry = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
if (first.status !== "completed" || first.runId !== "ci-industrial-run-1" || !first.rawSha256) {
  throw new Error("PostgreSQL industrial ingest did not return completed raw evidence");
}
if (retry.status !== "already_processed" || retry.runId !== "ci-industrial-run-1") {
  throw new Error("cross-replica PostgreSQL ingest was not idempotent");
}
if (asset.asset?.externalId !== "CI-PUMP-201" || asset.timeSeries?.length !== 1 || asset.documents?.length !== 1) {
  throw new Error("ingested PostgreSQL asset context is incomplete");
}
if (telemetry.series?.[0]?.points?.length !== 2 || telemetry.series[0].points[1].value !== 7.4) {
  throw new Error("ingested PostgreSQL telemetry was not readable from the replica");
}
' "${tmp_dir}/industrial-first.json" "${tmp_dir}/industrial-retry.json" \
  "${tmp_dir}/industrial-asset.json" "${tmp_dir}/industrial-telemetry.json"

industrial_evidence="$(postgres_value "SELECT count(*) FROM odf.ingestion_runs AS run JOIN odf.audit_log AS audit ON audit.entity_id = run.ingestion_run_id::text WHERE run.tenant_id = '${tenant_id}'::uuid AND run.project_id = '${project_id}'::uuid AND run.idempotency_key = 'ci-industrial-run-1' AND run.state = 'succeeded' AND run.raw_object_id IS NOT NULL AND audit.tenant_id = run.tenant_id AND audit.project_id = run.project_id AND audit.action = 'ingestion.completed';")"
if [ "$industrial_evidence" != "1" ]; then
  echo "PostgreSQL industrial run lacks structurally scoped raw/audit evidence" >&2
  exit 1
fi

# The raw record was archived through API A, while listing and replay happen
# through API B. This proves both PostgreSQL metadata and the immutable S3
# bytes are genuinely shared instead of replicated local filesystem state.
raw_landing_id="$(node -e '
const fs = require("node:fs");
const id = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).rawObjectId;
if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("ingest response lacks PostgreSQL raw landing ID");
process.stdout.write(id);
' "${tmp_dir}/industrial-first.json")"
curl --fail --silent --show-error \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  "${replica_base}/api/v1/platform/ingestion/raw?limit=100" >"${tmp_dir}/raw-list.json"
node -e '
const fs = require("node:fs");
const listed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expectedId = process.argv[2];
const item = listed.items?.find((candidate) => candidate.id === expectedId);
if (!item || item.state !== "accepted" || item.runId !== "ci-industrial-run-1"
    || item.rawObjectUri !== `raw://${process.argv[3]}/${process.argv[4]}/${expectedId}`) {
  throw new Error("replica could not read shared PostgreSQL raw landing metadata");
}
' "${tmp_dir}/raw-list.json" "$raw_landing_id" "$tenant_id" "$project_id"
raw_replay_status="$(curl --silent --show-error --output "${tmp_dir}/raw-replay.json" --write-out '%{http_code}' \
  -X POST "${replica_base}/api/v1/platform/ingestion/raw/${raw_landing_id}/replay" \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  -H "x-correlation-id: 12121212-1212-4121-8121-121212121212")"
if [ "$raw_replay_status" != "201" ]; then
  echo "Expected raw replay through API replica to return 201, received ${raw_replay_status}" >&2
  exit 1
fi
node -e '
const fs = require("node:fs");
const replay = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (replay.status !== "completed" || replay.replayedFromRawObjectId !== process.argv[2]
    || replay.rawObject?.lastReplayRunId?.indexOf("replay-") !== 0) {
  throw new Error("replica replay did not consume shared immutable raw evidence");
}
' "${tmp_dir}/raw-replay.json" "$raw_landing_id"

# Upload one governed object through API A, then full and range-read it through
# API B. The two containers have separate /var/lib/odf volumes, so this also
# proves the object metadata no longer falls back to local SQLite/filesystem.
governed_object_id="ci-shared-governed-object"
printf '%s' 'shared governed object bytes 2026-07-12' >"${tmp_dir}/governed.bin"
curl --fail --silent --show-error \
  -X POST "${api_base}/api/v1/platform/objects/${governed_object_id}/versions" \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  -H 'x-correlation-id: 13131313-1313-4131-8131-131313131313' \
  -H 'content-type: text/plain' \
  -H 'x-odf-file-name: ci-governed.txt' \
  -H 'x-odf-title: CI shared governed object' \
  --data-binary "@${tmp_dir}/governed.bin" >"${tmp_dir}/governed-created.json"
node -e '
const fs = require("node:fs");
const created = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (created.object?.id !== process.argv[2] || created.object?.currentVersion !== 1
    || created.version?.version !== 1 || !/^[0-9a-f]{64}$/.test(created.version?.sha256 ?? "")) {
  throw new Error("shared governed object upload returned invalid metadata");
}
' "${tmp_dir}/governed-created.json" "$governed_object_id"
curl --fail --silent --show-error \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  "${replica_base}/api/v1/platform/objects/${governed_object_id}/content" >"${tmp_dir}/governed-replica.bin"
curl --fail --silent --show-error \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" -H 'range: bytes=7-20' \
  "${replica_base}/api/v1/platform/objects/${governed_object_id}/content" >"${tmp_dir}/governed-range.bin"
node -e '
const fs = require("node:fs");
const original = fs.readFileSync(process.argv[1]);
const replica = fs.readFileSync(process.argv[2]);
const range = fs.readFileSync(process.argv[3]);
if (!original.equals(replica) || !range.equals(original.subarray(7, 21))) {
  throw new Error("governed object bytes were not readable through the separate API replica");
}
' "${tmp_dir}/governed.bin" "${tmp_dir}/governed-replica.bin" "${tmp_dir}/governed-range.bin"

object_storage_evidence="$(postgres_value "SELECT (EXISTS (SELECT 1 FROM odf.raw_landing_objects WHERE tenant_id = '${tenant_id}'::uuid AND project_id = '${project_id}'::uuid AND landing_id = '${raw_landing_id}'::uuid AND storage_profile = 'primary' AND object_version_id <> 'unversioned') AND EXISTS (SELECT 1 FROM odf.governed_object_versions WHERE tenant_id = '${tenant_id}'::uuid AND project_id = '${project_id}'::uuid AND object_id = '${governed_object_id}' AND version = 1 AND storage_profile = 'primary' AND object_version_id <> 'unversioned'))::text;")"
if [ "$object_storage_evidence" != "true" ]; then
  echo "shared object metadata does not retain immutable S3 version evidence" >&2
  exit 1
fi

# The API retrieves the governed object through S3 HeadObject before it can
# stream it, so its successful range read above proves AES256 object metadata.
# The privileged bootstrap utility separately proves the bucket itself remains
# versioned, encrypted by default, and private. Its application-mode probe
# proves the API identity has neither bucket administration nor object escape/
# deletion capability.
governed_object_key="$(postgres_value "SELECT object_key FROM odf.governed_object_versions WHERE tenant_id = '${tenant_id}'::uuid AND project_id = '${project_id}'::uuid AND object_id = '${governed_object_id}' AND version = 1;")"
case "$governed_object_key" in
  odf/v1/governed/*) ;;
  *)
    echo "governed object did not use the restricted S3 prefix" >&2
    exit 1
    ;;
esac
compose run --rm --no-deps --entrypoint /bin/sh minio-bootstrap /verify.sh admin
compose run --rm --no-deps -e "ODF_MINIO_VERIFY_OBJECT_KEY=${governed_object_key}" \
  --entrypoint /bin/sh minio-bootstrap /verify.sh application

unauthorized_object_scope_status="$(curl --silent --show-error --output "${tmp_dir}/unauthorized-object-scope.json" --write-out '%{http_code}' \
  -H "$auth_header" -H "$tenant_header" -H "x-odf-project-id: ${unauthorized_project_id}" \
  "${api_base}/api/v1/platform/objects/${governed_object_id}")"
if [ "$unauthorized_object_scope_status" != "403" ]; then
  echo "Expected governed object access in an unauthorized project to return 403, received ${unauthorized_object_scope_status}" >&2
  exit 1
fi

unauthorized_industrial_scope_status="$(curl --silent --show-error --output "${tmp_dir}/unauthorized-industrial-scope.json" --write-out '%{http_code}' \
  -H "$auth_header" -H "$tenant_header" -H "x-odf-project-id: ${unauthorized_project_id}" \
  "${api_base}/api/v1/assets")"
if [ "$unauthorized_industrial_scope_status" != "403" ]; then
  echo "Expected the existing project without membership to return 403, received ${unauthorized_industrial_scope_status}" >&2
  exit 1
fi

curl --fail --silent --show-error \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  "${api_base}/api/v1/workspaces/${workspace_id}" >"${tmp_dir}/workspace-before.json"
node -e '
const fs = require("node:fs");
const workspace = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (workspace.id !== "ci-production-like-workspace" || workspace.version !== 1) {
  throw new Error("CI-provisioned PostgreSQL workspace is not visible through the API");
}
' "${tmp_dir}/workspace-before.json"

# The replica must subscribe before the write. The transaction's outbox event
# is then delivered through Redis Streams rather than an API-local event hub.
curl --no-buffer --silent --show-error \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  "${replica_base}/api/v1/workspaces/${workspace_id}/events" >"${tmp_dir}/replica-events.txt" &
sse_pid="$!"
wait_for_file_text "${tmp_dir}/replica-events.txt" ": connected"

curl --fail --silent --show-error \
  -X PUT "${api_base}/api/v1/workspaces/${workspace_id}" \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  -H "x-correlation-id: ${correlation_id}" \
  -H "content-type: application/json" \
  --data '{"expectedVersion":1,"actor":"ignored-by-oidc","changeSummary":"Production-like PostgreSQL Canvas smoke update","snapshot":{"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}}' \
  >"${tmp_dir}/workspace-after.json"
node -e '
const fs = require("node:fs");
const workspace = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (workspace.version !== 2) throw new Error("Canvas update did not commit version 2");
' "${tmp_dir}/workspace-after.json"

wait_for_file_text "${tmp_dir}/replica-events.txt" "event: workspace.updated"

outbox_event_id="$(postgres_value "SELECT event_id FROM odf.outbox_events WHERE correlation_id = '${correlation_id}'::uuid AND event_type = 'workspace.updated' ORDER BY event_id DESC LIMIT 1;")"
if [ -z "$outbox_event_id" ]; then
  echo "No transactional outbox row was created for the Canvas update" >&2
  exit 1
fi

attempts=0
while [ "$attempts" -lt 40 ]; do
  published_event_id="$(postgres_value "SELECT event_id FROM odf.outbox_events WHERE event_id = ${outbox_event_id} AND published_at IS NOT NULL;")"
  if [ "$published_event_id" = "$outbox_event_id" ]; then
    break
  fi
  attempts=$((attempts + 1))
  sleep 1
done
if [ "${published_event_id:-}" != "$outbox_event_id" ]; then
  echo "Outbox event ${outbox_event_id} was not acknowledged as published" >&2
  exit 1
fi

stream_raw="$(compose exec -T -e "REDISCLI_AUTH=${ODF_REDIS_PASSWORD}" odf-redis \
  redis-cli --no-auth-warning --raw XRANGE odf:workspace-events - +)"
stream_event_ids="$(printf '%s\n' "$stream_raw" | \
  awk 'next_is_event_id { print; next_is_event_id = 0; next } $0 == "eventId" { next_is_event_id = 1 }')"
if ! printf '%s\n' "$stream_event_ids" | grep -Fxq "$outbox_event_id"; then
  echo "Redis stream does not contain transactional outbox eventId ${outbox_event_id}" >&2
  exit 1
fi

stale_status="$(curl --silent --show-error --output "${tmp_dir}/stale.json" --write-out '%{http_code}' \
  -X PUT "${api_base}/api/v1/workspaces/${workspace_id}" \
  -H "$auth_header" -H "$tenant_header" -H "$project_header" \
  -H "content-type: application/json" \
  --data '{"expectedVersion":1,"actor":"ignored-by-oidc","changeSummary":"Expected stale update","snapshot":{"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}}')"
if [ "$stale_status" != "409" ]; then
  echo "Expected stale Canvas update to return 409, received ${stale_status}" >&2
  exit 1
fi

wrong_scope_status="$(curl --silent --show-error --output "${tmp_dir}/wrong-scope.json" --write-out '%{http_code}' \
  -H "$auth_header" -H "$tenant_header" -H "x-odf-project-id: ${unauthorized_project_id}" \
  "${api_base}/api/v1/workspaces/${workspace_id}")"
case "$wrong_scope_status" in
  403|404) ;;
  *)
    echo "Expected mismatched project scope to return 403 or 404, received ${wrong_scope_status}" >&2
    exit 1
    ;;
esac

curl --fail --silent --show-error \
  -H "Authorization: Bearer ${ODF_METRICS_TOKEN}" \
  "${api_base}/metrics" | grep -Fq 'odf_api_http_requests_total'

role_boundary="$(postgres_value "SELECT (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'odf_ci_api' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))) AND pg_has_role('odf_ci_api', 'odf_app', 'member') AND has_table_privilege('odf_ci_api', 'odf.workspaces', 'UPDATE') AND NOT has_table_privilege('odf_ci_api', 'odf.outbox_events', 'UPDATE') AND pg_has_role('odf_ci_outbox', 'odf_outbox_publisher', 'member') AND has_table_privilege('odf_ci_outbox', 'odf.outbox_events', 'UPDATE') AND NOT has_table_privilege('odf_ci_outbox', 'odf.workspaces', 'UPDATE');")"
if [ "$role_boundary" != "t" ]; then
  echo "Dedicated API/outbox PostgreSQL role boundary was not preserved" >&2
  exit 1
fi

echo "Production-like PostgreSQL industrial and Canvas smoke passed (outbox event ${outbox_event_id})."
