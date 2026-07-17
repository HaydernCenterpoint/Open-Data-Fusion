from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any

from . import SCHEMA_VERSION


class ContractError(ValueError):
    """Raised when a pilot manifest violates the approved contract."""


CHECKS_BY_GATE: dict[int, tuple[str, ...]] = {
    0: ("deployment-preflight", "tenant-isolation"),
    1: (
        "ingress-security",
        "network-isolation",
        "credential-rotation",
        "secret-scan",
    ),
    2: (
        "database-object-restore",
        "broker-recovery",
        "replica-worker-recovery",
        "idempotency-checkpoints",
    ),
    3: ("durable-telemetry", "alert-delivery", "service-objectives"),
    4: ("connector-csv", "connector-postgres", "connector-opcua"),
}
CHECK_GATE = {
    check_id: gate
    for gate, check_ids in CHECKS_BY_GATE.items()
    for check_id in check_ids
}
REQUIRED_CHECK_IDS = frozenset(CHECK_GATE)
REQUIRED_IMAGES = frozenset(
    {"api", "web", "outbox-worker", "pipeline-worker", "edge-agent"}
)
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$")


@dataclass(frozen=True)
class Targets:
    rpo_minutes: float
    rto_minutes: float
    availability_percent: float
    latency_p95_seconds: float
    outbox_freshness_seconds: float
    observation_days: int
    load_multiplier: float
    evidence_retention_days: int


@dataclass(frozen=True)
class ConnectorTarget:
    kind: str
    external_id: str
    measured_peak_rate: float | None
    required_average_rate: float | None
    source_safety_ceiling_rate: float | None
    approved_backfill_window_minutes: float
    entity_count: int
    time_series_count: int
    average_record_bytes: int
    retention_days: int
    schema_fingerprint_sha256: str


@dataclass(frozen=True)
class Migration:
    version: str
    sha256: str


@dataclass(frozen=True)
class Scope:
    pilot_project_external_id: str
    synthetic_project_external_id: str
    read_only: bool
    writeback_authorized: bool


@dataclass(frozen=True)
class PilotManifest:
    schema_version: int
    pilot_run_id: str
    predecessor_pilot_run_id: str | None
    operator_id: str
    incident_contact_id: str
    scope: Scope
    environment_id: str
    application_commit: str
    migrations: tuple[Migration, ...]
    migration_set_sha256: str
    image_digests: dict[str, str]
    targets: Targets
    connectors: tuple[ConnectorTarget, ...]


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(f"{label} must be an object")
    return dict(value)


def _require_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    extra = sorted(set(value) - expected)
    missing = sorted(expected - set(value))
    if extra or missing:
        raise ContractError(
            f"{label} has unexpected fields; missing={missing}, extra={extra}"
        )


def _text(
    value: object,
    label: str,
    pattern: re.Pattern[str] = IDENTIFIER_PATTERN,
) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ContractError(f"{label} has an invalid value")
    return value


def _number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ContractError(f"{label} must be finite")
    if result <= 0:
        raise ContractError(f"{label} must be greater than zero")
    return result


def _integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ContractError(f"{label} must be a positive integer")
    return value


def _non_negative_integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ContractError(f"{label} must be a non-negative integer")
    return value


def parse_manifest(raw_value: object) -> PilotManifest:
    raw = _object(raw_value, "manifest")
    _require_keys(
        raw,
        {
            "schemaVersion",
            "pilotRunId",
            "predecessorPilotRunId",
            "operatorId",
            "incidentContactId",
            "scope",
            "environment",
            "targets",
            "connectors",
        },
        "manifest",
    )
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError(f"schemaVersion must be {SCHEMA_VERSION}")

    pilot_run_id = _text(raw.get("pilotRunId"), "pilotRunId", RUN_ID_PATTERN)
    predecessor_value = raw.get("predecessorPilotRunId")
    predecessor = (
        None
        if predecessor_value is None
        else _text(predecessor_value, "predecessorPilotRunId", RUN_ID_PATTERN)
    )
    if predecessor == pilot_run_id:
        raise ContractError("predecessorPilotRunId must differ from pilotRunId")

    operator_id = _text(raw.get("operatorId"), "operatorId")
    incident_contact_id = _text(raw.get("incidentContactId"), "incidentContactId")
    scope_values = _object(raw.get("scope"), "scope")
    _require_keys(
        scope_values,
        {
            "pilotProjectExternalId",
            "syntheticProjectExternalId",
            "readOnly",
            "writebackAuthorized",
        },
        "scope",
    )
    if scope_values.get("readOnly") is not True:
        raise ContractError("scope.readOnly must be true")
    if scope_values.get("writebackAuthorized") is not False:
        raise ContractError("scope.writebackAuthorized must be false")
    scope = Scope(
        pilot_project_external_id=_text(
            scope_values.get("pilotProjectExternalId"),
            "scope.pilotProjectExternalId",
        ),
        synthetic_project_external_id=_text(
            scope_values.get("syntheticProjectExternalId"),
            "scope.syntheticProjectExternalId",
        ),
        read_only=scope_values.get("readOnly") is True,
        writeback_authorized=scope_values.get("writebackAuthorized") is True,
    )
    if scope.pilot_project_external_id == scope.synthetic_project_external_id:
        raise ContractError("scope pilot and synthetic projects must differ")

    environment = _object(raw.get("environment"), "environment")
    _require_keys(
        environment,
        {
            "id",
            "kind",
            "applicationCommit",
            "migrations",
            "migrationSetSha256",
            "imageDigests",
        },
        "environment",
    )
    if environment.get("kind") != "managed-staging":
        raise ContractError("environment.kind must be managed-staging")
    environment_id = _text(environment.get("id"), "environment.id")
    application_commit = _text(
        environment.get("applicationCommit"),
        "environment.applicationCommit",
        COMMIT_PATTERN,
    )
    migration_values = environment.get("migrations")
    if not isinstance(migration_values, list) or not migration_values:
        raise ContractError("environment.migrations must be a non-empty array")
    migrations: list[Migration] = []
    for index, migration_value in enumerate(migration_values):
        migration = _object(
            migration_value,
            f"environment.migrations[{index}]",
        )
        _require_keys(
            migration,
            {"version", "sha256"},
            f"environment.migrations[{index}]",
        )
        migrations.append(
            Migration(
                version=_text(
                    migration.get("version"),
                    f"environment.migrations[{index}].version",
                ),
                sha256=_text(
                    migration.get("sha256"),
                    f"environment.migrations[{index}].sha256",
                    SHA256_PATTERN,
                ),
            )
        )
    if len({migration.version for migration in migrations}) != len(migrations):
        raise ContractError("environment migration versions must be unique")
    migration_set_sha256 = _text(
        environment.get("migrationSetSha256"),
        "environment.migrationSetSha256",
        SHA256_PATTERN,
    )
    normalized_migrations = [
        {"version": migration.version, "sha256": migration.sha256}
        for migration in migrations
    ]
    computed_migration_set_sha256 = hashlib.sha256(
        (
            json.dumps(
                normalized_migrations,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
    ).hexdigest()
    if migration_set_sha256 != computed_migration_set_sha256:
        raise ContractError("environment.migrationSetSha256 does not match migrations")

    image_values = _object(
        environment.get("imageDigests"),
        "environment.imageDigests",
    )
    if set(image_values) != REQUIRED_IMAGES:
        raise ContractError(
            "environment.imageDigests must contain exactly the required images"
        )
    image_digests = {
        name: _text(value, f"environment.imageDigests.{name}", DIGEST_PATTERN)
        for name, value in image_values.items()
    }

    target_values = _object(raw.get("targets"), "targets")
    _require_keys(
        target_values,
        {
            "rpoMinutes",
            "rtoMinutes",
            "availabilityPercent",
            "latencyP95Seconds",
            "outboxFreshnessSeconds",
            "observationDays",
            "loadMultiplier",
            "evidenceRetentionDays",
        },
        "targets",
    )
    targets = Targets(
        rpo_minutes=_number(target_values.get("rpoMinutes"), "targets.rpoMinutes"),
        rto_minutes=_number(target_values.get("rtoMinutes"), "targets.rtoMinutes"),
        availability_percent=_number(
            target_values.get("availabilityPercent"),
            "targets.availabilityPercent",
        ),
        latency_p95_seconds=_number(
            target_values.get("latencyP95Seconds"),
            "targets.latencyP95Seconds",
        ),
        outbox_freshness_seconds=_number(
            target_values.get("outboxFreshnessSeconds"),
            "targets.outboxFreshnessSeconds",
        ),
        observation_days=_integer(
            target_values.get("observationDays"),
            "targets.observationDays",
        ),
        load_multiplier=_number(
            target_values.get("loadMultiplier"),
            "targets.loadMultiplier",
        ),
        evidence_retention_days=_integer(
            target_values.get("evidenceRetentionDays"),
            "targets.evidenceRetentionDays",
        ),
    )
    if not 99.9 <= targets.availability_percent <= 100:
        raise ContractError(
            "targets.availabilityPercent must be between 99.9 and 100"
        )
    if targets.rpo_minutes > 15:
        raise ContractError("targets.rpoMinutes must be 15 or less")
    if targets.rto_minutes > 240:
        raise ContractError("targets.rtoMinutes must be 240 or less")
    if targets.latency_p95_seconds > 1:
        raise ContractError("targets.latencyP95Seconds must be 1 or less")
    if targets.outbox_freshness_seconds > 300:
        raise ContractError("targets.outboxFreshnessSeconds must be 300 or less")
    if targets.observation_days < 30:
        raise ContractError("targets.observationDays must be at least 30")
    if targets.load_multiplier < 2:
        raise ContractError("targets.loadMultiplier must be at least 2")
    if targets.evidence_retention_days < 90:
        raise ContractError("targets.evidenceRetentionDays must be at least 90")

    connector_values = raw.get("connectors")
    if not isinstance(connector_values, list):
        raise ContractError("connectors must be an array")
    connectors: list[ConnectorTarget] = []
    for index, connector_value in enumerate(connector_values):
        connector = _object(connector_value, f"connectors[{index}]")
        kind = connector.get("kind")
        if kind not in {"csv", "postgres", "opcua"}:
            raise ContractError(f"connectors[{index}].kind is invalid")
        common_connector_keys = {
            "kind",
            "externalId",
            "approvedBackfillWindowMinutes",
            "entityCount",
            "timeSeriesCount",
            "averageRecordBytes",
            "retentionDays",
            "schemaFingerprintSha256",
        }
        rate_keys = (
            {"requiredAverageRate", "sourceSafetyCeilingRate"}
            if kind == "csv"
            else {"measuredPeakRate"}
        )
        _require_keys(
            connector,
            common_connector_keys | rate_keys,
            f"connectors[{index}]",
        )
        measured = connector.get("measuredPeakRate")
        required = connector.get("requiredAverageRate")
        ceiling = connector.get("sourceSafetyCeilingRate")
        connectors.append(
            ConnectorTarget(
                kind=kind,
                external_id=_text(
                    connector.get("externalId"),
                    f"connectors[{index}].externalId",
                ),
                measured_peak_rate=(
                    None
                    if measured is None
                    else _number(measured, f"connectors[{index}].measuredPeakRate")
                ),
                required_average_rate=(
                    None
                    if required is None
                    else _number(
                        required,
                        f"connectors[{index}].requiredAverageRate",
                    )
                ),
                source_safety_ceiling_rate=(
                    None
                    if ceiling is None
                    else _number(
                        ceiling,
                        f"connectors[{index}].sourceSafetyCeilingRate",
                    )
                ),
                approved_backfill_window_minutes=_number(
                    connector.get("approvedBackfillWindowMinutes"),
                    f"connectors[{index}].approvedBackfillWindowMinutes",
                ),
                entity_count=_non_negative_integer(
                    connector.get("entityCount"),
                    f"connectors[{index}].entityCount",
                ),
                time_series_count=_non_negative_integer(
                    connector.get("timeSeriesCount"),
                    f"connectors[{index}].timeSeriesCount",
                ),
                average_record_bytes=_integer(
                    connector.get("averageRecordBytes"),
                    f"connectors[{index}].averageRecordBytes",
                ),
                retention_days=_integer(
                    connector.get("retentionDays"),
                    f"connectors[{index}].retentionDays",
                ),
                schema_fingerprint_sha256=_text(
                    connector.get("schemaFingerprintSha256"),
                    f"connectors[{index}].schemaFingerprintSha256",
                    SHA256_PATTERN,
                ),
            )
        )

    kinds = [connector.kind for connector in connectors]
    if sorted(kinds) != ["csv", "opcua", "postgres"]:
        raise ContractError(
            "connectors must contain exactly one csv, opcua, and postgres entry"
        )
    if len({connector.external_id for connector in connectors}) != len(connectors):
        raise ContractError("connector externalId values must be unique")
    for connector in connectors:
        if connector.kind == "csv":
            if (
                connector.required_average_rate is None
                or connector.source_safety_ceiling_rate is None
                or connector.measured_peak_rate is not None
            ):
                raise ContractError(
                    "csv requires requiredAverageRate and sourceSafetyCeilingRate "
                    "and forbids measuredPeakRate"
                )
            if connector.source_safety_ceiling_rate < connector.required_average_rate:
                raise ContractError(
                    "csv sourceSafetyCeilingRate must not be below requiredAverageRate"
                )
        elif (
            connector.measured_peak_rate is None
            or connector.required_average_rate is not None
            or connector.source_safety_ceiling_rate is not None
        ):
            raise ContractError(
                f"{connector.kind} requires measuredPeakRate and forbids CSV rate fields"
            )

    return PilotManifest(
        schema_version=SCHEMA_VERSION,
        pilot_run_id=pilot_run_id,
        predecessor_pilot_run_id=predecessor,
        operator_id=operator_id,
        incident_contact_id=incident_contact_id,
        scope=scope,
        environment_id=environment_id,
        application_commit=application_commit,
        migrations=tuple(migrations),
        migration_set_sha256=migration_set_sha256,
        image_digests=image_digests,
        targets=targets,
        connectors=tuple(connectors),
    )


def load_manifest(path: Path) -> PilotManifest:
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ContractError(f"could not read pilot manifest: {error}") from error
    return parse_manifest(raw)
