#!/usr/bin/env python3
"""Dependency-free guardrails for PostgreSQL/Compose infrastructure changes.

This is deliberately static: it verifies immutable migration content, checksum
coverage, tenant/RLS guardrails, and the compose/observability artifacts without
requiring Docker, PostgreSQL, or a network connection.
"""

from __future__ import annotations

import hashlib
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
    require(migration_paths, "no numbered PostgreSQL migrations found")

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


def validate_tenant_foreign_keys(sql: str) -> None:
    """Catch scope-breaking composite FKs before a migration reaches PostgreSQL.

    This is intentionally a narrow check for the regular table declarations in
    migration 003, not a replacement for PostgreSQL's SQL parser. It ensures
    every FK uses local columns that exist and points to a declared primary or
    unique key, which is especially important for tenant/project-scoped keys.
    """

    tables = dict(
        re.findall(
            r"CREATE TABLE IF NOT EXISTS odf\.(\w+) \((.*?)\n\);",
            sql,
            flags=re.DOTALL,
        )
    )
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

    foreign_keys = re.compile(
        r"FOREIGN KEY \(([^)]+)\)\s*\n\s*REFERENCES odf\.(\w+)\(([^)]+)\)"
    )
    for table, definition in tables.items():
        require("tenant_id" in table_columns[table], f"{table} is missing mandatory tenant_id")
        for local_raw, referenced_table, referenced_raw in foreign_keys.findall(definition):
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
        r"FOREACH table_name IN ARRAY ARRAY\[(.*?)\] LOOP\s+"
        r"EXECUTE format\('ALTER TABLE odf\.\%I ENABLE ROW LEVEL SECURITY'",
        sql,
        flags=re.DOTALL,
    )
    require(rls_table_names is not None, "could not identify the tenant RLS table list")
    rls_tables = set(re.findall(r"'(\w+)'", rls_table_names.group(1)))
    missing_rls = sorted(set(tables) - rls_tables)
    require(not missing_rls, f"tenant-scoped tables missing from RLS enforcement: {missing_rls}")


def validate_runtime_artifacts() -> None:
    validate_build_context()

    compose = read(ROOT / "docker-compose.yml")
    for service in ["odf-postgres:", "odf-redis:", "outbox-worker:", "otel-collector:", "prometheus:", "grafana:"]:
        require(service in compose, f"docker-compose.yml missing {service}")
    require("application-preview" in compose, "application containers must remain explicitly preview-only until the PostgreSQL adapter exists")
    require("profiles: [\"workers\"]" in compose, "outbox worker must remain an explicitly enabled profile")
    require("service_completed_successfully" in compose, "outbox worker must wait for the migration gate")
    require("maxmemory-policy noeviction" in compose, "Redis Streams baseline must not evict queued data")
    require("odf_metrics_token:" in compose, "Compose must define the API metrics secret")

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
    except (AssertionError, OSError, UnicodeError) as error:
        print(f"Infrastructure static validation failed: {error}", file=sys.stderr)
        return 1

    print(f"Infrastructure static validation passed ({len(migrations)} migrations, tenant/RLS, compose, and observability checks).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
