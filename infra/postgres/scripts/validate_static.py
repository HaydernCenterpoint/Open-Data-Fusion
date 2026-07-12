#!/usr/bin/env python3
"""Dependency-free guardrails for PostgreSQL/Compose infrastructure changes.

This is deliberately static: it verifies immutable migration content, checksum
coverage, tenant/RLS guardrails, and the compose/observability artifacts without
requiring Docker, PostgreSQL, or a network connection.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "infra" / "postgres" / "migrations"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def canonical_sql_digest(path: Path) -> str:
    # SHA256SUMS deliberately uses LF-canonical SQL so it remains stable for
    # Windows checkout users as well as Linux CI and the migration container.
    content = path.read_bytes().replace(b"\r\n", b"\n")
    require(b"\r" not in content, f"{path.relative_to(ROOT)} contains a bare carriage return")
    return hashlib.sha256(content).hexdigest()


def validate_manifest() -> list[Path]:
    migration_paths = sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql"))
    require(bool(migration_paths), "no numbered PostgreSQL migrations found")

    manifest_path = MIGRATIONS / "SHA256SUMS"
    manifest_rows = [line.split() for line in read(manifest_path).splitlines() if line.strip()]
    expected = {
        path.name: canonical_sql_digest(path)
        for path in migration_paths
    }
    actual = {parts[1]: parts[0] for parts in manifest_rows if len(parts) == 2}
    require(actual == expected, "SHA256SUMS must contain exactly every numbered migration and its current SHA-256")
    return migration_paths


def validate_migrations(migration_paths: list[Path]) -> None:
    for path in migration_paths:
        sql = read(path)
        require(re.search(r"^BEGIN;", sql, re.MULTILINE) is not None, f"{path.name} must begin a transaction")
        require(re.search(r"^COMMIT;\s*$", sql, re.MULTILINE) is not None, f"{path.name} must commit its transaction")
        require("ADD CONSTRAINT IF NOT EXISTS" not in sql.upper(), f"{path.name} uses unsupported ADD CONSTRAINT IF NOT EXISTS")
        require("CREATE INDEX CONCURRENTLY" not in sql.upper(), f"{path.name} cannot use concurrent indexes inside its transaction")

    platform = read(MIGRATIONS / "003_tenant_industrial_data_plane.sql")
    required_tables = [
        "tenants",
        "projects",
        "datasets",
        "source_connections",
        "raw_ingest_objects",
        "ingestion_runs",
        "source_checkpoints",
        "quarantined_records",
        "data_models",
        "model_views",
        "graph_instances",
        "assets",
        "time_series",
        "time_series_points",
        "documents",
        "relations",
        "relation_candidates",
        "provenance_records",
        "pipelines",
        "pipeline_runs",
        "quality_rules",
        "quality_results",
        "writeback_requests",
        "writeback_approvals",
    ]
    for table in required_tables:
        require(f"CREATE TABLE IF NOT EXISTS odf.{table}" in platform, f"missing tenant data-plane table: {table}")

    for guardrail in [
        "odf.current_tenant_id()",
        "odf.set_tenant_context",
        "FORCE ROW LEVEL SECURITY",
        "CREATE POLICY tenant_isolation",
        "odf_app",
        "odf_outbox_publisher",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA odf REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
        "reject_platform_history_mutation",
        "writeback_request_requires_approval",
        "writeback_request_state_transition",
        "writeback_request_initial_state",
        "WHERE state = 'proposed'",
        "WHERE state IN ('queued', 'running')",
    ]:
        require(guardrail in platform, f"missing data-plane guardrail: {guardrail}")

    validate_tenant_foreign_keys(platform)

    cutover = read(MIGRATIONS / "004_sqlite_cutover_role.sql")
    for guardrail in [
        "CREATE ROLE odf_cutover NOLOGIN NOSUPERUSER",
        "ALTER ROLE odf_cutover WITH NOLOGIN NOSUPERUSER",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_cutover",
        "GRANT SELECT ON odf.schema_migrations TO odf_cutover",
        "odf.workspaces",
        "odf.workspace_revisions",
        "odf.workspace_members",
        "odf.audit_log",
        "GRANT SELECT, UPDATE ON SEQUENCE odf.audit_log_id_seq TO odf_cutover",
    ]:
        require(guardrail in cutover, f"missing SQLite cutover role guardrail: {guardrail}")

    workspace_grants = read(MIGRATIONS / "006_workspace_application_role_grants.sql")
    for guardrail in [
        "GRANT SELECT, UPDATE ON odf.workspaces TO odf_app",
        "GRANT SELECT, INSERT ON odf.workspace_revisions TO odf_app",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON odf.workspace_members TO odf_app",
        "GRANT SELECT ON odf.workspaces, odf.workspace_revisions, odf.workspace_members TO odf_readonly",
        "REVOKE INSERT, UPDATE, DELETE ON odf.workspace_scopes FROM odf_app",
    ]:
        require(guardrail in workspace_grants, f"missing PostgreSQL Canvas least-privilege guardrail: {guardrail}")

    provisioner = read(MIGRATIONS / "007_tenant_project_provisioning_role.sql")
    for guardrail in [
        "CREATE ROLE odf_tenant_provisioner",
        "CREATE ROLE odf_tenant_provision_owner",
        "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS",
        "ALTER ROLE odf_tenant_provisioner WITH",
        "ALTER ROLE odf_tenant_provision_owner WITH",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_tenant_provisioner",
        "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_tenant_provisioner",
        "GRANT SELECT ON odf.schema_migrations TO odf_tenant_provisioner",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_tenant_provision_owner",
        "GRANT SELECT, INSERT ON",
        "odf.tenants",
        "odf.projects",
        "odf.tenant_members",
        "odf.project_members",
        "odf.model_spaces",
        "odf.audit_log",
        "GRANT USAGE ON SEQUENCE odf.audit_log_id_seq TO odf_tenant_provision_owner",
        "CREATE POLICY tenant_provision_owner_read",
        "CREATE POLICY tenant_provision_owner_insert",
        "TO odf_tenant_provision_owner USING (true)",
        "TO odf_tenant_provision_owner WITH CHECK (true)",
        "CREATE OR REPLACE FUNCTION odf.provision_tenant_project(",
        "SECURITY DEFINER",
        "SET search_path = pg_catalog, odf, pg_temp",
        "SET row_security = on",
        "tenant/project bootstrap target is partially occupied",
        "tenant/project bootstrap target already exists but is not an exact completed bootstrap",
        "ALTER FUNCTION odf.provision_tenant_project(",
        "OWNER TO odf_tenant_provision_owner",
        "GRANT EXECUTE ON FUNCTION odf.provision_tenant_project(",
        ") TO odf_tenant_provisioner;",
        "REVOKE INSERT, UPDATE, DELETE ON odf.projects FROM odf_app",
        "REVOKE INSERT, UPDATE, DELETE ON odf.tenant_members, odf.project_members FROM odf_app",
    ]:
        require(guardrail in provisioner, f"missing tenant/project provisioning guardrail: {guardrail}")
    require(
        re.search(r"CREATE POLICY\s+tenant_provisioner_.*?TO\s+odf_tenant_provisioner", provisioner, re.DOTALL) is None,
        "tenant provisioner must not receive global RLS policies",
    )
    direct_provisioner_table_grants = [
        (" ".join(privileges.split()), " ".join(relation.split()))
        for privileges, relation in re.findall(
            r"GRANT\s+([^;]+?)\s+ON\s+(?:TABLE\s+)?(odf\.[^;]+?)\s+TO\s+odf_tenant_provisioner\s*;",
            provisioner,
            re.DOTALL,
        )
    ]
    require(
        direct_provisioner_table_grants == [("SELECT", "odf.schema_migrations")],
        "tenant provisioner must have only schema_migrations SELECT and no direct tenant data grants",
    )

    hardening = read(MIGRATIONS / "008_industrial_runtime_hardening.sql")
    for guardrail in [
        "CREATE OR REPLACE FUNCTION odf.current_project_id()",
        "ADD COLUMN IF NOT EXISTS tenant_id uuid",
        "ADD COLUMN IF NOT EXISTS project_id uuid",
        "audit_log_project_scope_fk",
        "CREATE TRIGGER audit_log_populate_scope",
        "ALTER TABLE odf.audit_log FORCE ROW LEVEL SECURITY",
        "CREATE POLICY audit_log_app_scope",
        "CREATE POLICY audit_log_readonly_scope",
        "CREATE POLICY audit_log_cutover_insert",
        "CREATE POLICY audit_log_provision_owner_insert",
        "GRANT DELETE ON odf.document_asset_links TO odf_app",
        "CREATE EXTENSION IF NOT EXISTS pg_trgm",
        "graph_instances_external_id_trgm_idx",
        "assets_name_trgm_idx",
    ]:
        require(guardrail in hardening, f"missing industrial runtime hardening guardrail: {guardrail}")

    discovery = read(MIGRATIONS / "009_membership_scoped_project_discovery.sql")
    for guardrail in [
        "CREATE ROLE odf_project_discovery_owner",
        "ALTER ROLE odf_project_discovery_owner WITH",
        "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_project_discovery_owner",
        "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_project_discovery_owner",
        "GRANT SELECT ON",
        "CREATE POLICY project_discovery_owner_read",
        "TO odf_project_discovery_owner USING (true)",
        "CREATE OR REPLACE FUNCTION odf.discover_accessible_tenants(",
        "CREATE OR REPLACE FUNCTION odf.discover_accessible_projects(",
        "current_setting('odf.user_id', true)",
        "current_setting('odf.tenant_id', true)",
        "SECURITY DEFINER",
        "SET row_security = on",
        "OWNER TO odf_project_discovery_owner",
        "GRANT EXECUTE ON FUNCTION odf.discover_accessible_tenants(uuid, integer) TO odf_app",
        "GRANT EXECUTE ON FUNCTION odf.discover_accessible_projects(uuid, integer) TO odf_app",
    ]:
        require(guardrail in discovery, f"missing PostgreSQL project discovery guardrail: {guardrail}")
    require("p_user_id" not in discovery, "SECURITY DEFINER discovery functions must not accept a caller-selected user id")
    require("p_tenant_id" not in discovery, "SECURITY DEFINER project discovery must use the transaction tenant setting")
    require("odf.platform_admin" not in discovery, "PostgreSQL discovery must not add an unguarded platform-admin bypass")

    workspace_bootstrap = read(MIGRATIONS / "010_project_workspace_bootstrap.sql")
    for guardrail in [
        "CREATE ROLE odf_workspace_bootstrap_owner",
        "ALTER ROLE odf_workspace_bootstrap_owner WITH",
        "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS",
        "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA odf FROM odf_workspace_bootstrap_owner",
        "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA odf FROM odf_workspace_bootstrap_owner",
        "CREATE POLICY workspace_bootstrap_owner_read",
        "CREATE POLICY workspace_bootstrap_owner_insert",
        "CREATE OR REPLACE FUNCTION odf.create_project_workspace(",
        "current_setting('odf.tenant_id', true)",
        "current_setting('odf.project_id', true)",
        "current_setting('odf.user_id', true)",
        "active project owner permission is required",
        "SECURITY DEFINER",
        "SET search_path = pg_catalog, odf, pg_temp",
        "SET row_security = on",
        "OWNER TO odf_workspace_bootstrap_owner",
        "GRANT EXECUTE ON FUNCTION odf.create_project_workspace(uuid, text, text, uuid) TO odf_app",
        "'workspace.created'",
        "INSERT INTO odf.workspace_scopes",
        "INSERT INTO odf.workspace_revisions",
        "INSERT INTO odf.audit_log",
        "INSERT INTO odf.outbox_events",
    ]:
        require(guardrail in workspace_bootstrap, f"missing project workspace bootstrap guardrail: {guardrail}")
    require(
        "GRANT INSERT ON odf.workspaces TO odf_app" not in workspace_bootstrap,
        "workspace bootstrap must not grant direct workspace INSERT to the application role",
    )


def validate_tenant_foreign_keys(sql: str) -> None:
    """Catch scope-breaking composite FKs before a migration reaches PostgreSQL.

    This is intentionally a narrow check for the regular table declarations in
    migration 003, not a replacement for PostgreSQL's SQL parser. It ensures
    every FK uses local columns that exist and points to a declared primary or
    unique key, which is especially important for tenant/project-scoped keys.
    """

    table_matches: list[tuple[str, str]] = re.findall(
        r"CREATE TABLE IF NOT EXISTS odf\.(\w+) \((.*?)\n\);",
        sql,
        flags=re.DOTALL,
    )
    tables: dict[str, str] = dict(table_matches)
    require(len(tables) >= 30, "could not identify every data-plane table for FK validation")

    unique_keys: dict[str, set[tuple[str, ...]]] = {}
    table_columns: dict[str, set[str]] = {}
    for table, definition in tables.items():
        columns: set[str] = set()
        keys: set[tuple[str, ...]] = set()
        for line in definition.splitlines():
            normalized = line.strip().rstrip(",")
            if not normalized or normalized.startswith(("FOREIGN KEY", "UNIQUE", "CHECK", "PRIMARY KEY", "CONSTRAINT")):
                continue
            match = re.match(r"(\w+)\s+", normalized)
            if match:
                columns.add(match.group(1))
            if "PRIMARY KEY" in normalized and match:
                keys.add((match.group(1),))
        for match in re.finditer(r"\b(?:PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)", definition):
            keys.add(tuple(column.strip() for column in match.group(1).split(",")))
        table_columns[table] = columns
        unique_keys[table] = keys

    foreign_keys: re.Pattern[str] = re.compile(
        r"FOREIGN KEY \(([^)]+)\)\s*\n\s*REFERENCES odf\.(\w+)\(([^)]+)\)"
    )
    for table, definition in tables.items():
        require("tenant_id" in table_columns[table], f"{table} is missing mandatory tenant_id")
        foreign_key_matches: list[tuple[str, str, str]] = foreign_keys.findall(definition)
        for local_raw, referenced_table, referenced_raw in foreign_key_matches:
            local = tuple(column.strip() for column in local_raw.split(","))
            referenced = tuple(column.strip() for column in referenced_raw.split(","))
            missing = set(local) - table_columns[table]
            require(not missing, f"{table} FK references missing local columns: {sorted(missing)}")
            require(referenced_table in unique_keys, f"{table} FK references unknown table {referenced_table}")
            require(
                referenced in unique_keys[referenced_table],
                f"{table} FK references non-unique key {referenced_table}{referenced}",
            )

    rls_table_names = re.search(
        r"FOREACH table_name IN ARRAY ARRAY\[(.*?)\] LOOP\s+" +
        r"EXECUTE format\('ALTER TABLE odf\.\%I ENABLE ROW LEVEL SECURITY'",
        sql,
        flags=re.DOTALL,
    )
    if rls_table_names is None:
        raise AssertionError("could not identify the tenant RLS table list")
    rls_tables = set(re.findall(r"'(\w+)'", rls_table_names.group(1)))
    missing_rls = sorted(set(tables) - rls_tables)
    require(not missing_rls, f"tenant-scoped tables missing from RLS enforcement: {missing_rls}")


def validate_runtime_artifacts() -> None:
    validate_build_context()

    compose = read(ROOT / "docker-compose.yml")
    for service in ["odf-postgres:", "odf-redis:", "outbox-worker:", "otel-collector:", "prometheus:", "grafana:"]:
        require(service in compose, f"docker-compose.yml missing {service}")
    require("application-preview" in compose, "application preview profile is missing")
    require("ODF_DATA_PERSISTENCE: sqlite" in compose, "application preview must select the SQLite data backend")
    require("ODF_WORKSPACE_PERSISTENCE: sqlite" in compose, "the application preview must explicitly select SQLite")
    require("profiles: [\"workers\"]" in compose, "outbox worker must remain an explicitly enabled profile")
    require("service_completed_successfully" in compose, "outbox worker must wait for the migration gate")
    require("maxmemory-policy noeviction" in compose, "Redis Streams baseline must not evict queued data")
    require("ODF_OUTBOX_HEALTH_FILE" in compose, "outbox worker must expose a dependency heartbeat")
    require("lastSuccessAt" in compose, "outbox worker healthcheck must reject stale heartbeats")
    require("odf_metrics_token:" in compose, "Compose must define the API metrics secret")
    require("ODF_GRAFANA_ADMIN_PASSWORD:?Set" in compose, "Grafana must not have a checked-in fallback password")

    identity = read(ROOT / "docker-compose.identity.yml")
    for required_secret in [
        "KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME:?Set",
        "KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD:?Set",
        "ODF_DEMO_USER_PASSWORD:?Set",
        "ODF_CONNECTOR_CLIENT_SECRET:?Set",
    ]:
        require(required_secret in identity, f"Keycloak identity profile must require {required_secret.split(':', 1)[0]}")
    require("/health/ready" in identity, "Keycloak identity profile must expose a readiness healthcheck")

    realm = json.loads(read(ROOT / "infra" / "keycloak" / "open-data-fusion-realm.json"))
    clients = realm.get("clients", [])
    require(
        all("roles" not in client for client in clients),
        "Keycloak client roles must be declared in RealmRepresentation.roles.client, not ClientRepresentation.roles",
    )
    api_roles = realm.get("roles", {}).get("client", {}).get("open-data-fusion-api", [])
    required_api_roles = {
        "data:read",
        "data:ingest",
        "relations:review",
        "audit:read",
        "platform:admin",
        "writeback:request",
        "writeback:approve",
        "writeback:execute",
    }
    require(
        {role.get("name") for role in api_roles} == required_api_roles,
        "Keycloak realm must define the complete Open Data Fusion API client-role set",
    )

    production_like = read(ROOT / "docker-compose.production-like.yml")
    for service in ["keycloak:", "api:", "api-replica:", "outbox-worker:"]:
        require(service in production_like, f"production-like Compose profile missing {service}")
    for guardrail in [
        "profiles: [\"production-like\"]",
        "ODF_WORKSPACE_PERSISTENCE: postgres",
        "ODF_DATA_PERSISTENCE: postgres",
        "ODF_API_POSTGRES_URL:",
        "ODF_SEED: \"false\"",
        "ODF_OUTBOX_POSTGRES_URL:",
        "ODF_SHARED_EVENTS_REQUIRED: \"true\"",
        "KC_HOSTNAME: http://keycloak:8080",
        "service_completed_successfully",
    ]:
        require(guardrail in production_like, f"production-like Compose profile missing guardrail: {guardrail}")

    production_like_workflow = read(ROOT / ".github" / "workflows" / "production-like-integration.yml")
    for guardrail in [
        "Production-like PostgreSQL Canvas integration",
        "odf_ci_api",
        "odf_ci_outbox",
        "odf_ci_tenant_provision",
        "Prove security-definer tenant bootstrap boundary",
        "odf.provision_tenant_project",
        "production-like-smoke.sh",
        '"packages/contracts/**"',
        '"packages/platform-core/**"',
    ]:
        require(guardrail in production_like_workflow, f"production-like integration workflow missing guardrail: {guardrail}")

    infrastructure_workflow = read(ROOT / ".github" / "workflows" / "infra-validate.yml")
    for guardrail in [
        "Create least-privilege runtime probe principal",
        "odf_validation_api",
        "GRANT odf_app TO odf_validation_api",
        "postgresql://odf_validation_api:",
    ]:
        require(guardrail in infrastructure_workflow, f"infrastructure runtime probe missing guardrail: {guardrail}")

    production_like_smoke = read(ROOT / "infra" / "ci" / "production-like-smoke.sh")
    for guardrail in [
        "published_at IS NOT NULL",
        "XRANGE odf:workspace-events",
        "eventId",
        "event: workspace.updated",
        "/api/v1/platform/tenants?limit=100",
        "/projects?limit=100",
        "authenticated PostgreSQL tenant discovery",
        "/api/v1/ingest/bundle",
        "ci-industrial-run-1",
        "cross-replica PostgreSQL ingest was not idempotent",
        "run.raw_object_id IS NOT NULL",
        "audit.tenant_id = run.tenant_id",
        "has_table_privilege('odf_ci_api'",
    ]:
        require(guardrail in production_like_smoke, f"production-like smoke script missing assertion: {guardrail}")
    require(
        "wrong_project_id" not in production_like_smoke,
        "production-like smoke script must use its declared unauthorized project fixture",
    )

    otel = read(ROOT / "infra" / "observability" / "otel-collector-config.yaml")
    prometheus = read(ROOT / "infra" / "observability" / "prometheus.yml")
    alerts = read(ROOT / "infra" / "observability" / "alerts.yml")
    require("otlp:" in otel and "prometheus:" in otel, "OTel collector must receive OTLP and expose Prometheus metrics")
    require("otel-collector:9464" in prometheus, "Prometheus must scrape the collector metric endpoint")
    require("open-data-fusion-api" in prometheus, "Prometheus must scrape the API metrics endpoint")
    require("credentials_file: /run/secrets/odf_metrics_token" in prometheus, "Prometheus API scrape must read its bearer token from a secret file")
    require("OdfTelemetryCollectorDown" in alerts, "baseline alert is missing")

    api_dockerfile = read(ROOT / "Dockerfile.api")
    web_dockerfile = read(ROOT / "Dockerfile.web")
    outbox_dockerfile = read(ROOT / "Dockerfile.outbox")
    require("USER node" in api_dockerfile, "API runtime image must not run as root")
    require("COPY packages/postgres-runtime ./packages/postgres-runtime" in api_dockerfile, "API build must include the PostgreSQL runtime workspace")
    require("/workspace/packages/postgres-runtime/dist ./packages/postgres-runtime/dist" in api_dockerfile, "API image must include the PostgreSQL runtime build")
    require("ODF_METRICS_TOKEN_FILE=/run/secrets/odf_metrics_token" in api_dockerfile, "API container must load its metrics token from the mounted secret")
    require("nginx-unprivileged" in web_dockerfile, "web runtime image must use an unprivileged server")
    require("USER node" in outbox_dockerfile, "outbox runtime image must not run as root")


def validate_build_context() -> None:
    """Ensure Docker never receives local state or credentials as build input."""

    ignored = {
        line.strip()
        for line in read(ROOT / ".dockerignore").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    required_ignores = {
        ".git/",
        ".env",
        ".env.*",
        "**/.env",
        "**/.env.*",
        "!.env.example",
        "!**/.env.example",
        "secrets/",
        "node_modules/",
        "**/node_modules/",
        "dist/",
        "**/dist/",
        "coverage/",
        "**/coverage/",
        "*.log",
        "data/",
        "apps/*/data/",
        "raw/",
        "raw-archives/",
        "archives/",
        "apps/*/raw/",
        "apps/*/raw-archives/",
        "apps/*/archives/",
        "**/*.db",
        "**/*.sqlite",
        "docs/design/cognite-demo-reference.png",
        "docs/design/reference/",
        ".vscode/",
        ".idea/",
    }
    missing = sorted(required_ignores - ignored)
    require(not missing, f".dockerignore is missing protected build-context paths: {missing}")

    example_index = [line.strip() for line in read(ROOT / ".dockerignore").splitlines()].index("!.env.example")
    env_index = [line.strip() for line in read(ROOT / ".dockerignore").splitlines()].index(".env.*")
    require(example_index > env_index, ".env.example must be unignored after the .env.* rule")


def main() -> int:
    try:
        migrations = validate_manifest()
        validate_migrations(migrations)
        validate_runtime_artifacts()
    except (AssertionError, OSError, UnicodeError, ValueError) as error:
        print(f"Infrastructure static validation failed: {error}", file=sys.stderr)
        return 1

    print(f"Infrastructure static validation passed ({len(migrations)} migrations, tenant/RLS, compose, and observability checks).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
