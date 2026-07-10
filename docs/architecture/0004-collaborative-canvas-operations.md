# ADR 0004: Collaborative Canvas operations and immutable history

- Status: Accepted
- Date: 2026-07-10

## Context

Open Data Fusion Canvas is now a server-backed workspace with immutable revisions and append-only rollback. Multi-user editing adds three new problems: authorizing mutations, preventing lost updates, and distributing committed changes to connected clients without turning ephemeral presence into durable business data.

## Decision

### Authoritative write path

Clients mutate a workspace by submitting bounded semantic operations against a `baseVersion`:

```text
moveNode | addNode | updateNode | removeNode | addEdge | updateEdge | removeEdge
```

The API validates membership, version, operation shape, node/edge referential integrity, and the resulting snapshot inside one database transaction. A successful command:

1. updates the current workspace snapshot;
2. increments the workspace version;
3. appends an immutable revision containing the complete snapshot;
4. appends an audit event with actor, correlation ID, base/new version and summary;
5. publishes a `workspace.updated` event after commit.

The current snapshot is a fast read model. Revisions are the durable recovery record. Rollback always appends another revision; it never rewrites or deletes earlier versions.

### Concurrency

Every mutation includes `baseVersion`. If it differs from the current version, the API returns HTTP 409. The client reloads the current snapshot, surfaces a conflict, and lets the user retry or merge. The server never applies operations silently to an unexpected version.

This first collaboration increment uses operation-level optimistic concurrency rather than CRDT/OT. It keeps behavior deterministic and auditable while the product is still defining its editing semantics.

### Authorization

Workspace membership roles are:

- `owner`: manage and edit the workspace;
- `editor`: edit the workspace;
- `reviewer`: read and review history;
- `viewer`: read only.

The development profile derives identity from `x-odf-user`. The OIDC profile verifies bearer signature, issuer, audience, expiry and configured identity claim, and ignores identity supplied in request bodies or query parameters. Authorization is enforced by the API, never only by the Canvas UI. Only owners may add, change, or remove members, and neither the API transaction nor the PostgreSQL production schema permits removing the final owner.

### Live distribution and presence

HTTP remains the authoritative command path. Server-Sent Events distribute committed `workspace.updated` and `members.updated` events plus ephemeral `presence.updated` events. OIDC clients stream through `fetch` with a bearer header; only the explicit development profile uses EventSource `?user=`.

- A client that observes a newer workspace version reloads the workspace.
- Events may be duplicated or missed during disconnect; version comparison makes reconnect deterministic.
- Presence is in-memory, best-effort and never part of a revision.
- Heartbeats keep proxies from closing idle streams.
- Horizontal production deployment requires a shared event backbone such as Redis Streams or Kafka; the local in-memory hub is single-process only.

## Invariants

- Only committed database changes are broadcast.
- Every durable mutation creates exactly one next workspace version and one revision.
- Revision `(workspace_id, version)` is immutable and unique.
- Every edge references nodes that exist in the resulting snapshot.
- Removing a node also removes or rejects its incident edges according to the operation contract.
- A stale `baseVersion` cannot modify the workspace.
- Audit actor comes from authenticated request identity in production.
- Presence does not grant access and is never accepted as authorization evidence.

## Consequences

The model is simple to reason about, test and roll back. Highly concurrent editing of the same workspace may produce visible 409 conflicts. If real deployments show sustained contention, operation logs can later feed finer-grained merging or a CRDT layer while preserving the revision/audit boundary defined here.

## Verification checklist

- Owner/editor operations succeed and append revisions.
- Viewer mutation is rejected.
- Stale operation receives 409 and changes nothing.
- Invalid edge references are rejected atomically.
- Two clients receive a committed version event and reload.
- Disconnect/reconnect converges by comparing workspace versions.
- Rollback creates a new revision and retains all earlier revisions.
- Audit records contain actor, correlation ID and version transition.
