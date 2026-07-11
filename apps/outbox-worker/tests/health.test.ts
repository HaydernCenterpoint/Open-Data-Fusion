import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isFreshOutboxHeartbeat, OutboxHealthFile } from "../src/health.js";

describe("outbox health heartbeat", () => {
  it("accepts only a recent, well-formed heartbeat", () => {
    expect(isFreshOutboxHeartbeat({ lastSuccessAt: 9_000 }, 1_000, 10_000)).toBe(true);
    expect(isFreshOutboxHeartbeat({ lastSuccessAt: 8_999 }, 1_000, 10_000)).toBe(false);
    expect(isFreshOutboxHeartbeat({ lastSuccessAt: 10_001 }, 1_000, 10_000)).toBe(false);
    expect(isFreshOutboxHeartbeat({}, 1_000, 10_000)).toBe(false);
  });

  it("writes an atomically replaceable heartbeat and clears stale state on startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odf-outbox-health-"));
    const path = join(directory, "health.json");
    try {
      const health = new OutboxHealthFile(path, () => 1234);
      await health.markSuccess();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ lastSuccessAt: 1234 });
      await health.reset();
      await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
