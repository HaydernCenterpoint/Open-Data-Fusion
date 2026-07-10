# ADR 0002: Source of truth and projections

Status: accepted

## Decision

Immutable ingest records are the replay boundary. The canonical model owns current entities, relations, provenance, and review state. Search, graph traversal indexes, and time-series aggregates are rebuildable projections.

Application code must not dual-write independently to multiple serving stores. Future distributed deployments will publish changes through a transactional outbox.

## Consequences

- Every accepted write has an idempotency key, correlation ID, source identity, model version, and audit event.
- Failed payloads are quarantined rather than silently discarded.
- Contextualization output is a reviewable assertion with evidence, confidence, and version metadata.
