import { describe, expect, it } from "vitest";

import { ConflictError, NotFoundError, PostgresRuntime } from "../src/index.js";
import { normalizeModelInstanceBatch } from "../src/model-instance-helpers.js";
import { RecordingClient, RecordingPool, result } from "./recording-pg.js";

const scope = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  userId: "modeler@example.test",
};
const internalModelId = "33333333-3333-3333-3333-333333333333";
const internalSpaceId = "44444444-4444-4444-4444-444444444444";
const internalViewId = "55555555-5555-5555-5555-555555555555";

const modelRow = {
  data_model_id: internalModelId,
  tenant_id: scope.tenantId,
  project_id: scope.projectId,
  space_id: internalSpaceId,
  external_id: "plant-model",
  version: "2",
  name: "Plant model",
  description: null,
  definition: { source: "public-api" },
  state: "draft",
  created_by: scope.userId,
  created_at: "2026-07-17T07:00:00.000Z",
  published_at: null,
};
const viewDefinition = {
  externalId: "Equipment",
  name: "Equipment",
  usedFor: "node" as const,
  properties: { name: { type: "text" as const, required: true } },
};
const viewRow = {
  model_view_id: internalViewId,
  tenant_id: scope.tenantId,
  data_model_id: internalModelId,
  external_id: "Equipment",
  version: "2",
  name: "Equipment",
  definition: viewDefinition,
  created_at: "2026-07-17T07:00:00.000Z",
};
const edgeViewDefinition = {
  externalId: "Feeds",
  name: "Feeds",
  usedFor: "edge" as const,
  properties: {},
};
const edgeViewRow = {
  ...viewRow,
  model_view_id: "99999999-9999-9999-9999-999999999999",
  external_id: "Feeds",
  name: "Feeds",
  definition: edgeViewDefinition,
};

function allowAll(events: string[] = []) {
  return {
    resolve: async () => {
      events.push("policy");
      return { role: "owner" as const };
    },
    resolveTenantManagement: async () => ({ canManageProjects: true }),
  };
}

describe("PostgreSQL public model lifecycle", () => {
  it("allocates a version in the deterministic default space and commits audit/outbox last", async () => {
    const events: string[] = [];
    const client = new RecordingClient((query) => {
      events.push(`query:${query.text}`);
      if (query.text.includes("FROM odf.model_spaces")) return result([{ space_id: internalSpaceId }]);
      if (query.text.includes("AS next_version")) return result([{ next_version: 2 }]);
      if (query.text.startsWith("INSERT INTO odf.data_models")) return result([modelRow]);
      if (query.text.startsWith("INSERT INTO odf.model_views")) return result([viewRow]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowAll(events),
    });

    const created = await runtime.models.createModelVersion(scope, "plant-model", {
      name: "Plant model",
      schema: { source: "public-api" },
      views: [viewDefinition],
      correlationId: "66666666-6666-6666-6666-666666666666",
    });

    expect(created).toEqual({
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      id: "plant-model",
      version: 2,
      name: "Plant model",
      schema: { source: "public-api" },
      status: "draft",
      createdBy: scope.userId,
      createdAt: "2026-07-17T07:00:00.000Z",
      publishedAt: null,
    });
    expect(events[0]).toBe("policy");
    expect(client.queries[0]?.text).toBe("BEGIN");
    expect(client.queries.some((query) => query.text.includes("set_config('statement_timeout'") && query.values?.[0] === "5000ms")).toBe(true);
    const spaceQuery = client.queries.find((query) => query.text.includes("FROM odf.model_spaces"));
    expect(spaceQuery?.text).toContain("ORDER BY model_spaces.created_at, model_spaces.space_id");
    const lock = client.queries.find((query) => query.text.includes("pg_advisory_xact_lock"));
    expect(lock?.values).toEqual([`odf:model:${scope.tenantId}:${scope.projectId}:plant-model`]);
    const allocation = client.queries.find((query) => query.text.includes("AS next_version"));
    expect(allocation?.text).toContain("version ~ '^[1-9][0-9]*$'");
    const texts = client.queries.map((query) => query.text);
    const modelIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.data_models"));
    const viewIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.model_views"));
    const auditIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.audit_log"));
    const outboxIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.outbox_events"));
    expect(viewIndex).toBeGreaterThan(modelIndex);
    expect(auditIndex).toBeGreaterThan(viewIndex);
    expect(outboxIndex).toBeGreaterThan(auditIndex);
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("keeps published definitions immutable", async () => {
    const published = { ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" };
    const client = new RecordingClient((query) => (
      query.text.includes("FROM odf.data_models") ? result([published]) : result()
    ));
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.createModelView(scope, "plant-model", 2, {
      ...viewDefinition,
      correlationId: "77777777-7777-7777-7777-777777777777",
    })).rejects.toEqual(expect.any(ConflictError));
    await expect(runtime.models.publishModelVersion(
      scope,
      "plant-model",
      2,
      "88888888-8888-8888-8888-888888888888",
    )).rejects.toEqual(expect.any(ConflictError));
    expect(client.queries.some((query) => query.text.startsWith("INSERT INTO odf.model_views"))).toBe(false);
  });

  it("maps a missing public version to not found using scoped SQL", async () => {
    const client = new RecordingClient();
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.getModelVersion(scope, "missing-model", 9)).rejects.toEqual(expect.any(NotFoundError));
    const query = client.queries.find((entry) => entry.text.includes("FROM odf.data_models"));
    expect(query?.text).toContain("tenant_id = $1::uuid AND project_id = $2::uuid");
    expect(query?.values).toEqual([scope.tenantId, scope.projectId, "missing-model", "9"]);
  });

  it("atomically upserts two nodes and one edge without persisting properties in replay evidence", async () => {
    let graphInsert = 0;
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.data_models") && query.text.includes("state = 'published'")) {
        return result([{ ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" }]);
      }
      if (query.text.includes("FROM odf.model_views")) return result([viewRow, edgeViewRow]);
      if (query.text.includes("FROM odf.model_graph_batch_keys")) return result();
      if (query.text.includes("FROM odf.model_spaces")) return result([{ space_id: internalSpaceId, external_id: "plant-a" }]);
      if (query.text.includes("existing_graph_instances")) return result();
      if (query.text.startsWith("INSERT INTO odf.graph_instances")) {
        graphInsert += 1;
        return result([{
          instance_id: `aaaaaaaa-aaaa-aaaa-aaaa-${String(graphInsert).padStart(12, "0")}`,
          tenant_id: scope.tenantId,
          project_id: scope.projectId,
          dataset_id: null,
          space_id: internalSpaceId,
          external_id: graphInsert === 1 ? "source" : graphInsert === 2 ? "target" : "feeds",
          instance_kind: graphInsert < 3 ? "node" : "edge",
          data_model_id: internalModelId,
          model_view_id: graphInsert < 3 ? internalViewId : edgeViewRow.model_view_id,
          source_instance_id: graphInsert === 3 ? "aaaaaaaa-aaaa-aaaa-aaaa-000000000001" : null,
          target_instance_id: graphInsert === 3 ? "aaaaaaaa-aaaa-aaaa-aaaa-000000000002" : null,
          properties: graphInsert === 1 ? { name: "Source" } : graphInsert === 2 ? { name: "Target" } : {},
          valid_from: null,
          valid_to: null,
          created_at: "2026-07-17T09:00:00.000Z",
          updated_at: "2026-07-17T09:00:00.000Z",
          created: true,
        }]);
      }
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.upsertModelInstances(scope, "plant-model", 2, {
      idempotencyKey: "batch-1",
      instances: [
        { space: "plant-a", externalId: "source", kind: "node", viewExternalId: "Equipment", properties: { name: "Source" } },
        { space: "plant-a", externalId: "target", kind: "node", viewExternalId: "Equipment", properties: { name: "Target" } },
        {
          space: "plant-a", externalId: "feeds", kind: "edge", viewExternalId: "Feeds", properties: {},
          source: { space: "plant-a", externalId: "source" },
          target: { space: "plant-a", externalId: "target" },
        },
      ],
    }, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).resolves.toMatchObject({
      modelId: "plant-model",
      version: 2,
      total: 3,
      created: 3,
      updated: 0,
      replayed: false,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    expect(graphInsert).toBe(3);
    const replayWrite = client.queries.find((query) => query.text.startsWith("INSERT INTO odf.model_graph_batch_keys"));
    expect(replayWrite).toBeDefined();
    expect(replayWrite?.values?.some((value) => String(value).includes("properties"))).toBe(false);
    const auditAndOutbox = client.queries.filter((query) => query.text.startsWith("INSERT INTO odf.audit_log") || query.text.startsWith("INSERT INTO odf.outbox_events"));
    expect(auditAndOutbox).toHaveLength(2);
    expect(auditAndOutbox.flatMap((query) => query.values ?? []).some((value) => String(value).includes("properties"))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("returns exact replays without mutation and rejects changed bodies", async () => {
    const original = {
      idempotencyKey: "batch-replay",
      instances: [{
        space: "plant-a", externalId: "pump", kind: "node" as const,
        viewExternalId: "Equipment", properties: { name: "Pump" },
      }],
    };
    const requestHash = normalizeModelInstanceBatch("plant-model", 2, [viewDefinition], original).requestHash;
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.data_models") && query.text.includes("state = 'published'")) {
        return result([{ ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" }]);
      }
      if (query.text.includes("FROM odf.model_views")) return result([viewRow]);
      if (query.text.includes("FROM odf.model_graph_batch_keys")) {
        return result([{ request_hash: requestHash, summary: { total: 1, created: 1, updated: 0 } }]);
      }
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.upsertModelInstances(
      scope, "plant-model", 2, original, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    )).resolves.toMatchObject({ replayed: true, requestHash, total: 1, created: 1, updated: 0 });
    expect(client.queries.some((query) => query.text.startsWith("INSERT INTO odf.graph_instances"))).toBe(false);
    expect(client.queries.some((query) => query.text.startsWith("INSERT INTO odf.audit_log"))).toBe(false);

    await expect(runtime.models.upsertModelInstances(scope, "plant-model", 2, {
      ...original,
      instances: [{ ...original.instances[0]!, properties: { name: "Changed" } }],
    }, "cccccccc-cccc-cccc-cccc-cccccccccccc")).rejects.toEqual(expect.any(ConflictError));
  });

  it("rolls back before writes when a direct reference is missing", async () => {
    const referenceView = {
      ...viewDefinition,
      properties: {
        ...viewDefinition.properties,
        parent: { type: "direct" as const },
      },
    };
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.data_models") && query.text.includes("state = 'published'")) {
        return result([{ ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" }]);
      }
      if (query.text.includes("FROM odf.model_views")) return result([{ ...viewRow, definition: referenceView }]);
      if (query.text.includes("FROM odf.model_graph_batch_keys")) return result();
      if (query.text.includes("FROM odf.model_spaces")) return result([{ space_id: internalSpaceId, external_id: "plant-a" }]);
      if (query.text.includes("existing_graph_instances")) return result();
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.upsertModelInstances(scope, "plant-model", 2, {
      idempotencyKey: "missing-reference",
      instances: [{
        space: "plant-a", externalId: "pump", kind: "node", viewExternalId: "Equipment",
        properties: { name: "Pump", parent: { space: "plant-a", externalId: "missing" } },
      }],
    }, "dddddddd-dddd-dddd-dddd-dddddddddddd")).rejects.toEqual(expect.any(NotFoundError));
    expect(client.queries.some((query) => query.text.startsWith("INSERT INTO odf.graph_instances"))).toBe(false);
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("accepts the full 100-instance atomic batch", async () => {
    let graphInsert = 0;
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.data_models") && query.text.includes("state = 'published'")) {
        return result([{ ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" }]);
      }
      if (query.text.includes("FROM odf.model_views")) return result([viewRow]);
      if (query.text.includes("FROM odf.model_graph_batch_keys")) return result();
      if (query.text.includes("FROM odf.model_spaces")) return result([{ space_id: internalSpaceId, external_id: "plant-a" }]);
      if (query.text.includes("existing_graph_instances")) return result();
      if (query.text.startsWith("INSERT INTO odf.graph_instances")) {
        graphInsert += 1;
        return result([{
          instance_id: `aaaaaaaa-aaaa-aaaa-bbbb-${String(graphInsert).padStart(12, "0")}`,
          tenant_id: scope.tenantId, project_id: scope.projectId, dataset_id: null,
          space_id: internalSpaceId, external_id: String(query.values?.[3]), instance_kind: "node",
          data_model_id: internalModelId, model_view_id: internalViewId,
          source_instance_id: null, target_instance_id: null, properties: { name: String(query.values?.[3]) },
          valid_from: null, valid_to: null,
          created_at: "2026-07-17T09:00:00.000Z", updated_at: "2026-07-17T09:00:00.000Z", created: true,
        }]);
      }
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.upsertModelInstances(scope, "plant-model", 2, {
      idempotencyKey: "batch-100",
      instances: Array.from({ length: 100 }, (_, index) => ({
        space: "plant-a", externalId: `node-${index}`, kind: "node" as const,
        viewExternalId: "Equipment", properties: { name: `Node ${index}` },
      })),
    }, "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")).resolves.toMatchObject({ total: 100, created: 100, updated: 0 });
    expect(graphInsert).toBe(100);
  });

  it("queries with stable keyset pagination and projected properties", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.data_models") && query.text.includes("state = 'published'")) {
        return result([{ ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" }]);
      }
      if (query.text.includes("FROM odf.model_views")) return result([viewRow]);
      if (query.text.includes("JOIN odf.model_spaces space")) {
        return result(["a", "b", "c"].map((externalId, index) => ({
          instance_kind: "node",
          view_external_id: "Equipment",
          space_external_id: "plant-a",
          external_id: externalId,
          properties: { name: externalId.toUpperCase() },
          created_at: "2026-07-17T09:00:00.000Z",
          updated_at: "2026-07-17T09:00:00.000Z",
          source_space_external_id: null,
          source_external_id: null,
          target_space_external_id: null,
          target_external_id: null,
          sort_is_null: false,
          sort_value: index + 1,
        })));
      }
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    const page = await runtime.models.queryModelInstances(scope, "plant-model", 2, {
      viewExternalId: "Equipment",
      projection: ["name"],
      sort: { property: "name", direction: "asc" },
      limit: 2,
    });

    expect(page.items.map((item) => item.externalId)).toEqual(["a", "b"]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.nextCursor).not.toContain("plant-a");
    const query = client.queries.find((entry) => entry.text.includes("JOIN odf.model_spaces space"));
    expect(query?.text).toContain("IS NULL ASC");
    expect(query?.text).toContain("space.external_id ASC, graph.external_id ASC");
    expect(query?.values?.at(-1)).toBe(3);
  });

  it("uses a bounded recursive CTE for traversal and returns key-only paths", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.data_models") && query.text.includes("state = 'published'")) {
        return result([{ ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" }]);
      }
      if (query.text.includes("FROM odf.model_views")) return result([viewRow, edgeViewRow]);
      if (query.text.includes("WITH RECURSIVE start_nodes")) return result([{
        instance_path: [{ space: "plant-a", externalId: "source" }, { space: "plant-a", externalId: "target" }],
        edge_path: [{ space: "plant-a", externalId: "feeds" }],
      }]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.traverseModelInstances(scope, "plant-model", 2, {
      starts: [{ space: "plant-a", externalId: "source" }],
      direction: "out",
      edgeViewExternalId: "Feeds",
      maxHops: 3,
      limit: 10,
    })).resolves.toEqual({
      paths: [{
        instances: [{ space: "plant-a", externalId: "source" }, { space: "plant-a", externalId: "target" }],
        edges: [{ space: "plant-a", externalId: "feeds" }],
      }],
      truncated: false,
    });
    const query = client.queries.find((entry) => entry.text.includes("WITH RECURSIVE start_nodes"));
    expect(query?.text).not.toContain("plant-a");
    expect(query?.text).not.toContain("'source'");
    expect(query?.values).toContain(3);
    expect(query?.values).toContain(11);
  });

  it("returns bounded grouped numeric aggregates", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.data_models") && query.text.includes("state = 'published'")) {
        return result([{ ...modelRow, state: "published", published_at: "2026-07-17T08:00:00.000Z" }]);
      }
      if (query.text.includes("FROM odf.model_views")) {
        return result([{ ...viewRow, definition: {
          ...viewDefinition,
          properties: { ...viewDefinition.properties, pressure: { type: "float64" }, active: { type: "boolean" } },
        } }]);
      }
      if (query.text.includes("AS metric_values")) {
        return result([{ group_values: { active: true }, metric_values: { total: 2, averagePressure: 12.5 } }]);
      }
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, { projectAccessResolver: allowAll() });

    await expect(runtime.models.aggregateModelInstances(scope, "plant-model", 2, {
      viewExternalId: "Equipment",
      groupBy: ["active"],
      metrics: [
        { name: "total", operation: "count" },
        { name: "averagePressure", operation: "avg", property: "pressure" },
      ],
      limit: 20,
    })).resolves.toEqual({
      groups: [{ group: { active: true }, metrics: { total: 2, averagePressure: 12.5 } }],
      truncated: false,
    });
  });
});
