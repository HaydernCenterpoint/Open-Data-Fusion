# Open Data Fusion API

Backend vertical slice for industrial asset context, telemetry, ingestion, provenance, relation review, audit, and versioned Canvas workspaces.

## Run

Node.js 24 or newer is required because the database uses the built-in `node:sqlite` module.

```sh
npm install
npm run dev
```

The API listens on `http://localhost:4310` by default. Set `PORT`, `ODF_DATABASE_PATH`, or `ODF_SEED=false` to override runtime defaults. Authentication profiles and OIDC variables are documented in [`docs/security/authentication.md`](../../docs/security/authentication.md).

## API

- `GET /health` and `GET /api/health`
- `GET /api/v1/assets?q=&type=&limit=&offset=`
- `GET /api/v1/assets/:externalId`
- `GET /api/v1/assets/:externalId/telemetry?from=&to=&timeSeriesExternalId=&limit=`
- `POST /api/ingest` and `POST /api/v1/ingest/bundle`
- `GET /api/v1/relations?status=proposed`
- `POST /api/v1/relations/:id/review`
- `GET /api/v1/audit?action=&entityType=&entityId=&limit=&offset=`
- `GET /api/v1/workspaces/:id`
- `PUT /api/v1/workspaces/:id` with `expectedVersion`, `actor`, `changeSummary`, and `snapshot`
- `GET /api/v1/workspaces/:id/revisions?limit=&offset=`
- `POST /api/v1/workspaces/:id/rollback` with `expectedVersion`, `targetVersion`, and `actor`
- `GET /api/v1/workspaces/:id/members`
- `PUT /api/v1/workspaces/:id/members/:userId` with owner-only `displayName` and `role`
- `DELETE /api/v1/workspaces/:id/members/:userId` (owner-only)
- `POST /api/v1/workspaces/:id/operations` with `baseVersion`, `changeSummary`, and semantic operations
- `GET /api/v1/workspaces/:id/events?user=` as a Server-Sent Events stream

Example bundle:

```json
{
  "source": {
    "system": "opcua-north-plant",
    "runId": "opcua-2026-07-10T14:00:00Z",
    "actor": "edge-connector"
  },
  "dataPoints": [
    {
      "timeSeriesExternalId": "P-101-PRESSURE",
      "timestamp": "2026-07-10T14:00:00Z",
      "value": 111.2,
      "quality": "good"
    }
  ]
}
```

`runId` is an idempotency key. Replaying the same run and payload returns `already_processed`; reusing it with a different payload returns HTTP 409.

## Workspace revisions

The seeded `cooling-water-system` workspace starts at version 1. Every successful `PUT` requires the caller's `expectedVersion`, writes a new immutable revision, and increments the current version. A stale save receives HTTP 409 instead of overwriting another user's changes.

Rollback is append-only: restoring revision 1 while the workspace is at version 4 creates version 5 containing revision 1's snapshot. Revisions 1–4 remain available for audit and future rollback.

### Collaborative editing

The development profile resolves the current workspace identity from `x-odf-user` and defaults to `harper.dennis`. Seeded members demonstrate four roles: owner, editor, reviewer, and viewer. Only owner/editor may mutate the Canvas; reviewer/viewer remain read-only. Owners can add, change, or remove members; the database rejects any change that would leave a workspace without an owner.

`POST /operations` accepts atomic batches of `moveNode`, `addNode`, `updateNode`, `removeNode`, `addEdge`, `updateEdge`, and `removeEdge`. Every batch must target the current `baseVersion`, produces one immutable revision and audit event, then publishes `workspace.updated` after commit. Stale batches return HTTP 409; invalid graph references return HTTP 422.

The SSE endpoint publishes committed workspace versions and best-effort online presence. Clients reconnect by reloading the workspace and comparing version numbers. The in-memory hub is a local single-process profile; production horizontal scaling requires a shared event transport. In OIDC mode the API verifies bearer signature, issuer, audience, expiry, algorithm, and the configured identity claim; development header/query identities are ignored.

## Verify

```sh
npm run typecheck
npm test
npm run build
```
