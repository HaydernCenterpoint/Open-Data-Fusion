# Open Data Fusion edge agent

The edge agent performs read-only, checkpointed collection and durable store-and-forward delivery to
`POST /api/v1/ingest/bundle`.

For every source batch it follows this order:

1. read a bounded batch without mutating the source;
2. write the raw records to the archive directory;
3. atomically enqueue the ingest bundle and advance the source checkpoint in SQLite;
4. deliver queued work with a cached OAuth 2.0 client-credentials token.

If the API is unavailable, the checkpoint remains safe because the archived bundle stays in the local queue. Failed
deliveries use capped exponential backoff. SIGINT and SIGTERM stop new polls, close source clients, and drain ready
queue entries until `shutdownDrainTimeoutMs` expires; remaining entries are retained for the next start.

## Configuration

Copy `config.example.json`, keep credentials out of that file, and set `ODF_EDGE_CONFIG` to its path. Every credential
is specified by an environment-variable name such as `ODF_EDGE_CLIENT_SECRET`; unknown inline fields are rejected.
`delivery.tenantId` and `delivery.projectId` are sent as governed scope headers on every ingest request. The connector
service identity must be a member of that project and cannot select a scope outside its assigned platform policy.

CSV checkpoints include file identity, processed-row count, and a boundary hash. A replaced, truncated, or rewritten
file fails closed instead of silently skipping records. PostgreSQL queries must be one read-only `SELECT`/`WITH`
statement, use `$1` as the exclusive checkpoint and `$2` as the limit, and include deterministic `ORDER BY`.
PostgreSQL sessions also set `default_transaction_read_only=on`. OPC-UA supports anonymous or environment-backed
username authentication, configurable message security, per-node mapping/scaling, status-to-quality conversion, and
per-node timestamp checkpoints.

```powershell
$env:ODF_EDGE_CONFIG = "apps/edge-agent/config.example.json"
$env:ODF_EDGE_CLIENT_ID = "open-data-fusion-edge"
$env:ODF_EDGE_CLIENT_SECRET = "..."
npm run start --workspace @open-data-fusion/edge-agent
```
