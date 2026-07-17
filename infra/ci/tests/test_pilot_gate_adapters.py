from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from infra.ci.tests.test_pilot_gate_contract import valid_manifest
from infra.pilot_gate.adapters import AdapterError, run_adapter
from infra.pilot_gate.contract import parse_manifest
from infra.pilot_gate.evidence import EvidenceError, EvidenceStore


class PilotAdapterTests(unittest.TestCase):
    def test_rejects_unknown_adapter(self) -> None:
        with self.assertRaisesRegex(AdapterError, "unknown synthetic adapter"):
            run_adapter("operator-command", Path.cwd(), None)

    @patch("infra.pilot_gate.adapters.subprocess.run")
    @patch("infra.pilot_gate.adapters.time.monotonic", side_effect=(10.0, 10.25))
    def test_runs_a_fixed_command_without_a_shell(
        self, monotonic: Mock, run: Mock
    ) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="validated", stderr=""
        )

        result = run_adapter("static-validation", Path.cwd(), None)

        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["summary"], "static-validation completed successfully")
        self.assertEqual(result["metrics"]["durationMilliseconds"], 250)
        self.assertIs(run.call_args.kwargs["shell"], False)
        self.assertEqual(
            run.call_args.args[0][-1], "infra/ci/validate-production-gates.py"
        )
        self.assertNotIn("validated", json.dumps(result))
        monotonic.assert_called()

    @patch("infra.pilot_gate.adapters.subprocess.run")
    def test_requires_confirmation_and_discards_captured_secret_output(
        self, run: Mock
    ) -> None:
        with self.assertRaisesRegex(AdapterError, "confirmation"):
            run_adapter("broker-recovery", Path.cwd(), None)

        run.return_value = subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout="Authorization: Bearer abc.def.ghi",
            stderr="broker unavailable",
        )
        result = run_adapter(
            "broker-recovery", Path.cwd(), "local-production-like"
        )

        serialized = json.dumps(result)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["metrics"]["redactionCount"], 1)
        self.assertNotIn("abc.def.ghi", serialized)
        self.assertNotIn("broker unavailable", serialized)
        self.assertEqual(
            run.call_args.kwargs["env"]["ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM"],
            "local-production-like",
        )

    @patch("infra.pilot_gate.adapters.subprocess.run")
    def test_timeout_discards_partial_output(self, run: Mock) -> None:
        run.side_effect = subprocess.TimeoutExpired(
            cmd=["fixed"],
            timeout=120,
            output="access_token=do-not-store",
            stderr="partial adapter details",
        )

        result = run_adapter("static-validation", Path.cwd(), None)

        serialized = json.dumps(result)
        self.assertEqual(result["status"], "failed")
        self.assertIs(result["metrics"]["timedOut"], True)
        self.assertNotIn("do-not-store", serialized)
        self.assertNotIn("partial adapter details", serialized)

    @patch("infra.pilot_gate.adapters.subprocess.run")
    def test_supporting_evidence_is_hashed_without_advancing_the_gate(
        self, run: Mock
    ) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="validated", stderr=""
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()
            result = run_adapter("static-validation", Path.cwd(), None)

            store.record_supporting_evidence(result)

            state = store.read_run()
            self.assertEqual(state["state"], "created")
            entry = state["supportingEvidence"]["synthetic-static-validation"]
            self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue((store.run_directory / entry["path"]).is_file())
            self.assertEqual(
                store.load_supporting_evidence()["synthetic-static-validation"],
                result,
            )
            with self.assertRaisesRegex(EvidenceError, "append-only"):
                store.record_supporting_evidence(result)

    @patch("infra.pilot_gate.adapters.subprocess.run")
    def test_tampered_supporting_evidence_is_rejected(self, run: Mock) -> None:
        run.return_value = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="validated", stderr=""
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()
            store.record_supporting_evidence(
                run_adapter("static-validation", Path.cwd(), None)
            )
            entry = store.read_run()["supportingEvidence"][
                "synthetic-static-validation"
            ]
            (store.run_directory / entry["path"]).write_text(
                "{}\n", encoding="utf-8"
            )

            with self.assertRaisesRegex(EvidenceError, "hash mismatch"):
                store.load_supporting_evidence()

    def test_rejects_raw_process_output_fields(self) -> None:
        raw = {
            "schemaVersion": 1,
            "checkId": "synthetic-static-validation",
            "status": "passed",
            "startedAt": "2026-07-16T10:00:00Z",
            "completedAt": "2026-07-16T10:00:01Z",
            "summary": "static-validation completed successfully",
            "metrics": {
                "returnCode": 0,
                "durationMilliseconds": 1000,
                "redactionCount": 0,
                "timedOut": False,
                "stdout": "must not persist",
            },
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()

            with self.assertRaisesRegex(EvidenceError, "forbidden evidence"):
                store.record_supporting_evidence(raw)


if __name__ == "__main__":
    unittest.main()
