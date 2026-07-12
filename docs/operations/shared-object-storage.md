# Shared object storage for PostgreSQL replicas

PostgreSQL mode stores raw landing and governed-object metadata in PostgreSQL
and immutable bytes in one private S3-compatible bucket. SQLite remains a
supported real single-instance/embedded deployment and uses its configured
filesystem paths; it is not a multi-replica mode.

## Runtime contract

Set `ODF_DATA_PERSISTENCE=postgres` and `ODF_OBJECT_STORAGE_DRIVER=s3`.
The API refuses to start unless all of the following are available:

- PostgreSQL migration `011_shared_object_storage_metadata` and the narrow
  `odf_app` grants are present;
- the configured bucket can be reached with the API principal;
- bucket versioning is enabled when `ODF_OBJECT_STORAGE_REQUIRE_VERSIONING=true`;
- `ODF_OBJECT_STORAGE_SSE` is explicitly `AES256` or `aws:kms`, and every
  uploaded/read object reports that required server-side encryption mode;
- the API has a writable temporary staging directory; and
- the S3 endpoint is HTTPS in production, unless the explicit insecure
  override is set for a local reference profile.

Use workload identity/default cloud credentials when possible. For static
credentials, configure `ODF_OBJECT_STORAGE_ACCESS_KEY_ID_FILE` and
`ODF_OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE`; do not place credentials in a
connection string, source file, or checked-in environment file.

The API principal needs only bucket location/versioning checks plus object
`GetObject`, `GetObjectVersion`, `PutObject`, multipart-list/abort capability
within `odf/v1/*`. It must not receive bucket listing, delete, bucket-policy,
versioning-change, encryption-change, or administrative permissions.

## Data lifecycle

1. The API serializes/streams a payload to a local temporary file only while
   accepting the request.
2. It calculates SHA-256 and size, writes a server-generated opaque key to the
   bucket, and verifies the resulting object version.
3. A short PostgreSQL transaction stores the scoped locator, immutable
   metadata, event, audit record, and outbox intent.
4. Reads authorize tenant/project membership first, then proxy the object
   through the API. Physical bucket/key locators are never returned to clients.

S3 and PostgreSQL do not share an atomic transaction. A failed metadata
transaction can therefore leave an unreachable immutable object. Do not grant
the API delete permission. Run a separate, audited maintenance job to reconcile
only aged objects with no matching PostgreSQL locator; preserve raw evidence
under the organisation's retention/legal-hold policy.

## Production-like reference profile

`docker-compose.production-like.yml` supplies a private MinIO-compatible
reference service for CI/local rehearsal. It builds the patched
`RELEASE.2025-10-15T17-29-55Z` source commit from digest-pinned base images;
the `mc` bootstrap utility is also pinned by manifest digest. The bootstrap
creates a versioned, private, default-SSE-S3 bucket and a dedicated API user;
root credentials are mounted only into that one-shot bootstrap service.

The reference endpoint is HTTP only inside the isolated Compose network and
therefore sets `ODF_OBJECT_STORAGE_ALLOW_INSECURE_ENDPOINT=true`. It uses a
Docker-secret static KMS key solely to exercise SSE-S3 in CI. Never copy the
insecure override or static-key pattern to an internet-facing environment:
use HTTPS plus managed KMS/SSE-KMS (`ODF_OBJECT_STORAGE_SSE=aws:kms`) with a
provider-managed key and workload identity.

The production-like smoke test proves:

- ingest through API replica A, raw listing/replay through replica B;
- governed-object upload through A, full and range reads through B;
- non-empty immutable object version IDs and AES256 headers in PostgreSQL/API;
- exact bucket versioning, default encryption, and private-anonymous state;
- denial of bucket listing/configuration, object deletion, and writes outside
  the API prefix for the API S3 principal; and
- denied access for an authenticated user outside the selected project.

## Backup and restore

Treat PostgreSQL metadata and bucket versions as one recovery boundary.

1. Back up PostgreSQL with point-in-time recovery enabled.
2. Back up the object bucket with version history and retention configuration,
   not only current keys.
3. Record the restore point/time for both systems together.
4. Restore PostgreSQL and bucket to compatible points, then run a scoped
   sample of raw replays and governed-object checksum/head verification.
5. Keep the old bucket/version history read-only until reconciliation finishes.

Before rotating S3 credentials, deploy the replacement through the secret
manager, verify `/ready` on every replica, then revoke the old credential.
The reference bootstrap replaces an existing user with the same access key and
reattaches only its approved policy. When rotating the access-key identifier
itself, explicitly revoke the old MinIO/S3 principal through the provider's
audited identity workflow before or during the cutover; a deployment cannot
infer an obsolete identifier safely.

Bucket-default encryption affects newly written objects only. Before enabling
the mandatory API encryption check on an existing bucket, inventory and
rewrite/migrate older unencrypted versions into an encrypted, versioned bucket
through an audited maintenance procedure; do not weaken the runtime check to
keep legacy bytes readable.

Do not rotate the reference static KMS key in place: it is intentionally only
for disposable CI/local data and changing it can make existing encrypted
objects unreadable. Production key rotation belongs to the managed KMS/provider
procedure, including retained old-key decrypt capability until migration is
complete.
