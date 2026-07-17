from __future__ import annotations

import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from infra.pilot_gate.contract import (
    CHECKS_BY_GATE,
    REQUIRED_IMAGES,
    ContractError,
    load_manifest,
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
            "migrationSetSha256": (
                "ac0f8176205045a99e50d679600d4a192b6e57cb29eb4f6d4e92a4212cce90ed"
            ),
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
        self.assertEqual(
            manifest.connectors[0].approved_backfill_window_minutes,
            120.0,
        )
        self.assertEqual(
            [connector.kind for connector in manifest.connectors],
            ["csv", "postgres", "opcua"],
        )

    def test_image_digests_are_an_immutable_sorted_pair_sequence(self) -> None:
        manifest = parse_manifest(valid_manifest())
        digest = "sha256:" + ("a" * 64)
        expected = tuple((name, digest) for name in sorted(REQUIRED_IMAGES))

        self.assertIsInstance(manifest.image_digests, tuple)
        self.assertFalse(hasattr(manifest.image_digests, "__setitem__"))
        self.assertEqual(manifest.image_digests, expected)
        self.assertEqual(dict(manifest.image_digests), dict(expected))

    def test_schema_version_requires_the_integer_one(self) -> None:
        for schema_version in (True, 1.0):
            with self.subTest(schema_version=schema_version):
                raw = valid_manifest()
                raw["schemaVersion"] = schema_version

                with self.assertRaisesRegex(ContractError, "schemaVersion must be 1"):
                    parse_manifest(raw)

    def test_rejects_a_weaker_target(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["targets"], dict)
        raw["targets"]["availabilityPercent"] = 99.0

        with self.assertRaisesRegex(ContractError, "availabilityPercent"):
            parse_manifest(raw)

    def test_rejects_weaker_policy_thresholds(self) -> None:
        cases = (
            ("rpoMinutes", 16, "rpoMinutes"),
            ("rtoMinutes", 241, "rtoMinutes"),
            ("latencyP95Seconds", 1.1, "latencyP95Seconds"),
            ("outboxFreshnessSeconds", 301, "outboxFreshnessSeconds"),
            ("observationDays", 29, "observationDays"),
            ("loadMultiplier", 1.9, "loadMultiplier"),
            ("evidenceRetentionDays", 89, "evidenceRetentionDays"),
        )
        for field, value, message in cases:
            with self.subTest(field=field):
                raw = valid_manifest()
                assert isinstance(raw["targets"], dict)
                raw["targets"][field] = value
                with self.assertRaisesRegex(ContractError, message):
                    parse_manifest(raw)

    def test_requires_one_connector_of_each_approved_kind(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["connectors"], list)
        raw["connectors"].pop()

        with self.assertRaisesRegex(ContractError, "csv, opcua, and postgres"):
            parse_manifest(raw)

    def test_connector_kind_must_be_text(self) -> None:
        for kind in ([], {}):
            with self.subTest(kind=kind):
                raw = valid_manifest()
                assert isinstance(raw["connectors"], list)
                assert isinstance(raw["connectors"][0], dict)
                raw["connectors"][0]["kind"] = kind

                with self.assertRaisesRegex(ContractError, "kind is invalid"):
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

    def test_numeric_overflow_is_rejected_as_contract_error(self) -> None:
        for value in (10**400, float("inf")):
            with self.subTest(value=value):
                raw = valid_manifest()
                assert isinstance(raw["targets"], dict)
                raw["targets"]["rpoMinutes"] = value

                with self.assertRaisesRegex(ContractError, "finite"):
                    parse_manifest(raw)

    def test_rejects_unknown_manifest_fields(self) -> None:
        raw = valid_manifest()
        raw["password"] = "must-never-enter-the-contract"

        with self.assertRaisesRegex(ContractError, "unexpected fields"):
            parse_manifest(raw)

    def test_load_manifest_rejects_duplicate_json_object_keys(self) -> None:
        payload = json.dumps(valid_manifest()).replace(
            '{"schemaVersion": 1,',
            '{"schemaVersion": 2, "schemaVersion": 1,',
            1,
        )

        with TemporaryDirectory() as directory:
            path = Path(directory) / "pilot.json"
            path.write_text(payload, encoding="utf-8")

            with self.assertRaisesRegex(ContractError, "duplicate.*schemaVersion"):
                load_manifest(path)

    def test_scope_is_read_only_and_separates_synthetic_project(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["scope"], dict)
        raw["scope"]["readOnly"] = False
        with self.assertRaisesRegex(ContractError, "scope.readOnly"):
            parse_manifest(raw)

        raw = valid_manifest()
        assert isinstance(raw["scope"], dict)
        raw["scope"]["writebackAuthorized"] = True
        with self.assertRaisesRegex(ContractError, "scope.writebackAuthorized"):
            parse_manifest(raw)

        raw = valid_manifest()
        assert isinstance(raw["scope"], dict)
        raw["scope"]["syntheticProjectExternalId"] = "design-partner-pilot"
        with self.assertRaisesRegex(ContractError, "projects must differ"):
            parse_manifest(raw)

    def test_connector_rate_fields_match_the_approved_kind(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["connectors"], list)
        assert isinstance(raw["connectors"][0], dict)
        raw["connectors"][0]["measuredPeakRate"] = 1.0
        with self.assertRaisesRegex(ContractError, "unexpected fields"):
            parse_manifest(raw)

        raw = valid_manifest()
        assert isinstance(raw["connectors"], list)
        assert isinstance(raw["connectors"][1], dict)
        raw["connectors"][1]["requiredAverageRate"] = 1.0
        with self.assertRaisesRegex(ContractError, "unexpected fields"):
            parse_manifest(raw)

    def test_rejects_nested_contract_drift_and_non_managed_environment(self) -> None:
        locations = ("scope", "environment", "targets")
        for location in locations:
            with self.subTest(location=location):
                raw = valid_manifest()
                nested = raw[location]
                assert isinstance(nested, dict)
                nested["unexpected"] = True
                with self.assertRaisesRegex(ContractError, "unexpected fields"):
                    parse_manifest(raw)

        raw = valid_manifest()
        assert isinstance(raw["connectors"], list)
        assert isinstance(raw["connectors"][0], dict)
        raw["connectors"][0]["unexpected"] = True
        with self.assertRaisesRegex(ContractError, "unexpected fields"):
            parse_manifest(raw)

        raw = valid_manifest()
        assert isinstance(raw["environment"], dict)
        raw["environment"]["kind"] = "local-compose"
        with self.assertRaisesRegex(ContractError, "managed-staging"):
            parse_manifest(raw)

    def test_requires_the_exact_image_digest_set(self) -> None:
        digest = "sha256:" + ("a" * 64)
        self.assertEqual(
            REQUIRED_IMAGES,
            frozenset(
                {"api", "web", "outbox-worker", "pipeline-worker", "edge-agent"}
            ),
        )
        for case in ("missing", "extra"):
            with self.subTest(case=case):
                raw = valid_manifest()
                assert isinstance(raw["environment"], dict)
                image_digests = raw["environment"]["imageDigests"]
                assert isinstance(image_digests, dict)
                if case == "missing":
                    image_digests.pop("web")
                else:
                    image_digests["unexpected"] = digest

                with self.assertRaisesRegex(ContractError, "exactly the required images"):
                    parse_manifest(raw)

    def test_migration_versions_must_be_unique(self) -> None:
        raw = valid_manifest()
        assert isinstance(raw["environment"], dict)
        migrations = [
            {"version": "202607160001", "sha256": "7" * 64},
            {"version": "202607160001", "sha256": "8" * 64},
        ]
        raw["environment"]["migrations"] = migrations
        raw["environment"]["migrationSetSha256"] = hashlib.sha256(
            (
                json.dumps(migrations, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode("utf-8")
        ).hexdigest()

        with self.assertRaisesRegex(ContractError, "migration versions must be unique"):
            parse_manifest(raw)

    def test_catalog_has_all_five_gates_and_unique_check_ids(self) -> None:
        self.assertEqual(
            CHECKS_BY_GATE,
            {
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
            },
        )
        flattened = [
            check_id
            for check_ids in CHECKS_BY_GATE.values()
            for check_id in check_ids
        ]
        self.assertEqual(len(flattened), 16)
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertIn("service-objectives", flattened)
        self.assertIn("connector-opcua", flattened)


if __name__ == "__main__":
    unittest.main()
