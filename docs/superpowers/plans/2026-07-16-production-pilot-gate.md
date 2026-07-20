# Production Pilot Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a provider-neutral, fail-closed pilot certification runner that validates a managed-staging manifest, records sanitized and hash-addressed evidence, evaluates the approved production thresholds, and produces one immutable go/no-go decision.

**Architecture:** Implement the runner with the Python standard library already required by the repository. Keep manifest parsing, evidence safety, append-only storage, threshold evaluation, allowlisted synthetic rehearsal adapters, and CLI orchestration in separate modules. Managed-environment checks enter through a strict JSON evidence contract; the manifest never contains commands or credentials, and only fixed repository-owned synthetic adapters may launch subprocesses.

**Tech Stack:** Python 3 standard library, unittest, existing Bash rehearsal scripts, existing infrastructure static validator, npm workspace scripts, GitHub Actions.

---

## Scope and delivery shape

This plan implements the certification mechanism and its repository-owned
evidence contract. It does not provision a cloud environment, inject
credentials, or manufacture managed-service evidence. A real pilot can pass
only after operators record every required managed check from the approved
environment.

Deliver the work as four stacked pull requests:

1. docs/production-pilot-gate-design — approved spec and plan, based on main.
2. feat/pilot-gate-contract — Tasks 1 through 4, based on the design branch.
3. feat/pilot-gate-runner — Tasks 5 through 7, based on the contract branch.
4. docs/pilot-gate-operations — Task 8 plus final verification, based on the runner branch.

## File map

- Create: infra/pilot_gate/__init__.py — package marker and public version.
- Create: infra/pilot_gate/contract.py — strict manifest contract, required check catalog, connector targets, and threshold validation.
- Create: infra/pilot_gate/safety.py — forbidden evidence-key detection and in-memory subprocess-output redaction.
- Create: infra/pilot_gate/evidence.py — managed-check evidence parsing, atomic hash-addressed persistence, append-only run state, and predecessor validation.
- Create: infra/pilot_gate/evaluation.py — RPO/RTO, SLO, connector-rate, reconciliation, and independent-review decision rules.
- Create: infra/pilot_gate/adapters.py — fixed synthetic rehearsal command allowlist; never accepts a command from input.
- Create: infra/pilot_gate/cli.py — validate, init, record, run-synthetic, and evaluate commands.
- Create: infra/pilot-gate.example.json — complete non-secret managed-staging manifest.
- Create: infra/ci/tests/test_pilot_gate_contract.py — manifest and check-catalog regression coverage.
- Create: infra/ci/tests/test_pilot_gate_safety.py — secret-pattern and output-redaction coverage.
- Create: infra/ci/tests/test_pilot_gate_evidence.py — atomic storage, state transitions, gate ordering, and retry coverage.
- Create: infra/ci/tests/test_pilot_gate_evaluation.py — threshold and connector acceptance coverage.
- Create: infra/ci/tests/test_pilot_gate_adapters.py — allowlist, shell-safety, confirmation, timeout, and redaction coverage.
- Create: infra/ci/tests/test_pilot_gate_cli.py — command-level workflow and exit-code coverage.
- Modify: infra/ci/validate-production-gates.py — require the pilot assets and validate the checked-in example manifest.
- Modify: infra/ci/tests/test_validate_production_gates.py — lock the pilot-gate static invariants.
- Modify: package.json — expose pilot:gate and pilot:gate:validate commands.
- Create: docs/operations/production-pilot-gate.md — exact managed-staging operator and evidence-review runbook.
- Modify: README.md — link the new gate without marking a real design-partner pilot complete.

### Task 1: Define the managed-staging manifest contract

**Files:**
- Create: infra/pilot_gate/__init__.py
- Create: infra/pilot_gate/contract.py
- Create: infra/ci/tests/test_pilot_gate_contract.py

- [ ] **Step 1: Start the contract stack branch**

~~~powershell
git switch -c feat/pilot-gate-contract
~~~

Expected: the new branch starts at the approved design-and-plan commit, leaving
docs/production-pilot-gate-design fixed at the documentation boundary.

- [ ] **Step 2: Write the failing contract tests**

Create infra/ci/tests/test_pilot_gate_contract.py with a valid manifest factory
and tests that lock the required images, thresholds, connectors, and check
catalog:

~~~python
from __future__ import annotations

import unittest

from infra.pilot_gate.contract import (
    CHECKS_BY_GATE,
    ContractError,
    parse_manifest,
)


def valid_manifest() -> dict[str, object]:
    digest = "sha256:" + ("a" * 64)
    return {
        "schemaVersion": 1,
        "pilotRunId": "pilot-managed-20260716-001",
        "predecessorPilotRunId": None,
        "operatorId": "operator@example.test",
        "incidentContactId": "incident@example.test",
        "scope": {
            "pilotProjectExternalId": "design-partner-pilot",
            "syntheticProjectExternalId": "synthetic-isolation",
            "readOnly": True,
            "writebackAuthorized": False,
        },
        "environment": {
            "id": "managed-staging",
            "kind": "managed-staging",
            "applicationCommit": "1" * 40,
            "migrations": [
                {"version": "202607160001", "sha256": "7" * 64},
            ],
            "migrationSetSha256": "ac0f8176205045a99e50d679600d4a192b6e57cb29eb4f6d4e92a4212cce90ed",
            "imageDigests": {
                "api": digest,
                "web": digest,
                "outbox-worker": digest,
                "pipeline-worker": digest,
                "edge-agent": digest,
            },
        },
        "targets": {
            "rpoMinutes": 15,
            "rtoMinutes": 240,
            "availabilityPercent": 99.9,
            "latencyP95Seconds": 1.0,
            "outboxFreshnessSeconds": 300,
            "observationDays": 30,
            "loadMultiplier": 2.0,
            "evidenceRetentionDays": 90,
        },
        "connectors": [
            {
                "kind": "csv",
                "externalId": "pilot-csv",
                "requiredAverageRate": 100.0,
                "sourceSafetyCeilingRate": 180.0,
                "approvedBackfillWindowMinutes": 120,
                "entityCount": 500,
                "timeSeriesCount": 0,
                "averageRecordBytes": 512,
                "retentionDays": 90,
                "schemaFingerprintSha256": "c" * 64,
            },
            {
                "kind": "postgres",
                "externalId": "pilot-postgres",
                "measuredPeakRate": 50.0,
                "approvedBackfillWindowMinutes": 180,
                "entityCount": 1_000,
                "timeSeriesCount": 50,
                "averageRecordBytes": 1_024,
                "retentionDays": 365,
                "schemaFingerprintSha256": "d" * 64,
            },
            {
                "kind": "opcua",
                "externalId": "pilot-opcua",
                "measuredPeakRate": 200.0,
                "approvedBackfillWindowMinutes": 60,
                "entityCount": 200,
                "timeSeriesCount": 200,
                "averageRecordBytes": 256,
                "retentionDays": 30,
                "schemaFingerprintSha256": "e" * 64,
            },
        ],
    }


class PilotManifestContractTests(unittest.TestCase):
    def test_accepts_the_approved_baseline(self) -> None:
        manifest = parse_manifest(valid_manifest())

        self.assertEqual(manifest.pilot_run_id, "pilot-managed-20260716-001")
        self.assertEqual(manifest.targets.rto_minutes, 240.0)
        self.assertEqual(manifest.migrations[0].version, "202607160001")
        self.assertEqual(
            manifest.migration_set_sha256,
            "ac0f8176205045a99e50d679600d4a192b6e57cb29eb4f6d4e92a4212cce90ed",
        )
        self.assertTrue(manifest.scope.read_only)
        self.assertFalse(manifest.scope.writeback_authorized)
        self.assertEqual(manifest.connectors[0].approved_backfill_window_minutes, 120.0)
        self.assertEqual([connector.kind for connector in manifest.connectors], ["csv", "postgres", "opcua"])

    def test_rejects_a_weaker_target(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["targets"], dict)
        raw["targets"]["availabilityPercent"] = 99.0

        with self.assertRaisesRegex(ContractError, "availabilityPercent"):
            parse_manifest(raw)

    def test_requires_one_connector_of_each_approved_kind(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["connectors"], list)
        raw["connectors"].pop()

        with self.assertRaisesRegex(ContractError, "csv, opcua, and postgres"):
            parse_manifest(raw)

    def test_csv_safety_ceiling_cannot_be_below_required_rate(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["connectors"], list)
        assert isinstance(raw["connectors"][0], dict)
        raw["connectors"][0]["sourceSafetyCeilingRate"] = 90.0

        with self.assertRaisesRegex(ContractError, "sourceSafetyCeilingRate"):
            parse_manifest(raw)

    def test_connector_external_ids_must_be_unique(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["connectors"], list)
        assert isinstance(raw["connectors"][1], dict)
        raw["connectors"][1]["externalId"] = "pilot-csv"

        with self.assertRaisesRegex(ContractError, "externalId values must be unique"):
            parse_manifest(raw)

    def test_rejects_non_finite_numeric_values(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["targets"], dict)
        raw["targets"]["rpoMinutes"] = float("nan")

        with self.assertRaisesRegex(ContractError, "finite"):
            parse_manifest(raw)

    def test_rejects_unknown_manifest_fields(self) -> None:
        raw = valid_manifest()
        raw["password"] = "must-never-enter-the-contract"

        with self.assertRaisesRegex(ContractError, "unexpected fields"):
            parse_manifest(raw)

    def test_catalog_has_all_five_gates_and_unique_check_ids(self) -> None:
        self.assertEqual(set(CHECKS_BY_GATE), {0, 1, 2, 3, 4})
        flattened = [check_id for values in CHECKS_BY_GATE.values() for check_id in values]
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertIn("service-objectives", flattened)
        self.assertIn("connector-opcua", flattened)


if __name__ == "__main__":
    unittest.main()
~~~

- [ ] **Step 3: Run the contract test and confirm RED**

Run:

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_contract -v
~~~

Expected: FAIL with ModuleNotFoundError for infra.pilot_gate.

- [ ] **Step 4: Implement the strict contract**

Create infra/pilot_gate/__init__.py:

~~~python
"""Production pilot certification support."""

SCHEMA_VERSION = 1
~~~

Create infra/pilot_gate/contract.py. Use these public types and constants
exactly so later tasks share one vocabulary:

~~~python
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
    1: ("ingress-security", "network-isolation", "credential-rotation", "secret-scan"),
    2: ("database-object-restore", "broker-recovery", "replica-worker-recovery", "idempotency-checkpoints"),
    3: ("durable-telemetry", "alert-delivery", "service-objectives"),
    4: ("connector-csv", "connector-postgres", "connector-opcua"),
}
CHECK_GATE = {
    check_id: gate
    for gate, check_ids in CHECKS_BY_GATE.items()
    for check_id in check_ids
}
REQUIRED_CHECK_IDS = frozenset(CHECK_GATE)
REQUIRED_IMAGES = frozenset({"api", "web", "outbox-worker", "pipeline-worker", "edge-agent"})
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


def _text(value: object, label: str, pattern: re.Pattern[str] = IDENTIFIER_PATTERN) -> str:
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
    _require_keys(raw, {
        "schemaVersion",
        "pilotRunId",
        "predecessorPilotRunId",
        "operatorId",
        "incidentContactId",
        "scope",
        "environment",
        "targets",
        "connectors",
    }, "manifest")
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise ContractError(f"schemaVersion must be {SCHEMA_VERSION}")

    pilot_run_id = _text(raw.get("pilotRunId"), "pilotRunId", RUN_ID_PATTERN)
    predecessor_value = raw.get("predecessorPilotRunId")
    predecessor = None if predecessor_value is None else _text(
        predecessor_value,
        "predecessorPilotRunId",
        RUN_ID_PATTERN,
    )
    if predecessor == pilot_run_id:
        raise ContractError("predecessorPilotRunId must differ from pilotRunId")

    operator_id = _text(raw.get("operatorId"), "operatorId")
    incident_contact_id = _text(raw.get("incidentContactId"), "incidentContactId")
    scope_values = _object(raw.get("scope"), "scope")
    _require_keys(scope_values, {
        "pilotProjectExternalId",
        "syntheticProjectExternalId",
        "readOnly",
        "writebackAuthorized",
    }, "scope")
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
        read_only=True,
        writeback_authorized=False,
    )
    if scope.pilot_project_external_id == scope.synthetic_project_external_id:
        raise ContractError("scope pilot and synthetic projects must differ")
    environment = _object(raw.get("environment"), "environment")
    _require_keys(environment, {
        "id",
        "kind",
        "applicationCommit",
        "migrations",
        "migrationSetSha256",
        "imageDigests",
    }, "environment")
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
        migration = _object(migration_value, f"environment.migrations[{index}]")
        _require_keys(
            migration,
            {"version", "sha256"},
            f"environment.migrations[{index}]",
        )
        migrations.append(Migration(
            version=_text(
                migration.get("version"),
                f"environment.migrations[{index}].version",
            ),
            sha256=_text(
                migration.get("sha256"),
                f"environment.migrations[{index}].sha256",
                SHA256_PATTERN,
            ),
        ))
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
    computed_migration_set_sha256 = hashlib.sha256((
        json.dumps(
            normalized_migrations,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")).hexdigest()
    if migration_set_sha256 != computed_migration_set_sha256:
        raise ContractError("environment.migrationSetSha256 does not match migrations")
    image_values = _object(environment.get("imageDigests"), "environment.imageDigests")
    if set(image_values) != REQUIRED_IMAGES:
        raise ContractError("environment.imageDigests must contain exactly the required images")
    image_digests = {
        name: _text(value, f"environment.imageDigests.{name}", DIGEST_PATTERN)
        for name, value in image_values.items()
    }

    target_values = _object(raw.get("targets"), "targets")
    _require_keys(target_values, {
        "rpoMinutes",
        "rtoMinutes",
        "availabilityPercent",
        "latencyP95Seconds",
        "outboxFreshnessSeconds",
        "observationDays",
        "loadMultiplier",
        "evidenceRetentionDays",
    }, "targets")
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
        observation_days=_integer(target_values.get("observationDays"), "targets.observationDays"),
        load_multiplier=_number(target_values.get("loadMultiplier"), "targets.loadMultiplier"),
        evidence_retention_days=_integer(
            target_values.get("evidenceRetentionDays"),
            "targets.evidenceRetentionDays",
        ),
    )
    if targets.rpo_minutes > 15:
        raise ContractError("targets.rpoMinutes must be 15 or less")
    if targets.rto_minutes > 240:
        raise ContractError("targets.rtoMinutes must be 240 or less")
    if not 99.9 <= targets.availability_percent <= 100:
        raise ContractError("targets.availabilityPercent must be between 99.9 and 100")
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
        _require_keys(connector, common_connector_keys | rate_keys, f"connectors[{index}]")
        external_id = _text(connector.get("externalId"), f"connectors[{index}].externalId")
        measured = connector.get("measuredPeakRate")
        required = connector.get("requiredAverageRate")
        ceiling = connector.get("sourceSafetyCeilingRate")
        connectors.append(ConnectorTarget(
            kind=kind,
            external_id=external_id,
            measured_peak_rate=None if measured is None else _number(measured, f"connectors[{index}].measuredPeakRate"),
            required_average_rate=None if required is None else _number(required, f"connectors[{index}].requiredAverageRate"),
            source_safety_ceiling_rate=None if ceiling is None else _number(ceiling, f"connectors[{index}].sourceSafetyCeilingRate"),
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
        ))

    kinds = [connector.kind for connector in connectors]
    if sorted(kinds) != ["csv", "opcua", "postgres"]:
        raise ContractError("connectors must contain exactly one csv, opcua, and postgres entry")
    if len({connector.external_id for connector in connectors}) != len(connectors):
        raise ContractError("connector externalId values must be unique")
    for connector in connectors:
        if connector.kind == "csv":
            if connector.required_average_rate is None or connector.measured_peak_rate is not None:
                raise ContractError("csv requires requiredAverageRate and forbids measuredPeakRate")
            if (
                connector.source_safety_ceiling_rate is not None
                and connector.source_safety_ceiling_rate < connector.required_average_rate
            ):
                raise ContractError("csv sourceSafetyCeilingRate must not be below requiredAverageRate")
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
~~~

- [ ] **Step 5: Run contract tests and confirm GREEN**

Run:

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_contract -v
~~~

Expected: all PilotManifestContractTests pass.

- [ ] **Step 6: Commit the contract slice**

~~~powershell
git add infra/pilot_gate/__init__.py infra/pilot_gate/contract.py infra/ci/tests/test_pilot_gate_contract.py
git commit -m "feat(infra): define production pilot contract"
~~~

### Task 2: Reject unsafe evidence and redact captured subprocess output

**Files:**
- Create: infra/pilot_gate/safety.py
- Create: infra/ci/tests/test_pilot_gate_safety.py

- [ ] **Step 1: Write failing evidence-safety tests**

~~~python
from __future__ import annotations

import unittest

from infra.pilot_gate.safety import (
    FORBIDDEN_KEYS,
    UnsafeEvidenceError,
    assert_safe_json,
    redact_text,
)


class PilotEvidenceSafetyTests(unittest.TestCase):
    def test_rejects_every_explicitly_forbidden_key(self) -> None:
        for key in FORBIDDEN_KEYS:
            with self.subTest(key=key), self.assertRaises(UnsafeEvidenceError):
                assert_safe_json({key: "opaque-value"})

    def test_rejects_forbidden_keys_at_any_depth(self) -> None:
        with self.assertRaisesRegex(UnsafeEvidenceError, "authorization"):
            assert_safe_json({"metrics": {"authorization": "Bearer hidden"}})
        with self.assertRaisesRegex(UnsafeEvidenceError, "accessToken"):
            assert_safe_json({"metrics": {"accessToken": "opaque-value"}})
        with self.assertRaisesRegex(UnsafeEvidenceError, "objectStoreSignedUrl"):
            assert_safe_json({"metrics": {"objectStoreSignedUrl": "opaque-value"}})

    def test_rejects_private_keys_and_credential_urls(self) -> None:
        with self.assertRaises(UnsafeEvidenceError):
            assert_safe_json({"summary": "-----BEGIN PRIVATE KEY-----"})
        with self.assertRaises(UnsafeEvidenceError):
            assert_safe_json({"summary": "-----BEGIN CERTIFICATE-----"})
        with self.assertRaises(UnsafeEvidenceError):
            assert_safe_json({"summary": "postgresql://user:password@db.example/odf"})
        with self.assertRaises(UnsafeEvidenceError):
            assert_safe_json({"rawRowsExport": ["industrial-row"]})
        with self.assertRaisesRegex(UnsafeEvidenceError, "finite"):
            assert_safe_json({"metrics": {"latency": float("nan")}})

    def test_redacts_captured_output_without_echoing_secret_values(self) -> None:
        redacted, count = redact_text(
            "Authorization: Bearer abc.def.ghi\n"
            "database=postgresql://user:password@db.example/odf\n"
        )

        self.assertEqual(count, 2)
        self.assertNotIn("abc.def.ghi", redacted)
        self.assertNotIn("user:password", redacted)
        self.assertEqual(redacted.count("[REDACTED]"), 2)

    def test_redacts_cookies_and_complete_pem_blocks(self) -> None:
        redacted, count = redact_text(
            "Cookie: session=opaque-cookie\n"
            "-----BEGIN CERTIFICATE-----\nopaque-certificate\n-----END CERTIFICATE-----\n"
        )

        self.assertEqual(count, 2)
        self.assertNotIn("opaque-cookie", redacted)
        self.assertNotIn("opaque-certificate", redacted)


if __name__ == "__main__":
    unittest.main()
~~~

- [ ] **Step 2: Run the safety tests and confirm RED**

Run:

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_safety -v
~~~

Expected: FAIL because infra.pilot_gate.safety does not exist.

- [ ] **Step 3: Implement recursive rejection and in-memory redaction**

Create infra/pilot_gate/safety.py:

~~~python
from __future__ import annotations

import math
import re
from typing import Any


class UnsafeEvidenceError(ValueError):
    """Raised before unsafe evidence reaches persistent storage."""


FORBIDDEN_KEYS = frozenset({
    "authorization",
    "cookie",
    "password",
    "secret",
    "clientsecret",
    "privatekey",
    "token",
    "databaseurl",
    "logs",
    "payload",
    "signedurl",
    "rawpayload",
    "rawrows",
    "records",
    "rows",
    "stderr",
    "stdout",
    "certificate",
})
FORBIDDEN_KEY_PREFIXES = ("authorization", "cookie", "rawpayload", "rawrows")
FORBIDDEN_KEY_SUFFIXES = (
    "databaseurl",
    "password",
    "privatekey",
    "secret",
    "signedurl",
    "token",
)
VALUE_PATTERNS = (
    re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?"
        r"-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        re.DOTALL,
    ),
    re.compile(
        r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----",
        re.DOTALL,
    ),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+"),
    re.compile(r"(?im)\b(?:Cookie|Set-Cookie):[^\r\n]+"),
    re.compile(
        r"(?i)\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|password)"
        r"\s*[:=]\s*[^\s,;]+"
    ),
    re.compile(r"(?i)\bpostgres(?:ql)?://[^\s:@/]+:[^\s@/]+@[^\s]+"),
    re.compile(r"(?i)https?://[^\s]*X-Amz-Signature=[^\s&]+[^\s]*"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"-----BEGIN CERTIFICATE-----"),
    re.compile(r"(?i)\bX-Amz-Signature=[0-9a-f]+"),
)


def _normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def assert_safe_json(value: object, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise UnsafeEvidenceError(f"{path} contains a non-string key")
            normalized = _normalized_key(key)
            if (
                normalized in FORBIDDEN_KEYS
                or normalized.startswith(FORBIDDEN_KEY_PREFIXES)
                or normalized.endswith(FORBIDDEN_KEY_SUFFIXES)
            ):
                raise UnsafeEvidenceError(f"{path}.{key} is forbidden evidence")
            assert_safe_json(nested, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, nested in enumerate(value):
            assert_safe_json(nested, f"{path}[{index}]")
        return
    if isinstance(value, str):
        for pattern in VALUE_PATTERNS:
            if pattern.search(value):
                raise UnsafeEvidenceError(f"{path} contains prohibited secret material")
        return
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise UnsafeEvidenceError(f"{path} must contain only finite numbers")
        return
    raise UnsafeEvidenceError(f"{path} contains unsupported evidence type {type(value).__name__}")


def redact_text(value: str) -> tuple[str, int]:
    redacted = value
    count = 0
    for pattern in VALUE_PATTERNS:
        redacted, replacements = pattern.subn("[REDACTED]", redacted)
        count += replacements
    return redacted, count
~~~

- [ ] **Step 4: Run safety tests and confirm GREEN**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_safety -v
~~~

Expected: all PilotEvidenceSafetyTests pass.

- [ ] **Step 5: Commit the safety slice**

~~~powershell
git add infra/pilot_gate/safety.py infra/ci/tests/test_pilot_gate_safety.py
git commit -m "feat(infra): reject unsafe pilot evidence"
~~~

### Task 3: Persist hash-addressed evidence with append-only state transitions

**Files:**
- Create: infra/pilot_gate/evidence.py
- Create: infra/ci/tests/test_pilot_gate_evidence.py

- [ ] **Step 1: Write failing store and transition tests**

Create tests that initialize a run, prohibit later gates before preflight,
advance to preflight_passed after both Gate 0 checks, advance to executing at
Gate 1, make failed terminal, and require a real failed predecessor:

~~~python
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from infra.pilot_gate.contract import parse_manifest
from infra.pilot_gate.evidence import EvidenceError, EvidenceStore, parse_check_evidence
from infra.ci.tests.test_pilot_gate_contract import valid_manifest


def evidence(check_id: str, status: str = "passed") -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "checkId": check_id,
        "status": status,
        "startedAt": "2026-07-16T10:00:00Z",
        "completedAt": "2026-07-16T10:01:00Z",
        "summary": f"{check_id} {status}",
        "metrics": {},
    }


class PilotEvidenceStoreTests(unittest.TestCase):
    def test_enforces_gate_order_and_hash_addresses_check_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest = parse_manifest(valid_manifest())
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()

            with self.assertRaisesRegex(EvidenceError, "prior gate"):
                store.record_check(parse_check_evidence(evidence("ingress-security")))

            store.record_check(parse_check_evidence(evidence("deployment-preflight")))
            with self.assertRaisesRegex(EvidenceError, "append-only"):
                store.record_check(parse_check_evidence(evidence("deployment-preflight")))
            store.record_check(parse_check_evidence(evidence("tenant-isolation")))
            self.assertEqual(store.read_run()["state"], "preflight_passed")

            store.record_check(parse_check_evidence(evidence("ingress-security")))
            run = store.read_run()
            self.assertEqual(run["state"], "executing")
            check_entry = run["checks"]["ingress-security"]
            self.assertRegex(check_entry["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue((store.run_directory / check_entry["path"]).is_file())

    def test_failed_state_is_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest = parse_manifest(valid_manifest())
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            store.record_check(parse_check_evidence(evidence("deployment-preflight", "failed")))

            self.assertEqual(store.read_run()["state"], "failed")
            with self.assertRaisesRegex(EvidenceError, "terminal"):
                store.record_check(parse_check_evidence(evidence("tenant-isolation")))

    def test_retry_requires_a_failed_predecessor(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            raw = valid_manifest()
            raw["predecessorPilotRunId"] = "pilot-managed-20260715-999"
            store = EvidenceStore(root, parse_manifest(raw))

            with self.assertRaisesRegex(EvidenceError, "failed predecessor"):
                store.initialize()

    def test_retry_accepts_only_a_failed_predecessor_in_the_same_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            predecessor_raw = valid_manifest()
            predecessor = EvidenceStore(root, parse_manifest(predecessor_raw))
            predecessor.initialize()
            predecessor.record_check(parse_check_evidence(evidence("deployment-preflight", "failed")))

            retry_raw = valid_manifest()
            retry_raw["pilotRunId"] = "pilot-managed-20260716-002"
            retry_raw["predecessorPilotRunId"] = "pilot-managed-20260716-001"
            retry = EvidenceStore(root, parse_manifest(retry_raw))
            retry.initialize()

            self.assertEqual(retry.read_run()["predecessorPilotRunId"], "pilot-managed-20260716-001")

    def test_rejects_manifest_changes_after_initialization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            original = EvidenceStore(root, parse_manifest(valid_manifest()))
            original.initialize()
            changed_raw = valid_manifest()
            assert isinstance(changed_raw["connectors"], list)
            assert isinstance(changed_raw["connectors"][1], dict)
            changed_raw["connectors"][1]["measuredPeakRate"] = 1.0

            changed = EvidenceStore(root, parse_manifest(changed_raw))

            with self.assertRaisesRegex(EvidenceError, "manifest does not match"):
                changed.read_run()


if __name__ == "__main__":
    unittest.main()
~~~

- [ ] **Step 2: Run the store tests and confirm RED**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_evidence -v
~~~

Expected: FAIL because EvidenceStore is not defined.

- [ ] **Step 3: Implement evidence parsing and atomic persistence**

Create infra/pilot_gate/evidence.py with these public contracts:

~~~python
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any

from . import SCHEMA_VERSION
from .contract import (
    CHECK_GATE,
    CHECKS_BY_GATE,
    IDENTIFIER_PATTERN,
    PilotManifest,
    REQUIRED_CHECK_IDS,
)
from .safety import assert_safe_json


class EvidenceError(ValueError):
    """Raised when evidence is invalid, out of order, or mutates terminal state."""


@dataclass(frozen=True)
class CheckEvidence:
    check_id: str
    status: str
    started_at: str
    completed_at: str
    summary: str
    metrics: dict[str, object]


def _utc_timestamp(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise EvidenceError(f"{label} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise EvidenceError(f"{label} must be an ISO timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise EvidenceError(f"{label} must use UTC")
    return parsed.isoformat().replace("+00:00", "Z")


def parse_check_evidence(raw_value: object) -> CheckEvidence:
    if not isinstance(raw_value, dict):
        raise EvidenceError("check evidence must be an object")
    assert_safe_json(raw_value)
    expected_fields = {
        "schemaVersion",
        "checkId",
        "status",
        "startedAt",
        "completedAt",
        "summary",
        "metrics",
    }
    if set(raw_value) != expected_fields:
        raise EvidenceError("check evidence fields do not match the contract")
    if raw_value.get("schemaVersion") != SCHEMA_VERSION:
        raise EvidenceError(f"schemaVersion must be {SCHEMA_VERSION}")
    check_id = raw_value.get("checkId")
    if not isinstance(check_id, str) or check_id not in CHECK_GATE:
        raise EvidenceError("checkId is not a required managed check")
    status = raw_value.get("status")
    if status not in {"passed", "failed"}:
        raise EvidenceError("status must be passed or failed")
    summary = raw_value.get("summary")
    if not isinstance(summary, str) or not summary.strip() or len(summary) > 2_000:
        raise EvidenceError("summary must contain 1 to 2000 characters")
    metrics = raw_value.get("metrics")
    if not isinstance(metrics, dict):
        raise EvidenceError("metrics must be an object")
    started_at = _utc_timestamp(raw_value.get("startedAt"), "startedAt")
    completed_at = _utc_timestamp(raw_value.get("completedAt"), "completedAt")
    started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    completed = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
    if completed < started:
        raise EvidenceError("completedAt must not precede startedAt")
    return CheckEvidence(check_id, status, started_at, completed_at, summary.strip(), dict(metrics))


def canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        if os.name != "nt":
            path.chmod(0o600)
    finally:
        temporary = Path(temporary_name)
        if temporary.exists():
            temporary.unlink()


class EvidenceStore:
    def __init__(self, output_root: Path, manifest: PilotManifest):
        self.output_root = output_root
        self.manifest = manifest
        self.run_directory = output_root / manifest.pilot_run_id
        self.run_path = self.run_directory / "run.json"

    def initialize(self) -> None:
        if self.run_directory.exists():
            raise EvidenceError("pilot run directory already exists")
        predecessor = self.manifest.predecessor_pilot_run_id
        if predecessor is not None:
            predecessor_path = self.output_root / predecessor / "run.json"
            if not predecessor_path.is_file():
                raise EvidenceError("failed predecessor evidence is missing")
            predecessor_run = json.loads(predecessor_path.read_text(encoding="utf-8"))
            if predecessor_run.get("state") != "failed":
                raise EvidenceError("predecessor must be a failed pilot run")
            if predecessor_run.get("environmentId") != self.manifest.environment_id:
                raise EvidenceError("predecessor must use the same environment")
        run = {
            "schemaVersion": SCHEMA_VERSION,
            "pilotRunId": self.manifest.pilot_run_id,
            "manifestSha256": sha256_hex(canonical_json(asdict(self.manifest))),
            "predecessorPilotRunId": predecessor,
            "environmentId": self.manifest.environment_id,
            "applicationCommit": self.manifest.application_commit,
            "migrations": [asdict(migration) for migration in self.manifest.migrations],
            "migrationSetSha256": self.manifest.migration_set_sha256,
            "imageDigests": dict(self.manifest.image_digests),
            "operatorId": self.manifest.operator_id,
            "incidentContactId": self.manifest.incident_contact_id,
            "scope": {
                "pilotProjectExternalId": self.manifest.scope.pilot_project_external_id,
                "syntheticProjectExternalId": self.manifest.scope.synthetic_project_external_id,
                "readOnly": self.manifest.scope.read_only,
                "writebackAuthorized": self.manifest.scope.writeback_authorized,
            },
            "state": "created",
            "checks": {},
            "supportingEvidence": {},
        }
        _atomic_write(self.run_path, canonical_json(run))

    def read_run(self) -> dict[str, Any]:
        try:
            value: object = json.loads(self.run_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise EvidenceError(f"could not read pilot run: {error}") from error
        if not isinstance(value, dict):
            raise EvidenceError("pilot run must be an object")
        expected_manifest_sha256 = sha256_hex(canonical_json(asdict(self.manifest)))
        if value.get("manifestSha256") != expected_manifest_sha256:
            raise EvidenceError("manifest does not match initialized pilot run")
        return dict(value)

    def _write_run(self, run: dict[str, Any]) -> None:
        assert_safe_json(run)
        _atomic_write(self.run_path, canonical_json(run))

    def record_check(self, evidence: CheckEvidence) -> None:
        run = self.read_run()
        if run["state"] in {"passed", "failed"}:
            raise EvidenceError("terminal pilot state cannot be modified")
        checks = dict(run["checks"])
        if evidence.check_id in checks:
            raise EvidenceError("check evidence is append-only")
        gate = CHECK_GATE[evidence.check_id]
        for prior_gate in range(gate):
            for prior_check in CHECKS_BY_GATE[prior_gate]:
                entry = checks.get(prior_check)
                if not isinstance(entry, dict) or entry.get("status") != "passed":
                    raise EvidenceError(f"prior gate {prior_gate} has not passed")
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "checkId": evidence.check_id,
            "status": evidence.status,
            "startedAt": evidence.started_at,
            "completedAt": evidence.completed_at,
            "summary": evidence.summary,
            "metrics": evidence.metrics,
        }
        parse_check_evidence(payload)
        encoded = canonical_json(payload)
        digest = sha256_hex(encoded)
        relative_path = Path("checks") / f"{evidence.check_id}-{digest}.json"
        _atomic_write(self.run_directory / relative_path, encoded)
        checks[evidence.check_id] = {
            "path": relative_path.as_posix(),
            "sha256": digest,
            "status": evidence.status,
            "gate": gate,
        }
        run["checks"] = checks
        if evidence.status == "failed":
            run["state"] = "failed"
        elif gate == 0 and all(
            isinstance(checks.get(check_id), dict)
            and checks[check_id].get("status") == "passed"
            for check_id in CHECKS_BY_GATE[0]
        ):
            run["state"] = "preflight_passed"
        elif gate > 0 and run["state"] == "preflight_passed":
            run["state"] = "executing"
        self._write_run(run)

    def load_checks(self) -> dict[str, CheckEvidence]:
        run = self.read_run()
        result: dict[str, CheckEvidence] = {}
        for check_id, entry in run["checks"].items():
            path = self.run_directory / entry["path"]
            encoded = path.read_bytes()
            if sha256_hex(encoded) != entry["sha256"]:
                raise EvidenceError(f"check evidence hash mismatch: {check_id}")
            result[check_id] = parse_check_evidence(json.loads(encoded))
        return result
~~~

- [ ] **Step 4: Run store tests and confirm GREEN**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_evidence -v
~~~

Expected: all PilotEvidenceStoreTests pass.

- [ ] **Step 5: Commit the append-only evidence store**

~~~powershell
git add infra/pilot_gate/evidence.py infra/ci/tests/test_pilot_gate_evidence.py
git commit -m "feat(infra): persist immutable pilot evidence"
~~~

### Task 4: Evaluate recovery, SLO, connector, and independent-review thresholds

**Files:**
- Create: infra/pilot_gate/evaluation.py
- Modify: infra/pilot_gate/evidence.py
- Create: infra/ci/tests/test_pilot_gate_evaluation.py

- [ ] **Step 1: Write failing decision tests**

Use one evidence builder for every required check, then override the metric-rich
checks. Include passing, weak-SLO, unsafe-CSV-rate, missing-check, and
same-reviewer cases:

~~~python
from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from infra.pilot_gate.contract import (
    CHECKS_BY_GATE,
    REQUIRED_CHECK_IDS,
    parse_manifest,
)
from infra.pilot_gate.evaluation import (
    BOOLEAN_PROOFS_BY_CHECK,
    CONNECTOR_PROOFS_BY_KIND,
    evaluate,
)
from infra.pilot_gate.evidence import CheckEvidence, EvidenceError, EvidenceStore
from infra.ci.tests.test_pilot_gate_contract import valid_manifest


def passed(check_id: str, metrics: dict[str, object] | None = None) -> CheckEvidence:
    return CheckEvidence(
        check_id=check_id,
        status="passed",
        started_at="2026-07-16T10:00:00Z",
        completed_at="2026-07-16T10:01:00Z",
        summary=f"{check_id} passed",
        metrics=metrics or {},
    )


def passing_checks() -> dict[str, CheckEvidence]:
    checks = {check_id: passed(check_id) for check_id in REQUIRED_CHECK_IDS}
    for check_id, proof_names in BOOLEAN_PROOFS_BY_CHECK.items():
        checks[check_id] = passed(
            check_id,
            {proof_name: True for proof_name in proof_names},
        )
    checks["deployment-preflight"].metrics.update({
        "apiReplicas": 2,
        "clockSkewSeconds": 0.4,
        "migrationSetSha256": "ac0f8176205045a99e50d679600d4a192b6e57cb29eb4f6d4e92a4212cce90ed",
    })
    checks["database-object-restore"] = passed("database-object-restore", {
        "rpoMinutes": 10,
        "rtoMinutes": 180,
        "rlsVerified": True,
        "objectsReconciled": True,
        "databaseFingerprintMatched": True,
        "kmsMaterialAvailable": True,
        "representativeReadsVerified": True,
        "tenantProjectReadVerified": True,
        "rawReplayReadVerified": True,
        "governedObjectReadVerified": True,
        "canvasRevisionReadVerified": True,
        "auditCorrelationReadVerified": True,
        "recoveryPointId": "recovery-20260716-001",
        "objectSnapshotSha256": "f" * 64,
    })
    checks["service-objectives"] = passed("service-objectives", {
        "availabilityPercent": 99.95,
        "latencyP95Seconds": 0.8,
        "outboxFreshnessSeconds": 120,
        "observationDays": 30,
        "unresolvedDeadLetters": 0,
        "redisReady": True,
        "pipelineHeartbeatHealthy": True,
        "postHocExclusionsAbsent": True,
        "scheduledMaintenanceIncluded": True,
        "windowStartedAfterShakedown": True,
        "windowStartedAt": "2026-06-16T00:00:00Z",
        "windowCompletedAt": "2026-07-16T00:00:00Z",
    })
    common = {
        "sourceCredentialReadOnly": True,
        "sourceSafetyApproved": True,
        "sourceReconciled": True,
        "restartResume": True,
        "edgeRestartRecovered": True,
        "apiRestartRecovered": True,
        "networkRecovery": True,
        "boundedRetry": True,
        "orderedDrain": True,
        "credentialRotation": True,
        "checkpointPreservedAfterRotation": True,
        "secretExposureAbsent": True,
        "additiveSchema": True,
        "incompatibleSchemaFailsClosed": True,
        "twoBatchReadOnlyRehearsalApproved": True,
        "backfillCompleted": True,
        "growthBounded": True,
        "sourceImpactAbsent": True,
        "serviceObjectivesHeld": True,
        "acceptedQuarantinedRejectedReconciled": True,
        "allDifferencesExplained": True,
    }
    checks["connector-csv"] = passed("connector-csv", common | {
        "achievedRate": 180.0,
        "backfillMinutes": 100.0,
        "observedSchemaFingerprintSha256": "c" * 64,
        "checkpointBeforeSha256": "1" * 64,
        "checkpointAfterSha256": "2" * 64,
        "replacementMutationFailsClosed": True,
    })
    checks["connector-postgres"] = passed("connector-postgres", common | {
        "achievedRate": 100.0,
        "backfillMinutes": 150.0,
        "sustainedMinutes": 60.0,
        "observedSchemaFingerprintSha256": "d" * 64,
        "checkpointBeforeSha256": "3" * 64,
        "checkpointAfterSha256": "4" * 64,
        "boundedReadOnlyQuery": True,
        "deterministicOrdering": True,
    })
    checks["connector-opcua"] = passed("connector-opcua", common | {
        "achievedRate": 400.0,
        "backfillMinutes": 55.0,
        "sustainedMinutes": 60.0,
        "observedSchemaFingerprintSha256": "e" * 64,
        "checkpointBeforeSha256": "5" * 64,
        "checkpointAfterSha256": "6" * 64,
        "perNodeCheckpoints": True,
        "badStatusMappedNonGood": True,
    })
    return checks


class PilotEvaluationTests(unittest.TestCase):
    def test_accepts_complete_evidence_and_independent_reviewer(self) -> None:
        violations = evaluate(
            parse_manifest(valid_manifest()),
            passing_checks(),
            reviewer_id="reviewer@example.test",
        )
        self.assertEqual(violations, [])

    def test_rejects_a_weak_availability_result(self) -> None:
        checks = passing_checks()
        checks["service-objectives"].metrics["availabilityPercent"] = 99.8

        violations = evaluate(parse_manifest(valid_manifest()), checks, "reviewer@example.test")
        self.assertIn("service-objectives availabilityPercent is below target", violations)

    def test_rejects_operator_self_review(self) -> None:
        violations = evaluate(
            parse_manifest(valid_manifest()),
            passing_checks(),
            reviewer_id="operator@example.test",
        )
        self.assertIn("reviewer must differ from operator", violations)

    def test_rejects_strict_latency_and_outbox_boundaries(self) -> None:
        checks = passing_checks()
        checks["service-objectives"].metrics["latencyP95Seconds"] = 1.0
        checks["service-objectives"].metrics["outboxFreshnessSeconds"] = 300

        violations = evaluate(parse_manifest(valid_manifest()), checks, "reviewer@example.test")

        self.assertIn("service-objectives latencyP95Seconds must be below target", violations)
        self.assertIn("service-objectives outboxFreshnessSeconds must be below target", violations)

    def test_rejects_missing_check_and_unsafe_csv_rate(self) -> None:
        checks = passing_checks()
        del checks["alert-delivery"]
        checks["connector-csv"].metrics["achievedRate"] = 179.0

        violations = evaluate(parse_manifest(valid_manifest()), checks, "reviewer@example.test")

        self.assertIn("required check is missing: alert-delivery", violations)
        self.assertIn("connector-csv achievedRate is below target", violations)

    def test_rejects_every_missing_boolean_proof_and_non_finite_metric(self) -> None:
        manifest = parse_manifest(valid_manifest())
        for check_id, proof_names in BOOLEAN_PROOFS_BY_CHECK.items():
            for proof_name in proof_names:
                with self.subTest(check_id=check_id, proof_name=proof_name):
                    checks = passing_checks()
                    checks[check_id].metrics[proof_name] = False
                    self.assertIn(
                        f"{check_id} {proof_name} is not true",
                        evaluate(manifest, checks, "reviewer@example.test"),
                    )
        for kind, proof_names in CONNECTOR_PROOFS_BY_KIND.items():
            check_id = f"connector-{kind}"
            for proof_name in proof_names:
                with self.subTest(check_id=check_id, proof_name=proof_name):
                    checks = passing_checks()
                    checks[check_id].metrics[proof_name] = False
                    self.assertIn(
                        f"{check_id} {proof_name} is not true",
                        evaluate(manifest, checks, "reviewer@example.test"),
                    )

        checks = passing_checks()
        checks["service-objectives"].metrics["availabilityPercent"] = float("nan")
        self.assertIn(
            "service-objectives availabilityPercent must be finite",
            evaluate(manifest, checks, "reviewer@example.test"),
        )

    def test_rejects_recovery_preflight_window_and_connector_metric_failures(self) -> None:
        checks = passing_checks()
        checks["deployment-preflight"].metrics["apiReplicas"] = 1
        checks["deployment-preflight"].metrics["clockSkewSeconds"] = 6
        checks["deployment-preflight"].metrics["migrationSetSha256"] = "0" * 64
        checks["database-object-restore"].metrics["rpoMinutes"] = 16
        checks["database-object-restore"].metrics["rtoMinutes"] = 241
        checks["service-objectives"].metrics["unresolvedDeadLetters"] = 1
        checks["service-objectives"].metrics["windowCompletedAt"] = "2026-07-15T00:00:00Z"
        checks["connector-postgres"].metrics["observedSchemaFingerprintSha256"] = "0" * 64
        checks["connector-postgres"].metrics["backfillMinutes"] = 181
        checks["connector-postgres"].metrics["sustainedMinutes"] = 59

        violations = evaluate(
            parse_manifest(valid_manifest()),
            checks,
            "reviewer@example.test",
        )

        self.assertIn("deployment-preflight apiReplicas must be at least two", violations)
        self.assertIn("deployment-preflight clockSkewSeconds exceeds five", violations)
        self.assertIn(
            "deployment-preflight migrationSetSha256 does not match the approved manifest",
            violations,
        )
        self.assertIn("database-object-restore rpoMinutes exceeds target", violations)
        self.assertIn("database-object-restore rtoMinutes exceeds target", violations)
        self.assertIn("service-objectives unresolvedDeadLetters must be zero", violations)
        self.assertIn("service-objectives measurement window is shorter than target", violations)
        self.assertIn(
            "connector-postgres observedSchemaFingerprintSha256 does not match the approved manifest",
            violations,
        )
        self.assertIn("connector-postgres backfillMinutes exceeds approved window", violations)
        self.assertIn("connector-postgres sustainedMinutes is below sixty", violations)

    def test_final_decision_hashes_both_evidence_indexes_and_is_append_only(self) -> None:
        manifest = parse_manifest(valid_manifest())
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            checks = passing_checks()
            for gate in range(5):
                for check_id in CHECKS_BY_GATE[gate]:
                    store.record_check(checks[check_id])

            decision = store.finalize("reviewer@example.test", [])

            self.assertEqual(decision["outcome"], "passed")
            self.assertRegex(decision["manifestSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(decision["managedCheckIndexSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(decision["supportingEvidenceIndexSha256"], r"^[0-9a-f]{64}$")
            with self.assertRaisesRegex(EvidenceError, "append-only"):
                store.finalize("reviewer@example.test", [])

    def test_finalize_cannot_pass_an_incomplete_run_even_with_empty_violations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory),
                parse_manifest(valid_manifest()),
            )
            store.initialize()

            decision = store.finalize("reviewer@example.test", [])

            self.assertEqual(decision["outcome"], "failed")
            self.assertIn("managed check index is incomplete", decision["violations"])


if __name__ == "__main__":
    unittest.main()
~~~

- [ ] **Step 2: Run evaluation tests and confirm RED**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_evaluation -v
~~~

Expected: FAIL because infra.pilot_gate.evaluation does not exist.

- [ ] **Step 3: Implement explicit decision rules**

Create infra/pilot_gate/evaluation.py. Do not trust a passed status without the
required metric proof:

~~~python
from __future__ import annotations

from datetime import datetime, timezone
import math

from .contract import (
    IDENTIFIER_PATTERN,
    PilotManifest,
    REQUIRED_CHECK_IDS,
    SHA256_PATTERN,
)
from .evidence import CheckEvidence


BOOLEAN_PROOFS_BY_CHECK: dict[str, tuple[str, ...]] = {
    "deployment-preflight": (
        "imageDigestsVerified",
        "migrationsVerified",
        "managedPostgresVerified",
        "managedRedisVerified",
        "managedObjectStorageVerified",
        "workforceOidcValidated",
        "postgresAuthoritative",
        "applicationSuperuserAbsent",
        "migrationOwnerAbsent",
        "sharedCredentialsAbsent",
        "objectVersioning",
        "objectEncryption",
        "redisPersistence",
        "purposeSpecificIdentities",
        "capacityApproved",
        "workerTopologyVerified",
        "sqliteFallbackDisabled",
        "inMemorySharedEventsDisabled",
        "writebackExecutorAbsent",
        "writebackExecutionFailsClosed",
    ),
    "tenant-isolation": (
        "rlsForced",
        "crossTenantDenied",
        "syntheticTenantSeparated",
        "pilotProjectActive",
        "syntheticProjectActive",
        "membershipScoped",
    ),
    "ingress-security": (
        "tls12OrNewer",
        "hstsEnabled",
        "managedCertificateRenewal",
        "workforceOidcRequired",
        "unauthenticatedApplicationDenied",
        "mtlsRequired",
        "oauthRequired",
        "missingCertificateDenied",
        "invalidCertificateDenied",
        "missingBearerDenied",
        "ingestRoutesOnly",
        "spoofedHeadersStripped",
    ),
    "network-isolation": (
        "defaultDeny",
        "approvedDependenciesReachable",
        "arbitraryEgressDenied",
        "directDatabaseDenied",
        "directApiDenied",
    ),
    "credential-rotation": (
        "connectorCredentialRotated",
        "certificateRotated",
        "oldMaterialRevoked",
        "realTransactionVerified",
        "policyNotWidened",
        "plaintextFallbackDisabled",
    ),
    "secret-scan": ("prohibitedMaterialAbsent",),
    "database-object-restore": (
        "rlsVerified",
        "objectsReconciled",
        "databaseFingerprintMatched",
        "kmsMaterialAvailable",
        "representativeReadsVerified",
        "tenantProjectReadVerified",
        "rawReplayReadVerified",
        "governedObjectReadVerified",
        "canvasRevisionReadVerified",
        "auditCorrelationReadVerified",
    ),
    "broker-recovery": (
        "managedOutageRecovered",
        "deadLetterReviewed",
        "requeueIndependentlyReviewed",
        "expiredLeaseTakeover",
        "aggregateOrderingPreserved",
    ),
    "replica-worker-recovery": (
        "apiReplicaRecovered",
        "workerRecovered",
        "noAuthoritativeStoreFallback",
        "rollingReleaseRecovered",
    ),
    "idempotency-checkpoints": (
        "noMissingAcceptedObservations",
        "noDuplicateAcceptedObservations",
        "checkpointSafe",
    ),
    "durable-telemetry": (
        "externalStorage",
        "logsRedacted",
        "retentionConfigured",
        "routeViewsPresent",
        "independentOperatorVerified",
    ),
    "alert-delivery": (
        "testAlertDelivered",
        "testAlertAcknowledged",
    ),
    "service-objectives": (
        "redisReady",
        "pipelineHeartbeatHealthy",
        "postHocExclusionsAbsent",
        "scheduledMaintenanceIncluded",
        "windowStartedAfterShakedown",
    ),
}


COMMON_CONNECTOR_PROOFS = (
    "sourceCredentialReadOnly",
    "sourceSafetyApproved",
    "sourceReconciled",
    "restartResume",
    "edgeRestartRecovered",
    "apiRestartRecovered",
    "networkRecovery",
    "boundedRetry",
    "orderedDrain",
    "credentialRotation",
    "checkpointPreservedAfterRotation",
    "secretExposureAbsent",
    "additiveSchema",
    "incompatibleSchemaFailsClosed",
    "twoBatchReadOnlyRehearsalApproved",
    "backfillCompleted",
    "growthBounded",
    "sourceImpactAbsent",
    "serviceObjectivesHeld",
    "acceptedQuarantinedRejectedReconciled",
    "allDifferencesExplained",
)
CONNECTOR_PROOFS_BY_KIND: dict[str, tuple[str, ...]] = {
    "csv": COMMON_CONNECTOR_PROOFS + ("replacementMutationFailsClosed",),
    "postgres": COMMON_CONNECTOR_PROOFS + (
        "boundedReadOnlyQuery",
        "deterministicOrdering",
    ),
    "opcua": COMMON_CONNECTOR_PROOFS + (
        "perNodeCheckpoints",
        "badStatusMappedNonGood",
    ),
}


def _number(metrics: dict[str, object], name: str, violations: list[str], check_id: str) -> float | None:
    value = metrics.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        violations.append(f"{check_id} {name} is missing or non-numeric")
        return None
    result = float(value)
    if not math.isfinite(result):
        violations.append(f"{check_id} {name} must be finite")
        return None
    if result < 0:
        violations.append(f"{check_id} {name} must not be negative")
        return None
    return result


def _sha256(
    metrics: dict[str, object],
    name: str,
    violations: list[str],
    check_id: str,
    expected: str | None = None,
) -> str | None:
    value = metrics.get(name)
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        violations.append(f"{check_id} {name} must be a SHA-256 hex digest")
        return None
    if expected is not None and value != expected:
        violations.append(f"{check_id} {name} does not match the approved manifest")
    return value


def _utc_metric(
    metrics: dict[str, object],
    name: str,
    violations: list[str],
    check_id: str,
) -> datetime | None:
    value = metrics.get(name)
    if not isinstance(value, str):
        violations.append(f"{check_id} {name} must be a UTC timestamp")
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        violations.append(f"{check_id} {name} must be a UTC timestamp")
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        violations.append(f"{check_id} {name} must be a UTC timestamp")
        return None
    return parsed


def _true(metrics: dict[str, object], name: str, violations: list[str], check_id: str) -> None:
    if metrics.get(name) is not True:
        violations.append(f"{check_id} {name} is not true")


def evaluate(
    manifest: PilotManifest,
    checks: dict[str, CheckEvidence],
    reviewer_id: str,
) -> list[str]:
    violations: list[str] = []
    if not isinstance(reviewer_id, str) or not IDENTIFIER_PATTERN.fullmatch(reviewer_id):
        violations.append("reviewer has an invalid identity")
    elif reviewer_id.casefold() == manifest.operator_id.casefold():
        violations.append("reviewer must differ from operator")
    missing = sorted(REQUIRED_CHECK_IDS - checks.keys())
    violations.extend(f"required check is missing: {check_id}" for check_id in missing)
    for check_id, evidence in sorted(checks.items()):
        if check_id in REQUIRED_CHECK_IDS and evidence.status != "passed":
            violations.append(f"required check failed: {check_id}")
    for check_id, proof_names in BOOLEAN_PROOFS_BY_CHECK.items():
        evidence = checks.get(check_id)
        if evidence is None:
            continue
        for proof_name in proof_names:
            _true(evidence.metrics, proof_name, violations, check_id)

    preflight = checks.get("deployment-preflight")
    if preflight is not None:
        replicas = _number(preflight.metrics, "apiReplicas", violations, preflight.check_id)
        clock_skew = _number(preflight.metrics, "clockSkewSeconds", violations, preflight.check_id)
        if replicas is not None and replicas < 2:
            violations.append("deployment-preflight apiReplicas must be at least two")
        if replicas is not None and not replicas.is_integer():
            violations.append("deployment-preflight apiReplicas must be an integer")
        if clock_skew is not None and clock_skew > 5:
            violations.append("deployment-preflight clockSkewSeconds exceeds five")
        _sha256(
            preflight.metrics,
            "migrationSetSha256",
            violations,
            preflight.check_id,
            manifest.migration_set_sha256,
        )

    restore = checks.get("database-object-restore")
    if restore is not None:
        rpo = _number(restore.metrics, "rpoMinutes", violations, restore.check_id)
        rto = _number(restore.metrics, "rtoMinutes", violations, restore.check_id)
        if rpo is not None and rpo > manifest.targets.rpo_minutes:
            violations.append("database-object-restore rpoMinutes exceeds target")
        if rto is not None and rto > manifest.targets.rto_minutes:
            violations.append("database-object-restore rtoMinutes exceeds target")
        recovery_point = restore.metrics.get("recoveryPointId")
        if not isinstance(recovery_point, str) or not IDENTIFIER_PATTERN.fullmatch(recovery_point):
            violations.append("database-object-restore recoveryPointId is invalid")
        _sha256(restore.metrics, "objectSnapshotSha256", violations, restore.check_id)

    objectives = checks.get("service-objectives")
    if objectives is not None:
        availability = _number(objectives.metrics, "availabilityPercent", violations, objectives.check_id)
        latency = _number(objectives.metrics, "latencyP95Seconds", violations, objectives.check_id)
        freshness = _number(objectives.metrics, "outboxFreshnessSeconds", violations, objectives.check_id)
        days = _number(objectives.metrics, "observationDays", violations, objectives.check_id)
        dead_letters = _number(objectives.metrics, "unresolvedDeadLetters", violations, objectives.check_id)
        if availability is not None and availability < manifest.targets.availability_percent:
            violations.append("service-objectives availabilityPercent is below target")
        if availability is not None and availability > 100:
            violations.append("service-objectives availabilityPercent exceeds 100")
        if latency is not None and latency >= manifest.targets.latency_p95_seconds:
            violations.append("service-objectives latencyP95Seconds must be below target")
        if freshness is not None and freshness >= manifest.targets.outbox_freshness_seconds:
            violations.append("service-objectives outboxFreshnessSeconds must be below target")
        if days is not None and days < manifest.targets.observation_days:
            violations.append("service-objectives observationDays is below target")
        if dead_letters is not None and dead_letters != 0:
            violations.append("service-objectives unresolvedDeadLetters must be zero")
        window_started = _utc_metric(
            objectives.metrics,
            "windowStartedAt",
            violations,
            objectives.check_id,
        )
        window_completed = _utc_metric(
            objectives.metrics,
            "windowCompletedAt",
            violations,
            objectives.check_id,
        )
        if (
            window_started is not None
            and window_completed is not None
            and (window_completed - window_started).total_seconds()
            < manifest.targets.observation_days * 86_400
        ):
            violations.append("service-objectives measurement window is shorter than target")

    connector_by_kind = {connector.kind: connector for connector in manifest.connectors}
    for kind in ("csv", "postgres", "opcua"):
        check_id = f"connector-{kind}"
        connector_evidence = checks.get(check_id)
        if connector_evidence is None:
            continue
        for proof in CONNECTOR_PROOFS_BY_KIND[kind]:
            _true(connector_evidence.metrics, proof, violations, check_id)
        target = connector_by_kind[kind]
        _sha256(
            connector_evidence.metrics,
            "observedSchemaFingerprintSha256",
            violations,
            check_id,
            target.schema_fingerprint_sha256,
        )
        _sha256(connector_evidence.metrics, "checkpointBeforeSha256", violations, check_id)
        _sha256(connector_evidence.metrics, "checkpointAfterSha256", violations, check_id)
        backfill_minutes = _number(
            connector_evidence.metrics,
            "backfillMinutes",
            violations,
            check_id,
        )
        if (
            backfill_minutes is not None
            and backfill_minutes > target.approved_backfill_window_minutes
        ):
            violations.append(f"{check_id} backfillMinutes exceeds approved window")
        if kind != "csv":
            sustained_minutes = _number(
                connector_evidence.metrics,
                "sustainedMinutes",
                violations,
                check_id,
            )
            if sustained_minutes is not None and sustained_minutes < 60:
                violations.append(f"{check_id} sustainedMinutes is below sixty")
        achieved = _number(connector_evidence.metrics, "achievedRate", violations, check_id)
        if achieved is None:
            continue
        if kind == "csv":
            assert target.required_average_rate is not None
            required_rate = target.required_average_rate * manifest.targets.load_multiplier
            if target.source_safety_ceiling_rate is not None:
                required_rate = min(required_rate, target.source_safety_ceiling_rate)
        else:
            assert target.measured_peak_rate is not None
            required_rate = target.measured_peak_rate * manifest.targets.load_multiplier
        if achieved < required_rate:
            violations.append(f"{check_id} achievedRate is below target")

    return violations
~~~

Extend EvidenceStore with finalize. It must hash the decision plus both the
managed-check and supporting-evidence indexes before changing executing to
passed:

~~~python
    def finalize(self, reviewer_id: str, violations: list[str]) -> dict[str, object]:
        run = self.read_run()
        if (self.run_directory / "decision.json").exists():
            raise EvidenceError("pilot decision is append-only")
        if run["state"] == "passed":
            raise EvidenceError("pilot decision is append-only")
        final_violations = list(violations)
        if not isinstance(reviewer_id, str) or not IDENTIFIER_PATTERN.fullmatch(reviewer_id):
            if "reviewer has an invalid identity" not in final_violations:
                final_violations.append("reviewer has an invalid identity")
        elif reviewer_id.casefold() == self.manifest.operator_id.casefold():
            if "reviewer must differ from operator" not in final_violations:
                final_violations.append("reviewer must differ from operator")
        if run["state"] != "executing":
            final_violations.append("pilot run is not in executing state")
        if set(run["checks"]) != REQUIRED_CHECK_IDS:
            final_violations.append("managed check index is incomplete")
        outcome = "passed" if not final_violations else "failed"
        decision = {
            "schemaVersion": SCHEMA_VERSION,
            "pilotRunId": self.manifest.pilot_run_id,
            "manifestSha256": run["manifestSha256"],
            "reviewerId": reviewer_id,
            "reviewedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "outcome": outcome,
            "violations": final_violations,
            "managedCheckIndexSha256": sha256_hex(canonical_json(run["checks"])),
            "supportingEvidenceIndexSha256": sha256_hex(canonical_json(run["supportingEvidence"])),
        }
        assert_safe_json(decision)
        encoded = canonical_json(decision)
        _atomic_write(self.run_directory / "decision.json", encoded)
        run["state"] = outcome
        run["decision"] = {
            "path": "decision.json",
            "sha256": sha256_hex(encoded),
            "outcome": outcome,
        }
        self._write_run(run)
        return decision
~~~

- [ ] **Step 4: Run all contract/evidence/evaluation tests**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_contract infra.ci.tests.test_pilot_gate_safety infra.ci.tests.test_pilot_gate_evidence infra.ci.tests.test_pilot_gate_evaluation -v
~~~

Expected: all pilot contract tests pass.

- [ ] **Step 5: Commit the evaluator**

~~~powershell
git add infra/pilot_gate/evaluation.py infra/pilot_gate/evidence.py infra/ci/tests/test_pilot_gate_evaluation.py
git commit -m "feat(infra): evaluate production pilot evidence"
~~~

### Task 5: Add fixed synthetic rehearsal adapters

**Files:**
- Create: infra/pilot_gate/adapters.py
- Modify: infra/pilot_gate/evidence.py
- Create: infra/ci/tests/test_pilot_gate_adapters.py

- [ ] **Step 1: Start the runner stack branch**

~~~powershell
git switch -c feat/pilot-gate-runner
~~~

Expected: the runner branch starts at the Task 4 evaluator commit, leaving
feat/pilot-gate-contract fixed at the contract boundary.

- [ ] **Step 2: Write failing adapter tests**

Patch subprocess.run and prove commands are fixed arrays, shell execution is
disabled, confirmation is required where specified, and captured secrets are
redacted:

~~~python
from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from infra.pilot_gate.adapters import AdapterError, run_adapter
from infra.pilot_gate.contract import parse_manifest
from infra.pilot_gate.evidence import EvidenceError, EvidenceStore
from infra.ci.tests.test_pilot_gate_contract import valid_manifest


class PilotAdapterTests(unittest.TestCase):
    def test_rejects_unknown_adapter(self) -> None:
        with self.assertRaisesRegex(AdapterError, "unknown synthetic adapter"):
            run_adapter("operator-command", Path.cwd(), None)

    @patch("infra.pilot_gate.adapters.subprocess.run")
    def test_runs_a_fixed_command_without_a_shell(self, run: Mock) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="validated",
            stderr="",
        )

        result = run_adapter("static-validation", Path.cwd(), None)

        self.assertEqual(result["status"], "passed")
        self.assertEqual(run.call_args.kwargs["shell"], False)
        self.assertEqual(
            run.call_args.args[0][-1],
            "infra/ci/validate-production-gates.py",
        )

    @patch("infra.pilot_gate.adapters.subprocess.run")
    def test_requires_confirmation_and_redacts_output(self, run: Mock) -> None:
        with self.assertRaisesRegex(AdapterError, "confirmation"):
            run_adapter("broker-recovery", Path.cwd(), None)

        run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout="Authorization: Bearer abc.def.ghi",
            stderr="broker unavailable",
        )
        result = run_adapter("broker-recovery", Path.cwd(), "local-production-like")

        self.assertEqual(result["status"], "failed")
        self.assertNotIn("abc.def.ghi", result["summary"])
        self.assertEqual(result["metrics"]["redactionCount"], 1)

    @patch("infra.pilot_gate.adapters.subprocess.run")
    def test_supporting_evidence_is_hashed_without_advancing_the_gate(self, run: Mock) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="validated",
            stderr="",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory),
                parse_manifest(valid_manifest()),
            )
            store.initialize()
            result = run_adapter("static-validation", Path.cwd(), None)

            store.record_supporting_evidence(result)

            state = store.read_run()
            self.assertEqual(state["state"], "created")
            entry = state["supportingEvidence"]["synthetic-static-validation"]
            self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue((store.run_directory / entry["path"]).is_file())
            with self.assertRaisesRegex(EvidenceError, "append-only"):
                store.record_supporting_evidence(result)


if __name__ == "__main__":
    unittest.main()
~~~

- [ ] **Step 3: Run adapter tests and confirm RED**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_adapters -v
~~~

Expected: FAIL because adapters.py does not exist.

- [ ] **Step 4: Implement the fixed allowlist**

Create infra/pilot_gate/adapters.py. Never accept a command, path, timeout, or
environment-variable name from the manifest:

~~~python
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys

from . import SCHEMA_VERSION
from .safety import redact_text


class AdapterError(ValueError):
    """Raised when a synthetic adapter cannot be launched safely."""


@dataclass(frozen=True)
class Adapter:
    command: tuple[str, ...]
    timeout_seconds: int
    confirmation_env: str | None = None
    confirmation_value: str | None = None


ADAPTERS: dict[str, Adapter] = {
    "static-validation": Adapter((sys.executable, "infra/ci/validate-production-gates.py"), 120),
    "production-like-smoke": Adapter(("bash", "infra/ci/production-like-smoke.sh"), 900),
    "broker-recovery": Adapter(
        ("bash", "infra/ci/outbox-broker-rehearsal.sh"),
        900,
        "ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM",
        "local-production-like",
    ),
    "observability": Adapter(("bash", "infra/ci/production-like-observability-smoke.sh"), 900),
    "security-ingress": Adapter(
        ("bash", "infra/ci/security-ingress-smoke.sh"),
        600,
        "ODF_SECURITY_INGRESS_SMOKE_CONFIRM",
        "local-security-ingress",
    ),
    "edge-mtls": Adapter(
        ("bash", "infra/ci/edge-agent-mtls-rehearsal.sh"),
        600,
        "ODF_EDGE_MTLS_REHEARSAL_CONFIRM",
        "local-ci-edge-mtls-rehearsal",
    ),
    "backup-restore": Adapter(("bash", "infra/ci/postgres-backup-restore-rehearsal.sh"), 900),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run_adapter(
    adapter_id: str,
    repository_root: Path,
    confirmation: str | None,
) -> dict[str, object]:
    adapter = ADAPTERS.get(adapter_id)
    if adapter is None:
        raise AdapterError("unknown synthetic adapter")
    if adapter.confirmation_value is not None and confirmation != adapter.confirmation_value:
        raise AdapterError(f"{adapter_id} requires explicit confirmation")
    environment = dict(os.environ)
    if adapter.confirmation_env is not None and adapter.confirmation_value is not None:
        environment[adapter.confirmation_env] = adapter.confirmation_value
    started_at = _now()
    try:
        completed = subprocess.run(
            list(adapter.command),
            cwd=repository_root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=adapter.timeout_seconds,
            check=False,
            shell=False,
        )
        combined = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
        redacted_output, redaction_count = redact_text(combined)
        redacted = redacted_output[:20_000]
        status = "passed" if completed.returncode == 0 else "failed"
        return {
            "schemaVersion": SCHEMA_VERSION,
            "checkId": f"synthetic-{adapter_id}",
            "status": status,
            "startedAt": started_at,
            "completedAt": _now(),
            "summary": redacted or f"{adapter_id} produced no output",
            "metrics": {
                "returnCode": completed.returncode,
                "redactionCount": redaction_count,
            },
        }
    except subprocess.TimeoutExpired:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "checkId": f"synthetic-{adapter_id}",
            "status": "failed",
            "startedAt": started_at,
            "completedAt": _now(),
            "summary": f"{adapter_id} exceeded its fixed timeout",
            "metrics": {"timedOut": True, "redactionCount": 0},
        }
~~~

Add import re and this module-level identifier pattern to evidence.py:

~~~python
import re

SYNTHETIC_CHECK_ID_PATTERN = re.compile(r"^synthetic-[a-z0-9][a-z0-9-]{2,63}$")
~~~

Then add EvidenceStore.record_supporting_evidence. It validates the generated
shape, writes under supporting/, and updates supportingEvidence without
changing managed gate state:

~~~python
    def record_supporting_evidence(self, raw_value: object) -> None:
        assert_safe_json(raw_value)
        if not isinstance(raw_value, dict):
            raise EvidenceError("supporting evidence must be an object")
        expected_fields = {
            "schemaVersion",
            "checkId",
            "status",
            "startedAt",
            "completedAt",
            "summary",
            "metrics",
        }
        if set(raw_value) != expected_fields or raw_value.get("schemaVersion") != SCHEMA_VERSION:
            raise EvidenceError("supporting evidence fields do not match the contract")
        check_id = raw_value.get("checkId")
        if not isinstance(check_id, str) or not SYNTHETIC_CHECK_ID_PATTERN.fullmatch(check_id):
            raise EvidenceError("supporting checkId has an invalid value")
        if raw_value.get("status") not in {"passed", "failed"}:
            raise EvidenceError("supporting status must be passed or failed")
        started_at = _utc_timestamp(raw_value.get("startedAt"), "supporting.startedAt")
        completed_at = _utc_timestamp(raw_value.get("completedAt"), "supporting.completedAt")
        if datetime.fromisoformat(completed_at.replace("Z", "+00:00")) < datetime.fromisoformat(
            started_at.replace("Z", "+00:00")
        ):
            raise EvidenceError("supporting completedAt must not precede startedAt")
        summary = raw_value.get("summary")
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 20_000:
            raise EvidenceError("supporting summary must contain 1 to 20000 characters")
        if not isinstance(raw_value.get("metrics"), dict):
            raise EvidenceError("supporting metrics must be an object")
        run = self.read_run()
        if run["state"] in {"passed", "failed"}:
            raise EvidenceError("terminal pilot state cannot be modified")
        supporting = dict(run["supportingEvidence"])
        if check_id in supporting:
            raise EvidenceError("supporting evidence is append-only")
        encoded = canonical_json(raw_value)
        digest = sha256_hex(encoded)
        relative_path = Path("supporting") / f"{check_id}-{digest}.json"
        _atomic_write(self.run_directory / relative_path, encoded)
        supporting[check_id] = {
            "path": relative_path.as_posix(),
            "sha256": digest,
            "status": raw_value.get("status"),
        }
        run["supportingEvidence"] = supporting
        self._write_run(run)
~~~

- [ ] **Step 5: Run adapter and evidence tests**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_adapters infra.ci.tests.test_pilot_gate_evidence -v
~~~

Expected: all adapter and evidence tests pass.

- [ ] **Step 6: Commit the allowlisted adapters**

~~~powershell
git add infra/pilot_gate/adapters.py infra/pilot_gate/evidence.py infra/ci/tests/test_pilot_gate_adapters.py
git commit -m "feat(infra): run allowlisted pilot rehearsals"
~~~

### Task 6: Expose a fail-closed command-line workflow

**Files:**
- Create: infra/pilot_gate/cli.py
- Create: infra/ci/tests/test_pilot_gate_cli.py

- [ ] **Step 1: Write failing CLI workflow tests**

Test validate, init, record, duplicate record, and evaluate exit codes using
temporary files. Mock adapters rather than launching Docker:

~~~python
from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from infra.pilot_gate.cli import main
from infra.ci.tests.test_pilot_gate_contract import valid_manifest


class PilotGateCliTests(unittest.TestCase):
    def test_validate_and_init_emit_json_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            output = io.StringIO()

            with redirect_stdout(output):
                self.assertEqual(main(["validate", "--manifest", str(manifest_path)]), 0)
                self.assertEqual(main([
                    "init",
                    "--manifest", str(manifest_path),
                    "--output-root", str(root / "evidence"),
                ]), 0)

            self.assertIn('"status": "valid"', output.getvalue())
            self.assertTrue((root / "evidence" / "pilot-managed-20260716-001" / "run.json").is_file())

    def test_record_rejects_out_of_order_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            evidence_path = root / "evidence.json"
            evidence_path.write_text(json.dumps({
                "schemaVersion": 1,
                "checkId": "ingress-security",
                "status": "passed",
                "startedAt": "2026-07-16T10:00:00Z",
                "completedAt": "2026-07-16T10:01:00Z",
                "summary": "ingress passed",
                "metrics": {},
            }), encoding="utf-8")
            main(["init", "--manifest", str(manifest_path), "--output-root", str(root / "out")])
            errors = io.StringIO()

            with redirect_stderr(errors):
                code = main([
                    "record",
                    "--manifest", str(manifest_path),
                    "--output-root", str(root / "out"),
                    "--evidence", str(evidence_path),
                ])

            self.assertEqual(code, 2)
            self.assertIn("prior gate", errors.getvalue())

    @patch("infra.pilot_gate.cli.run_adapter")
    def test_run_synthetic_records_supporting_evidence_only(self, adapter: Mock) -> None:
        adapter.return_value = {
            "schemaVersion": 1,
            "checkId": "synthetic-static-validation",
            "status": "passed",
            "startedAt": "2026-07-16T10:00:00Z",
            "completedAt": "2026-07-16T10:01:00Z",
            "summary": "static validation passed",
            "metrics": {"returnCode": 0, "redactionCount": 0},
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            output_root = root / "out"
            self.assertEqual(main([
                "init",
                "--manifest", str(manifest_path),
                "--output-root", str(output_root),
            ]), 0)

            self.assertEqual(main([
                "run-synthetic",
                "--manifest", str(manifest_path),
                "--output-root", str(output_root),
                "--adapter", "static-validation",
            ]), 0)

            run = json.loads((
                output_root / "pilot-managed-20260716-001" / "run.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(run["state"], "created")
            self.assertIn("synthetic-static-validation", run["supportingEvidence"])


if __name__ == "__main__":
    unittest.main()
~~~

- [ ] **Step 2: Run CLI tests and confirm RED**

~~~powershell
python -m unittest infra.ci.tests.test_pilot_gate_cli -v
~~~

Expected: FAIL because cli.py does not exist.

- [ ] **Step 3: Implement validate, init, record, run-synthetic, and evaluate**

Create infra/pilot_gate/cli.py. Every result is JSON; validation failures use
exit code 2, a completed no-go decision uses exit code 1, and a go decision uses
exit code 0:

~~~python
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Sequence, TextIO

from .adapters import AdapterError, run_adapter
from .contract import ContractError, load_manifest
from .evaluation import evaluate
from .evidence import EvidenceError, EvidenceStore, parse_check_evidence
from .safety import UnsafeEvidenceError


ROOT = Path(__file__).resolve().parents[2]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pilot-gate")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "init", "record", "run-synthetic", "evaluate"):
        subparser = subparsers.add_parser(name)
        subparser.add_argument("--manifest", type=Path, required=True)
        if name != "validate":
            subparser.add_argument("--output-root", type=Path, required=True)
        if name == "record":
            subparser.add_argument("--evidence", type=Path, required=True)
        if name == "run-synthetic":
            subparser.add_argument("--adapter", required=True)
            subparser.add_argument("--confirm")
        if name == "evaluate":
            subparser.add_argument("--reviewer", required=True)
    return parser


def _emit(value: object, stream: TextIO | None = None) -> None:
    destination = sys.stdout if stream is None else stream
    print(json.dumps(value, sort_keys=True, allow_nan=False), file=destination)


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
        manifest = load_manifest(args.manifest)
        if args.command == "validate":
            _emit({"pilotRunId": manifest.pilot_run_id, "status": "valid"})
            return 0
        store = EvidenceStore(args.output_root, manifest)
        if args.command == "init":
            store.initialize()
            _emit({"pilotRunId": manifest.pilot_run_id, "state": "created"})
            return 0
        if args.command == "record":
            raw: object = json.loads(args.evidence.read_text(encoding="utf-8"))
            parsed = parse_check_evidence(raw)
            store.record_check(parsed)
            _emit({"checkId": parsed.check_id, "state": store.read_run()["state"]})
            return 0
        if args.command == "run-synthetic":
            result = run_adapter(args.adapter, ROOT, args.confirm)
            store.record_supporting_evidence(result)
            _emit({"checkId": result["checkId"], "status": result["status"]})
            return 0 if result["status"] == "passed" else 1
        checks = store.load_checks()
        violations = evaluate(manifest, checks, args.reviewer)
        decision = store.finalize(args.reviewer, violations)
        _emit(decision)
        return 0 if decision["outcome"] == "passed" else 1
    except (
        AdapterError,
        ContractError,
        EvidenceError,
        UnsafeEvidenceError,
        OSError,
        UnicodeError,
        json.JSONDecodeError,
    ) as error:
        _emit({"status": "error", "message": str(error)}, sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
~~~

- [ ] **Step 4: Expand CLI tests through a complete passing run**

Use passing_checks from test_pilot_gate_evaluation, write each check as JSON in
gate order, invoke record, then evaluate with reviewer@example.test. Assert
decision.json exists, outcome is passed, a second evaluate returns exit code 2,
and no raw evidence value appears in run.json.

Add CHECKS_BY_GATE and passing_checks to the test imports, then add:

~~~python
    def test_records_all_gates_and_emits_one_passing_decision(self) -> None:
        from infra.pilot_gate.contract import CHECKS_BY_GATE
        from infra.ci.tests.test_pilot_gate_evaluation import passing_checks

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
            output_root = root / "out"
            self.assertEqual(main([
                "init",
                "--manifest", str(manifest_path),
                "--output-root", str(output_root),
            ]), 0)
            checks = passing_checks()
            for gate in range(5):
                for check_id in CHECKS_BY_GATE[gate]:
                    item = checks[check_id]
                    evidence_path = root / f"{check_id}.json"
                    evidence_path.write_text(json.dumps({
                        "schemaVersion": 1,
                        "checkId": item.check_id,
                        "status": item.status,
                        "startedAt": item.started_at,
                        "completedAt": item.completed_at,
                        "summary": item.summary,
                        "metrics": item.metrics,
                    }), encoding="utf-8")
                    self.assertEqual(main([
                        "record",
                        "--manifest", str(manifest_path),
                        "--output-root", str(output_root),
                        "--evidence", str(evidence_path),
                    ]), 0)
                    if gate == 0 and check_id == "deployment-preflight":
                        with redirect_stderr(io.StringIO()):
                            self.assertEqual(main([
                                "record",
                                "--manifest", str(manifest_path),
                                "--output-root", str(output_root),
                                "--evidence", str(evidence_path),
                            ]), 2)
            self.assertEqual(main([
                "evaluate",
                "--manifest", str(manifest_path),
                "--output-root", str(output_root),
                "--reviewer", "reviewer@example.test",
            ]), 0)
            decision_path = output_root / "pilot-managed-20260716-001" / "decision.json"
            decision = json.loads(decision_path.read_text(encoding="utf-8"))
            self.assertEqual(decision["outcome"], "passed")
            run_text = (
                output_root / "pilot-managed-20260716-001" / "run.json"
            ).read_text(encoding="utf-8")
            self.assertNotIn("deployment-preflight passed", run_text)
            self.assertEqual(main([
                "evaluate",
                "--manifest", str(manifest_path),
                "--output-root", str(output_root),
                "--reviewer", "reviewer@example.test",
            ]), 2)
~~~

- [ ] **Step 5: Run all pilot-gate unit tests**

~~~powershell
python -m unittest discover -s infra/ci/tests -p "test_pilot_gate_*.py" -v
~~~

Expected: all pilot-gate tests pass.

- [ ] **Step 6: Commit the CLI**

~~~powershell
git add infra/pilot_gate/cli.py infra/ci/tests/test_pilot_gate_cli.py
git commit -m "feat(infra): add production pilot gate CLI"
~~~

### Task 7: Check in a valid example and make static validation enforce it

**Files:**
- Create: infra/pilot-gate.example.json
- Modify: package.json
- Modify: infra/ci/validate-production-gates.py
- Modify: infra/ci/tests/test_validate_production_gates.py

- [ ] **Step 1: Write failing static-validator tests**

Add this class to test_validate_production_gates.py:

~~~python
class PilotGateAssetTests(unittest.TestCase):
    def test_checked_in_manifest_is_valid_and_non_secret(self) -> None:
        from infra.pilot_gate.contract import load_manifest

        path = VALIDATOR_PATH.parents[2] / "infra/pilot-gate.example.json"
        manifest = load_manifest(path)

        self.assertEqual(manifest.environment_id, "managed-staging")
        self.assertEqual(manifest.targets.evidence_retention_days, 90)
        self.assertTrue(manifest.scope.read_only)
        self.assertFalse(manifest.scope.writeback_authorized)
        raw = path.read_text(encoding="utf-8").lower()
        self.assertNotIn("password", raw)
        self.assertNotIn("privatekey", raw)

    def test_validator_references_the_pilot_contract(self) -> None:
        validator_text = VALIDATOR_PATH.read_text(encoding="utf-8")

        self.assertIn("infra/pilot-gate.example.json", validator_text)
        self.assertIn("REQUIRED_CHECK_IDS", validator_text)
~~~

- [ ] **Step 2: Run the focused static tests and confirm RED**

~~~powershell
python -m unittest infra.ci.tests.test_validate_production_gates.PilotGateAssetTests -v
~~~

Expected: FAIL because the checked-in example manifest does not exist.

- [ ] **Step 3: Add the complete non-secret example manifest**

Create infra/pilot-gate.example.json exactly as follows. It intentionally uses
non-secret identifiers and fixed non-production digests; do not add URLs, secret
paths, or credential-shaped values.

~~~json
{
  "schemaVersion": 1,
  "pilotRunId": "pilot-managed-20260716-001",
  "predecessorPilotRunId": null,
  "operatorId": "operator@example.test",
  "incidentContactId": "incident@example.test",
  "scope": {
    "pilotProjectExternalId": "design-partner-pilot",
    "syntheticProjectExternalId": "synthetic-isolation",
    "readOnly": true,
    "writebackAuthorized": false
  },
  "environment": {
    "id": "managed-staging",
    "kind": "managed-staging",
    "applicationCommit": "1111111111111111111111111111111111111111",
    "migrations": [
      {
        "version": "202607160001",
        "sha256": "7777777777777777777777777777777777777777777777777777777777777777"
      }
    ],
    "migrationSetSha256": "ac0f8176205045a99e50d679600d4a192b6e57cb29eb4f6d4e92a4212cce90ed",
    "imageDigests": {
      "api": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "web": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "outbox-worker": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "pipeline-worker": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "edge-agent": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  },
  "targets": {
    "rpoMinutes": 15,
    "rtoMinutes": 240,
    "availabilityPercent": 99.9,
    "latencyP95Seconds": 1.0,
    "outboxFreshnessSeconds": 300,
    "observationDays": 30,
    "loadMultiplier": 2.0,
    "evidenceRetentionDays": 90
  },
  "connectors": [
    {
      "kind": "csv",
      "externalId": "pilot-csv",
      "requiredAverageRate": 100.0,
      "sourceSafetyCeilingRate": 180.0,
      "approvedBackfillWindowMinutes": 120,
      "entityCount": 500,
      "timeSeriesCount": 0,
      "averageRecordBytes": 512,
      "retentionDays": 90,
      "schemaFingerprintSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    {
      "kind": "postgres",
      "externalId": "pilot-postgres",
      "measuredPeakRate": 50.0,
      "approvedBackfillWindowMinutes": 180,
      "entityCount": 1000,
      "timeSeriesCount": 50,
      "averageRecordBytes": 1024,
      "retentionDays": 365,
      "schemaFingerprintSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    },
    {
      "kind": "opcua",
      "externalId": "pilot-opcua",
      "measuredPeakRate": 200.0,
      "approvedBackfillWindowMinutes": 60,
      "entityCount": 200,
      "timeSeriesCount": 200,
      "averageRecordBytes": 256,
      "retentionDays": 30,
      "schemaFingerprintSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  ]
}
~~~

- [ ] **Step 4: Add package commands**

Add these entries to the root scripts object in package.json:

~~~json
"pilot:gate": "python -m infra.pilot_gate.cli",
"pilot:gate:validate": "python -m infra.pilot_gate.cli validate --manifest infra/pilot-gate.example.json"
~~~

- [ ] **Step 5: Extend the static production-gate validator**

After ROOT is defined, add the repository root to sys.path and import the
contract:

~~~python
import sys

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from infra.pilot_gate.contract import REQUIRED_CHECK_IDS, load_manifest
~~~

Inside main, load the example, require managed staging, and lock the complete
managed-check count:

~~~python
    pilot_example = ROOT / "infra/pilot-gate.example.json"
    pilot_manifest = load_manifest(pilot_example)
    if pilot_manifest.environment_id != "managed-staging":
        raise AssertionError("pilot example must target managed-staging")
    if len(REQUIRED_CHECK_IDS) != 16:
        raise AssertionError("pilot gate must retain all sixteen managed checks")
~~~

- [ ] **Step 6: Run manifest and infrastructure validation**

~~~powershell
npm run pilot:gate:validate
python -m unittest infra.ci.tests.test_validate_production_gates.PilotGateAssetTests -v
npm run infra:validate
~~~

Expected: the manifest prints valid, PilotGateAssetTests pass, and all
infrastructure validators finish successfully.

- [ ] **Step 7: Commit the integrated runner surface**

~~~powershell
git add infra/pilot-gate.example.json package.json infra/ci/validate-production-gates.py infra/ci/tests/test_validate_production_gates.py
git commit -m "feat(infra): integrate production pilot gate"
~~~

### Task 8: Write the managed-staging operator runbook

**Files:**
- Create: docs/operations/production-pilot-gate.md
- Modify: README.md
- Modify: infra/ci/validate-production-gates.py

- [ ] **Step 1: Start the operations stack branch**

~~~powershell
git switch -c docs/pilot-gate-operations
~~~

Expected: the operations branch starts at the Task 7 integration commit,
leaving feat/pilot-gate-runner fixed at the runner boundary.

- [ ] **Step 2: Create the complete operator runbook**

The runbook must include these sections in this order:

1. Scope and safety boundary.
2. Required topology and purpose-specific identities.
3. Manifest preparation and source-owner approval.
4. Gate initialization.
5. Synthetic evidence adapters.
6. Managed evidence JSON contract.
7. Gate-by-gate recording order.
8. Independent evaluation.
9. Artifact review and retention.
10. Failure response, retry, rollback, and bounded cleanup.

Include exact commands:

~~~powershell
npm run pilot:gate -- validate --manifest C:\secure-config\pilot-manifest.json
npm run pilot:gate -- init --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence
npm run pilot:gate -- run-synthetic --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --adapter static-validation
npm run pilot:gate -- record --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --evidence C:\sanitized-evidence\deployment-preflight.json
npm run pilot:gate -- evaluate --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --reviewer reviewer@example.test
~~~

Document the exact managed evidence shape:

~~~json
{
  "schemaVersion": 1,
  "checkId": "deployment-preflight",
  "status": "passed",
  "startedAt": "2026-07-16T10:00:00Z",
  "completedAt": "2026-07-16T10:05:00Z",
  "summary": "Managed staging images, migrations, replicas, workers, storage, and clocks passed preflight.",
  "metrics": {
    "apiReplicas": 2,
    "clockSkewSeconds": 0.4,
    "migrationSetSha256": "ac0f8176205045a99e50d679600d4a192b6e57cb29eb4f6d4e92a4212cce90ed",
    "imageDigestsVerified": true,
    "migrationsVerified": true,
    "managedPostgresVerified": true,
    "managedRedisVerified": true,
    "managedObjectStorageVerified": true,
    "workforceOidcValidated": true,
    "postgresAuthoritative": true,
    "applicationSuperuserAbsent": true,
    "migrationOwnerAbsent": true,
    "sharedCredentialsAbsent": true,
    "objectVersioning": true,
    "objectEncryption": true,
    "redisPersistence": true,
    "purposeSpecificIdentities": true,
    "capacityApproved": true,
    "workerTopologyVerified": true,
    "sqliteFallbackDisabled": true,
    "inMemorySharedEventsDisabled": true,
    "writebackExecutorAbsent": true,
    "writebackExecutionFailsClosed": true
  }
}
~~~

Follow the JSON example with a check-metric matrix generated from the contract.
The matrix must list every boolean in BOOLEAN_PROOFS_BY_CHECK and
CONNECTOR_PROOFS_BY_KIND, plus these typed metrics: deployment migration hash,
database/object recovery point and snapshot hash, RPO/RTO, the exact 30-day SLO
window, strict latency/outbox values, unresolved dead letters, connector schema
fingerprints, checkpoint hashes, backfill duration, sustained duration, and
achieved rate. State that a missing, false, malformed, non-finite, or
out-of-threshold value produces a no-go decision.

State explicitly that operators must record checks in gate order, an
unavailable required check is a failed run, a failed run cannot be resumed,
retries need a new pilotRunId and failed predecessor, and synthetic results do
not satisfy any of the sixteen managed checks.

- [ ] **Step 3: Add README discovery without overstating completion**

Under Next production gates, add a completed foundation item:

~~~markdown
- [x] Add a provider-neutral Production Pilot Gate runner, immutable evidence contract, and managed-staging operator runbook
~~~

Keep the live design-partner connector and environment-specific rehearsal
items unchecked. Add a link to docs/operations/production-pilot-gate.md beside
the production-like validation guidance.

- [ ] **Step 4: Make static validation require runbook invariants**

Add:

~~~python
    pilot_runbook = read("docs/operations/production-pilot-gate.md")
    require(
        pilot_runbook,
        [
            "synthetic results do not satisfy",
            "failed predecessor",
            "independent reviewer",
            "pilot:gate -- evaluate",
            "read-only pilot scope",
        ],
        "production pilot gate runbook",
    )
~~~

- [ ] **Step 5: Run documentation-linked validation**

~~~powershell
npm run pilot:gate:validate
npm run infra:validate
git diff --check
~~~

Expected: example validation and infrastructure validation pass, and Git
reports no whitespace errors.

- [ ] **Step 6: Commit the operations documentation**

~~~powershell
git add docs/operations/production-pilot-gate.md README.md infra/ci/validate-production-gates.py
git commit -m "docs: add production pilot gate runbook"
~~~

### Task 9: Verify, split, and publish the stacked pull requests

**Files:**
- Verify only; do not add generated evidence or .omo runtime files.

- [ ] **Step 1: Run the focused Python suite**

~~~powershell
python -m unittest discover -s infra/ci/tests -p "test_pilot_gate_*.py" -v
~~~

Expected: all pilot-gate tests pass.

- [ ] **Step 2: Run every infrastructure validator**

~~~powershell
npm run infra:validate
~~~

Expected: PostgreSQL static validation, infrastructure unit tests, and
production-gate validation pass.

- [ ] **Step 3: Run the complete repository check**

~~~powershell
npm run check
~~~

Expected: lockfile dry run, workspace typechecks, all tests, all builds, and
all infrastructure validation pass.

- [ ] **Step 4: Audit scope and repository cleanliness**

~~~powershell
git diff --check origin/main...HEAD
git status -sb
git log --oneline origin/main..HEAD
~~~

Expected: no whitespace errors, only intentional commits are ahead of main,
and .omo remains untracked and unstaged.

- [ ] **Step 5: Verify the stacked branch boundaries**

~~~powershell
git show-ref --verify refs/heads/docs/production-pilot-gate-design
git show-ref --verify refs/heads/feat/pilot-gate-contract
git show-ref --verify refs/heads/feat/pilot-gate-runner
git show-ref --verify refs/heads/docs/pilot-gate-operations
git merge-base --is-ancestor docs/production-pilot-gate-design feat/pilot-gate-contract
git merge-base --is-ancestor feat/pilot-gate-contract feat/pilot-gate-runner
git merge-base --is-ancestor feat/pilot-gate-runner docs/pilot-gate-operations
git log --oneline docs/production-pilot-gate-design..feat/pilot-gate-contract
git log --oneline feat/pilot-gate-contract..feat/pilot-gate-runner
git log --oneline feat/pilot-gate-runner..docs/pilot-gate-operations
~~~

Expected: each ancestry check exits zero; the three log ranges contain only
Tasks 1-4, Tasks 5-7, and Task 8 respectively.

- [ ] **Step 6: Push and create four stacked pull requests**

Use these bases:

1. docs/production-pilot-gate-design -> main
2. feat/pilot-gate-contract -> docs/production-pilot-gate-design
3. feat/pilot-gate-runner -> feat/pilot-gate-contract
4. docs/pilot-gate-operations -> feat/pilot-gate-runner

Push the preserved branch pointers:

~~~powershell
git push -u origin docs/production-pilot-gate-design
git push -u origin feat/pilot-gate-contract
git push -u origin feat/pilot-gate-runner
git push -u origin docs/pilot-gate-operations
~~~

Create the four PRs with explicit stack metadata and no certification
overstatement:

~~~powershell
gh pr create --base main --head docs/production-pilot-gate-design --title "docs: design production pilot gate" --body "Summary: approve the provider-neutral managed-staging production pilot gate. Changes: add the reviewed design and implementation plan. Testing: git diff --check and documentation invariant scans. Stack parent: main. Certification: this repository-only change has not certified any managed environment."
gh pr create --base docs/production-pilot-gate-design --head feat/pilot-gate-contract --title "feat(infra): define production pilot gate contract" --body "Summary: add the fail-closed production pilot evidence contract and evaluator. Changes: validate manifests, sanitize evidence, persist immutable hashes, and enforce all managed thresholds. Testing: focused pilot-gate contract, safety, evidence, and evaluation suites. Stack parent: docs/production-pilot-gate-design. Certification: this repository-only change has not certified any managed environment."
gh pr create --base feat/pilot-gate-contract --head feat/pilot-gate-runner --title "feat(infra): add production pilot gate runner" --body "Summary: add the allowlisted rehearsal adapters and production pilot CLI. Changes: run fixed synthetic checks, record supporting evidence, validate the checked-in manifest, and integrate repository commands. Testing: complete pilot-gate suite and infrastructure validation. Stack parent: feat/pilot-gate-contract. Certification: this repository-only change has not certified any managed environment."
gh pr create --base feat/pilot-gate-runner --head docs/pilot-gate-operations --title "docs: add production pilot gate operations" --body "Summary: document safe managed-staging execution and review. Changes: add the operator runbook, README discovery, and static runbook invariants. Testing: manifest validation, infrastructure validation, complete repository check, and whitespace audit. Stack parent: feat/pilot-gate-runner. Certification: this repository-only change has not certified any managed environment."
~~~

- [ ] **Step 7: Wait for remote verification**

~~~powershell
gh pr checks docs/production-pilot-gate-design --watch --interval 10
gh pr checks feat/pilot-gate-contract --watch --interval 10
gh pr checks feat/pilot-gate-runner --watch --interval 10
gh pr checks docs/pilot-gate-operations --watch --interval 10
~~~

Expected: CI, Security, dependency review, supply-chain checks, and CodeQL
finish successfully for all four PRs. Do not merge without a separate explicit
merge instruction.

## Completion evidence

The implementation is complete only when:

- all sixteen managed checks are immutable contract entries across five gates;
- unsafe evidence is rejected before persistence and synthetic output is
  redacted in memory;
- evidence files and the final decision are hash-addressed and append-only;
- failed runs are terminal and retries reference a real failed predecessor;
- arbitrary input cannot select a command, executable, script path, timeout, or
  confirmation environment variable;
- threshold evaluation enforces recovery, SLO, connector-rate, reconciliation,
  and independent-review rules;
- the example manifest and runbook pass static validation;
- the complete repository check and all remote PR checks pass; and
- documentation still describes the actual design-partner pilot as pending.
