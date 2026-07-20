from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
import sys
import time

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
    "static-validation": Adapter(
        (sys.executable, "infra/ci/validate-production-gates.py"), 120
    ),
    "production-like-smoke": Adapter(
        ("bash", "infra/ci/production-like-smoke.sh"), 900
    ),
    "broker-recovery": Adapter(
        ("bash", "infra/ci/outbox-broker-rehearsal.sh"),
        900,
        "ODF_OUTBOX_BROKER_REHEARSAL_CONFIRM",
        "local-production-like",
    ),
    "observability": Adapter(
        ("bash", "infra/ci/production-like-observability-smoke.sh"), 900
    ),
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
    "backup-restore": Adapter(
        ("bash", "infra/ci/postgres-backup-restore-rehearsal.sh"), 900
    ),
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _captured_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value if isinstance(value, str) else ""


def _redaction_count(stdout: object, stderr: object) -> int:
    combined = "\n".join(
        part
        for part in (_captured_text(stdout), _captured_text(stderr))
        if part
    )
    _, count = redact_text(combined)
    return count


def _result(
    adapter_id: str,
    started_at: str,
    started_monotonic: float,
    *,
    return_code: int | None,
    redaction_count: int,
    timed_out: bool,
) -> dict[str, object]:
    duration_milliseconds = max(
        0, int(round((time.monotonic() - started_monotonic) * 1_000))
    )
    if timed_out:
        status = "failed"
        summary = f"{adapter_id} exceeded its fixed timeout"
    elif return_code == 0:
        status = "passed"
        summary = f"{adapter_id} completed successfully"
    else:
        status = "failed"
        summary = f"{adapter_id} failed with exit code {return_code}"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "checkId": f"synthetic-{adapter_id}",
        "status": status,
        "startedAt": started_at,
        "completedAt": _now(),
        "summary": summary,
        "metrics": {
            "returnCode": return_code,
            "durationMilliseconds": duration_milliseconds,
            "redactionCount": redaction_count,
            "timedOut": timed_out,
        },
    }


def run_adapter(
    adapter_id: str,
    repository_root: Path,
    confirmation: str | None,
) -> dict[str, object]:
    adapter = ADAPTERS.get(adapter_id)
    if adapter is None:
        raise AdapterError("unknown synthetic adapter")
    if (
        adapter.confirmation_value is not None
        and confirmation != adapter.confirmation_value
    ):
        raise AdapterError(f"{adapter_id} requires explicit confirmation")
    environment = dict(os.environ)
    environment.pop("ODF_PILOT_REVIEWER_HMAC_KEY", None)
    if adapter.confirmation_env is not None:
        assert adapter.confirmation_value is not None
        environment[adapter.confirmation_env] = adapter.confirmation_value
    started_at = _now()
    started_monotonic = time.monotonic()
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
    except subprocess.TimeoutExpired as error:
        return _result(
            adapter_id,
            started_at,
            started_monotonic,
            return_code=None,
            redaction_count=_redaction_count(error.stdout, error.stderr),
            timed_out=True,
        )
    except OSError as error:
        raise AdapterError(f"{adapter_id} could not launch its fixed command") from error
    return _result(
        adapter_id,
        started_at,
        started_monotonic,
        return_code=completed.returncode,
        redaction_count=_redaction_count(completed.stdout, completed.stderr),
        timed_out=False,
    )
