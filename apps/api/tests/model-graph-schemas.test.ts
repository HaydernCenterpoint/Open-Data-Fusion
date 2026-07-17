import { describe, expect, it } from "vitest";
import {
  createModelVersionSchema,
  emptyBodySchema,
  instanceAggregateSchema,
  instanceQuerySchema,
  instanceTraverseSchema,
  instanceUpsertSchema,
  modelVersionPathSchema,
  modelViewDefinitionSchema,
} from "../src/model-graph-schemas.js";

const view = {
  externalId: "Equipment",
  name: "Equipment",
  usedFor: "node",
  properties: { name: { type: "text", required: true } },
};

describe("model graph REST schemas", () => {
  it("accepts positive integer version paths and rejects unknown fields", () => {
    expect(modelVersionPathSchema.parse({ modelId: "plant-model", version: "2" })).toEqual({ modelId: "plant-model", version: 2 });
    expect(modelVersionPathSchema.safeParse({ modelId: "plant-model", version: "0" }).success).toBe(false);
    expect(modelVersionPathSchema.safeParse({ modelId: "plant-model", version: "2", extra: true }).success).toBe(false);
  });

  it("accepts strict views and optional inline views", () => {
    expect(modelViewDefinitionSchema.safeParse(view).success).toBe(true);
    expect(modelViewDefinitionSchema.safeParse({ ...view, extra: true }).success).toBe(false);
    expect(createModelVersionSchema.safeParse({ name: "Plant model", schema: {} }).success).toBe(true);
    expect(createModelVersionSchema.safeParse({ name: "Plant model", schema: {}, views: [view] }).success).toBe(true);
  });

  it("validates recursive filters and rejects unknown operators", () => {
    expect(instanceQuerySchema.safeParse({
      viewExternalId: "Equipment",
      filter: { and: [
        { equals: { property: "name", value: "Pump" } },
        { not: { exists: { property: "retiredAt" } } },
      ] },
      limit: 200,
    }).success).toBe(true);
    expect(instanceQuerySchema.safeParse({ viewExternalId: "Equipment", filter: { regex: {} } }).success).toBe(false);
    expect(instanceQuerySchema.safeParse({ viewExternalId: "Equipment", surprise: true }).success).toBe(false);
  });

  it("bounds atomic upsert batches from 1 to 100", () => {
    const item = { space: "plant-a", externalId: "pump-101", kind: "node", viewExternalId: "Equipment", properties: { name: "Pump" } };
    expect(instanceUpsertSchema.safeParse({ idempotencyKey: "request-1", instances: [item] }).success).toBe(true);
    expect(instanceUpsertSchema.safeParse({ idempotencyKey: "request-1", instances: [] }).success).toBe(false);
    expect(instanceUpsertSchema.safeParse({ idempotencyKey: "request-1", instances: Array.from({ length: 101 }, () => item) }).success).toBe(false);
  });

  it("bounds traversal starts and hops", () => {
    const start = { space: "plant-a", externalId: "pump-101" };
    expect(instanceTraverseSchema.safeParse({ starts: [start], direction: "out", maxHops: 3 }).success).toBe(true);
    expect(instanceTraverseSchema.safeParse({ starts: [], direction: "out" }).success).toBe(false);
    expect(instanceTraverseSchema.safeParse({ starts: Array.from({ length: 21 }, () => start), direction: "out" }).success).toBe(false);
    expect(instanceTraverseSchema.safeParse({ starts: [start], direction: "out", maxHops: 4 }).success).toBe(false);
  });

  it("requires bounded aggregate metrics and an empty publish body", () => {
    expect(instanceAggregateSchema.safeParse({
      viewExternalId: "Equipment",
      metrics: [{ name: "total", operation: "count" }],
    }).success).toBe(true);
    expect(instanceAggregateSchema.safeParse({ viewExternalId: "Equipment", metrics: [] }).success).toBe(false);
    expect(emptyBodySchema.safeParse({}).success).toBe(true);
    expect(emptyBodySchema.safeParse({ force: true }).success).toBe(false);
  });
});
