import { describe, expect, it } from "vitest";

import {
  ConflictError,
  DatabaseUnavailableError,
  ForbiddenError,
  NotFoundError,
  PostgresRuntime,
  createPostgresPool,
  mapPostgresError,
} from "../src/index.js";
import { RecordingClient, RecordingPool, pgFailure, result } from "./recording-pg.js";

const tenantContext = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  projectId: "33333333-3333-3333-3333-333333333333",
  userId: "operator@example.test",
};

function allowWorkspaceAccess(role: "owner" | "editor" | "reviewer" | "viewer" = "owner") {
  return {
    resolve: async () => ({ role }),
  };
}

function workspaceRow(version = 2): Record<string, unknown> {
  return {
    id: "cooling-water-system",
    name: "Cooling Water System",
    snapshot: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    version,
    created_by: "owner@example.test",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_by: "operator@example.test",
    updated_at: "2026-07-11T00:01:00.000Z",
  };
}

function rawRow(): Record<string, unknown> {
  return {
    raw_object_id: "22222222-2222-2222-2222-222222222222",
    tenant_id: tenantContext.tenantId,
    project_id: "33333333-3333-3333-3333-333333333333",
    dataset_id: null,
    source_connection_id: "44444444-4444-4444-4444-444444444444",
    storage_uri: "s3://raw/2026/07/11/payload.json",
    content_sha256: "a".repeat(64),
    content_type: "application/json",
    byte_size: 123,
    received_at: "2026-07-11T00:00:00.000Z",
    retention_until: null,
    encryption_key_ref: null,
    metadata: { source: "edge" },
  };
}

function ingestionRunRow(): Record<string, unknown> {
  return {
    ingestion_run_id: "55555555-5555-5555-5555-555555555555",
    tenant_id: tenantContext.tenantId,
    project_id: "33333333-3333-3333-3333-333333333333",
    dataset_id: null,
    source_connection_id: "44444444-4444-4444-4444-444444444444",
    raw_object_id: "22222222-2222-2222-2222-222222222222",
    idempotency_key: "edge-run-001",
    state: "queued",
    checkpoint_before: null,
    checkpoint_after: null,
    accepted_records: 0,
    rejected_records: 0,
    started_at: "2026-07-11T00:00:00.000Z",
    completed_at: null,
    error_code: null,
    error_summary: null,
    correlation_id: "66666666-6666-6666-6666-666666666666",
  };
}

describe("PostgresRuntime transaction boundary", () => {
  it("begins, sets transaction-local identity context with parameters, and commits", async () => {
    const client = new RecordingClient();
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    const response = await runtime.withTransaction({
      tenantId: tenantContext.tenantId,
      projectId: tenantContext.projectId,
      userId: "user'with-quote",
      platformAdmin: false,
    }, async (transaction) => {
      expect(transaction.kind).toBe("database-transaction");
      expect(Object.keys(transaction).toSorted()).toEqual(["kind", "query"]);
      return transaction.query({ text: "SELECT $1::text AS value", values: ["safe value"] });
    });

    expect(response.rows).toEqual([]);
    expect(client.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      "SELECT set_config('lock_timeout', $1, true)",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
      "SELECT set_config('odf.tenant_id', $1, true)",
      "SELECT set_config('odf.project_id', $1, true)",
      "SELECT set_config('odf.user_id', $1, true)",
      "SELECT set_config('odf.platform_admin', $1, true)",
      "SELECT $1::text AS value",
      "COMMIT",
    ]);
    expect(client.queries[4]?.values).toEqual([tenantContext.tenantId]);
    expect(client.queries[5]?.values).toEqual([tenantContext.projectId]);
    expect(client.queries[6]?.values).toEqual(["user'with-quote"]);
    expect(client.queries[8]?.values).toEqual(["safe value"]);
    expect(client.queries.some((query) => query.text.includes("user'with-quote"))).toBe(false);
    expect(client.released).toBe(true);
    expect(client.releasedWithError).toBe(false);
  });

  it("rolls back and maps PostgreSQL conflicts without exposing SQL detail", async () => {
    const client = new RecordingClient((query) => (
      query.text === "SELECT $1::text AS value"
        ? pgFailure("23505")
        : result()
    ));
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    await expect(runtime.withTransaction(tenantContext, async (transaction) => (
      transaction.query({ text: "SELECT $1::text AS value", values: ["safe"] })
    ))).rejects.toEqual(expect.any(ConflictError));

    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

describe("database error boundary", () => {
  it("maps stable domain errors without exposing PostgreSQL detail", () => {
    const forbidden = mapPostgresError(pgFailure("42501"));
    const missing = mapPostgresError(pgFailure("23503"));
    const unavailable = mapPostgresError(new Error("SELECT secret FROM private.internal"));

    expect(forbidden).toEqual(expect.any(ForbiddenError));
    expect(missing).toEqual(expect.any(NotFoundError));
    expect(unavailable).toEqual(expect.any(DatabaseUnavailableError));
    expect(unavailable.message).not.toContain("private.internal");
  });
});

describe("pool and probes", () => {
  it("rejects oversized pools before opening a connection", () => {
    expect(() => createPostgresPool({
      connectionString: "postgresql://example.invalid/open_data_fusion",
      max: 51,
    })).toThrow("max must be an integer between 1 and 50");
  });

  it("reports health and catalog-based readiness without tenant table reads", async () => {
    const client = new RecordingClient();
    const pool = new RecordingPool(client, (query) => {
      if (query.text.includes("current_database")) return result([{ database: "odf" }]);
      return result([{
        schema_present: true,
        tenant_data_plane_present: true,
        workspace_scope_present: true,
        project_membership_present: true,
        workspace_grants_present: true,
        api_principal_attested: true,
      }]);
    });
    const runtime = PostgresRuntime.fromPool(pool);

    await expect(runtime.health()).resolves.toMatchObject({ status: "ok", database: "odf" });
    await expect(runtime.readiness()).resolves.toMatchObject({
      status: "ready",
      schemaPresent: true,
      tenantDataPlanePresent: true,
      workspaceScopePresent: true,
      projectMembershipPresent: true,
      workspaceGrantsPresent: true,
      apiPrincipalAttested: true,
    });
    expect(pool.directQueries[1]?.text).toContain("to_regclass('odf.raw_ingest_objects')");
    expect(pool.directQueries[1]?.text).toContain("pg_has_role(current_user, 'odf_app', 'member')");
    expect(pool.directQueries[1]?.text).toContain("pg_has_role(current_user, 'odf_outbox_publisher', 'member')");
    expect(pool.directQueries[1]?.text).toContain("pg_has_role(current_user, 'odf_project_discovery_owner', 'member')");
    expect(pool.directQueries[1]?.text).toContain("pg_has_role(current_user, 'odf_workspace_bootstrap_owner', 'member')");
  });

  it("does not report ready for a principal outside the API least-privilege boundary", async () => {
    const client = new RecordingClient();
    const pool = new RecordingPool(client, () => result([{
      schema_present: true,
      tenant_data_plane_present: true,
      workspace_scope_present: true,
      project_membership_present: true,
      workspace_grants_present: true,
      api_principal_attested: false,
    }]));
    const runtime = PostgresRuntime.fromPool(pool);

    await expect(runtime.readiness()).resolves.toMatchObject({
      status: "not_ready",
      apiPrincipalAttested: false,
    });
  });
});

describe("workspace repository", () => {
  it("can build a database-backed access resolver from the same runtime transaction runner", () => {
    const client = new RecordingClient();
    let suppliedRunner: unknown;
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolverFactory: (runner) => {
        suppliedRunner = runner;
        return allowWorkspaceAccess();
      },
    });

    expect(suppliedRunner).toBe(runtime);
  });

  it("does not disclose a workspace snapshot to a caller without membership", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.startsWith("SELECT workspace.id FROM odf.workspaces AS workspace")) {
        return result([{ id: "cooling-water-system" }]);
      }
      if (query.text.includes("FROM odf.workspaces AS workspace")) return result();
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowWorkspaceAccess(),
    });

    await expect(runtime.workspaces.getWorkspace(tenantContext, "cooling-water-system"))
      .rejects.toEqual(expect.any(ForbiddenError));
    expect(client.queries.some((query) => query.text.includes("membership.user_id = $4"))).toBe(true);
    expect(client.queries.some((query) => query.text.includes("scope.project_id = $3::uuid"))).toBe(true);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("writes the expected-version update, immutable revision, audit, and outbox in one transaction", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("SELECT role FROM odf.workspace_members")) return result([{ role: "editor" }]);
      if (query.text.startsWith("UPDATE odf.workspaces")) return result([workspaceRow()]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowWorkspaceAccess("editor"),
    });

    const workspace = await runtime.workspaces.mutateWorkspace(tenantContext, {
      workspaceId: "cooling-water-system",
      expectedVersion: 1,
      snapshot: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
      changeSummary: "Move P-101",
      actor: tenantContext.userId,
      correlationId: "77777777-7777-7777-7777-777777777777",
    });

    expect(workspace.version).toBe(2);
    const texts = client.queries.map((query) => query.text);
    const updateIndex = texts.findIndex((text) => text.startsWith("UPDATE odf.workspaces"));
    const revisionIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.workspace_revisions"));
    const auditIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.audit_log"));
    const outboxIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.outbox_events"));
    expect(updateIndex).toBeGreaterThan(0);
    expect(revisionIndex).toBeGreaterThan(updateIndex);
    expect(auditIndex).toBeGreaterThan(revisionIndex);
    expect(outboxIndex).toBeGreaterThan(auditIndex);
    expect(texts.at(-1)).toBe("COMMIT");
    expect(client.queries[updateIndex]?.text).toContain("AND version = $4");
    expect(client.queries[updateIndex]?.text).toContain("AND EXISTS (");
    expect(client.queries[updateIndex]?.values?.slice(1)).toEqual([
      tenantContext.userId,
      "cooling-water-system",
      1,
      tenantContext.tenantId,
      tenantContext.projectId,
    ]);
  });

  it("preserves the migration-enforced last-owner invariant through a conflict mapping", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("SELECT role FROM odf.workspace_members")) return result([{ role: "owner" }]);
      if (query.text.startsWith("DELETE FROM odf.workspace_members")) {
        return pgFailure("23514", "workspace_must_retain_owner");
      }
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowWorkspaceAccess(),
    });

    await expect(runtime.workspaces.removeWorkspaceMember(tenantContext, {
      workspaceId: "cooling-water-system",
      actor: tenantContext.userId,
      memberUserId: tenantContext.userId,
      correlationId: "77777777-7777-7777-7777-777777777777",
    })).rejects.toThrow("retain at least one owner");
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });
});

describe("ingestion repository", () => {
  it("stores immutable raw metadata and an idempotent queued run before audit/outbox", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.startsWith("INSERT INTO odf.raw_ingest_objects")) return result([rawRow()]);
      if (query.text.startsWith("INSERT INTO odf.ingestion_runs")) return result([ingestionRunRow()]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    const outcome = await runtime.ingestion.createCanonicalIngest({
      tenantId: tenantContext.tenantId,
      projectId: "33333333-3333-3333-3333-333333333333",
      sourceConnectionId: "44444444-4444-4444-4444-444444444444",
      idempotencyKey: "edge-run-001",
      actor: tenantContext.userId,
      correlationId: "66666666-6666-6666-6666-666666666666",
      raw: {
        storageUri: "s3://raw/2026/07/11/payload.json",
        contentSha256: "a".repeat(64),
        contentType: "application/json",
        byteSize: 123,
      },
    });

    expect(outcome).toMatchObject({ rawObjectCreated: true, ingestionRunCreated: true });
    const texts = client.queries.map((query) => query.text);
    expect(texts.find((text) => text.startsWith("INSERT INTO odf.raw_ingest_objects"))).toContain(
      "ON CONFLICT (tenant_id, source_connection_id, content_sha256) DO NOTHING",
    );
    expect(texts.find((text) => text.startsWith("INSERT INTO odf.ingestion_runs"))).toContain(
      "ON CONFLICT (tenant_id, source_connection_id, idempotency_key) DO NOTHING",
    );
    expect(texts.findIndex((text) => text.startsWith("INSERT INTO odf.ingestion_run_events"))).toBeGreaterThan(0);
    expect(texts.findIndex((text) => text.startsWith("INSERT INTO odf.audit_log"))).toBeGreaterThan(0);
    expect(texts.findIndex((text) => text.startsWith("INSERT INTO odf.outbox_events"))).toBeGreaterThan(0);
  });

  it("reuses matching immutable records without adding duplicate events", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.startsWith("INSERT INTO odf.raw_ingest_objects")) return result();
      if (query.text.includes("FROM odf.raw_ingest_objects")) return result([rawRow()]);
      if (query.text.startsWith("INSERT INTO odf.ingestion_runs")) return result();
      if (query.text.includes("FROM odf.ingestion_runs")) return result([ingestionRunRow()]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    const outcome = await runtime.ingestion.createCanonicalIngest({
      tenantId: tenantContext.tenantId,
      projectId: "33333333-3333-3333-3333-333333333333",
      sourceConnectionId: "44444444-4444-4444-4444-444444444444",
      idempotencyKey: "edge-run-001",
      actor: tenantContext.userId,
      correlationId: "66666666-6666-6666-6666-666666666666",
      raw: {
        storageUri: "s3://raw/2026/07/11/payload.json",
        contentSha256: "a".repeat(64),
        byteSize: 123,
      },
    });

    expect(outcome).toMatchObject({ rawObjectCreated: false, ingestionRunCreated: false });
    expect(client.queries.some((query) => query.text.startsWith("INSERT INTO odf.ingestion_run_events"))).toBe(false);
    expect(client.queries.some((query) => query.text.startsWith("INSERT INTO odf.audit_log"))).toBe(false);
  });
});

describe("queue repository", () => {
  it("uses non-blocking SKIP LOCKED claims for outbox and pipeline workers", async () => {
    const outbox = {
      event_id: "1",
      aggregate_type: "workspace",
      aggregate_id: "cooling-water-system",
      event_type: "workspace.saved",
      event_version: 1,
      topic: "workspace-events",
      message_key: "cooling-water-system",
      payload: { version: 2 },
      headers: {},
      deduplication_key: "workspace:cooling-water-system:v2",
      correlation_id: "77777777-7777-7777-7777-777777777777",
      occurred_at: "2026-07-11T00:00:00.000Z",
      attempt_count: 1,
    };
    const pipeline = {
      pipeline_run_id: "88888888-8888-8888-8888-888888888888",
      tenant_id: tenantContext.tenantId,
      project_id: "33333333-3333-3333-3333-333333333333",
      pipeline_id: "99999999-9999-9999-9999-999999999999",
      pipeline_version: 1,
      state: "running",
      trigger_type: "manual",
      correlation_id: "77777777-7777-7777-7777-777777777777",
      started_at: "2026-07-11T00:00:00.000Z",
      completed_at: null,
      summary: {},
    };
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.outbox_events")) return result([outbox]);
      if (query.text.includes("FROM odf.pipeline_runs")) return result([pipeline]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    expect(await runtime.queues.claimOutboxEvents({
      workerId: "outbox-worker-1",
      batchSize: 10,
      leaseMilliseconds: 30_000,
    })).toHaveLength(1);
    expect(await runtime.queues.claimPipelineRuns({
      tenantId: tenantContext.tenantId,
      projectId: "33333333-3333-3333-3333-333333333333",
      workerId: "pipeline-worker-1",
      batchSize: 5,
      correlationId: "77777777-7777-7777-7777-777777777777",
    })).toHaveLength(1);

    const claims = client.queries.filter((query) => query.text.includes("FOR UPDATE SKIP LOCKED"));
    expect(claims).toHaveLength(2);
    expect(claims.every((query) => query.text.includes("$"))).toBe(true);
    expect(claims.some((query) => query.text.includes("outbox-worker-1"))).toBe(false);
    expect(claims.some((query) => query.text.includes("pipeline-worker-1"))).toBe(false);
    const pipelineClaim = claims.find((query) => query.text.includes("odf.pipeline_run_events"));
    expect(pipelineClaim?.text).toContain("(tenant_id, pipeline_run_id, event_type, state, details)");
    expect(pipelineClaim?.text).not.toContain("correlation_id)");
    const outboxClaim = claims.find((query) => query.text.includes("predecessor.aggregate_type = event.aggregate_type"));
    expect(outboxClaim?.text).toContain("predecessor.aggregate_id = event.aggregate_id");
    expect(outboxClaim?.text).toContain("predecessor.published_at IS NULL");
  });
});
