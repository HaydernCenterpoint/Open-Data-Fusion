import { describe, expect, it } from "vitest";

import { BuiltinDagExecutor } from "../src/executor.js";
import type { JsonObject, PipelineExecutionRequest } from "../src/types.js";

const request = (definition: JsonObject): PipelineExecutionRequest => ({
  signal: new AbortController().signal,
  run: {
    pipelineRunId: "run-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    pipelineId: "pipeline-1",
    pipelineVersion: 1,
    state: "running",
    triggerType: "manual",
    correlationId: "correlation-1",
    startedAt: null,
    completedAt: null,
    summary: { input: { pressure: 14, asset: { name: "pump" } } },
  },
  version: {
    pipelineVersionId: "version-1",
    tenantId: "tenant-1",
    projectId: "project-1",
    pipelineId: "pipeline-1",
    version: 1,
    definition,
    schedule: null,
    createdBy: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  qualityRules: [{
    qualityRuleId: "rule-1",
    externalId: "pressure-range",
    ruleKind: "range",
    fieldName: "pressure",
    configuration: { minimum: 10, maximum: 20 },
    severity: "error",
    enabled: true,
  }],
});

describe("built-in DAG executor", () => {
  it("uses a stable dependency order for validate, quality, and noop", async () => {
    const result = await new BuiltinDagExecutor().execute(request({
      steps: [
        { id: "quality", kind: "quality", dependsOn: ["validate"], configuration: {} },
        { id: "done", kind: "noop", dependsOn: ["quality"], configuration: {} },
        { id: "validate", kind: "validate", dependsOn: [], configuration: { requiredFields: ["asset.name"] } },
      ],
    }));
    expect((result.output.steps as JsonObject[]).map((step) => step.id)).toEqual(["validate", "quality", "done"]);
  });

  it.each([
    [{ steps: [{ id: "x", kind: "code", dependsOn: [], configuration: { source: "eval('x')" } }] }, "not supported"],
    [{ steps: [{ id: "x", kind: "noop", dependsOn: [], configuration: { sql: "DELETE FROM assets" } }] }, "unsupported field"],
    [{ steps: [{ id: "a", kind: "noop", dependsOn: ["b"], configuration: {} }, { id: "b", kind: "noop", dependsOn: ["a"], configuration: {} }] }, "cycle"],
  ])("rejects unsafe or invalid definitions", async (definition, message) => {
    await expect(new BuiltinDagExecutor().execute(request(definition as JsonObject))).rejects.toThrow(message);
  });

  it("fails closed on quality engines that are not bounded and built in", async () => {
    const value = request({ steps: [{ id: "quality", kind: "quality", dependsOn: [], configuration: {} }] });
    value.qualityRules = [{ ...value.qualityRules[0]!, ruleKind: "regex", configuration: { pattern: ".*" } }];
    await expect(new BuiltinDagExecutor().execute(value)).rejects.toThrow("not supported");
  });
});
