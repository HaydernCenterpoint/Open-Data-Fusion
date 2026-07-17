#!/usr/bin/env python3
"""Static validation for recovery, telemetry, and ingress production gates."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import cast


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from infra.pilot_gate.contract import REQUIRED_CHECK_IDS, load_manifest


def read(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        raise AssertionError(f"missing production-gate asset: {relative}")
    return path.read_text(encoding="utf-8")


def require(text: str, values: list[str], label: str) -> None:
    for value in values:
        if value not in text:
            raise AssertionError(f"{label} is missing required invariant: {value}")


def require_lf_shell_scripts(root: Path) -> None:
    for path in sorted(root.rglob("*.sh")):
        if path.is_file() and b"\r\n" in path.read_bytes():
            raise AssertionError(f"shell script contains CRLF line endings: {path.relative_to(root)}")


def main() -> None:
    require_lf_shell_scripts(ROOT / "infra")

    pilot_manifest_text = read("infra/pilot-gate.example.json")
    pilot_manifest = load_manifest(ROOT / "infra/pilot-gate.example.json")
    if pilot_manifest.environment_id != "managed-staging":
        raise AssertionError("pilot manifest must target managed staging")
    if not pilot_manifest.scope.read_only or pilot_manifest.scope.writeback_authorized:
        raise AssertionError("pilot manifest scope must remain read-only")
    if len(REQUIRED_CHECK_IDS) != 16:
        raise AssertionError("pilot gate must retain all 16 managed checks")
    require(
        pilot_manifest_text,
        ["reviewerKeySha256", "migrationSetSha256", "writebackAuthorized"],
        "production pilot manifest",
    )

    backup = read("infra/ci/postgres-backup-restore-rehearsal.sh")
    broker_rehearsal = read("infra/ci/outbox-broker-rehearsal.sh")
    observability_rehearsal = read("infra/ci/production-like-observability-smoke.sh")
    security_ingress_smoke = read("infra/ci/security-ingress-smoke.sh")
    edge_mtls_rehearsal = read("infra/ci/edge-agent-mtls-rehearsal.sh")
    edge_mtls_configuration = read("infra/security/rehearsal/edge-agent-mtls.json")
    production_like_compose = read("docker-compose.production-like.yml")
    production_like_workflow = read(".github/workflows/production-like-integration.yml")
    api_instrumentation = read("apps/api/src/instrumentation.ts")
    api_observability = read("apps/api/src/observability.ts")
    require(
        backup,
        [
            "pg_dump",
            "pg_restore",
            "--single-transaction",
            "sha256sum",
            "cmp -s",
            "dropdb --if-exists --force",
            "api api-replica outbox-worker pipeline-worker edge-agent",
        ],
        "backup/restore rehearsal",
    )

    outbox = read("apps/outbox-worker/src/outbox.ts")
    repository = read("apps/outbox-worker/src/postgres.ts")
    recovery = read("apps/outbox-worker/src/recovery-cli.ts")
    telemetry = read("apps/outbox-worker/src/telemetry.ts")
    pipeline_telemetry = read("apps/pipeline-worker/src/telemetry.ts")
    pipeline_health = read("apps/pipeline-worker/src/health.ts")
    require(outbox, ["maximumDeliveryAttempts", "repository.deadLetter", "deadLettered"], "outbox pump")
    require(
        repository,
        ["available_at = 'infinity'::timestamptz", "operationalSnapshot", "requeueDeadLetter", "attempt_count = 0"],
        "outbox repository",
    )
    require(recovery, ['mode: "dry_run"', 'args.includes("--apply")', "numeric outbox event ID"], "outbox recovery CLI")
    require(
        telemetry,
        ["odf_outbox_dead_letter_events", "odf_outbox_oldest_pending_age_seconds", "odf_outbox_redis_ready"],
        "outbox telemetry",
    )
    require(
        pipeline_telemetry,
        ["odf_pipeline_cycles_total", "odf_pipeline_last_successful_cycle_timestamp_seconds", "startPipelineTelemetryServer"],
        "pipeline telemetry",
    )
    require(pipeline_health, ["PipelineHealthFile", "lastSuccessAt", "rename"], "pipeline health heartbeat")

    compose = read("docker-compose.yml")
    prometheus = read("infra/observability/prometheus.yml")
    alerts = read("infra/observability/alerts.yml")
    slo = read("infra/observability/slo.yml")
    collector = read("infra/observability/otel-collector-config.yaml")
    require(
        compose,
        ["ODF_OUTBOX_MAX_ATTEMPTS", "ODF_PIPELINE_METRICS_PORT", "/healthz", "odf-otel-data:/var/lib/otel", "otel-storage-init"],
        "Compose operations profile",
    )
    require(prometheus, ["/etc/prometheus/slo.yml", "outbox-worker:9465", "pipeline-worker:9466"], "Prometheus config")
    require(
        alerts,
        ["OdfOutboxDeadLettersPresent", "OdfOutboxBacklogStale", "OdfPipelineWorkerDown", "OdfPipelineWorkerStale", "OdfApiAvailabilityFastBurn", "OdfApiLatencyP95High"],
        "Prometheus alerts",
    )
    require(
        slo,
        ["odf:api_http_error_ratio:ratio_5m", "odf:api_http_latency_p95_seconds:5m", "odf:outbox_publish_success:ratio_5m"],
        "SLO recording rules",
    )
    require(collector, ["file/traces:", "file/logs:", "max_megabytes: 100", "max_days: 7"], "durable OTel config")
    require(
        api_instrumentation,
        ['serviceName: "open-data-fusion-api"', "autoDetectResources: false"],
        "API telemetry resource policy",
    )
    require(
        api_observability,
        ["createApiLogger", "redactedLogRecord", "redactedSerializedLog", "streamWrite", "SENSITIVE_FIELD"],
        "API redacted Pino logging",
    )
    require(
        production_like_compose,
        [
            'ODF_OTEL_ENABLED: "true"',
            "OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318",
            "OTEL_LOGS_EXPORTER: otlp",
            "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: http/protobuf",
        ],
        "production-like OTLP wiring",
    )
    require(
        observability_rehearsal,
        [
            "otel-collector",
            "Prometheus targets healthy",
            "traces.json",
            "logs.json",
            "generate_correlation_id",
            "wait_for_durable_log",
            "Durable API log evidence",
            "trigger_worker_log_probe",
            "wait_for_durable_worker_log",
            "Durable worker log evidence",
            "x-odf-observability-probe",
            "outbox-worker",
            "pipeline-worker",
            "Collector durable telemetry volume",
        ],
        "production-like observability rehearsal",
    )
    require(
        broker_rehearsal,
        [
            "ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM",
            "CONFIG SET maxmemory 1",
            "available_at = 'infinity'::timestamptz",
            "requeue --event-id",
            "wait_for_restored_writers",
            "CLIENT PAUSE \"$CONCURRENCY_WRITE_PAUSE_MILLISECONDS\" WRITE",
            "CLIENT UNPAUSE",
            "CONCURRENCY_FIXTURE_ROW_COUNT=6",
            "count(DISTINCT lease_owner)",
            "CONCURRENCY_STALE_ATTEMPT_COUNT + 1",
            "run_two_worker_concurrency_rehearsal",
            "stream_event_position",
            "ODF_OUTBOX_POSTGRES_URL must target local Compose service",
            "fixture_insert_attempted",
            "concurrency_fixture_insert_attempted",
            "delete_fixture_stream",
            "assert_only_temporary_workers_active",
            "trap '' INT TERM",
        ],
        "outbox broker rehearsal",
    )

    require(
        security_ingress_smoke,
        [
            "ODF_SECURITY_INGRESS_SMOKE_CONFIRM",
            "ODF_ENVOY_IMAGE must be pinned",
            "no_client_certificate_status",
            "unauthenticated mTLS ingest",
            "non-ingest mTLS route",
        ],
        "security ingress smoke",
    )

    require(
        edge_mtls_rehearsal,
        [
            "ODF_EDGE_MTLS_REHEARSAL_CONFIRM",
            "ci-edge-mtls",
            "ODF_ENVOY_IMAGE must be pinned",
            "Queued ingest batch delivered",
            "odf-mtls-gateway",
        ],
        "edge mTLS delivery rehearsal",
    )
    try:
        parsed_edge_mtls_configuration: object = json.loads(edge_mtls_configuration)
    except json.JSONDecodeError as error:
        raise AssertionError(f"edge mTLS fixture configuration is invalid JSON: {error}") from error
    if not isinstance(parsed_edge_mtls_configuration, dict):
        raise AssertionError("edge mTLS fixture configuration must be a JSON object")
    require(
        edge_mtls_configuration,
        [
            '"apiBaseUrl": "https://odf-mtls-gateway:9443"',
            '"sourceSystem": "ci-edge-mtls"',
            '"certificateFile": "/run/secrets/odf_edge_ingest_client_cert"',
            '"privateKeyFile": "/run/secrets/odf_edge_ingest_client_key"',
        ],
        "edge mTLS fixture configuration",
    )
    require(
        production_like_workflow,
        ["vars.ODF_APPROVED_ENVOY_IMAGE", "ci-edge-mtls", "edge-agent-mtls-rehearsal.sh", "two-worker lease drain"],
        "conditional edge mTLS CI rehearsal",
    )

    envoy = read("infra/security/envoy-connector-mtls.yaml")
    security_compose = read("docker-compose.security-rehearsal.yml")
    network_policies = read("infra/security/kubernetes/network-policies.yaml")
    pki = read("infra/security/generate-rehearsal-pki.sh")
    require(
        envoy,
        ["require_client_certificate: true", "tls_minimum_protocol_version: TLSv1_2", "x-odf-mtls-verified", "request_headers_to_remove"],
        "connector mTLS gateway",
    )
    require(
        security_compose,
        [
            "ODF_ENVOY_IMAGE:?",
            "read_only: true",
            'cap_drop: ["ALL"]',
            "ODF_INGRESS_CLIENT_CA_FILE:?",
            "odf_edge_ingest_client_cert",
            "odf_edge_ingest_client_key",
            "ODF_INGRESS_CLIENT_CERT_FILE:?",
            "ODF_INGRESS_CLIENT_KEY_FILE:?",
        ],
        "security rehearsal Compose overlay",
    )
    require(
        network_policies,
        [
            "name: odf-default-deny",
            "policyTypes: [Ingress, Egress]",
            "name: odf-postgres-ingress",
            "name: odf-pipeline-egress-and-metrics",
            "name: odf-prometheus-scrape-egress",
            "name: odf-otel-collector-ingress",
        ],
        "network policy baseline",
    )
    require(
        pki,
        [
            "-days 7",
            "extendedKeyUsage=clientAuth",
            "spiffe://open-data-fusion/rehearsal/connector",
            "ODF_INGRESS_CLIENT_CERT_FILE=",
            "ODF_INGRESS_CLIENT_KEY_FILE=",
        ],
        "rehearsal PKI generator",
    )
    if "BEGIN PRIVATE KEY" in "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in (ROOT / "infra" / "security").rglob("*")
        if path.is_file()
    ):
        raise AssertionError("infra/security must never contain committed private key material")

    loaded_contract: object = json.loads(read("infra/security/secret-contract.json"))
    if not isinstance(loaded_contract, dict):
        raise AssertionError("secret contract must be a JSON object")
    contract = cast(dict[str, object], loaded_contract)
    if contract.get("schemaVersion") != 1:
        raise AssertionError("secret contract schemaVersion must be 1")
    raw_secrets_value = contract.get("secrets")
    if not isinstance(raw_secrets_value, list):
        raise AssertionError("secret contract is incomplete")
    raw_secrets = cast(list[object], raw_secrets_value)
    if len(raw_secrets) < 8:
        raise AssertionError("secret contract is incomplete")
    secrets: list[dict[str, object]] = []
    for raw_secret in raw_secrets:
        if not isinstance(raw_secret, dict):
            raise AssertionError("every secret contract entry must be an object")
        secrets.append(cast(dict[str, object], raw_secret))
    names: list[str] = []
    for secret in secrets:
        name = secret.get("name")
        if not isinstance(name, str) or not name:
            raise AssertionError("secret contract names must be unique and non-empty")
        names.append(name)
    if len(names) != len(set(names)):
        raise AssertionError("secret contract names must be unique and non-empty")
    required_secret_contract_entries = {
        "postgres-pipeline-credential",
        "edge-ingest-client-certificate",
        "edge-ingest-client-private-key",
        "edge-ingest-server-trust-bundle",
    }
    if not required_secret_contract_entries.issubset(set(names)):
        raise AssertionError("secret contract is missing pipeline or edge mTLS material")
    if any("value" in secret for secret in secrets):
        raise AssertionError("secret contract must describe delivery without embedding values")

    for runbook in [
        "docs/operations/postgres-backup-restore-rehearsal.md",
        "docs/operations/outbox-dead-letter-recovery.md",
        "docs/operations/observability-slos.md",
        "docs/operations/production-ingress-security.md",
    ]:
        _ = read(runbook)

    print("Production recovery, telemetry, SLO, and ingress security gates validated.")


if __name__ == "__main__":
    main()
