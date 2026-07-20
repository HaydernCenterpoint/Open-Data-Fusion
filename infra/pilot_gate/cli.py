from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Sequence, TextIO

from .adapters import AdapterError, run_adapter
from .contract import ContractError, load_manifest
from .evaluation import sign_reviewer_attestation
from .evidence import (
    EvidenceError,
    EvidenceStore,
    canonical_json,
    parse_check_evidence,
    sha256_hex,
)
from .safety import UnsafeEvidenceError


ROOT = Path(__file__).resolve().parents[2]
REVIEWER_KEY_ENV = "ODF_PILOT_REVIEWER_HMAC_KEY"


class CliError(ValueError):
    """Raised for a fail-closed command-line contract error."""


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CliError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser(prog="pilot-gate")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in (
        "validate",
        "init",
        "record",
        "run-synthetic",
        "attest",
        "evaluate",
    ):
        subparser = subparsers.add_parser(name)
        subparser.add_argument("--manifest", type=Path, required=True)
        if name != "validate":
            subparser.add_argument("--output-root", type=Path, required=True)
        if name == "record":
            subparser.add_argument("--evidence", type=Path, required=True)
        elif name == "run-synthetic":
            subparser.add_argument("--adapter", required=True)
            subparser.add_argument("--confirm")
        elif name == "attest":
            subparser.add_argument("--reviewer", required=True)
            subparser.add_argument("--attestation-out", type=Path, required=True)
        elif name == "evaluate":
            subparser.add_argument("--attestation", type=Path, required=True)
    return parser


def _emit(value: object, stream: TextIO | None = None) -> None:
    destination = sys.stdout if stream is None else stream
    print(json.dumps(value, sort_keys=True, allow_nan=False), file=destination)


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CliError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _load_json(path: Path, label: str) -> object:
    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=_unique_object,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise CliError(f"could not read {label}: {error}") from error


def _reviewer_key() -> bytes:
    value = os.environ.get(REVIEWER_KEY_ENV)
    if value is None:
        raise CliError(f"{REVIEWER_KEY_ENV} is required")
    encoded = value.encode("utf-8")
    if len(encoded) < 32:
        raise CliError(f"{REVIEWER_KEY_ENV} must contain at least 32 bytes")
    return encoded


def _write_attestation(path: Path, value: dict[str, object]) -> str:
    encoded = canonical_json(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as error:
        raise CliError("attestation output is append-only") from error
    if os.name != "nt":
        path.chmod(0o600)
    return sha256_hex(encoded)


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
            parsed = parse_check_evidence(_load_json(args.evidence, "check evidence"))
            store.record_check(parsed)
            _emit({"checkId": parsed.check_id, "state": store.read_run()["state"]})
            return 0
        if args.command == "run-synthetic":
            result = run_adapter(args.adapter, ROOT, args.confirm)
            store.record_supporting_evidence(result)
            _emit({"checkId": result["checkId"], "status": result["status"]})
            return 0 if result["status"] == "passed" else 1
        if args.command == "attest":
            run = store.read_run()
            if "decision" in run:
                raise EvidenceError("pilot decision is append-only")
            output_path = args.attestation_out.resolve()
            if output_path.is_relative_to(store.run_directory.resolve()):
                raise CliError("attestation output must be outside the pilot run directory")
            attestation = sign_reviewer_attestation(
                manifest,
                run,
                args.reviewer,
                _reviewer_key(),
            )
            digest = _write_attestation(output_path, attestation)
            _emit(
                {
                    "pilotRunId": manifest.pilot_run_id,
                    "reviewerId": attestation["reviewerId"],
                    "attestationSha256": digest,
                    "status": "attested",
                }
            )
            return 0
        attestation = _load_json(args.attestation, "reviewer attestation")
        decision = store.finalize(attestation, _reviewer_key())
        _emit(decision)
        return 0 if decision["outcome"] == "passed" else 1
    except (
        AdapterError,
        CliError,
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
