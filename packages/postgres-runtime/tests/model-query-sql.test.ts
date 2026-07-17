import { describe, expect, it } from "vitest";

import { compilePostgresModelAggregate, compilePostgresModelQuery } from "../src/model-query-sql.js";

const view = {
  externalId: "Equipment.Secret",
  name: "Equipment",
  usedFor: "node" as const,
  properties: {
    secretText: { type: "text" as const },
    secretPressure: { type: "float64" as const },
    secretActive: { type: "boolean" as const },
  },
};
const context = {
  tenantId: "tenant-secret-value",
  projectId: "project-secret-value",
  dataModelId: "model-secret-value",
  modelViewId: "view-secret-value",
  view,
};

function expectParameterized(text: string, values: readonly unknown[], secrets: string[]): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
  for (const secret of secrets) expect(values.some((value) => JSON.stringify(value).includes(secret))).toBe(true);
}

describe("PostgreSQL model query compiler", () => {
  it.each([
    ["equals", { equals: { property: "secretText", value: "equals-secret-value" } }],
    ["in", { in: { property: "secretText", values: ["in-secret-a", "in-secret-b"] } }],
    ["range", { range: { property: "secretPressure", gte: 10.25, lt: 99.5 } }],
    ["exists", { exists: { property: "secretActive" } }],
    ["and/or/not", { and: [
      { or: [
        { equals: { property: "secretText", value: "nested-secret" } },
        { not: { exists: { property: "secretActive" } } },
      ] },
      { range: { property: "secretPressure", gt: 1 } },
    ] }],
  ])("parameterizes the %s operator", (_label, filter) => {
    const compiled = compilePostgresModelQuery({
      ...context,
      request: {
        viewExternalId: view.externalId,
        projection: ["secretText"],
        filter: filter as never,
        sort: { property: "secretPressure", direction: "desc" },
        limit: 50,
      },
    });
    expectParameterized(compiled.text, compiled.values ?? [], [
      context.tenantId,
      context.projectId,
      context.dataModelId,
      context.modelViewId,
      "secretText",
      "secretPressure",
    ]);
    expect(compiled.text).toContain("LIMIT");
  });

  it("parameterizes grouped numeric aggregation names, keys, and filters", () => {
    const compiled = compilePostgresModelAggregate({
      ...context,
      request: {
        viewExternalId: view.externalId,
        filter: { equals: { property: "secretActive", value: true } },
        groupBy: ["secretActive"],
        metrics: [
          { name: "secretCount", operation: "count" },
          { name: "secretAverage", operation: "avg", property: "secretPressure" },
        ],
        limit: 25,
      },
    });
    expectParameterized(compiled.text, compiled.values ?? [], [
      context.tenantId,
      context.projectId,
      context.dataModelId,
      context.modelViewId,
      "secretActive",
      "secretPressure",
      "secretCount",
      "secretAverage",
    ]);
    expect(compiled.text).toContain("GROUP BY");
    expect(compiled.text).toContain("avg(");
  });
});
