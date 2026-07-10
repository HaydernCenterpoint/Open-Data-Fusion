# Open Data Fusion

Open Data Fusion is an open-source industrial data integration and contextualization platform. The first vertical slice connects ingest, provenance, an asset graph, time-series data, reviewable relations, audit history, and an Industrial Canvas with versioned workspace history.

This project is independently implemented. It is not affiliated with, endorsed by, or compatible by default with Cognite Data Fusion.

## Current increment

- Local-first API backed by SQLite.
- Idempotent asset and data-point ingest with provenance.
- Asset, time-series, document, relation, and audit endpoints.
- Versioned Canvas workspaces with immutable revisions, optimistic concurrency, and append-only rollback.
- Full semantic Canvas authoring for move, edit, resize, connect, delete, undo, and redo.
- Workspace roles, owner-managed membership, live presence, and committed updates over SSE.
- End-to-end OIDC login (Authorization Code + PKCE), JWT resource-server verification, authenticated SSE, and a reproducible local Keycloak realm.
- PostgreSQL workspace/outbox migration foundation for the planned multi-instance cutover.
- React Industrial Canvas plus an Asset Explorer data-detail view.
- Contextualization relations remain reviewable assertions rather than automatic truth.

## Run locally

Requirements: Node.js 24+ and npm 11+.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The web app runs at `http://localhost:5173`; the API runs at `http://localhost:4310`.

To exercise the local collaboration profile, open separate tabs with `?user=harper.dennis`, `?user=riley.chen`, or `?user=samantha.lee`. Harper and Riley may edit; Samantha is read-only. These query identities are development-only and must be replaced by verified OIDC identity in production.

The optional local identity provider is isolated in its own Compose file:

```powershell
npm run infra:identity
```

The API and Vite both read this root `.env`. See [`infra/keycloak/README.md`](infra/keycloak/README.md) for the OIDC variables and demo login setup. The PostgreSQL schema and transactional outbox are a cutover foundation, not yet the API runtime; see [ADR 0005](docs/architecture/0005-postgresql-cutover-and-transactional-outbox.md).

```powershell
npm run check
```

## Repository layout

```text
apps/api            Local API, SQLite schema, seed data, ingest, audit, workspace revisions
apps/web            React/Vite Industrial Canvas and Asset Explorer
packages/contracts  Shared domain and API types
infra/keycloak      Reproducible local OIDC realm and browser/API clients
infra/postgres      Production workspace, history, membership, audit, and outbox migration
docs/design         Accepted UI concept and design system
docs/architecture   Architecture decision records
```

## Product boundary

The kernel still excludes a shared multi-instance event broker, offline merge-resolution, industrial write-back, P&ID parsing, 3D, and autonomous ML matching. Those capabilities are gated behind a production-like design-partner pilot.
