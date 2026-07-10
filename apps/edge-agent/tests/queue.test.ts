import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archiveRawPayload } from "../src/archive.js";
import { EdgeQueue } from "../src/queue.js";
import type { IngestBundle } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const bundle = (runId: string): IngestBundle => ({
  source: { system: "csv-pilot", runId, actor: "edge-agent" },
  assets: [],
  timeSeries: [],
  dataPoints: [{ timeSeriesExternalId: "P-101-PRESSURE", timestamp: "2026-07-11T00:00:00.000Z", value: 111.2, quality: "good" }],
  documents: [],
  relations: [],
});

describe("durable edge queue", () => {
  it("archives raw records before atomically advancing the checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odf-edge-"));
    temporaryDirectories.push(directory);
    const archive = await archiveRawPayload(join(directory, "raw"), "csv-pilot", "2026-07-11T00:00:00.000Z", [{ pressure: 111.2 }]);
    expect(JSON.parse(await readFile(archive.path, "utf8"))).toMatchObject({ sourceSystem: "csv-pilot" });

    const queue = new EdgeQueue(join(directory, "queue.db"));
    expect(queue.enqueue("batch-1", "csv-pilot", bundle("run-1"), "line:2", archive)).toBe(true);
    expect(queue.enqueue("batch-duplicate", "csv-pilot", bundle("run-1"), "line:3", archive)).toBe(false);
    expect(queue.checkpoint("csv-pilot")).toBe("line:2");

    const claimed = queue.claim();
    expect(claimed).toMatchObject({ id: "batch-1", idempotencyKey: "run-1", attemptCount: 1 });
    queue.markSent("batch-1");
    expect(queue.pendingCount()).toBe(0);
    queue.close();
  });

  it("returns failed delivery to the queue without losing its checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odf-edge-"));
    temporaryDirectories.push(directory);
    const archive = await archiveRawPayload(join(directory, "raw"), "csv-pilot", "2026-07-11T00:00:00.000Z", [{ pressure: 112 }]);
    const queue = new EdgeQueue(":memory:");
    queue.enqueue("batch-2", "csv-pilot", bundle("run-2"), "line:4", archive);
    expect(queue.claim()).not.toBeNull();
    queue.release("batch-2", "network\nerror", 0);
    expect(queue.claim()?.attemptCount).toBe(2);
    expect(queue.checkpoint("csv-pilot")).toBe("line:4");
    queue.close();
  });
});
