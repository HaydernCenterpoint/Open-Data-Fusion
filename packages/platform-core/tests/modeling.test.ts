import { describe, expect, it } from "vitest";
import type { InstanceAggregateRequest, InstanceQueryRequest, InstanceUpsertItem, ModelViewDefinition } from "@open-data-fusion/contracts";
import {
  canonicalModelGraphJson,
  ModelValidationError,
  normalizeInstanceAggregate,
  normalizeInstanceQuery,
  normalizeModelInstance,
  normalizeModelView,
  normalizeModelViews,
} from "../src/modeling.js";

const equipmentView: ModelViewDefinition = {
  externalId: "Equipment",
  name: "Equipment",
  usedFor: "node",
  properties: {
    name: { type: "text", required: true },
    sequence: { type: "int64" },
    pressure: { type: "float64", nullable: true },
    active: { type: "boolean" },
    observedAt: { type: "timestamp" },
    installedOn: { type: "date" },
    metadata: { type: "json" },
    parent: { type: "direct" },
    tags: { type: "text", list: true },
  },
};

describe("model graph validation", () => {
  it("normalizes a strict bounded view definition", () => {
    expect(normalizeModelView({
      externalId: "Equipment",
      name: "Equipment",
      usedFor: "node",
      properties: {
        name: { type: "text", required: true },
        ratedPressure: { type: "float64", nullable: true },
      },
    })).toEqual({
      externalId: "Equipment",
      name: "Equipment",
      usedFor: "node",
      properties: {
        name: { type: "text", required: true, nullable: false, list: false },
        ratedPressure: { type: "float64", required: false, nullable: true, list: false },
      },
    });
  });

  it("rejects unknown definition fields and excessive view counts with safe issues", () => {
    expect(() => normalizeModelView({ ...equipmentView, surprise: true } as never)).toThrow(ModelValidationError);
    try {
      normalizeModelViews(Array.from({ length: 101 }, (_, index) => ({ ...equipmentView, externalId: `Equipment-${index}` })));
    } catch (error) {
      expect(error).toMatchObject({ issues: [{ path: "views", message: "Use at most 100 views" }] });
    }
  });

  it("normalizes every supported scalar, list, and direct reference", () => {
    const input: InstanceUpsertItem = {
      space: "plant-a",
      externalId: "pump-101",
      kind: "node",
      viewExternalId: "Equipment",
      properties: {
        name: "Pump 101",
        sequence: 42,
        pressure: 12.5,
        active: true,
        observedAt: "2026-07-17T07:00:00+00:00",
        installedOn: "2024-02-29",
        metadata: { vendor: "ODF", flags: [true, null] },
        parent: { space: "plant-a", externalId: "system-1" },
        tags: ["critical", "rotating"],
      },
    };

    expect(normalizeModelInstance(equipmentView, input)).toEqual({
      ...input,
      properties: {
        ...input.properties,
        observedAt: "2026-07-17T07:00:00.000Z",
      },
    });
  });

  it("rejects missing, unknown, unsafe, invalid, and oversized properties", () => {
    const base = {
      space: "plant-a", externalId: "pump-101", kind: "node", viewExternalId: "Equipment",
    } as const;
    const invalidProperties = [
      {},
      { name: "Pump", unknown: true },
      { name: "Pump", sequence: Number.MAX_SAFE_INTEGER + 1 },
      { name: "Pump", pressure: Number.POSITIVE_INFINITY },
      { name: "Pump", active: "true" },
      { name: "Pump", observedAt: "not-a-time" },
      { name: "Pump", installedOn: "2023-02-29" },
      { name: "Pump", parent: { space: "plant-a" } },
      { name: "Pump", tags: Array.from({ length: 1_001 }, () => "tag") },
      { name: "x".repeat(256 * 1024) },
    ];

    for (const properties of invalidProperties) {
      expect(() => normalizeModelInstance(equipmentView, { ...base, properties })).toThrow(ModelValidationError);
    }
  });

  it("enforces node and edge endpoint shape", () => {
    expect(() => normalizeModelInstance(equipmentView, {
      space: "plant-a", externalId: "pump-101", kind: "node", viewExternalId: "Equipment",
      source: { space: "plant-a", externalId: "system-1" }, properties: { name: "Pump" },
    })).toThrow(ModelValidationError);

    const edgeView: ModelViewDefinition = {
      externalId: "Feeds", name: "Feeds", usedFor: "edge", properties: {},
    };
    expect(() => normalizeModelInstance(edgeView, {
      space: "plant-a", externalId: "feeds-1", kind: "edge", viewExternalId: "Feeds", properties: {},
    })).toThrow(ModelValidationError);
  });

  it("normalizes bounded filters, projection, sorting, and result limits", () => {
    const request: InstanceQueryRequest = {
      viewExternalId: "Equipment",
      projection: ["name", "pressure"],
      filter: { and: [
        { equals: { property: "active", value: true } },
        { range: { property: "pressure", gte: 10, lt: 20 } },
      ] },
      sort: { property: "pressure" },
    };

    expect(normalizeInstanceQuery(equipmentView, request)).toEqual({
      ...request,
      sort: { property: "pressure", direction: "asc" },
      limit: 50,
    });
  });

  it("rejects excessive or invalid filters", () => {
    const query = (input: Partial<InstanceQueryRequest>) => normalizeInstanceQuery(equipmentView, {
      viewExternalId: "Equipment", ...input,
    });
    expect(() => query({ filter: { and: [] } })).toThrow(ModelValidationError);
    expect(() => query({ filter: { in: { property: "name", values: Array.from({ length: 101 }, (_, i) => i) } } })).toThrow(ModelValidationError);
    expect(() => query({ filter: { range: { property: "tags", gt: "a" } } })).toThrow(ModelValidationError);
    expect(() => query({ projection: Array.from({ length: 51 }, () => "name") })).toThrow(ModelValidationError);
    expect(() => query({ limit: 201 })).toThrow(ModelValidationError);
    expect(() => query({ filter: {
      and: Array.from({ length: 21 }, () => ({ equals: { property: "name", value: "Pump" } })),
    } })).toThrow(ModelValidationError);

    let nested: InstanceQueryRequest["filter"] = { equals: { property: "name", value: "Pump" } };
    for (let index = 0; index < 5; index += 1) nested = { not: nested };
    expect(() => query({ filter: nested })).toThrow(ModelValidationError);
  });

  it("normalizes bounded numeric aggregations", () => {
    const request: InstanceAggregateRequest = {
      viewExternalId: "Equipment",
      groupBy: ["active"],
      metrics: [
        { name: "total", operation: "count" },
        { name: "averagePressure", operation: "avg", property: "pressure" },
      ],
    };
    expect(normalizeInstanceAggregate(equipmentView, request)).toEqual({ ...request, limit: 200 });
    expect(() => normalizeInstanceAggregate(equipmentView, {
      viewExternalId: "Equipment", metrics: [{ name: "bad", operation: "sum", property: "name" }],
    })).toThrow(ModelValidationError);
    expect(() => normalizeInstanceAggregate(equipmentView, {
      viewExternalId: "Equipment",
      groupBy: ["name", "active", "sequence", "pressure"],
      metrics: [{ name: "total", operation: "count" }],
    })).toThrow(ModelValidationError);
    expect(() => normalizeInstanceAggregate(equipmentView, {
      viewExternalId: "Equipment",
      metrics: Array.from({ length: 11 }, (_, index) => ({ name: `metric-${index}`, operation: "count" as const })),
    })).toThrow(ModelValidationError);
  });

  it("produces deterministic canonical JSON without reordering arrays", () => {
    expect(canonicalModelGraphJson({ z: 1, a: { y: 2, x: 3 } }))
      .toBe(canonicalModelGraphJson({ a: { x: 3, y: 2 }, z: 1 }));
    expect(canonicalModelGraphJson({ instances: ["a", "b"] }))
      .not.toBe(canonicalModelGraphJson({ instances: ["b", "a"] }));
    expect(canonicalModelGraphJson({ value: "a" }))
      .not.toBe(canonicalModelGraphJson({ value: "b" }));
  });
});
