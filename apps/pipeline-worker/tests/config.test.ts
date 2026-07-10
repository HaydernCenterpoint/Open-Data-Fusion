import { describe, expect, it } from "vitest";

import { loadPipelineWorkerConfig } from "../src/config.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ODF_POSTGRES_URL: "postgresql://worker@example.invalid/odf",
    ODF_PIPELINE_SCOPES: JSON.stringify([{ tenantId: TENANT, projectId: PROJECT }]),
    ODF_PIPELINE_EXECUTOR: "builtin",
    ...overrides,
  };
}

describe("pipeline worker configuration", () => {
  it("loads a bounded allowlist and safe defaults", () => {
    const config = loadPipelineWorkerConfig(environment());
    expect(config.scopes).toEqual([{ tenantId: TENANT, projectId: PROJECT }]);
    expect(config.maxScopesPerPoll).toBe(1);
    expect(config.batchSize).toBe(20);
    expect(config.executor).toBe("builtin");
  });

  it("fails closed when an executor is not explicitly enabled", () => {
    const config = loadPipelineWorkerConfig(environment({ ODF_PIPELINE_EXECUTOR: undefined }));
    expect(config.executor).toBe("disabled");
  });

  it.each([
    [{ ODF_PIPELINE_BATCH_SIZE: "201" }, "ODF_PIPELINE_BATCH_SIZE"],
    [{ ODF_PIPELINE_CONCURRENCY: "0" }, "ODF_PIPELINE_CONCURRENCY"],
    [{ ODF_PIPELINE_MAX_SCOPES_PER_POLL: "2" }, "cannot exceed"],
    [{ ODF_PIPELINE_RETRY_BASE_MS: "200", ODF_PIPELINE_RETRY_MAX_MS: "100" }, "greater than or equal"],
  ])("rejects out-of-bounds settings", (overrides, message) => {
    expect(() => loadPipelineWorkerConfig(environment(overrides))).toThrow(message);
  });

  it("rejects duplicate and malformed scopes", () => {
    expect(() => loadPipelineWorkerConfig(environment({
      ODF_PIPELINE_SCOPES: JSON.stringify([
        { tenantId: TENANT, projectId: PROJECT },
        { tenantId: TENANT.toUpperCase(), projectId: PROJECT },
      ]),
    }))).toThrow("duplicate scope");
    expect(() => loadPipelineWorkerConfig(environment({
      ODF_PIPELINE_SCOPES: JSON.stringify([{ tenantId: "tenant", projectId: PROJECT }]),
    }))).toThrow("must be UUIDs");
  });
});
