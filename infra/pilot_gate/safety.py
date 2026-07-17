from __future__ import annotations

import math
import re


class UnsafeEvidenceError(ValueError):
    """Raised before unsafe evidence reaches persistent storage."""


FORBIDDEN_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "cookies",
        "setcookie",
        "password",
        "secret",
        "token",
        "privatekey",
        "certificate",
        "databaseurl",
        "signedurl",
        "payload",
        "rawpayload",
        "rawrows",
        "rows",
        "records",
        "stdout",
        "stderr",
        "logs",
    }
)
FORBIDDEN_KEY_PREFIXES = (
    "authorization",
    "cookie",
    "setcookie",
    "rawpayload",
    "rawrows",
)
FORBIDDEN_KEY_SUFFIXES = (
    "authorization",
    "cookie",
    "cookies",
    "password",
    "secret",
    "token",
    "privatekey",
    "certificate",
    "databaseurl",
    "signedurl",
    "payload",
    "rows",
    "records",
    "stdout",
    "stderr",
    "logs",
)
VALUE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"-----BEGIN (?P<pem_label>(?:[A-Z0-9]+ )*(?:PRIVATE|PUBLIC) KEY|"
        r"CERTIFICATE(?: REQUEST)?)-----.*?"
        r"(?:-----END (?P=pem_label)-----|$)",
        re.DOTALL,
    ),
    re.compile(
        r"(?im)(?<![A-Za-z0-9_-])[\"']?(?:proxy[-_ ]?)?authorization[\"']?"
        r"\s*[:=]\s*(?:\"(?:\\.|[^\"\r\n])*\"|'(?:\\.|[^'\r\n])*'|[^\r\n]+)"
    ),
    re.compile(
        r"(?im)(?<![A-Za-z0-9_-])[\"']?(?:set[-_ ]?)?cookie[\"']?"
        r"\s*[:=]\s*(?:\"(?:\\.|[^\"\r\n])*\"|'(?:\\.|[^'\r\n])*'|[^\r\n]+)"
    ),
    re.compile(
        r"""
        (?<![A-Za-z0-9_-])[\"']?
        (?:
            access[-_]?(?:token|key(?:[-_]?id)?)
            |refresh[-_]?token
            |client[-_]?(?:id|secret|token|key)
            |api[-_]?(?:key|token|secret)
            |aws[-_]?(?:
                access[-_]?key(?:[-_]?id)?
                |secret[-_]?access[-_]?key
                |session[-_]?token
            )
            |password|passwd
        )
        [\"']?\s*[:=]\s*
        (?:\"(?:\\.|[^\"\r\n])*\"|'(?:\\.|[^'\r\n])*'|[^\s,;}\]]+)
        """,
        re.IGNORECASE | re.VERBOSE,
    ),
    re.compile(
        r"""
        (?<![A-Za-z0-9_-])[\"']?
        (?:(?:sqlalchemy[-_]?)?database|db|postgres(?:ql)?|mysql|mariadb|
           mongo(?:db)?|redis|amqp|broker|cache|jdbc)
        [-_]?(?:url|uri|dsn|connection[-_]?string)
        [\"']?\s*[:=]\s*
        (?:\"(?:\\.|[^\"\r\n])*\"|'(?:\\.|[^'\r\n])*'|[^\s,;}\]]+)
        """,
        re.IGNORECASE | re.VERBOSE,
    ),
    re.compile(
        r"\b[a-z][a-z0-9+.-]*://[^\s/@]+@[^\s\"'<>]+",
        re.IGNORECASE,
    ),
)


def _normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _is_forbidden_key(value: str) -> bool:
    normalized = _normalized_key(value)
    return (
        normalized in FORBIDDEN_KEYS
        or normalized.startswith(FORBIDDEN_KEY_PREFIXES)
        or normalized.endswith(FORBIDDEN_KEY_SUFFIXES)
    )


def assert_safe_json(value: object, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise UnsafeEvidenceError(f"{path} contains a non-string key")
            if _is_forbidden_key(key):
                raise UnsafeEvidenceError(f"{path}.{key} is forbidden evidence")
            assert_safe_json(nested, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, nested in enumerate(value):
            assert_safe_json(nested, f"{path}[{index}]")
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise UnsafeEvidenceError(f"{path} must contain only finite numbers")
        return
    if type(value) is str:
        if any(pattern.search(value) for pattern in VALUE_PATTERNS):
            raise UnsafeEvidenceError(
                f"{path} contains prohibited secret material"
            )
        return
    if value is None or type(value) in {bool, int}:
        return
    raise UnsafeEvidenceError(
        f"{path} contains unsupported evidence type {type(value).__name__}"
    )


def redact_text(value: str) -> tuple[str, int]:
    redacted = value
    count = 0
    for pattern in VALUE_PATTERNS:
        redacted, replacements = pattern.subn("[REDACTED]", redacted)
        count += replacements
    return redacted, count
