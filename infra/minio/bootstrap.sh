#!/bin/sh
# Idempotent private bucket bootstrap for the production-like S3-compatible
# reference profile. Root credentials stay in this one-shot job; API replicas
# receive only the narrow application credentials created here.

set -eu

root_user="$(cat /run/secrets/odf_minio_root_user)"
root_password="$(cat /run/secrets/odf_minio_root_password)"
api_access_key="$(cat /run/secrets/odf_minio_api_access_key)"
api_secret_key="$(cat /run/secrets/odf_minio_api_secret_key)"
bucket="${ODF_MINIO_BUCKET:-odf-objects}"

mc alias set odf http://odf-minio:9000 "$root_user" "$root_password"

attempt=0
until mc admin info odf >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Timed out waiting for the S3-compatible storage service" >&2
    exit 1
  fi
  sleep 1
done

mc mb --ignore-existing "odf/${bucket}"
mc version enable "odf/${bucket}"
mc anonymous set none "odf/${bucket}"
# The MinIO reference server receives a static KMS key from a Docker secret.
# Set bucket-default SSE-S3 as defense in depth; the API also requires and
# verifies the AES256 response header for every immutable object.
mc encrypt set sse-s3 "odf/${bucket}"

cat > /tmp/odf-api-object-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:GetBucketVersioning"],
      "Resource": ["arn:aws:s3:::${bucket}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
      "Resource": ["arn:aws:s3:::${bucket}/odf/v1/*"]
    }
  ]
}
EOF

mc admin policy create odf odf-api-object-store /tmp/odf-api-object-policy.json >/dev/null 2>&1 \
  || mc admin policy update odf odf-api-object-store /tmp/odf-api-object-policy.json

# The bootstrap job gates both API replicas, so replacing an existing
# application user here is safe and makes a same-access-key secret rotation
# effective even when the MinIO data volume persists across deployments. User
# removal also clears any stale policy attachments before the sole approved
# policy is reattached.
if mc admin user info odf "$api_access_key" >/dev/null 2>&1; then
  mc admin user remove odf "$api_access_key"
fi
mc admin user add odf "$api_access_key" "$api_secret_key"
mc admin policy attach odf odf-api-object-store --user "$api_access_key"

# Fail the bootstrap gate unless bucket versioning, bucket-default SSE-S3, and
# anonymous/private access all have their exact expected states.
sh /verify.sh admin
