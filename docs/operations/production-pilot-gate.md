# Production Pilot Gate for managed staging

## 1. Scope and safety boundary

The Production Pilot Gate is a provider-neutral evidence runner for one
approved **managed staging** environment. It does not deploy infrastructure,
discover credentials, execute operator-supplied commands, or certify an
environment from repository tests alone. A go decision is meaningful only
after the target environment has supplied all sixteen managed checks and an
independent reviewer has signed the resulting evidence indexes.

The approved boundary is a read-only pilot scope:

- one design-partner project plus a distinct synthetic isolation project;
- no industrial write-back executor, command, control action, or plaintext
  fallback;
- read-only CSV, PostgreSQL/JDBC, and OPC UA source access;
- managed PostgreSQL as the authoritative store, managed Redis for delivery,
  private versioned object storage, workforce OIDC, TLS/mTLS ingress, and
  externally retained telemetry;
- exact application commit, migration set, and image digests approved before
  initialization;
- sanitized metrics and summaries only. Credentials, connection strings,
  payloads, rows, logs, and raw stdout/stderr are prohibited evidence.

The runner is fail-closed. A missing, false, malformed, non-finite, unsafe, or
out-of-threshold value produces a no-go. Synthetic results do not satisfy any
of the sixteen managed checks.

## 2. Required topology and purpose-specific identities

Before creating a manifest, the deployment owner must document and verify:

- at least two API replicas behind approved ingress;
- separate outbox and pipeline workers with health and telemetry;
- managed PostgreSQL with forced tenant RLS and no application superuser or
  migration-owner membership;
- managed Redis with persistence and a non-authoritative delivery role;
- private, encrypted, versioned object storage;
- workforce OIDC for application users and OAuth plus mTLS for connector
  ingress;
- default-deny networking and allowlisted dependencies;
- durable log, trace, metric, and alert storage outside application replicas;
- synchronized clocks with no more than five seconds of measured skew.

Use separate identities for the pilot operator, incident contact, independent
reviewer, API, migration runner, outbox worker, pipeline worker, each connector,
telemetry collector, backup/restore, and secret rotation. The reviewer must not
be the manifest operator. Shared credentials, superuser application access,
and a reviewer secret available to the operator invalidate the run.

## 3. Manifest preparation and source-owner approval

Copy `infra/pilot-gate.example.json` to a protected configuration location and
replace every example identifier and digest. Do not place the working manifest
or reviewer secret in Git. The manifest must bind:

- a unique `pilotRunId` and optional failed predecessor;
- operator and incident-contact identities;
- distinct pilot and synthetic project identifiers;
- `managed-staging`, read-only scope, and disabled write-back;
- the exact application commit, ordered migration hashes and aggregate
  `migrationSetSha256`, and all five image digests;
- RPO, RTO, availability, latency, outbox freshness, observation duration,
  load multiplier, and evidence retention targets;
- exactly one CSV, PostgreSQL, and OPC UA connector target;
- the SHA-256 fingerprint of the reviewer-controlled key, never the key.

The source owner must approve each connector's read-only credential, bounded
query or node/file scope, target rate, source-safety ceiling where applicable,
backfill window, expected entity/time-series volume, retention, and schema
fingerprint. Record that approval outside the manifest under the organization's
change-control system.

The reviewer generates a random key of at least 32 bytes in a separate
reviewer-controlled secret-manager or CI context and supplies only its SHA-256
fingerprint for `environment.reviewerKeySha256`. `ODF_PILOT_REVIEWER_HMAC_KEY`
must never appear in the manifest, command line, shell history, logs, or stored
evidence. HMAC is the provider-neutral trust ceiling in this repository; when a
deployment provider is selected, replace it with an OIDC/KMS asymmetric
signature whose public trust anchor can be verified without sharing the
reviewer's signing material.

Validate the prepared manifest:

```powershell
npm run pilot:gate -- validate --manifest C:\secure-config\pilot-manifest.json
```

Validation does not prove that the declared managed environment exists. It
only proves that the manifest conforms to the approved contract.

## 4. Gate initialization

Create a dedicated evidence root on encrypted storage with access limited to
the operator, independent reviewer, incident responders, and retention system.
Initialize exactly once:

```powershell
npm run pilot:gate -- init --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence
```

Initialization creates `<output-root>/<pilotRunId>/run.json`. The run binds the
manifest hash, environment, commit, migrations, image digests, reviewer-key
fingerprint, operator, scope, and empty append-only indexes. Re-running `init`
for the same identifier fails; do not delete the directory to bypass that
protection.

## 5. Synthetic evidence adapters

The optional adapters run fixed repository-owned argument arrays with
`shell=False`, fixed timeouts, and no manifest-supplied command, path, timeout,
or environment-variable name.

| Adapter | Fixed rehearsal | Confirmation |
| --- | --- | --- |
| `static-validation` | Production-gate static validator | None |
| `production-like-smoke` | Local production-like application smoke | None |
| `broker-recovery` | Local outbox/broker recovery | `local-production-like` |
| `observability` | Local durable telemetry smoke | None |
| `security-ingress` | Local TLS/mTLS ingress smoke | `local-security-ingress` |
| `edge-mtls` | Local edge mTLS delivery rehearsal | `local-ci-edge-mtls-rehearsal` |
| `backup-restore` | Local PostgreSQL backup/restore rehearsal | None |

Run the smallest relevant adapter, for example:

```powershell
npm run pilot:gate -- run-synthetic --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --adapter static-validation
```

For an adapter requiring confirmation:

```powershell
npm run pilot:gate -- run-synthetic --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --adapter broker-recovery --confirm local-production-like
```

The runner captures process output only in memory, scans it for prohibited
material, records a redaction count and fixed success/failure summary, and then
discards the output. It never persists stdout/stderr, even after redaction.
Supporting results are content-addressed under `supporting/` and do not advance
a managed gate.

## 6. Managed evidence JSON contract

Each managed check is a separate sanitized JSON object bound to the initialized
run and environment. A deployment-preflight record has this shape (replace all
example digests with the manifest's exact values):

```json
{
  "schemaVersion": 1,
  "pilotRunId": "pilot-managed-20260716-001",
  "environmentId": "managed-staging",
  "checkId": "deployment-preflight",
  "status": "passed",
  "startedAt": "2026-07-16T10:00:00Z",
  "completedAt": "2026-07-16T10:05:00Z",
  "summary": "Managed staging preflight passed.",
  "metrics": {
    "apiReplicas": 2,
    "clockSkewSeconds": 0.4,
    "migrationSetSha256": "ac0f8176205045a99e50d679600d4a192b6e57cb29eb4f6d4e92a4212cce90ed",
    "observedApplicationCommit": "1111111111111111111111111111111111111111",
    "observedImageDigests": {
      "api": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "web": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "outbox-worker": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "pipeline-worker": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "edge-agent": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "imageDigestsVerified": true,
    "migrationsVerified": true,
    "managedPostgresVerified": true,
    "managedRedisVerified": true,
    "managedObjectStorageVerified": true,
    "workforceOidcValidated": true,
    "postgresAuthoritative": true,
    "applicationSuperuserAbsent": true,
    "migrationOwnerAbsent": true,
    "sharedCredentialsAbsent": true,
    "objectVersioning": true,
    "objectEncryption": true,
    "redisPersistence": true,
    "purposeSpecificIdentities": true,
    "capacityApproved": true,
    "workerTopologyVerified": true,
    "sqliteFallbackDisabled": true,
    "inMemorySharedEventsDisabled": true,
    "writebackExecutorAbsent": true,
    "writebackExecutionFailsClosed": true
  }
}
```

Timestamps must be UTC and `completedAt` cannot precede `startedAt`. Status is
only `passed` or `failed`; a summary contains 1–2,000 characters. JSON fields
are strict, duplicate keys are rejected, and all strings and nested values are
scanned for prohibited secret or raw-data material.

### Boolean proof matrix

Every listed field must be the JSON boolean `true` for a go decision.

| Managed check | Required boolean proofs |
| --- | --- |
| `deployment-preflight` | `imageDigestsVerified`, `migrationsVerified`, `managedPostgresVerified`, `managedRedisVerified`, `managedObjectStorageVerified`, `workforceOidcValidated`, `postgresAuthoritative`, `applicationSuperuserAbsent`, `migrationOwnerAbsent`, `sharedCredentialsAbsent`, `objectVersioning`, `objectEncryption`, `redisPersistence`, `purposeSpecificIdentities`, `capacityApproved`, `workerTopologyVerified`, `sqliteFallbackDisabled`, `inMemorySharedEventsDisabled`, `writebackExecutorAbsent`, `writebackExecutionFailsClosed` |
| `tenant-isolation` | `rlsForced`, `crossTenantDenied`, `syntheticTenantSeparated`, `pilotProjectActive`, `syntheticProjectActive`, `membershipScoped` |
| `ingress-security` | `tls12OrNewer`, `hstsEnabled`, `managedCertificateRenewal`, `workforceOidcRequired`, `unauthenticatedApplicationDenied`, `mtlsRequired`, `oauthRequired`, `missingCertificateDenied`, `invalidCertificateDenied`, `missingBearerDenied`, `ingestRoutesOnly`, `spoofedHeadersStripped` |
| `network-isolation` | `defaultDeny`, `approvedDependenciesReachable`, `arbitraryEgressDenied`, `directDatabaseDenied`, `directApiDenied` |
| `credential-rotation` | `connectorCredentialRotated`, `certificateRotated`, `oldMaterialRevoked`, `realTransactionVerified`, `policyNotWidened`, `plaintextFallbackDisabled` |
| `secret-scan` | `prohibitedMaterialAbsent` |
| `database-object-restore` | `rlsVerified`, `objectsReconciled`, `databaseFingerprintMatched`, `kmsMaterialAvailable`, `representativeReadsVerified`, `tenantProjectReadVerified`, `rawReplayReadVerified`, `governedObjectReadVerified`, `canvasRevisionReadVerified`, `auditCorrelationReadVerified` |
| `broker-recovery` | `managedOutageRecovered`, `deadLetterReviewed`, `requeueIndependentlyReviewed`, `expiredLeaseTakeover`, `aggregateOrderingPreserved` |
| `replica-worker-recovery` | `apiReplicaRecovered`, `workerRecovered`, `noAuthoritativeStoreFallback`, `rollingReleaseRecovered` |
| `idempotency-checkpoints` | `noMissingAcceptedObservations`, `noDuplicateAcceptedObservations`, `checkpointSafe` |
| `durable-telemetry` | `externalStorage`, `logsRedacted`, `retentionConfigured`, `routeViewsPresent`, `independentOperatorVerified` |
| `alert-delivery` | `testAlertDelivered`, `testAlertAcknowledged` |
| `service-objectives` | `redisReady`, `pipelineHeartbeatHealthy`, `postHocExclusionsAbsent`, `scheduledMaintenanceIncluded`, `windowStartedAfterShakedown` |

Each `connector-csv`, `connector-postgres`, and `connector-opcua` check also
requires all common connector proofs:

`sourceCredentialReadOnly`, `sourceSafetyApproved`, `sourceReconciled`,
`restartResume`, `edgeRestartRecovered`, `apiRestartRecovered`,
`networkRecovery`, `boundedRetry`, `orderedDrain`, `credentialRotation`,
`checkpointPreservedAfterRotation`, `secretExposureAbsent`, `additiveSchema`,
`incompatibleSchemaFailsClosed`, `twoBatchReadOnlyRehearsalApproved`,
`backfillCompleted`, `growthBounded`, `sourceImpactAbsent`,
`serviceObjectivesHeld`, `acceptedQuarantinedRejectedReconciled`, and
`allDifferencesExplained`.

Connector-specific proofs are:

| Check | Additional boolean proofs |
| --- | --- |
| `connector-csv` | `replacementMutationFailsClosed` |
| `connector-postgres` | `boundedReadOnlyQuery`, `deterministicOrdering` |
| `connector-opcua` | `perNodeCheckpoints`, `badStatusMappedNonGood` |

### Typed metric matrix

| Check | Required typed metrics and threshold |
| --- | --- |
| `deployment-preflight` | Integer `apiReplicas >= 2`; finite `clockSkewSeconds <= 5`; `migrationSetSha256`, `observedApplicationCommit`, and the exact five-entry `observedImageDigests` must equal the manifest. |
| `database-object-restore` | Finite non-negative `rpoMinutes <= targets.rpoMinutes` and `rtoMinutes <= targets.rtoMinutes`; valid `recoveryPointId`; SHA-256 `objectSnapshotSha256`. |
| `service-objectives` | `availabilityPercent` is at least the target and at most 100; `latencyP95Seconds` and `outboxFreshnessSeconds` are strictly below their targets; integer `observationDays` is at least the target; `unresolvedDeadLetters` is zero; UTC `windowStartedAt`/`windowCompletedAt` span the exact target duration (at least 30 days in the baseline). Scheduled maintenance remains inside the window and post-hoc exclusions are forbidden. |
| Every connector | `observedSchemaFingerprintSha256` equals its manifest target; SHA-256 `checkpointBeforeSha256` and `checkpointAfterSha256`; finite non-negative `backfillMinutes` no greater than the approved window; finite non-negative `achievedRate` at or above the computed load target. |
| `connector-postgres`, `connector-opcua` | `sustainedMinutes >= 60`. |

CSV's achieved target is the smaller of `requiredAverageRate ×
loadMultiplier` and `sourceSafetyCeilingRate`; this preserves the source-owner
safety ceiling. PostgreSQL and OPC UA targets are `measuredPeakRate ×
loadMultiplier`. A missing, false, malformed, non-finite, or out-of-threshold
value produces a no-go decision.

## 7. Gate-by-gate recording order

Record checks in this exact order. Checks within the same gate may be recorded
in either order; no later gate starts until every earlier check has passed.

1. Gate 0 — `deployment-preflight`, `tenant-isolation`.
2. Gate 1 — `ingress-security`, `network-isolation`,
   `credential-rotation`, `secret-scan`.
3. Gate 2 — `database-object-restore`, `broker-recovery`,
   `replica-worker-recovery`, `idempotency-checkpoints`.
4. Gate 3 — `durable-telemetry`, `alert-delivery`, `service-objectives`.
5. Gate 4 — `connector-csv`, `connector-postgres`, `connector-opcua`.

Record one check:

```powershell
npm run pilot:gate -- record --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --evidence C:\sanitized-evidence\deployment-preflight.json
```

The runner content-addresses the file and stores only its path, SHA-256,
status, and gate in `run.json`. Recording the same check twice is rejected. An
unavailable required check is a failed run, not a waiver. Record it as failed
or allow evaluation to report it missing; do not invent evidence.

## 8. Independent evaluation

After evidence collection stops, the independent reviewer inspects the
manifest, managed check files, supporting index, source-owner approvals,
change/incident records, and target-environment dashboards. The reviewer uses
a separate security context containing `ODF_PILOT_REVIEWER_HMAC_KEY`; the
operator must not have access to that context.

The reviewer signs the current immutable indexes to a file outside the pilot
run directory:

```powershell
npm run pilot:gate -- attest --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --reviewer reviewer@example.test --attestation-out C:\reviewer-evidence\pilot-attestation.json
```

In the same reviewer-controlled verification context, finalize exactly once:

```powershell
npm run pilot:gate -- evaluate --manifest C:\secure-config\pilot-manifest.json --output-root C:\secure-evidence --attestation C:\reviewer-evidence\pilot-attestation.json
```

The attestation binds the run, environment, manifest hash, reviewer identity,
review time, managed-check index hash, and supporting-evidence index hash.
Evaluation verifies the signature and pinned key fingerprint, reloads every
content-addressed file, computes violations internally, and writes one
append-only decision. Callers cannot supply or suppress violations.

Exit code `0` means a completed go decision, `1` means a completed no-go
decision, and `2` means invalid input, unsafe evidence, bad signature, ordering
failure, or an attempted append-only mutation. A repository test result or
successful synthetic adapter is never a substitute for reviewer-attested
managed evidence.

## 9. Artifact review and retention

Retain the entire `<output-root>/<pilotRunId>` directory for at least
`targets.evidenceRetentionDays` (90 days in the baseline), or longer when
change-control, incident, regulatory, or source-owner policy requires it. The
artifact set contains:

- `run.json`, the manifest-bound state and immutable indexes;
- `checks/<checkId>-<sha256>.json`, the sixteen managed records;
- `supporting/<checkId>-<sha256>.json`, optional fixed-adapter results;
- `reviewer-attestations/<sha256>.json`, the verified signed attestation;
- `decision.json`, the single passed/failed outcome and violations.

Copy the directory to write-once or object-locked retention and verify hashes
after transfer. Retain the working manifest and source-owner/change approvals
under their own protected records. Never retain the HMAC key with evidence.
Never add raw stdout/stderr, logs, query results, source rows, payloads,
credentials, certificates, signed URLs, connection strings, or customer/plant
data to any artifact.

`decision.json` is written before `run.json` is updated. If a process stops in
that narrow window, the next read validates the immutable decision and repairs
only the missing run index; it does not replace or recompute a second decision.

## 10. Failure response, retry, rollback, and bounded cleanup

A failed check makes the run terminal. Stop later gates, preserve the evidence,
notify the incident contact and source owner where applicable, and record the
no-go through independent evaluation. A failed run cannot be resumed or
rewritten.

To retry after remediation:

1. Roll back or disable the affected managed-staging release, connector,
   credential, route, or policy without widening access or enabling write-back.
2. Confirm the original run has terminal state `failed` and retain it.
3. Create a new manifest with a new `pilotRunId` and set
   `predecessorPilotRunId` to the failed predecessor in the same environment.
4. Recompute commit, migration, image, reviewer-key, and connector fingerprints
   as needed; obtain renewed source-owner approval for changed bounds.
5. Initialize a new directory and repeat every gate from Gate 0.

Rollback restores the last approved managed-staging deployment and secret
versions; it never enables plaintext ingress, shared credentials, SQLite
fallback, in-memory shared events, unrestricted egress, or write-back.

Cleanup is bounded to synthetic fixtures and disposable local rehearsal
resources whose identifiers were recorded by their owning runbooks. Verify the
resolved target before removal. Do not delete managed evidence, source records,
retained backups, or another run's resources. If safe ownership cannot be
proven, leave the resource in place and escalate through incident/change
control.
