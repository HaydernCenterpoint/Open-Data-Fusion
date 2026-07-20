from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from infra.ci.tests.test_pilot_gate_contract import valid_manifest
from infra.pilot_gate.contract import CHECKS_BY_GATE, REQUIRED_CHECK_IDS, parse_manifest
from infra.pilot_gate.evaluation import (
    BOOLEAN_PROOFS_BY_CHECK,
    CONNECTOR_PROOFS_BY_KIND,
    evaluate,
    sign_reviewer_attestation,
)
from infra.pilot_gate.evidence import (
    CheckEvidence,
    EvidenceError,
    EvidenceStore,
    canonical_json,
)


REVIEWER_KEY = b"reviewer-controlled-test-key-32bytes-minimum"


def passed(check_id: str, metrics: dict[str, object] | None = None) -> CheckEvidence:
    return CheckEvidence(
        pilot_run_id="pilot-managed-20260716-001",
        environment_id="managed-staging",
        check_id=check_id,
        status="passed",
        started_at="2026-07-16T10:00:00Z",
        completed_at="2026-07-16T10:01:00Z",
        summary=f"{check_id} passed",
        metrics=metrics or {},
    )


def passing_checks() -> dict[str, CheckEvidence]:
    manifest = parse_manifest(valid_manifest())
    checks = {check_id: passed(check_id) for check_id in REQUIRED_CHECK_IDS}
    for check_id, proof_names in BOOLEAN_PROOFS_BY_CHECK.items():
        checks[check_id] = passed(
            check_id, {proof_name: True for proof_name in proof_names}
        )
    checks["deployment-preflight"].metrics.update(
        {
            "apiReplicas": 2,
            "clockSkewSeconds": 0.4,
            "migrationSetSha256": manifest.migration_set_sha256,
            "observedApplicationCommit": manifest.application_commit,
            "observedImageDigests": dict(manifest.image_digests),
        }
    )
    checks["database-object-restore"] = passed(
        "database-object-restore",
        {
            **{
                proof: True
                for proof in BOOLEAN_PROOFS_BY_CHECK["database-object-restore"]
            },
            "rpoMinutes": 10,
            "rtoMinutes": 180,
            "recoveryPointId": "recovery-20260716-001",
            "objectSnapshotSha256": "f" * 64,
        },
    )
    checks["service-objectives"] = passed(
        "service-objectives",
        {
            **{
                proof: True
                for proof in BOOLEAN_PROOFS_BY_CHECK["service-objectives"]
            },
            "availabilityPercent": 99.95,
            "latencyP95Seconds": 0.8,
            "outboxFreshnessSeconds": 120,
            "observationDays": 30,
            "unresolvedDeadLetters": 0,
            "windowStartedAt": "2026-06-16T00:00:00Z",
            "windowCompletedAt": "2026-07-16T00:00:00Z",
        },
    )
    common = {
        proof: True
        for proof in set().union(*CONNECTOR_PROOFS_BY_KIND.values())
    }
    connector_values = {
        "csv": {
            "achievedRate": 180.0,
            "backfillMinutes": 100.0,
            "observedSchemaFingerprintSha256": "c" * 64,
            "checkpointBeforeSha256": "1" * 64,
            "checkpointAfterSha256": "2" * 64,
        },
        "postgres": {
            "achievedRate": 100.0,
            "backfillMinutes": 150.0,
            "sustainedMinutes": 60.0,
            "observedSchemaFingerprintSha256": "d" * 64,
            "checkpointBeforeSha256": "3" * 64,
            "checkpointAfterSha256": "4" * 64,
        },
        "opcua": {
            "achievedRate": 400.0,
            "backfillMinutes": 55.0,
            "sustainedMinutes": 60.0,
            "observedSchemaFingerprintSha256": "e" * 64,
            "checkpointBeforeSha256": "5" * 64,
            "checkpointAfterSha256": "6" * 64,
        },
    }
    for kind, values in connector_values.items():
        proofs = {proof: common[proof] for proof in CONNECTOR_PROOFS_BY_KIND[kind]}
        checks[f"connector-{kind}"] = passed(
            f"connector-{kind}", proofs | values
        )
    return checks


def record_all(store: EvidenceStore, checks: dict[str, CheckEvidence]) -> None:
    for gate in range(5):
        for check_id in CHECKS_BY_GATE[gate]:
            store.record_check(checks[check_id])


class PilotEvaluationTests(unittest.TestCase):
    def test_accepts_complete_evidence(self) -> None:
        self.assertEqual(evaluate(parse_manifest(valid_manifest()), passing_checks()), [])

    def test_binds_preflight_to_observed_commit_and_image_digests(self) -> None:
        manifest = parse_manifest(valid_manifest())
        checks = passing_checks()
        checks["deployment-preflight"].metrics["observedApplicationCommit"] = "2" * 40
        digests = dict(manifest.image_digests)
        digests["api"] = "sha256:" + "b" * 64
        checks["deployment-preflight"].metrics["observedImageDigests"] = digests

        violations = evaluate(manifest, checks)

        self.assertIn(
            "deployment-preflight observedApplicationCommit does not match the approved manifest",
            violations,
        )
        self.assertIn(
            "deployment-preflight observedImageDigests does not match the approved manifest",
            violations,
        )

    def test_rejects_missing_proofs_weak_slo_and_unsafe_connector_rate(self) -> None:
        manifest = parse_manifest(valid_manifest())
        checks = passing_checks()
        checks["tenant-isolation"].metrics["rlsForced"] = False
        checks["service-objectives"].metrics["availabilityPercent"] = 99.8
        checks["connector-csv"].metrics["achievedRate"] = 179.0

        violations = evaluate(manifest, checks)

        self.assertIn("tenant-isolation rlsForced is not true", violations)
        self.assertIn(
            "service-objectives availabilityPercent is below target", violations
        )
        self.assertIn("connector-csv achievedRate is below target", violations)

    def test_every_boolean_proof_is_enforced(self) -> None:
        manifest = parse_manifest(valid_manifest())
        for check_id, proofs in BOOLEAN_PROOFS_BY_CHECK.items():
            for proof in proofs:
                with self.subTest(check_id=check_id, proof=proof):
                    checks = passing_checks()
                    checks[check_id].metrics[proof] = False
                    self.assertIn(
                        f"{check_id} {proof} is not true",
                        evaluate(manifest, checks),
                    )
        for kind, proofs in CONNECTOR_PROOFS_BY_KIND.items():
            check_id = f"connector-{kind}"
            for proof in proofs:
                with self.subTest(check_id=check_id, proof=proof):
                    checks = passing_checks()
                    checks[check_id].metrics[proof] = False
                    self.assertIn(
                        f"{check_id} {proof} is not true",
                        evaluate(manifest, checks),
                    )

    def test_finalization_uses_signed_attestation_and_internal_evaluation(self) -> None:
        manifest = parse_manifest(valid_manifest())
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            checks = passing_checks()
            checks["service-objectives"].metrics["availabilityPercent"] = 99.8
            record_all(store, checks)
            attestation = sign_reviewer_attestation(
                manifest,
                store.read_run(),
                "reviewer@example.test",
                REVIEWER_KEY,
                reviewed_at="2026-07-16T12:00:00Z",
            )

            decision = store.finalize(attestation, REVIEWER_KEY)

            self.assertEqual(decision["outcome"], "failed")
            self.assertIn(
                "service-objectives availabilityPercent is below target",
                decision["violations"],
            )
            self.assertRegex(decision["reviewerAttestationSha256"], r"^[0-9a-f]{64}$")
            with self.assertRaisesRegex(EvidenceError, "append-only"):
                store.finalize(attestation, REVIEWER_KEY)

    def test_complete_run_can_pass_with_independent_valid_attestation(self) -> None:
        manifest = parse_manifest(valid_manifest())
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            record_all(store, passing_checks())
            attestation = sign_reviewer_attestation(
                manifest,
                store.read_run(),
                "reviewer@example.test",
                REVIEWER_KEY,
                reviewed_at="2026-07-16T12:00:00Z",
            )

            decision = store.finalize(attestation, REVIEWER_KEY)

            self.assertEqual(decision["outcome"], "passed")
            self.assertEqual(store.read_run()["state"], "passed")
            self.assertRegex(decision["managedCheckIndexSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(
                decision["supportingEvidenceIndexSha256"], r"^[0-9a-f]{64}$"
            )

    def test_rejects_self_review_bad_signature_and_short_keys(self) -> None:
        manifest = parse_manifest(valid_manifest())
        run = {
            "manifestSha256": "a" * 64,
            "pilotRunId": manifest.pilot_run_id,
            "environmentId": manifest.environment_id,
            "checks": {},
            "supportingEvidence": {},
        }
        with self.assertRaisesRegex(EvidenceError, "reviewer must differ"):
            sign_reviewer_attestation(
                manifest, run, manifest.operator_id, REVIEWER_KEY
            )
        with self.assertRaisesRegex(EvidenceError, "at least 32 bytes"):
            sign_reviewer_attestation(
                manifest, run, "reviewer@example.test", b"short"
            )

        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            attestation = sign_reviewer_attestation(
                manifest, store.read_run(), "reviewer@example.test", REVIEWER_KEY
            )
            attestation["signatureHmacSha256"] = "0" * 64
            with self.assertRaisesRegex(EvidenceError, "signature"):
                store.finalize(attestation, REVIEWER_KEY)
            self.assertFalse((store.run_directory / "decision.json").exists())

    def test_read_repairs_run_index_after_decision_write_crash(self) -> None:
        manifest = parse_manifest(valid_manifest())
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            record_all(store, passing_checks())
            attestation = sign_reviewer_attestation(
                manifest,
                store.read_run(),
                "reviewer@example.test",
                REVIEWER_KEY,
                reviewed_at="2026-07-16T12:00:00Z",
            )

            with patch.object(store, "_write_run", side_effect=OSError("crash")):
                with self.assertRaisesRegex(OSError, "crash"):
                    store.finalize(attestation, REVIEWER_KEY)

            repaired = store.read_run()
            self.assertEqual(repaired["state"], "passed")
            self.assertEqual(repaired["decision"]["path"], "decision.json")
            self.assertRegex(repaired["decision"]["sha256"], r"^[0-9a-f]{64}$")

    def test_terminal_run_read_rejects_tampered_managed_evidence(self) -> None:
        manifest = parse_manifest(valid_manifest())
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            record_all(store, passing_checks())
            run = store.read_run()
            entry = run["checks"]["deployment-preflight"]
            attestation = sign_reviewer_attestation(
                manifest,
                run,
                "reviewer@example.test",
                REVIEWER_KEY,
                reviewed_at="2026-07-16T12:00:00Z",
            )
            store.finalize(attestation, REVIEWER_KEY)
            (store.run_directory / entry["path"]).write_text(
                "{}\n", encoding="utf-8"
            )

            with self.assertRaisesRegex(EvidenceError, "hash mismatch"):
                store.read_run()

    def test_crash_repair_recomputes_decision_violations(self) -> None:
        manifest = parse_manifest(valid_manifest())
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(Path(temporary_directory), manifest)
            store.initialize()
            checks = passing_checks()
            checks["service-objectives"].metrics["availabilityPercent"] = 99.8
            record_all(store, checks)
            attestation = sign_reviewer_attestation(
                manifest,
                store.read_run(),
                "reviewer@example.test",
                REVIEWER_KEY,
                reviewed_at="2026-07-16T12:00:00Z",
            )
            with patch.object(store, "_write_run", side_effect=OSError("crash")):
                with self.assertRaisesRegex(OSError, "crash"):
                    store.finalize(attestation, REVIEWER_KEY)
            decision = json.loads(store.decision_path.read_text(encoding="utf-8"))
            decision["outcome"] = "passed"
            decision["violations"] = []
            store.decision_path.write_bytes(canonical_json(decision))

            with self.assertRaisesRegex(EvidenceError, "violations do not match"):
                store.read_run()


if __name__ == "__main__":
    unittest.main()
