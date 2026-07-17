import { describe, expect, it } from "vitest";

import { ConflictError, NotFoundError, PostgresRuntime } from "../src/index.js";
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
});
