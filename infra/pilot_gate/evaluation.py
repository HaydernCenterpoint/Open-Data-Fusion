from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import math

from . import SCHEMA_VERSION
from .contract import (
    IDENTIFIER_PATTERN,
    PilotManifest,
    REQUIRED_CHECK_IDS,
    SHA256_PATTERN,
)
from .evidence import (
    CheckEvidence,
    EvidenceError,
    canonical_json,
    manifest_sha256,
    sha256_hex,
)
from .safety import assert_safe_json


BOOLEAN_PROOFS_BY_CHECK: dict[str, tuple[str, ...]] = {
    "deployment-preflight": (
        "imageDigestsVerified",
        "migrationsVerified",
        "managedPostgresVerified",
        "managedRedisVerified",
        "managedObjectStorageVerified",
        "workforceOidcValidated",
        "postgresAuthoritative",
        "applicationSuperuserAbsent",
        "migrationOwnerAbsent",
        "sharedCredentialsAbsent",
        "objectVersioning",
        "objectEncryption",
        "redisPersistence",
        "purposeSpecificIdentities",
        "capacityApproved",
        "workerTopologyVerified",
        "sqliteFallbackDisabled",
        "inMemorySharedEventsDisabled",
        "writebackExecutorAbsent",
        "writebackExecutionFailsClosed",
    ),
    "tenant-isolation": (
        "rlsForced",
        "crossTenantDenied",
        "syntheticTenantSeparated",
        "pilotProjectActive",
        "syntheticProjectActive",
        "membershipScoped",
    ),
    "ingress-security": (
        "tls12OrNewer",
        "hstsEnabled",
        "managedCertificateRenewal",
        "workforceOidcRequired",
        "unauthenticatedApplicationDenied",
        "mtlsRequired",
        "oauthRequired",
        "missingCertificateDenied",
        "invalidCertificateDenied",
        "missingBearerDenied",
        "ingestRoutesOnly",
        "spoofedHeadersStripped",
    ),
    "network-isolation": (
        "defaultDeny",
        "approvedDependenciesReachable",
        "arbitraryEgressDenied",
        "directDatabaseDenied",
        "directApiDenied",
    ),
    "credential-rotation": (
        "connectorCredentialRotated",
        "certificateRotated",
        "oldMaterialRevoked",
        "realTransactionVerified",
        "policyNotWidened",
        "plaintextFallbackDisabled",
    ),
    "secret-scan": ("prohibitedMaterialAbsent",),
    "database-object-restore": (
        "rlsVerified",
        "objectsReconciled",
        "databaseFingerprintMatched",
        "kmsMaterialAvailable",
        "representativeReadsVerified",
        "tenantProjectReadVerified",
        "rawReplayReadVerified",
        "governedObjectReadVerified",
        "canvasRevisionReadVerified",
        "auditCorrelationReadVerified",
    ),
    "broker-recovery": (
        "managedOutageRecovered",
        "deadLetterReviewed",
        "requeueIndependentlyReviewed",
        "expiredLeaseTakeover",
        "aggregateOrderingPreserved",
    ),
    "replica-worker-recovery": (
        "apiReplicaRecovered",
        "workerRecovered",
        "noAuthoritativeStoreFallback",
        "rollingReleaseRecovered",
    ),
    "idempotency-checkpoints": (
        "noMissingAcceptedObservations",
        "noDuplicateAcceptedObservations",
        "checkpointSafe",
    ),
    "durable-telemetry": (
        "externalStorage",
        "logsRedacted",
        "retentionConfigured",
        "routeViewsPresent",
        "independentOperatorVerified",
    ),
    "alert-delivery": ("testAlertDelivered", "testAlertAcknowledged"),
    "service-objectives": (
        "redisReady",
        "pipelineHeartbeatHealthy",
        "postHocExclusionsAbsent",
        "scheduledMaintenanceIncluded",
        "windowStartedAfterShakedown",
    ),
}

COMMON_CONNECTOR_PROOFS = (
    "sourceCredentialReadOnly",
    "sourceSafetyApproved",
    "sourceReconciled",
    "restartResume",
    "edgeRestartRecovered",
    "apiRestartRecovered",
    "networkRecovery",
    "boundedRetry",
    "orderedDrain",
    "credentialRotation",
    "checkpointPreservedAfterRotation",
    "secretExposureAbsent",
    "additiveSchema",
    "incompatibleSchemaFailsClosed",
    "twoBatchReadOnlyRehearsalApproved",
    "backfillCompleted",
    "growthBounded",
    "sourceImpactAbsent",
    "serviceObjectivesHeld",
    "acceptedQuarantinedRejectedReconciled",
    "allDifferencesExplained",
)
CONNECTOR_PROOFS_BY_KIND: dict[str, tuple[str, ...]] = {
    "csv": COMMON_CONNECTOR_PROOFS + ("replacementMutationFailsClosed",),
    "postgres": COMMON_CONNECTOR_PROOFS
    + ("boundedReadOnlyQuery", "deterministicOrdering"),
    "opcua": COMMON_CONNECTOR_PROOFS
    + ("perNodeCheckpoints", "badStatusMappedNonGood"),
}


def _number(
    metrics: dict[str, object], name: str, violations: list[str], check_id: str
) -> float | None:
    value = metrics.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        violations.append(f"{check_id} {name} is missing or non-numeric")
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        violations.append(f"{check_id} {name} must be finite")
        return None
    if not math.isfinite(result):
        violations.append(f"{check_id} {name} must be finite")
        return None
    if result < 0:
        violations.append(f"{check_id} {name} must not be negative")
        return None
    return result


def _sha256(
    metrics: dict[str, object],
    name: str,
    violations: list[str],
    check_id: str,
    expected: str | None = None,
) -> str | None:
    value = metrics.get(name)
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        violations.append(f"{check_id} {name} must be a SHA-256 hex digest")
        return None
    if expected is not None and value != expected:
        violations.append(f"{check_id} {name} does not match the approved manifest")
    return value


def _utc_metric(
    metrics: dict[str, object], name: str, violations: list[str], check_id: str
) -> datetime | None:
    value = metrics.get(name)
    if not isinstance(value, str):
        violations.append(f"{check_id} {name} must be a UTC timestamp")
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        violations.append(f"{check_id} {name} must be a UTC timestamp")
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        violations.append(f"{check_id} {name} must be a UTC timestamp")
        return None
    return parsed


def _true(
    metrics: dict[str, object], name: str, violations: list[str], check_id: str
) -> None:
    if metrics.get(name) is not True:
        violations.append(f"{check_id} {name} is not true")


def evaluate(
    manifest: PilotManifest, checks: dict[str, CheckEvidence]
) -> list[str]:
    violations: list[str] = []
    missing = sorted(REQUIRED_CHECK_IDS - checks.keys())
    unexpected = sorted(checks.keys() - REQUIRED_CHECK_IDS)
    violations.extend(f"required check is missing: {check_id}" for check_id in missing)
    violations.extend(f"unexpected managed check: {check_id}" for check_id in unexpected)
    for check_id, evidence in sorted(checks.items()):
        if evidence.pilot_run_id != manifest.pilot_run_id:
            violations.append(f"{check_id} pilotRunId does not match the approved manifest")
        if evidence.environment_id != manifest.environment_id:
            violations.append(
                f"{check_id} environmentId does not match the approved manifest"
            )
        if check_id in REQUIRED_CHECK_IDS and evidence.status != "passed":
            violations.append(f"required check failed: {check_id}")
    for check_id, proof_names in BOOLEAN_PROOFS_BY_CHECK.items():
        evidence = checks.get(check_id)
        if evidence is not None:
            for proof_name in proof_names:
                _true(evidence.metrics, proof_name, violations, check_id)

    preflight = checks.get("deployment-preflight")
    if preflight is not None:
        replicas = _number(
            preflight.metrics, "apiReplicas", violations, preflight.check_id
        )
        clock_skew = _number(
            preflight.metrics, "clockSkewSeconds", violations, preflight.check_id
        )
        if replicas is not None and replicas < 2:
            violations.append("deployment-preflight apiReplicas must be at least two")
        if replicas is not None and not replicas.is_integer():
            violations.append("deployment-preflight apiReplicas must be an integer")
        if clock_skew is not None and clock_skew > 5:
            violations.append("deployment-preflight clockSkewSeconds exceeds five")
        _sha256(
            preflight.metrics,
            "migrationSetSha256",
            violations,
            preflight.check_id,
            manifest.migration_set_sha256,
        )
        if (
            preflight.metrics.get("observedApplicationCommit")
            != manifest.application_commit
        ):
            violations.append(
                "deployment-preflight observedApplicationCommit does not match the approved manifest"
            )
        observed_images = preflight.metrics.get("observedImageDigests")
        if not isinstance(observed_images, dict) or observed_images != dict(
            manifest.image_digests
        ):
            violations.append(
                "deployment-preflight observedImageDigests does not match the approved manifest"
            )

    restore = checks.get("database-object-restore")
    if restore is not None:
        rpo = _number(restore.metrics, "rpoMinutes", violations, restore.check_id)
        rto = _number(restore.metrics, "rtoMinutes", violations, restore.check_id)
        if rpo is not None and rpo > manifest.targets.rpo_minutes:
            violations.append("database-object-restore rpoMinutes exceeds target")
        if rto is not None and rto > manifest.targets.rto_minutes:
            violations.append("database-object-restore rtoMinutes exceeds target")
        recovery_point = restore.metrics.get("recoveryPointId")
        if not isinstance(recovery_point, str) or not IDENTIFIER_PATTERN.fullmatch(
            recovery_point
        ):
            violations.append("database-object-restore recoveryPointId is invalid")
        _sha256(
            restore.metrics, "objectSnapshotSha256", violations, restore.check_id
        )

    objectives = checks.get("service-objectives")
    if objectives is not None:
        availability = _number(
            objectives.metrics, "availabilityPercent", violations, objectives.check_id
        )
        latency = _number(
            objectives.metrics, "latencyP95Seconds", violations, objectives.check_id
        )
        freshness = _number(
            objectives.metrics, "outboxFreshnessSeconds", violations, objectives.check_id
        )
        days = _number(
            objectives.metrics, "observationDays", violations, objectives.check_id
        )
        dead_letters = _number(
            objectives.metrics, "unresolvedDeadLetters", violations, objectives.check_id
        )
        if availability is not None and availability < manifest.targets.availability_percent:
            violations.append("service-objectives availabilityPercent is below target")
        if availability is not None and availability > 100:
            violations.append("service-objectives availabilityPercent exceeds 100")
        if latency is not None and latency >= manifest.targets.latency_p95_seconds:
            violations.append(
                "service-objectives latencyP95Seconds must be below target"
            )
        if freshness is not None and freshness >= manifest.targets.outbox_freshness_seconds:
            violations.append(
                "service-objectives outboxFreshnessSeconds must be below target"
            )
        if days is not None and days < manifest.targets.observation_days:
            violations.append("service-objectives observationDays is below target")
        if days is not None and not days.is_integer():
            violations.append("service-objectives observationDays must be an integer")
        if dead_letters is not None and dead_letters != 0:
            violations.append("service-objectives unresolvedDeadLetters must be zero")
        window_started = _utc_metric(
            objectives.metrics, "windowStartedAt", violations, objectives.check_id
        )
        window_completed = _utc_metric(
            objectives.metrics, "windowCompletedAt", violations, objectives.check_id
        )
        if (
            window_started is not None
            and window_completed is not None
            and (window_completed - window_started).total_seconds()
            < manifest.targets.observation_days * 86_400
        ):
            violations.append(
                "service-objectives measurement window is shorter than target"
            )

    connector_by_kind = {connector.kind: connector for connector in manifest.connectors}
    for kind in ("csv", "postgres", "opcua"):
        check_id = f"connector-{kind}"
        connector_evidence = checks.get(check_id)
        if connector_evidence is None:
            continue
        for proof in CONNECTOR_PROOFS_BY_KIND[kind]:
            _true(connector_evidence.metrics, proof, violations, check_id)
        target = connector_by_kind[kind]
        _sha256(
            connector_evidence.metrics,
            "observedSchemaFingerprintSha256",
            violations,
            check_id,
            target.schema_fingerprint_sha256,
        )
        _sha256(
            connector_evidence.metrics,
            "checkpointBeforeSha256",
            violations,
            check_id,
        )
        _sha256(
            connector_evidence.metrics,
            "checkpointAfterSha256",
            violations,
            check_id,
        )
        backfill_minutes = _number(
            connector_evidence.metrics, "backfillMinutes", violations, check_id
        )
        if (
            backfill_minutes is not None
            and backfill_minutes > target.approved_backfill_window_minutes
        ):
            violations.append(f"{check_id} backfillMinutes exceeds approved window")
        if kind != "csv":
            sustained_minutes = _number(
                connector_evidence.metrics, "sustainedMinutes", violations, check_id
            )
            if sustained_minutes is not None and sustained_minutes < 60:
                violations.append(f"{check_id} sustainedMinutes is below sixty")
        achieved = _number(
            connector_evidence.metrics, "achievedRate", violations, check_id
        )
        if achieved is None:
            continue
        if kind == "csv":
            assert target.required_average_rate is not None
            required_rate = target.required_average_rate * manifest.targets.load_multiplier
            if target.source_safety_ceiling_rate is not None:
                required_rate = min(required_rate, target.source_safety_ceiling_rate)
        else:
            assert target.measured_peak_rate is not None
            required_rate = target.measured_peak_rate * manifest.targets.load_multiplier
        if achieved < required_rate:
            violations.append(f"{check_id} achievedRate is below target")
    return violations


def _reviewed_at(value: str | None) -> str:
    if value is None:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    parsed = _utc_metric({"reviewedAt": value}, "reviewedAt", [], "reviewer")
    if parsed is None:
        raise EvidenceError("reviewedAt must be a UTC timestamp")
    return parsed.isoformat().replace("+00:00", "Z")


def _validate_reviewer(
    manifest: PilotManifest, reviewer_id: object, reviewer_key: bytes
) -> str:
    if not isinstance(reviewer_id, str) or not IDENTIFIER_PATTERN.fullmatch(reviewer_id):
        raise EvidenceError("reviewer has an invalid identity")
    if reviewer_id.casefold() == manifest.operator_id.casefold():
        raise EvidenceError("reviewer must differ from operator")
    if not isinstance(reviewer_key, bytes) or len(reviewer_key) < 32:
        raise EvidenceError("reviewer key must contain at least 32 bytes")
    if hashlib.sha256(reviewer_key).hexdigest() != manifest.reviewer_key_sha256:
        raise EvidenceError("reviewer key does not match the approved manifest")
    return reviewer_id


def _attestation_payload(
    manifest: PilotManifest,
    run: dict[str, object],
    reviewer_id: str,
    reviewed_at: str,
) -> dict[str, object]:
    if run.get("pilotRunId") != manifest.pilot_run_id:
        raise EvidenceError("attestation run does not match the approved manifest")
    if run.get("environmentId") != manifest.environment_id:
        raise EvidenceError("attestation environment does not match the approved manifest")
    expected_manifest_sha256 = manifest_sha256(manifest)
    if run.get("manifestSha256") != expected_manifest_sha256:
        raise EvidenceError("attestation manifest hash does not match")
    checks = run.get("checks")
    supporting = run.get("supportingEvidence")
    if not isinstance(checks, dict) or not isinstance(supporting, dict):
        raise EvidenceError("attestation evidence indexes are invalid")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "pilotRunId": manifest.pilot_run_id,
        "environmentId": manifest.environment_id,
        "reviewerId": reviewer_id,
        "reviewerKeySha256": manifest.reviewer_key_sha256,
        "reviewedAt": reviewed_at,
        "manifestSha256": expected_manifest_sha256,
        "managedCheckIndexSha256": sha256_hex(canonical_json(checks)),
        "supportingEvidenceIndexSha256": sha256_hex(canonical_json(supporting)),
    }


def sign_reviewer_attestation(
    manifest: PilotManifest,
    run: dict[str, object],
    reviewer_id: str,
    reviewer_key: bytes,
    *,
    reviewed_at: str | None = None,
) -> dict[str, object]:
    """Create a reviewer-controlled HMAC attestation bound to current indexes."""
    reviewer_id = _validate_reviewer(manifest, reviewer_id, reviewer_key)
    payload = _attestation_payload(
        manifest, run, reviewer_id, _reviewed_at(reviewed_at)
    )
    # ponytail: HMAC is the provider-neutral trust anchor; use OIDC/KMS asymmetric
    # signatures when a deployment provider is selected.
    signature = hmac.new(reviewer_key, canonical_json(payload), hashlib.sha256).hexdigest()
    return payload | {"signatureHmacSha256": signature}


def verify_reviewer_attestation(
    manifest: PilotManifest,
    run: dict[str, object],
    attestation: object,
    reviewer_key: bytes,
) -> dict[str, object]:
    if not isinstance(attestation, dict):
        raise EvidenceError("reviewer attestation must be an object")
    assert_safe_json(attestation)
    expected_fields = {
        "schemaVersion",
        "pilotRunId",
        "environmentId",
        "reviewerId",
        "reviewerKeySha256",
        "reviewedAt",
        "manifestSha256",
        "managedCheckIndexSha256",
        "supportingEvidenceIndexSha256",
        "signatureHmacSha256",
    }
    if set(attestation) != expected_fields:
        raise EvidenceError("reviewer attestation fields do not match the contract")
    if type(attestation.get("schemaVersion")) is not int or attestation.get(
        "schemaVersion"
    ) != SCHEMA_VERSION:
        raise EvidenceError(f"schemaVersion must be the integer {SCHEMA_VERSION}")
    reviewer_id = _validate_reviewer(
        manifest, attestation.get("reviewerId"), reviewer_key
    )
    reviewed_at_value = attestation.get("reviewedAt")
    if not isinstance(reviewed_at_value, str):
        raise EvidenceError("reviewedAt must be a UTC timestamp")
    payload = _attestation_payload(
        manifest, run, reviewer_id, _reviewed_at(reviewed_at_value)
    )
    for name, value in payload.items():
        if attestation.get(name) != value:
            raise EvidenceError(f"reviewer attestation {name} does not match")
    signature = attestation.get("signatureHmacSha256")
    expected_signature = hmac.new(
        reviewer_key, canonical_json(payload), hashlib.sha256
    ).hexdigest()
    if not isinstance(signature, str) or not hmac.compare_digest(
        signature, expected_signature
    ):
        raise EvidenceError("reviewer attestation signature is invalid")
    return dict(attestation)
