#!/usr/bin/env python3
"""Static validation for recovery, telemetry, and ingress production gates."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        raise AssertionError(f"missing production-gate asset: {relative}")
    return path.read_text(encoding="utf-8")


def require(text: str, values: list[str], label: str) -> None:
    for value in values:
        if value not in text:
            raise AssertionError(f"{label} is missing required invariant: {value}")


def main() -> None:
    backup = read("infra/ci/postgres-backup-restore-rehearsal.sh")
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

    compose = read("docker-compose.yml")
    prometheus = read("infra/observability/prometheus.yml")
    alerts = read("infra/observability/alerts.yml")
    slo = read("infra/observability/slo.yml")
    collector = read("infra/observability/otel-collector-config.yaml")
    require(compose, ["ODF_OUTBOX_MAX_ATTEMPTS", "odf-otel-data:/var/lib/otel", "otel-storage-init"], "Compose operations profile")
    require(prometheus, ["/etc/prometheus/slo.yml", "outbox-worker:9465"], "Prometheus config")
    require(
        alerts,
        ["OdfOutboxDeadLettersPresent", "OdfOutboxBacklogStale", "OdfApiAvailabilityFastBurn", "OdfApiLatencyP95High"],
        "Prometheus alerts",
    )
    require(
        slo,
        ["odf:api_http_error_ratio:ratio_5m", "odf:api_http_latency_p95_seconds:5m", "odf:outbox_publish_success:ratio_5m"],
        "SLO recording rules",
    )
    require(collector, ["file/traces:", "file/logs:", "max_megabytes: 100", "max_days: 7"], "durable OTel config")

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
        ["ODF_ENVOY_IMAGE:?", "read_only: true", 'cap_drop: ["ALL"]', "ODF_INGRESS_CLIENT_CA_FILE:?"],
        "security rehearsal Compose overlay",
    )
    require(network_policies, ["name: odf-default-deny", "policyTypes: [Ingress, Egress]", "name: odf-postgres-ingress"], "network policy baseline")
    require(pki, ["-days 7", "extendedKeyUsage=clientAuth", "spiffe://open-data-fusion/rehearsal/connector"], "rehearsal PKI generator")
    if "BEGIN PRIVATE KEY" in "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in (ROOT / "infra" / "security").rglob("*")
        if path.is_file()
    ):
        raise AssertionError("infra/security must never contain committed private key material")

    contract = json.loads(read("infra/security/secret-contract.json"))
    if contract.get("schemaVersion") != 1:
        raise AssertionError("secret contract schemaVersion must be 1")
    secrets = contract.get("secrets")
    if not isinstance(secrets, list) or len(secrets) < 8:
        raise AssertionError("secret contract is incomplete")
    names = [item.get("name") for item in secrets if isinstance(item, dict)]
    if len(names) != len(set(names)) or any(not name for name in names):
        raise AssertionError("secret contract names must be unique and non-empty")
    if any("value" in item for item in secrets if isinstance(item, dict)):
        raise AssertionError("secret contract must describe delivery without embedding values")

    for runbook in [
        "docs/operations/postgres-backup-restore-rehearsal.md",
        "docs/operations/outbox-dead-letter-recovery.md",
        "docs/operations/observability-slos.md",
        "docs/operations/production-ingress-security.md",
    ]:
        read(runbook)

    print("Production recovery, telemetry, SLO, and ingress security gates validated.")


if __name__ == "__main__":
    main()
