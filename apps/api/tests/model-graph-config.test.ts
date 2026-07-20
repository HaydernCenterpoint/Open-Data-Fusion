import { describe, expect, it } from "vitest";
import { modelGraphApiEnabled } from "../src/model-graph-config.js";

describe("model graph API rollout switch", () => {
  it("defaults to enabled outside production", () => {
    expect(modelGraphApiEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(modelGraphApiEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("honors explicit booleans", () => {
    expect(modelGraphApiEnabled({ NODE_ENV: "production", ODF_MODEL_GRAPH_API_ENABLED: "true" })).toBe(true);
    expect(modelGraphApiEnabled({ NODE_ENV: "development", ODF_MODEL_GRAPH_API_ENABLED: "false" })).toBe(false);
  });

  it("rejects an implicit production decision", () => {
    expect(() => modelGraphApiEnabled({ NODE_ENV: "production" }))
      .toThrow("ODF_MODEL_GRAPH_API_ENABLED must be explicitly true or false in production");
  });

  it("rejects invalid values in every environment", () => {
    expect(() => modelGraphApiEnabled({ NODE_ENV: "test", ODF_MODEL_GRAPH_API_ENABLED: "yes" }))
      .toThrow("ODF_MODEL_GRAPH_API_ENABLED must be true or false");
  });
});
