from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Iterator

from . import SCHEMA_VERSION
from .contract import (
    CHECK_GATE,
    CHECKS_BY_GATE,
    IDENTIFIER_PATTERN,
    PilotManifest,
    RUN_ID_PATTERN,
    SHA256_PATTERN,
)
from .safety import UnsafeEvidenceError, assert_safe_json


class EvidenceError(ValueError):
    """Raised when pilot evidence is invalid or mutates append-only state."""


@dataclass(frozen=True)
class CheckEvidence:
    pilot_run_id: str
    environment_id: str
    check_id: str
    status: str
    started_at: str
    completed_at: str
    summary: str
    metrics: dict[str, object]


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


def manifest_sha256(manifest: PilotManifest) -> str:
    return sha256_hex(canonical_json(asdict(manifest)))


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise EvidenceError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _load_json(path: Path) -> object:
    try:
        return json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise EvidenceError(f"could not read evidence file {path.name}: {error}") from error


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
        "pilotRunId",
        "environmentId",
        "checkId",
        "status",
        "startedAt",
        "completedAt",
        "summary",
        "metrics",
    }
    if set(raw_value) != expected_fields:
        raise EvidenceError("check evidence fields do not match the contract")
    if type(raw_value.get("schemaVersion")) is not int or raw_value.get(
        "schemaVersion"
    ) != SCHEMA_VERSION:
        raise EvidenceError(f"schemaVersion must be the integer {SCHEMA_VERSION}")
    pilot_run_id = raw_value.get("pilotRunId")
    if not isinstance(pilot_run_id, str) or not RUN_ID_PATTERN.fullmatch(
        pilot_run_id
    ):
        raise EvidenceError("pilotRunId is invalid")
    environment_id = raw_value.get("environmentId")
    if not isinstance(environment_id, str) or not IDENTIFIER_PATTERN.fullmatch(
        environment_id
    ):
        raise EvidenceError("environmentId is invalid")
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
    metrics_copy = json.loads(canonical_json(metrics))
    assert isinstance(metrics_copy, dict)
    return CheckEvidence(
        pilot_run_id=pilot_run_id,
        environment_id=environment_id,
        check_id=check_id,
        status=status,
        started_at=started_at,
        completed_at=completed_at,
        summary=summary.strip(),
        metrics=metrics_copy,
    )


def _atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
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


def _write_content_addressed(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        if path.read_bytes() != value:
            raise EvidenceError(f"immutable evidence already exists: {path.name}")
    if os.name != "nt":
        path.chmod(0o600)


def _write_exclusive(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as error:
        raise EvidenceError(f"append-only file already exists: {path.name}") from error
    if os.name != "nt":
        path.chmod(0o600)


@contextmanager
def _run_lock(run_directory: Path) -> Iterator[None]:
    lock_path = run_directory / ".lock"
    with lock_path.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class EvidenceStore:
    def __init__(self, output_root: Path, manifest: PilotManifest):
        self.output_root = output_root
        self.manifest = manifest
        self.run_directory = output_root / manifest.pilot_run_id
        self.run_path = self.run_directory / "run.json"
        self.decision_path = self.run_directory / "decision.json"

    def initialize(self) -> None:
        self.output_root.mkdir(parents=True, exist_ok=True)
        predecessor = self.manifest.predecessor_pilot_run_id
        if predecessor is not None:
            predecessor_path = self.output_root / predecessor / "run.json"
            if not predecessor_path.is_file():
                raise EvidenceError("failed predecessor evidence is missing")
            predecessor_run = _load_json(predecessor_path)
            if not isinstance(predecessor_run, dict):
                raise EvidenceError("failed predecessor evidence is invalid")
            if predecessor_run.get("state") != "failed":
                raise EvidenceError("predecessor must be a failed pilot run")
            if predecessor_run.get("environmentId") != self.manifest.environment_id:
                raise EvidenceError("predecessor must use the same environment")
        try:
            self.run_directory.mkdir()
        except FileExistsError as error:
            raise EvidenceError("pilot run directory already exists") from error
        with _run_lock(self.run_directory):
            run = {
                "schemaVersion": SCHEMA_VERSION,
                "pilotRunId": self.manifest.pilot_run_id,
                "manifestSha256": manifest_sha256(self.manifest),
                "predecessorPilotRunId": predecessor,
                "environmentId": self.manifest.environment_id,
                "applicationCommit": self.manifest.application_commit,
                "reviewerKeySha256": self.manifest.reviewer_key_sha256,
                "migrations": [asdict(item) for item in self.manifest.migrations],
                "migrationSetSha256": self.manifest.migration_set_sha256,
                "imageDigests": dict(self.manifest.image_digests),
                "operatorId": self.manifest.operator_id,
                "incidentContactId": self.manifest.incident_contact_id,
                "scope": {
                    "pilotProjectExternalId": (
                        self.manifest.scope.pilot_project_external_id
                    ),
                    "syntheticProjectExternalId": (
                        self.manifest.scope.synthetic_project_external_id
                    ),
                    "readOnly": self.manifest.scope.read_only,
                    "writebackAuthorized": self.manifest.scope.writeback_authorized,
                },
                "state": "created",
                "checks": {},
                "supportingEvidence": {},
            }
            self._write_run(run)

    def _read_run_unlocked(self) -> dict[str, Any]:
        value = _load_json(self.run_path)
        if not isinstance(value, dict):
            raise EvidenceError("pilot run must be an object")
        if value.get("manifestSha256") != manifest_sha256(self.manifest):
            raise EvidenceError("manifest does not match initialized pilot run")
        return dict(value)

    def read_run(self) -> dict[str, Any]:
        with _run_lock(self.run_directory):
            run = self._read_run_unlocked()
            return self._repair_decision(run)

    def _write_run(self, run: dict[str, Any]) -> None:
        assert_safe_json(run)
        _atomic_write(self.run_path, canonical_json(run))

    def _repair_decision(self, run: dict[str, Any]) -> dict[str, Any]:
        if not self.decision_path.exists():
            if "decision" in run:
                raise EvidenceError("pilot decision index references a missing file")
            return run
        encoded = self.decision_path.read_bytes()
        decision_value = _load_json(self.decision_path)
        if not isinstance(decision_value, dict):
            raise EvidenceError("pilot decision must be an object")
        decision = dict(decision_value)
        if encoded != canonical_json(decision):
            raise EvidenceError("pilot decision is not canonical JSON")
        expected_fields = {
            "schemaVersion",
            "pilotRunId",
            "environmentId",
            "manifestSha256",
            "outcome",
            "violations",
            "reviewerId",
            "reviewedAt",
            "reviewerAttestationPath",
            "reviewerAttestationSha256",
            "managedCheckIndexSha256",
            "supportingEvidenceIndexSha256",
            "decidedAt",
        }
        if set(decision) != expected_fields:
            raise EvidenceError("pilot decision fields do not match the contract")
        if type(decision.get("schemaVersion")) is not int or decision.get(
            "schemaVersion"
        ) != SCHEMA_VERSION:
            raise EvidenceError(f"schemaVersion must be the integer {SCHEMA_VERSION}")
        if decision.get("pilotRunId") != self.manifest.pilot_run_id:
            raise EvidenceError("pilot decision run does not match")
        if decision.get("environmentId") != self.manifest.environment_id:
            raise EvidenceError("pilot decision environment does not match")
        expected_manifest_sha256 = manifest_sha256(self.manifest)
        if decision.get("manifestSha256") != expected_manifest_sha256:
            raise EvidenceError("pilot decision manifest hash does not match")
        outcome = decision.get("outcome")
        if outcome not in {"passed", "failed"}:
            raise EvidenceError("pilot decision outcome is invalid")
        violations = decision.get("violations")
        if not isinstance(violations, list) or any(
            not isinstance(item, str) for item in violations
        ):
            raise EvidenceError("pilot decision violations are invalid")
        if (outcome == "passed") != (violations == []):
            raise EvidenceError("pilot decision outcome contradicts violations")
        reviewer_id = decision.get("reviewerId")
        if not isinstance(reviewer_id, str) or not IDENTIFIER_PATTERN.fullmatch(
            reviewer_id
        ):
            raise EvidenceError("pilot decision reviewer is invalid")
        _utc_timestamp(decision.get("reviewedAt"), "reviewedAt")
        _utc_timestamp(decision.get("decidedAt"), "decidedAt")
        checks = run.get("checks")
        supporting = run.get("supportingEvidence")
        if not isinstance(checks, dict) or not isinstance(supporting, dict):
            raise EvidenceError("pilot evidence indexes are invalid")
        if decision.get("managedCheckIndexSha256") != sha256_hex(
            canonical_json(checks)
        ):
            raise EvidenceError("pilot decision check index hash does not match")
        if decision.get("supportingEvidenceIndexSha256") != sha256_hex(
            canonical_json(supporting)
        ):
            raise EvidenceError("pilot decision supporting index hash does not match")
        self._load_supporting_from_run(run)
        attestation_digest = decision.get("reviewerAttestationSha256")
        attestation_path_value = decision.get("reviewerAttestationPath")
        if not isinstance(attestation_digest, str) or not SHA256_PATTERN.fullmatch(
            attestation_digest
        ):
            raise EvidenceError("pilot decision attestation hash is invalid")
        expected_attestation_path = (
            Path("reviewer-attestations") / f"{attestation_digest}.json"
        )
        if attestation_path_value != expected_attestation_path.as_posix():
            raise EvidenceError("pilot decision attestation path is invalid")
        attestation_path = self.run_directory / expected_attestation_path
        try:
            attestation_encoded = attestation_path.read_bytes()
        except OSError as error:
            raise EvidenceError("pilot reviewer attestation is missing") from error
        if sha256_hex(attestation_encoded) != attestation_digest:
            raise EvidenceError("pilot reviewer attestation hash does not match")
        attestation = _load_json(attestation_path)
        if not isinstance(attestation, dict):
            raise EvidenceError("pilot reviewer attestation is invalid")
        for field in (
            "pilotRunId",
            "environmentId",
            "reviewerId",
            "reviewedAt",
            "manifestSha256",
            "managedCheckIndexSha256",
            "supportingEvidenceIndexSha256",
        ):
            decision_field = {
                "reviewerId": "reviewerId",
                "reviewedAt": "reviewedAt",
            }.get(field, field)
            if attestation.get(field) != decision.get(decision_field):
                raise EvidenceError(
                    f"pilot decision does not match reviewer attestation field {field}"
                )
        decision_digest = sha256_hex(encoded)
        decision_entry = {
            "path": "decision.json",
            "sha256": decision_digest,
            "outcome": outcome,
            "reviewerAttestationSha256": attestation_digest,
        }
        existing_entry = run.get("decision")
        if existing_entry is None:
            run["decision"] = decision_entry
            run["state"] = outcome
            self._write_run(run)
        elif existing_entry != decision_entry or run.get("state") != outcome:
            raise EvidenceError("pilot decision index does not match immutable decision")
        return run

    def record_check(self, evidence: CheckEvidence) -> None:
        with _run_lock(self.run_directory):
            run = self._repair_decision(self._read_run_unlocked())
            if evidence.pilot_run_id != self.manifest.pilot_run_id:
                raise EvidenceError("pilotRunId does not match initialized run")
            if evidence.environment_id != self.manifest.environment_id:
                raise EvidenceError("environmentId does not match initialized run")
            if run.get("state") in {"passed", "failed"}:
                raise EvidenceError("terminal pilot state cannot be modified")
            checks_value = run.get("checks")
            if not isinstance(checks_value, dict):
                raise EvidenceError("pilot check index is invalid")
            checks = dict(checks_value)
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
                "pilotRunId": evidence.pilot_run_id,
                "environmentId": evidence.environment_id,
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
            _write_content_addressed(self.run_directory / relative_path, encoded)
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
            elif gate > 0 and run.get("state") == "preflight_passed":
                run["state"] = "executing"
            self._write_run(run)

    def _load_checks_from_run(
        self, run: dict[str, Any]
    ) -> dict[str, CheckEvidence]:
        checks_value = run.get("checks")
        if not isinstance(checks_value, dict):
            raise EvidenceError("pilot check index is invalid")
        result: dict[str, CheckEvidence] = {}
        for check_id, entry_value in checks_value.items():
            if check_id not in CHECK_GATE or not isinstance(entry_value, dict):
                raise EvidenceError("pilot check index entry is invalid")
            digest = entry_value.get("sha256")
            expected_path = (
                Path("checks") / f"{check_id}-{digest}.json"
                if isinstance(digest, str)
                else None
            )
            if (
                not isinstance(digest, str)
                or not SHA256_PATTERN.fullmatch(digest)
                or expected_path is None
                or entry_value.get("path") != expected_path.as_posix()
            ):
                raise EvidenceError(f"invalid check index entry: {check_id}")
            path = self.run_directory / expected_path
            encoded = path.read_bytes()
            if sha256_hex(encoded) != digest:
                raise EvidenceError(f"check evidence hash mismatch: {check_id}")
            evidence = parse_check_evidence(_load_json(path))
            if evidence.check_id != check_id:
                raise EvidenceError(f"check evidence identity mismatch: {check_id}")
            result[check_id] = evidence
        return result

    def load_checks(self) -> dict[str, CheckEvidence]:
        with _run_lock(self.run_directory):
            run = self._repair_decision(self._read_run_unlocked())
            return self._load_checks_from_run(run)

    @staticmethod
    def _validate_supporting_evidence(raw_value: object) -> dict[str, object]:
        try:
            assert_safe_json(raw_value)
        except UnsafeEvidenceError as error:
            raise EvidenceError(str(error)) from error
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
        if set(raw_value) != expected_fields or type(
            raw_value.get("schemaVersion")
        ) is not int or raw_value.get("schemaVersion") != SCHEMA_VERSION:
            raise EvidenceError("supporting evidence fields do not match the contract")
        check_id = raw_value.get("checkId")
        from .adapters import ADAPTERS

        expected_check_ids = {f"synthetic-{adapter_id}" for adapter_id in ADAPTERS}
        if not isinstance(check_id, str) or check_id not in expected_check_ids:
            raise EvidenceError("supporting checkId is not an allowlisted adapter")
        status = raw_value.get("status")
        if status not in {"passed", "failed"}:
            raise EvidenceError("supporting status must be passed or failed")
        started_at = _utc_timestamp(
            raw_value.get("startedAt"), "supporting.startedAt"
        )
        completed_at = _utc_timestamp(
            raw_value.get("completedAt"), "supporting.completedAt"
        )
        if datetime.fromisoformat(completed_at.replace("Z", "+00:00")) < datetime.fromisoformat(
            started_at.replace("Z", "+00:00")
        ):
            raise EvidenceError("supporting completedAt must not precede startedAt")
        metrics = raw_value.get("metrics")
        if not isinstance(metrics, dict) or set(metrics) != {
            "returnCode",
            "durationMilliseconds",
            "redactionCount",
            "timedOut",
        }:
            raise EvidenceError("supporting metrics do not match the contract")
        return_code = metrics.get("returnCode")
        duration = metrics.get("durationMilliseconds")
        redaction_count = metrics.get("redactionCount")
        timed_out = metrics.get("timedOut")
        if type(duration) is not int or duration < 0:
            raise EvidenceError("supporting durationMilliseconds is invalid")
        if type(redaction_count) is not int or redaction_count < 0:
            raise EvidenceError("supporting redactionCount is invalid")
        if type(timed_out) is not bool:
            raise EvidenceError("supporting timedOut is invalid")
        if timed_out:
            if return_code is not None or status != "failed":
                raise EvidenceError("timed-out supporting evidence is inconsistent")
            expected_summary = f"{str(check_id)[len('synthetic-'):]} exceeded its fixed timeout"
        else:
            if type(return_code) is not int:
                raise EvidenceError("supporting returnCode is invalid")
            expected_status = "passed" if return_code == 0 else "failed"
            if status != expected_status:
                raise EvidenceError("supporting status contradicts returnCode")
            adapter_id = str(check_id)[len("synthetic-") :]
            expected_summary = (
                f"{adapter_id} completed successfully"
                if return_code == 0
                else f"{adapter_id} failed with exit code {return_code}"
            )
        if raw_value.get("summary") != expected_summary:
            raise EvidenceError("supporting summary must be the fixed adapter summary")
        return json.loads(canonical_json(raw_value))

    def _load_supporting_from_run(
        self, run: dict[str, Any]
    ) -> dict[str, dict[str, object]]:
        supporting_value = run.get("supportingEvidence")
        if not isinstance(supporting_value, dict):
            raise EvidenceError("supporting evidence index is invalid")
        result: dict[str, dict[str, object]] = {}
        for check_id, entry_value in supporting_value.items():
            if not isinstance(check_id, str) or not isinstance(entry_value, dict):
                raise EvidenceError("supporting evidence index entry is invalid")
            digest = entry_value.get("sha256")
            expected_path = (
                Path("supporting") / f"{check_id}-{digest}.json"
                if isinstance(digest, str)
                else None
            )
            if (
                set(entry_value) != {"path", "sha256", "status"}
                or not isinstance(digest, str)
                or not SHA256_PATTERN.fullmatch(digest)
                or expected_path is None
                or entry_value.get("path") != expected_path.as_posix()
                or entry_value.get("status") not in {"passed", "failed"}
            ):
                raise EvidenceError(f"invalid supporting index entry: {check_id}")
            path = self.run_directory / expected_path
            try:
                encoded = path.read_bytes()
            except OSError as error:
                raise EvidenceError(
                    f"supporting evidence is missing: {check_id}"
                ) from error
            if sha256_hex(encoded) != digest:
                raise EvidenceError(f"supporting evidence hash mismatch: {check_id}")
            parsed = self._validate_supporting_evidence(_load_json(path))
            if parsed.get("checkId") != check_id:
                raise EvidenceError(
                    f"supporting evidence identity mismatch: {check_id}"
                )
            if parsed.get("status") != entry_value.get("status"):
                raise EvidenceError(f"supporting evidence status mismatch: {check_id}")
            result[check_id] = parsed
        return result

    def load_supporting_evidence(self) -> dict[str, dict[str, object]]:
        with _run_lock(self.run_directory):
            run = self._repair_decision(self._read_run_unlocked())
            return self._load_supporting_from_run(run)

    def record_supporting_evidence(self, raw_value: object) -> None:
        payload = self._validate_supporting_evidence(raw_value)
        check_id = payload["checkId"]
        assert isinstance(check_id, str)
        with _run_lock(self.run_directory):
            run = self._repair_decision(self._read_run_unlocked())
            if run.get("state") in {"passed", "failed"}:
                raise EvidenceError("terminal pilot state cannot be modified")
            supporting_value = run.get("supportingEvidence")
            if not isinstance(supporting_value, dict):
                raise EvidenceError("supporting evidence index is invalid")
            supporting = dict(supporting_value)
            if check_id in supporting:
                raise EvidenceError("supporting evidence is append-only")
            encoded = canonical_json(payload)
            digest = sha256_hex(encoded)
            relative_path = Path("supporting") / f"{check_id}-{digest}.json"
            _write_content_addressed(self.run_directory / relative_path, encoded)
            supporting[check_id] = {
                "path": relative_path.as_posix(),
                "sha256": digest,
                "status": payload["status"],
            }
            run["supportingEvidence"] = supporting
            self._write_run(run)

    def finalize(
        self, attestation: object, reviewer_key: bytes
    ) -> dict[str, object]:
        from .evaluation import evaluate, verify_reviewer_attestation

        with _run_lock(self.run_directory):
            run = self._read_run_unlocked()
            if self.decision_path.exists() or "decision" in run:
                self._repair_decision(run)
                raise EvidenceError("pilot decision is append-only")
            verified_attestation = verify_reviewer_attestation(
                self.manifest, run, attestation, reviewer_key
            )
            checks = self._load_checks_from_run(run)
            self._load_supporting_from_run(run)
            violations = evaluate(self.manifest, checks)
            outcome = "passed" if not violations else "failed"
            attestation_encoded = canonical_json(verified_attestation)
            attestation_digest = sha256_hex(attestation_encoded)
            attestation_relative_path = (
                Path("reviewer-attestations") / f"{attestation_digest}.json"
            )
            _write_content_addressed(
                self.run_directory / attestation_relative_path,
                attestation_encoded,
            )
            checks_value = run.get("checks")
            supporting_value = run.get("supportingEvidence")
            assert isinstance(checks_value, dict)
            assert isinstance(supporting_value, dict)
            decision: dict[str, object] = {
                "schemaVersion": SCHEMA_VERSION,
                "pilotRunId": self.manifest.pilot_run_id,
                "environmentId": self.manifest.environment_id,
                "manifestSha256": manifest_sha256(self.manifest),
                "outcome": outcome,
                "violations": violations,
                "reviewerId": verified_attestation["reviewerId"],
                "reviewedAt": verified_attestation["reviewedAt"],
                "reviewerAttestationPath": attestation_relative_path.as_posix(),
                "reviewerAttestationSha256": attestation_digest,
                "managedCheckIndexSha256": sha256_hex(
                    canonical_json(checks_value)
                ),
                "supportingEvidenceIndexSha256": sha256_hex(
                    canonical_json(supporting_value)
                ),
                "decidedAt": datetime.now(timezone.utc)
                .isoformat()
                .replace("+00:00", "Z"),
            }
            decision_encoded = canonical_json(decision)
            _write_exclusive(self.decision_path, decision_encoded)
            run["decision"] = {
                "path": "decision.json",
                "sha256": sha256_hex(decision_encoded),
                "outcome": outcome,
                "reviewerAttestationSha256": attestation_digest,
            }
            run["state"] = outcome
            self._write_run(run)
            return decision
