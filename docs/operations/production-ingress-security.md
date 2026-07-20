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

For a supported edge-agent deployment, mount the client certificate and private
key as read-only files and configure `delivery.mtls.certificateFile` and
`delivery.mtls.privateKeyFile`; configure `delivery.mtls.caFile` when the
gateway uses a private server CA. The agent rejects inline PEM material,
unreadable credentials, non-HTTPS destinations, and invalid TLS credentials
before delivery starts. OAuth remains a separate bearer-authorization layer;
mTLS alone never grants ingest access.

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

Run the automated local/CI proof only after the stack is ready:

```bash
export ODF_SECURITY_INGRESS_SMOKE_CONFIRM=local-security-ingress
bash infra/ci/security-ingress-smoke.sh
```

The smoke requires the approved digest-pinned `ODF_ENVOY_IMAGE` and confirms
that no client certificate fails TLS, a valid certificate reaches the API but
unauthenticated ingest is denied, and non-ingest paths receive the gateway's
404 response. It neither obtains a token nor creates data.

The checked-in `ci-edge-mtls` CSV fixture can additionally prove the supported
edge-agent path end-to-end. It requires an equivalent ready `ci-edge-mtls`
source in the selected tenant/project; the production-like CI fixture creates
that source, while a manual deployment must create it through the governed
platform API first. With the same disposable PKI values, run:

```bash
export ODF_INGRESS_CLIENT_CERT_FILE="$PWD/.local/odf-pki/client.crt"
export ODF_INGRESS_CLIENT_KEY_FILE="$PWD/.local/odf-pki/client.key"
docker compose -f docker-compose.yml \
  -f docker-compose.production-like.yml \
  -f docker-compose.security-rehearsal.yml \
  --profile production-like --profile security-rehearsal --profile edge \
  up -d --build --wait odf-mtls-gateway edge-agent
export ODF_EDGE_MTLS_REHEARSAL_CONFIRM=local-ci-edge-mtls-rehearsal
bash infra/ci/edge-agent-mtls-rehearsal.sh
```

This confirms `CSV → archive/queue → OAuth → edge mTLS → gateway → API` for a
synthetic local record. It does not replace a design-partner connector drill.
Delete the entire local PKI directory and rehearsal volume after use. Never
import its CA or keys into production.

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
