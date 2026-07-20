from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest

from infra.ci.tests.test_pilot_gate_contract import valid_manifest
from infra.pilot_gate.contract import parse_manifest
from infra.pilot_gate.evidence import (
    EvidenceError,
    EvidenceStore,
    parse_check_evidence,
)


def evidence(
    check_id: str,
    status: str = "passed",
    *,
    run_id: str = "pilot-managed-20260716-001",
    environment_id: str = "managed-staging",
) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "pilotRunId": run_id,
        "environmentId": environment_id,
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
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()

            with self.assertRaisesRegex(EvidenceError, "prior gate"):
                store.record_check(parse_check_evidence(evidence("ingress-security")))

            store.record_check(parse_check_evidence(evidence("deployment-preflight")))
            with self.assertRaisesRegex(EvidenceError, "append-only"):
                store.record_check(
                    parse_check_evidence(evidence("deployment-preflight"))
                )
            store.record_check(parse_check_evidence(evidence("tenant-isolation")))
            self.assertEqual(store.read_run()["state"], "preflight_passed")

            store.record_check(parse_check_evidence(evidence("ingress-security")))
            run = store.read_run()
            self.assertEqual(run["state"], "executing")
            entry = run["checks"]["ingress-security"]
            self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue((store.run_directory / entry["path"]).is_file())

    def test_check_evidence_is_bound_to_the_run_and_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()

            for field, value in (
                ("run_id", "pilot-managed-20260716-999"),
                ("environment_id", "other-managed-staging"),
            ):
                with self.subTest(field=field), self.assertRaisesRegex(
                    EvidenceError, "does not match"
                ):
                    store.record_check(
                        parse_check_evidence(
                            evidence("deployment-preflight", **{field: value})
                        )
                    )

    def test_schema_version_requires_the_integer_one(self) -> None:
        for value in (True, 1.0, "1"):
            with self.subTest(value=value), self.assertRaisesRegex(
                EvidenceError, "schemaVersion"
            ):
                raw = evidence("deployment-preflight")
                raw["schemaVersion"] = value
                parse_check_evidence(raw)

    def test_failed_state_is_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()
            store.record_check(
                parse_check_evidence(evidence("deployment-preflight", "failed"))
            )

            self.assertEqual(store.read_run()["state"], "failed")
            with self.assertRaisesRegex(EvidenceError, "terminal"):
                store.record_check(parse_check_evidence(evidence("tenant-isolation")))

    def test_retry_requires_a_failed_predecessor_in_the_same_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            retry_raw = valid_manifest()
            retry_raw["pilotRunId"] = "pilot-managed-20260716-002"
            retry_raw["predecessorPilotRunId"] = "pilot-managed-20260716-001"

            with self.assertRaisesRegex(EvidenceError, "failed predecessor"):
                EvidenceStore(root, parse_manifest(retry_raw)).initialize()

            predecessor = EvidenceStore(root, parse_manifest(valid_manifest()))
            predecessor.initialize()
            predecessor.record_check(
                parse_check_evidence(evidence("deployment-preflight", "failed"))
            )
            retry = EvidenceStore(root, parse_manifest(retry_raw))
            retry.initialize()
            self.assertEqual(
                retry.read_run()["predecessorPilotRunId"],
                "pilot-managed-20260716-001",
            )

    def test_rejects_manifest_changes_after_initialization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            EvidenceStore(root, parse_manifest(valid_manifest())).initialize()
            changed_raw = valid_manifest()
            connectors = changed_raw["connectors"]
            assert isinstance(connectors, list)
            postgres = connectors[1]
            assert isinstance(postgres, dict)
            postgres["measuredPeakRate"] = 1.0

            with self.assertRaisesRegex(EvidenceError, "manifest does not match"):
                EvidenceStore(root, parse_manifest(changed_raw)).read_run()

    def test_concurrent_gate_zero_records_do_not_lose_an_index_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()
            checks = tuple(
                parse_check_evidence(evidence(check_id))
                for check_id in ("deployment-preflight", "tenant-isolation")
            )

            with ThreadPoolExecutor(max_workers=2) as executor:
                list(executor.map(store.record_check, checks))

            run = store.read_run()
            self.assertEqual(set(run["checks"]), {c.check_id for c in checks})
            self.assertEqual(run["state"], "preflight_passed")

    def test_tampered_check_content_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            store = EvidenceStore(
                Path(temporary_directory), parse_manifest(valid_manifest())
            )
            store.initialize()
            store.record_check(parse_check_evidence(evidence("deployment-preflight")))
            entry = store.read_run()["checks"]["deployment-preflight"]
            path = store.run_directory / entry["path"]
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["summary"] = "tampered"
            path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(EvidenceError, "hash mismatch"):
                store.load_checks()


if __name__ == "__main__":
    unittest.main()
