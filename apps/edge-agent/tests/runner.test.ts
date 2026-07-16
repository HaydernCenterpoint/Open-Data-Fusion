import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryClient } from "../src/delivery.js";
import { EdgeQueue } from "../src/queue.js";
import { EdgeAgentRunner, type EdgeAgentRunnerOptions, type ManagedConnector } from "../src/runner.js";
import type { ConnectorBatch, EdgeConnector, IngestBundle } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const runnerOptions: EdgeAgentRunnerOptions = {
  archiveDirectory: "raw",
  actor: "edge-agent",
  pollIntervalMs: 100,
  deliveryIntervalMs: 10,
  deliveryLeaseMs: 1_000,
  shutdownDrainTimeoutMs: 100,
  maxDrainBatch: 10,
  retry: { baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
};

const batch: ConnectorBatch = {
  checkpointAfter: "row:1",
  observedAt: "2026-07-11T00:00:00.000Z",
  assets: [],
  timeSeries: [],
  dataPoints: [
    { timeSeriesExternalId: "P-101-PRESSURE", timestamp: "2026-07-11T00:00:00.000Z", value: 100, quality: "good" },
  ],
  documents: [],
  relations: [],
  rawRecords: [{ pressure: 100 }],
};

function managedConnector(connector: EdgeConnector): ManagedConnector {
  return { sourceSystem: "csv-pilot", connector };
}

const noDelivery: DeliveryClient = { async deliver() {} };

describe("edge-agent runner", () => {
  it("never advances a connector checkpoint when durable raw archival fails", async () => {
    const connector: EdgeConnector = { async poll() { return batch; }, async close() {} };
    const queue = new EdgeQueue(":memory:");
    const runner = new EdgeAgentRunner(runnerOptions, [managedConnector(connector)], queue, noDelivery, {
      archive: async () => {
        throw new Error("disk full");
      },
    });

    await expect(runner.pollConnector("csv-pilot")).rejects.toThrow("disk full");
    expect(queue.checkpoint("csv-pilot")).toBeNull();
    expect(queue.pendingCount()).toBe(0);
    queue.close();
  });

  it("archives before atomically enqueueing and advancing the checkpoint", async () => {
    const events: string[] = [];
    const connector: EdgeConnector = {
      async poll(checkpoint) {
        events.push(`poll:${checkpoint ?? "none"}`);
        return batch;
      },
      async close() {},
    };
    const queue = new EdgeQueue(":memory:");
    const runner = new EdgeAgentRunner(runnerOptions, [managedConnector(connector)], queue, noDelivery, {
      createId: () => "batch-1",
      archive: async () => {
        events.push(`archive:checkpoint-${queue.checkpoint("csv-pilot") ?? "none"}`);
        return { path: "raw/batch-1.json", sha256: "a".repeat(64), bytes: 10 };
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(await runner.pollConnector("csv-pilot")).toBe(true);
    expect(events).toEqual(["poll:none", "archive:checkpoint-none"]);
    expect(queue.checkpoint("csv-pilot")).toBe("row:1");
    expect(queue.claim()).toMatchObject({ id: "batch-1", checkpointAfter: "row:1" });
    queue.close();
  });

  it("releases failed deliveries with backoff and succeeds on a later drain", async () => {
    const queue = new EdgeQueue(":memory:");
    const bundle: IngestBundle = {
      source: { system: "csv-pilot", runId: "run-1", actor: "edge-agent" },
      assets: [],
      timeSeries: [],
      dataPoints: batch.dataPoints,
      documents: [],
      relations: [],
    };
    queue.enqueue("batch-1", "csv-pilot", bundle, "row:1", {
      path: "raw/batch-1.json",
      sha256: "a".repeat(64),
      bytes: 10,
    });
    let attempts = 0;
    const delivery: DeliveryClient = {
      async deliver() {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
      },
    };
    const connector: EdgeConnector = { async poll() { return null; }, async close() {} };
    const runner = new EdgeAgentRunner(runnerOptions, [managedConnector(connector)], queue, delivery, {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(await runner.drainOne()).toBe(true);
    expect(queue.pendingCount()).toBe(1);
    expect(await runner.drainOne()).toBe(false);
    await wait(15);
    expect(await runner.drainOne()).toBe(true);
    expect(queue.pendingCount()).toBe(0);
    expect(attempts).toBe(2);
    queue.close();
  });

  it("redelivers a disk-backed queued bundle idempotently after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odf-edge-restart-"));
    temporaryDirectories.push(directory);
    const queuePath = join(directory, "queue.db");
    const restartOptions: EdgeAgentRunnerOptions = {
      ...runnerOptions,
      archiveDirectory: join(directory, "raw"),
      shutdownDrainTimeoutMs: 0,
      retry: { baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
    };
    const acceptedKeys = new Set<string>();
    const deliveryKeys: string[] = [];
    const initialQueue = new EdgeQueue(queuePath);
    const initialRunner = new EdgeAgentRunner(
      restartOptions,
      [managedConnector({ async poll() { return batch; }, async close() {} })],
      initialQueue,
      {
        async deliver(queued) {
          deliveryKeys.push(queued.idempotencyKey);
          acceptedKeys.add(queued.idempotencyKey);
          throw new Error("connection closed after the remote ingest accepted the batch");
        },
      },
      { createId: () => "first-queue-row", logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );
    let restartedRunner: EdgeAgentRunner | undefined;

    try {
      expect(await initialRunner.pollConnector("csv-pilot")).toBe(true);
      expect(await initialRunner.drainOne()).toBe(true);
      expect(initialQueue.pendingCount()).toBe(1);
      await initialRunner.shutdown();

      const restartedQueue = new EdgeQueue(queuePath);
      let replayedBundle: IngestBundle | undefined;
      let duplicateAcknowledgements = 0;
      restartedRunner = new EdgeAgentRunner(
        restartOptions,
        [managedConnector({ async poll() { return null; }, async close() {} })],
        restartedQueue,
        {
          async deliver(queued) {
            deliveryKeys.push(queued.idempotencyKey);
            replayedBundle = queued.bundle;
            if (acceptedKeys.has(queued.idempotencyKey)) duplicateAcknowledgements += 1;
            else acceptedKeys.add(queued.idempotencyKey);
          },
        },
        { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      );

      expect(restartedQueue.checkpoint("csv-pilot")).toBe("row:1");
      expect(await restartedRunner.drainOne()).toBe(true);
      expect(restartedQueue.pendingCount()).toBe(0);
      expect(deliveryKeys).toHaveLength(2);
      expect(deliveryKeys[1]).toBe(deliveryKeys[0]);
      expect(acceptedKeys.size).toBe(1);
      expect(duplicateAcknowledgements).toBe(1);
      expect(replayedBundle?.dataPoints).toEqual(batch.dataPoints);
    } finally {
      await restartedRunner?.shutdown();
      await initialRunner.shutdown();
    }
  });

  it("closes source handles and drains queued work during graceful shutdown", async () => {
    const queue = new EdgeQueue(":memory:");
    const bundle: IngestBundle = {
      source: { system: "csv-pilot", runId: "run-1", actor: "edge-agent" },
      assets: [],
      timeSeries: [],
      dataPoints: batch.dataPoints,
      documents: [],
      relations: [],
    };
    queue.enqueue("batch-1", "csv-pilot", bundle, "row:1", {
      path: "raw/batch-1.json",
      sha256: "a".repeat(64),
      bytes: 10,
    });
    let connectorClosed = false;
    let delivered = false;
    const connector: EdgeConnector = {
      async poll() { return null; },
      async close() { connectorClosed = true; },
    };
    const runner = new EdgeAgentRunner(
      runnerOptions,
      [managedConnector(connector)],
      queue,
      { async deliver() { delivered = true; } },
      { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    );

    await runner.shutdown();
    expect(connectorClosed).toBe(true);
    expect(delivered).toBe(true);
  });
});
