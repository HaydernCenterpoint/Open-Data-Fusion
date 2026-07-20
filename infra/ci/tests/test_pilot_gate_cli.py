from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from infra.ci.tests.test_pilot_gate_contract import valid_manifest
from infra.ci.tests.test_pilot_gate_evaluation import passing_checks
from infra.pilot_gate.cli import main
from infra.pilot_gate.contract import CHECKS_BY_GATE


REVIEWER_KEY = "reviewer-controlled-test-key-32bytes-minimum"


def write_manifest(root: Path) -> Path:
    path = root / "manifest.json"
    path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
    return path


def write_check(root: Path, check_id: str) -> Path:
    item = passing_checks()[check_id]
    path = root / f"{check_id}.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "pilotRunId": item.pilot_run_id,
                "environmentId": item.environment_id,
                "checkId": item.check_id,
                "status": item.status,
                "startedAt": item.started_at,
                "completedAt": item.completed_at,
                "summary": item.summary,
                "metrics": item.metrics,
            }
        ),
        encoding="utf-8",
    )
    return path


class PilotGateCliTests(unittest.TestCase):
    def test_validate_and_init_emit_json_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = write_manifest(root)
            output = io.StringIO()

            with redirect_stdout(output):
                self.assertEqual(
                    main(["validate", "--manifest", str(manifest_path)]), 0
                )
                self.assertEqual(
                    main(
                        [
                            "init",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(root / "evidence"),
                        ]
                    ),
                    0,
                )

            self.assertIn('"status": "valid"', output.getvalue())
            self.assertTrue(
                (
                    root
                    / "evidence"
                    / "pilot-managed-20260716-001"
                    / "run.json"
                ).is_file()
            )

    def test_record_rejects_out_of_order_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = write_manifest(root)
            evidence_path = write_check(root, "ingress-security")
            output_root = root / "out"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(
                    main(
                        [
                            "init",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                        ]
                    ),
                    0,
                )
            errors = io.StringIO()

            with redirect_stderr(errors):
                code = main(
                    [
                        "record",
                        "--manifest",
                        str(manifest_path),
                        "--output-root",
                        str(output_root),
                        "--evidence",
                        str(evidence_path),
                    ]
                )

            self.assertEqual(code, 2)
            self.assertIn("prior gate", errors.getvalue())

    @patch("infra.pilot_gate.cli.run_adapter")
    def test_run_synthetic_records_supporting_evidence_only(
        self, adapter: Mock
    ) -> None:
        adapter.return_value = {
            "schemaVersion": 1,
            "checkId": "synthetic-static-validation",
            "status": "passed",
            "startedAt": "2026-07-16T10:00:00Z",
            "completedAt": "2026-07-16T10:01:00Z",
            "summary": "static-validation completed successfully",
            "metrics": {
                "returnCode": 0,
                "durationMilliseconds": 60_000,
                "redactionCount": 0,
                "timedOut": False,
            },
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = write_manifest(root)
            output_root = root / "out"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(
                    main(
                        [
                            "init",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                        ]
                    ),
                    0,
                )
                self.assertEqual(
                    main(
                        [
                            "run-synthetic",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                            "--adapter",
                            "static-validation",
                        ]
                    ),
                    0,
                )

            run = json.loads(
                (
                    output_root / "pilot-managed-20260716-001" / "run.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(run["state"], "created")
            self.assertIn(
                "synthetic-static-validation", run["supportingEvidence"]
            )

    def test_records_all_gates_and_emits_one_signed_passing_decision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = write_manifest(root)
            output_root = root / "out"
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(
                    main(
                        [
                            "init",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                        ]
                    ),
                    0,
                )
                for gate in range(5):
                    for check_id in CHECKS_BY_GATE[gate]:
                        self.assertEqual(
                            main(
                                [
                                    "record",
                                    "--manifest",
                                    str(manifest_path),
                                    "--output-root",
                                    str(output_root),
                                    "--evidence",
                                    str(write_check(root, check_id)),
                                ]
                            ),
                            0,
                        )

            attestation_path = root / "review" / "attestation.json"
            with patch.dict(
                os.environ,
                {"ODF_PILOT_REVIEWER_HMAC_KEY": REVIEWER_KEY},
                clear=False,
            ), redirect_stdout(output):
                self.assertEqual(
                    main(
                        [
                            "attest",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                            "--reviewer",
                            "reviewer@example.test",
                            "--attestation-out",
                            str(attestation_path),
                        ]
                    ),
                    0,
                )
                self.assertEqual(
                    main(
                        [
                            "evaluate",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                            "--attestation",
                            str(attestation_path),
                        ]
                    ),
                    0,
                )

            decision_path = (
                output_root
                / "pilot-managed-20260716-001"
                / "decision.json"
            )
            decision = json.loads(decision_path.read_text(encoding="utf-8"))
            self.assertEqual(decision["outcome"], "passed")
            persisted = "\n".join(
                path.read_text(encoding="utf-8")
                for path in (
                    attestation_path,
                    decision_path,
                    output_root
                    / "pilot-managed-20260716-001"
                    / "run.json",
                )
            )
            self.assertNotIn(REVIEWER_KEY, persisted)
            errors = io.StringIO()
            with patch.dict(
                os.environ,
                {"ODF_PILOT_REVIEWER_HMAC_KEY": REVIEWER_KEY},
                clear=False,
            ), redirect_stderr(errors):
                self.assertEqual(
                    main(
                        [
                            "evaluate",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                            "--attestation",
                            str(attestation_path),
                        ]
                    ),
                    2,
                )
            self.assertIn("append-only", errors.getvalue())

    def test_attest_fails_closed_without_reviewer_key(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            manifest_path = write_manifest(root)
            output_root = root / "out"
            with redirect_stdout(io.StringIO()):
                self.assertEqual(
                    main(
                        [
                            "init",
                            "--manifest",
                            str(manifest_path),
                            "--output-root",
                            str(output_root),
                        ]
                    ),
                    0,
                )
            errors = io.StringIO()
            with patch.dict(os.environ, {}, clear=True), redirect_stderr(errors):
                code = main(
                    [
                        "attest",
                        "--manifest",
                        str(manifest_path),
                        "--output-root",
                        str(output_root),
                        "--reviewer",
                        "reviewer@example.test",
                        "--attestation-out",
                        str(root / "attestation.json"),
                    ]
                )

            self.assertEqual(code, 2)
            self.assertIn("ODF_PILOT_REVIEWER_HMAC_KEY", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
