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
- PostgreSQL workspace/outbox migration foundation plus a transactional SQLite cutover rehearsal/import workflow for the planned multi-instance cutover.
- Responsive React Industrial Canvas plus an Asset Explorer data-detail view.
- URL-synchronized views, assets, tenants, and projects with browser back/forward support.
- Timestamp-aware telemetry charts with data-derived axes and honest latest-available fallbacks.
- Keyboard-accessible search, tabs, dialogs, Canvas inspection, and responsive contextual drawers.
- Contextualization relations remain reviewable assertions with explicit confirmation and review evidence rather than automatic truth.

## Run locally

Requirements: Node.js 24+ and npm 11+.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The web app runs at `http://localhost:5173`; the API runs at `http://localhost:4310`.

To exercise the local collaboration profile, open separate tabs with `?user=harper.dennis`, `?user=riley.chen`, or `?user=samantha.lee`. Harper and Riley may edit; Samantha is read-only. These query identities are development-only and must be replaced by verified OIDC identity in production.

### Deep-link the web workspace

The web client keeps its active surface and project context in the URL. For example:

```text
http://localhost:5173/?view=explorer&asset=P-101&tenant=demo&project=north-plant
```

Supported `view` values are `canvas`, `explorer`, `sources`, `pipelines`, `models`, `context`, `diagrams`, `matching`, `spatial`, `writeback`, and `audit`. The optional development `user` parameter can be combined with these route parameters. Unknown query parameters are preserved for the OIDC flow.

The optional local identity provider is isolated in its own Compose file:

```powershell
npm run infra:identity
```

The API and Vite both read this root `.env`. See [`infra/keycloak/README.md`](infra/keycloak/README.md) for the OIDC variables and demo login setup. The PostgreSQL schema and transactional outbox are a cutover foundation, not yet the API runtime; see [ADR 0005](docs/architecture/0005-postgresql-cutover-and-transactional-outbox.md).

### Rehearse a SQLite cutover

Create a deterministic preflight bundle before planning a one-way PostgreSQL import:

```powershell
npm run cutover:preflight --workspace @open-data-fusion/api -- `
  --database data/open-data-fusion.db `
  --output "$env:TEMP\odf-cutover-preflight.json"
```

The command opens SQLite read-only, validates workspace history and membership invariants, then writes the JSON bundle only when validation succeeds. It does not alter SQLite or enable dual writes.

After applying PostgreSQL migrations 001–004, connect with a dedicated login that inherits the non-login `odf_cutover` role. Keep the connection URL in the environment rather than a command argument:

```powershell
$env:ODF_POSTGRES_URL = "postgresql://odf_cutover_login:secret@localhost:5432/odf"
npm run cutover:import --workspace @open-data-fusion/api -- `
  --bundle "$env:TEMP\odf-cutover-preflight.json" `
  --database data/open-data-fusion.db
```

The import command is a dry-run by default: it takes a PostgreSQL advisory lock, verifies the target is empty and current, inserts all four workspace-history datasets, validates counts, current revisions, owners, and canonical checksums, then rolls the transaction back. Add `--apply` only inside the planned maintenance window to commit the same verified transaction:

```powershell
npm run cutover:import --workspace @open-data-fusion/api -- `
  --bundle "$env:TEMP\odf-cutover-preflight.json" `
  --database data/open-data-fusion.db `
  --apply
```

Legacy non-UUID correlation IDs are mapped deterministically to PostgreSQL UUIDs; the result reports the mapping checksum and remap count. The importer never creates historical outbox events and refuses a non-empty target. This completes an export/import rehearsal for [ADR 0005](docs/architecture/0005-postgresql-cutover-and-transactional-outbox.md); it still does not switch the API runtime from SQLite to PostgreSQL.

```powershell
npm run check
```

## Repository layout

```text
apps/api            Local API, SQLite schema, seed data, ingest, audit, workspace revisions
apps/web            Responsive React/Vite Canvas, Explorer, and governed platform surfaces
packages/contracts          Shared domain and API types
packages/platform-core      Shared governed platform policies and domain logic
packages/postgres-runtime   Typed PostgreSQL repositories and transaction boundary
infra/keycloak              Reproducible local OIDC realm and browser/API clients
infra/postgres      Production workspace, history, membership, audit, and outbox migration
docs/design         Accepted UI concept and design system
docs/architecture   Architecture decision records
```

## Product boundary

The kernel still excludes a shared multi-instance event broker and offline merge-resolution. Industrial write-back is fail-closed unless an external executor and backend policy are configured; critical requests remain non-executable. Diagram extraction is currently text/tag based, Spatial uses a lightweight review schematic rather than a 3D engine, and matching outputs remain proposal-only. Full P&ID parsing, production 3D, and autonomous ML acceptance remain gated behind a production-like design-partner pilot.
