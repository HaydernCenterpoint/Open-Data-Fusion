#!/usr/bin/env bash
# Generates a short-lived local CA, server certificate, and client certificate
# solely for the mTLS rehearsal overlay. Production certificates must come from
# the organisation's PKI/secret manager and must never reuse these keys.

set -euo pipefail
umask 077

output_directory="${1:-}"
if [ -z "$output_directory" ]; then
  echo "Usage: generate-rehearsal-pki.sh <empty-output-directory>" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required" >&2
  exit 1
fi
if [ -e "$output_directory" ] && [ -n "$(find "$output_directory" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
  echo "Output directory must be empty so existing key material is never overwritten" >&2
  exit 1
fi
mkdir -p "$output_directory"
chmod 700 "$output_directory"

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$output_directory/ca.key"
openssl req -x509 -new -sha256 -days 7 \
  -key "$output_directory/ca.key" \
  -subj "/CN=ODF rehearsal CA" \
  -out "$output_directory/ca.crt"

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$output_directory/server.key"
openssl req -new -sha256 \
  -key "$output_directory/server.key" \
  -subj "/CN=localhost" \
  -out "$output_directory/server.csr"
cat >"$output_directory/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:odf-mtls-gateway,IP:127.0.0.1
EOF
openssl x509 -req -sha256 -days 7 \
  -in "$output_directory/server.csr" \
  -CA "$output_directory/ca.crt" \
  -CAkey "$output_directory/ca.key" \
  -CAcreateserial \
  -extfile "$output_directory/server.ext" \
  -out "$output_directory/server.crt"

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$output_directory/client.key"
openssl req -new -sha256 \
  -key "$output_directory/client.key" \
  -subj "/CN=ODF rehearsal connector" \
  -out "$output_directory/client.csr"
cat >"$output_directory/client.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=URI:spiffe://open-data-fusion/rehearsal/connector
EOF
openssl x509 -req -sha256 -days 7 \
  -in "$output_directory/client.csr" \
  -CA "$output_directory/ca.crt" \
  -CAkey "$output_directory/ca.key" \
  -CAserial "$output_directory/ca.srl" \
  -extfile "$output_directory/client.ext" \
  -out "$output_directory/client.crt"

openssl verify -CAfile "$output_directory/ca.crt" "$output_directory/server.crt" "$output_directory/client.crt" >/dev/null
rm -f "$output_directory"/*.csr "$output_directory"/*.ext "$output_directory/ca.srl"
chmod 600 "$output_directory"/*.key "$output_directory"/*.crt

absolute_directory="$(cd "$output_directory" && pwd)"
cat <<EOF
Rehearsal PKI created for seven days. Export:
ODF_INGRESS_TLS_CERT_FILE=${absolute_directory}/server.crt
ODF_INGRESS_TLS_KEY_FILE=${absolute_directory}/server.key
ODF_INGRESS_CLIENT_CA_FILE=${absolute_directory}/ca.crt

Test clients with:
  --cert ${absolute_directory}/client.crt --key ${absolute_directory}/client.key --cacert ${absolute_directory}/ca.crt
EOF
