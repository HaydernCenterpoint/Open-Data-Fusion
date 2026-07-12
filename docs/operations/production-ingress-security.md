# Production ingress, mTLS, secrets, and network isolation

## Deployment contract

The application containers are not internet-facing ingress. A production
deployment must provide:

- TLS 1.2+ at every external listener, HSTS, managed certificate renewal, and
  no plaintext fallback;
- a separate connector/data-ingest listener requiring a trusted client
  certificate in addition to API bearer authorization;
- request size/rate/time limits and access logs that omit authorization,
  cookies, payloads, and query secrets;
- default-deny ingress/egress, with API access only from approved gateways and
  Prometheus, and dependency ports allowlisted explicitly;
- read-only secret file mounts or workload identity; no credentials in Git,
  images, command-line arguments, connection-string logs, or ConfigMaps;
- independently scoped PostgreSQL, Redis, object-store, metrics, PKI, and
  migration credentials with tested overlapping rotation.

`infra/security/secret-contract.json` is the machine-readable inventory.
Deployment tooling must map entries to its secret manager and reject missing or
expired material before rollout.

## Rehearsal assets

`envoy-connector-mtls.yaml` exposes only ingest paths, strips spoofed mTLS
headers, requires a client certificate, and forwards to the internal API. The
Compose overlay binds it to loopback and requires an approved Envoy image
pinned by digest.

Generate disposable seven-day rehearsal certificates:

```bash
bash infra/security/generate-rehearsal-pki.sh .local/odf-pki
export ODF_INGRESS_TLS_CERT_FILE="$PWD/.local/odf-pki/server.crt"
export ODF_INGRESS_TLS_KEY_FILE="$PWD/.local/odf-pki/server.key"
export ODF_INGRESS_CLIENT_CA_FILE="$PWD/.local/odf-pki/ca.crt"
export ODF_ENVOY_IMAGE='envoyproxy/envoy@sha256:<approved-digest>'
docker compose -f docker-compose.yml \
  -f docker-compose.production-like.yml \
  -f docker-compose.security-rehearsal.yml \
  --profile production-like --profile security-rehearsal up -d --wait
```

Verify a request without a client certificate fails the TLS handshake. Then
repeat with `client.crt`, `client.key`, and `ca.crt`; an authenticated ingest
request may proceed to normal OIDC/permission checks. Delete the entire local
PKI directory after rehearsal. Never import its CA or keys into production.

## Network policy

`infra/security/kubernetes/network-policies.yaml` is a default-deny baseline.
Workloads must use its `app.kubernetes.io/name` labels. Validate the policy in a
staging namespace with positive dependency tests and negative arbitrary-egress,
cross-tenant, direct-database, and direct-API tests.

Kubernetes NetworkPolicy cannot portably allow a managed S3 hostname. Add the
smallest provider/CNI-specific FQDN or egress-gateway rule for the approved S3,
OIDC, KMS, and telemetry endpoints; never add unrestricted `0.0.0.0/0` egress.
The public ingress exception in the reference policy applies only to the mTLS
gateway on port 9443.

## Rotation and rollback

Rotate using overlap: create the replacement credential/certificate, mount both
trust paths where applicable, roll consumers, verify readiness and a real
transaction, then revoke the old material. Rollback restores the last valid
secret version and gateway config; it never re-enables plaintext ingress or
widens network policy. Record certificate expiry, secret version, rollout,
verification, revocation, and incident/change identifiers.
