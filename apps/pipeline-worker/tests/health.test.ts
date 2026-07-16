import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isFreshPipelineHeartbeat, PipelineHealthFile } from "../src/health.js";

describe("pipeline health heartbeat", () => {
  it("accepts only a recent, well-formed heartbeat", () => {
    expect(isFreshPipelineHeartbeat({ lastSuccessAt: 9_000 }, 1_000, 10_000)).toBe(true);
    expect(isFreshPipelineHeartbeat({ lastSuccessAt: 8_999 }, 1_000, 10_000)).toBe(false);
    expect(isFreshPipelineHeartbeat({ lastSuccessAt: 10_001 }, 1_000, 10_000)).toBe(false);
    expect(isFreshPipelineHeartbeat({}, 1_000, 10_000)).toBe(false);
  });

  it("atomically replaces a heartbeat, reports freshness, and clears stale state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odf-pipeline-health-"));
    const path = join(directory, "health.json");
    try {
      const health = new PipelineHealthFile(path, () => 1_234);
      await health.markSuccess();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ lastSuccessAt: 1_234 });
      await expect(health.isFresh(1_000)).resolves.toBe(true);
      await health.reset();
      await expect(health.isFresh(1_000)).resolves.toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
