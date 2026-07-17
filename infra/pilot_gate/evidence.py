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
from .safety import assert_safe_json


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

    def _read_run(self) -> dict[str, Any]:
        value = _load_json(self.run_path)
        if not isinstance(value, dict):
            raise EvidenceError("pilot run must be an object")
        if value.get("manifestSha256") != manifest_sha256(self.manifest):
            raise EvidenceError("manifest does not match initialized pilot run")
        return dict(value)

    def read_run(self) -> dict[str, Any]:
        return self._read_run()

    def _write_run(self, run: dict[str, Any]) -> None:
        assert_safe_json(run)
        _atomic_write(self.run_path, canonical_json(run))

    def record_check(self, evidence: CheckEvidence) -> None:
        with _run_lock(self.run_directory):
            run = self._read_run()
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

    def load_checks(self) -> dict[str, CheckEvidence]:
        run = self._read_run()
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
