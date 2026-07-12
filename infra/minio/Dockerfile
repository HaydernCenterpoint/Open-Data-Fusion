# Build the object-store reference image from the exact upstream security
# release commit. MinIO no longer publishes a maintained server image after
# the 2025-10-15 security release, so the production-like profile must not
# silently pull the older vulnerable Docker Hub tag.
#
# Both external base image references are immutable multi-architecture OCI
# indexes. The source revision is the signed
# RELEASE.2025-10-15T17-29-55Z commit.
FROM golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848 AS build

ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git /src \
  && cd /src \
  && git checkout --detach "${MINIO_COMMIT}" \
  && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"

WORKDIR /src

RUN CGO_ENABLED=0 GOOS=linux GOARCH="$(go env GOARCH)" \
  go build -tags kqueue -trimpath \
  --ldflags "$(go run ./buildscripts/gen-ldflags.go)" \
  -o /out/minio ./

FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 minio \
  && useradd --system --uid 10001 --gid minio --home-dir /home/minio --create-home --shell /usr/sbin/nologin minio \
  && mkdir -p /data \
  && chown -R minio:minio /data /home/minio

COPY --from=build /out/minio /usr/local/bin/minio

ENV HOME=/home/minio
USER minio
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data"]
