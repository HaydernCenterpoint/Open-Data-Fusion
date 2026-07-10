import { describe, expect, it } from "vitest";

import {
  ForbiddenError,
  PostgresRuntime,
} from "../src/index.js";
import { RecordingClient, RecordingPool, result } from "./recording-pg.js";

const scope = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  userId: "operator@example.test",
};

const pipelineVersion = {
  pipeline_version_id: "33333333-3333-3333-3333-333333333333",
  tenant_id: scope.tenantId,
  project_id: scope.projectId,
  pipeline_id: "44444444-4444-4444-4444-444444444444",
  version: 1,
  definition: { steps: [] },
  schedule: null,
  created_by: scope.userId,
  created_at: "2026-07-11T00:00:00.000Z",
};

const qualityRule = {
  quality_rule_id: "55555555-5555-5555-5555-555555555555",
  tenant_id: scope.tenantId,
  project_id: scope.projectId,
  external_id: "pressure-required",
  version: 1,
  name: "Pressure required",
  rule_kind: "required",
  target_model_external_id: "pump",
  field_name: "pressure",
  configuration: { field: "pressure" },
  severity: "error",
  enabled: true,
  created_at: "2026-07-11T00:00:00.000Z",
};

const pipeline = {
  pipeline_id: pipelineVersion.pipeline_id,
  tenant_id: scope.tenantId,
  project_id: scope.projectId,
  external_id: "ingest-pressure",
  name: "Ingest pressure",
  description: null,
  current_version: 1,
  enabled: true,
  created_by: scope.userId,
  created_at: "2026-07-11T00:00:00.000Z",
  updated_at: "2026-07-11T00:00:00.000Z",
};

const point = {
  tenant_id: scope.tenantId,
  project_id: scope.projectId,
  time_series_id: "66666666-6666-6666-6666-666666666666",
  observed_at: "2026-07-11T00:00:00.000Z",
  sequence: "0",
  numeric_value: 12.5,
  text_value: null,
  quality: "good",
  source_connection_id: null,
  ingestion_run_id: null,
  received_at: "2026-07-11T00:00:00.000Z",
};

const writebackRequest = {
  writeback_request_id: "77777777-7777-7777-7777-777777777777",
  tenant_id: scope.tenantId,
  project_id: scope.projectId,
  source_connection_id: "88888888-8888-8888-8888-888888888888",
  target_instance_id: null,
  target_external_id: "P-101",
  operation: "setpoint.update",
  payload: { value: 30 },
  risk: "medium",
  state: "approved",
  requested_by: "requester@example.test",
  requested_at: "2026-07-11T00:00:00.000Z",
  dry_run_result: { safe: true },
  executed_at: null,
  updated_at: "2026-07-11T00:00:00.000Z",
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

describe("production platform repository policy and RLS boundary", () => {
  it("fails closed before opening a transaction when no project policy resolver is installed", async () => {
    const client = new RecordingClient();
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    await expect(runtime.pipelines.getPipelineVersion(scope, pipelineVersion.pipeline_id, 1))
      .rejects.toEqual(expect.any(ForbiddenError));
    expect(client.queries).toHaveLength(0);
  });

  it("authorizes before BEGIN and parameterizes tenant/project pipeline worker reads", async () => {
    const events: string[] = [];
    const client = new RecordingClient((query) => {
      events.push("query:" + query.text);
      return query.text.includes("FROM odf.pipeline_versions") ? result([pipelineVersion]) : result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowAll(events),
    });

    const version = await runtime.pipelines.getPipelineVersion(scope, pipelineVersion.pipeline_id, 1);

    expect(version.definition).toEqual({ steps: [] });
    expect(events[0]).toBe("policy");
    expect(events[1]).toBe("query:BEGIN");
    expect(client.queries[0]?.text).toBe("BEGIN");
    const query = client.queries.find((entry) => entry.text.includes("FROM odf.pipeline_versions"));
    expect(query?.text).toContain("tenant_id = $1::uuid AND project_id = $2::uuid");
    expect(query?.values).toEqual([scope.tenantId, scope.projectId, pipelineVersion.pipeline_id, 1]);
    expect(query?.text).not.toContain(scope.tenantId);
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
  });

  it("provides bounded, enabled quality-rule reads for workers", async () => {
    const client = new RecordingClient((query) => (
      query.text.includes("FROM odf.quality_rules") ? result([qualityRule]) : result()
    ));
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowAll(),
    });

    const page = await runtime.pipelines.listEnabledQualityRules(scope, 25);

    expect(page.items).toHaveLength(1);
    const query = client.queries.find((entry) => entry.text.includes("FROM odf.quality_rules"));
    expect(query?.text).toContain("enabled = true");
    expect(query?.text).toContain("LIMIT $4");
    expect(query?.values?.at(-1)).toBe(26);
  });

  it("creates a pipeline and its immutable initial version before audit/outbox commit", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.startsWith("INSERT INTO odf.pipelines")) return result([pipeline]);
      if (query.text.startsWith("INSERT INTO odf.pipeline_versions")) return result([pipelineVersion]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowAll(),
    });

    await expect(runtime.pipelines.createPipeline(scope, {
      pipelineId: pipeline.pipeline_id,
      pipelineVersionId: pipelineVersion.pipeline_version_id,
      externalId: pipeline.external_id,
      name: pipeline.name,
      definition: { steps: [] },
      correlationId: "99999999-9999-9999-9999-999999999999",
    })).resolves.toMatchObject({ pipelineId: pipeline.pipeline_id, currentVersion: 1 });

    const texts = client.queries.map((query) => query.text);
    const pipelineIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.pipelines"));
    const versionIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.pipeline_versions"));
    const auditIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.audit_log"));
    const outboxIndex = texts.findIndex((text) => text.startsWith("INSERT INTO odf.outbox_events"));
    expect(versionIndex).toBeGreaterThan(pipelineIndex);
    expect(auditIndex).toBeGreaterThan(versionIndex);
    expect(outboxIndex).toBeGreaterThan(auditIndex);
    expect(texts.at(-1)).toBe("COMMIT");
  });
});

describe("industrial and governance query boundaries", () => {
  it("uses indexed latest and bucket time-series queries with scoped parameters", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("GROUP BY bucket_start")) {
        return result([{
          bucket_start: "2026-07-11T00:00:00.000Z",
          point_count: "1",
          numeric_minimum: 12.5,
          numeric_maximum: 12.5,
          numeric_average: 12.5,
          latest_text_value: null,
        }]);
      }
      if (query.text.includes("FROM odf.time_series_points")) return result([point]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowAll(),
    });

    await expect(runtime.industrial.latestTimeSeriesPoint(scope, point.time_series_id)).resolves.toMatchObject({ numericValue: 12.5 });
    await expect(runtime.industrial.bucketTimeSeries(scope, point.time_series_id, "2026-07-11T00:00:00.000Z", "2026-07-11T01:00:00.000Z", 60))
      .resolves.toMatchObject([{ pointCount: "1", numericAverage: 12.5 }]);

    const latest = client.queries.find((entry) => entry.text.includes("ORDER BY observed_at DESC, sequence DESC"));
    const bucket = client.queries.find((entry) => entry.text.includes("GROUP BY bucket_start"));
    expect(latest?.text).toContain("tenant_id = $1::uuid AND project_id = $2::uuid");
    expect(bucket?.values).toEqual([scope.tenantId, scope.projectId, point.time_series_id, "2026-07-11T00:00:00.000Z", "2026-07-11T01:00:00.000Z", 60]);
  });

  it("uses audit_log rather than an undeclared writeback-events table and keeps search scoped", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.writeback_requests")) return result([writebackRequest]);
      if (query.text.includes("FROM odf.audit_log")) return result([{
        id: "1",
        actor: scope.userId,
        action: "platform.writeback_request_created",
        entity_id: writebackRequest.writeback_request_id,
        details: { risk: "medium" },
        correlation_id: "99999999-9999-9999-9999-999999999999",
        occurred_at: "2026-07-11T00:00:00.000Z",
      }]);
      if (query.text.includes("WITH candidates AS")) return result([{
        entity_type: "asset",
        entity_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        title: "P-101",
        summary: "Pump",
        updated_at: "2026-07-11T00:00:00.000Z",
      }]);
      return result();
    });
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
      projectAccessResolver: allowAll(),
    });

    await expect(runtime.writeback.listWritebackEvents(scope, writebackRequest.writeback_request_id, 10)).resolves.toMatchObject({ items: [{ action: "platform.writeback_request_created" }] });
    await expect(runtime.search.search(scope, "pump", 10)).resolves.toMatchObject({ items: [{ entityType: "asset", title: "P-101" }] });

    const events = client.queries.find((entry) => entry.text.includes("FROM odf.audit_log"));
    const search = client.queries.find((entry) => entry.text.includes("WITH candidates AS"));
    expect(events?.text).not.toContain("writeback_events");
    expect(search?.text).toContain("tenant_id = $1::uuid AND project_id = $2::uuid");
    expect(search?.text).not.toContain("pump");
    expect(search?.values?.slice(0, 3)).toEqual([scope.tenantId, scope.projectId, "pump"]);
  });
});
