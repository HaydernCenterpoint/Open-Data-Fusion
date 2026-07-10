import { createHash, randomUUID } from "node:crypto";

import { archiveRawPayload } from "./archive.js";
import { DeliveryError, type DeliveryClient } from "./delivery.js";
import { EdgeQueue } from "./queue.js";
import type { ArchivedPayload, EdgeConnector, IngestBundle } from "./types.js";

export interface ManagedConnector {
  sourceSystem: string;
  connector: EdgeConnector;
}

export interface EdgeAgentRunnerOptions {
  archiveDirectory: string;
  actor: string;
  pollIntervalMs: number;
  deliveryIntervalMs: number;
  deliveryLeaseMs: number;
  shutdownDrainTimeoutMs: number;
  maxDrainBatch: number;
  retry: {
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio: number;
  };
}

export interface EdgeAgentLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface EdgeAgentRunnerDependencies {
  archive?: (
    archiveDirectory: string,
    sourceSystem: string,
    observedAt: string,
    records: readonly Record<string, unknown>[],
  ) => Promise<ArchivedPayload>;
  createId?: () => string;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  logger?: EdgeAgentLogger;
}

const consoleLogger: EdgeAgentLogger = {
  info: (message, details) => console.info(message, details ?? {}),
  warn: (message, details) => console.warn(message, details ?? {}),
  error: (message, details) => console.error(message, details ?? {}),
};

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class EdgeAgentRunner {
  private readonly archive: NonNullable<EdgeAgentRunnerDependencies["archive"]>;
  private readonly createId: () => string;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly sleep: NonNullable<EdgeAgentRunnerDependencies["sleep"]>;
  private readonly logger: EdgeAgentLogger;
  private readonly stopController = new AbortController();
  private closed = false;
  private running = false;

  constructor(
    private readonly options: EdgeAgentRunnerOptions,
    private readonly connectors: readonly ManagedConnector[],
    private readonly queue: EdgeQueue,
    private readonly delivery: DeliveryClient,
    dependencies: EdgeAgentRunnerDependencies = {},
  ) {
    this.archive = dependencies.archive ?? archiveRawPayload;
    this.createId = dependencies.createId ?? randomUUID;
    this.random = dependencies.random ?? Math.random;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.logger = dependencies.logger ?? consoleLogger;
  }

  requestStop(): void {
    this.stopController.abort();
  }

  async pollConnector(sourceSystem: string): Promise<boolean> {
    if (this.closed) throw new Error("Edge agent runner is closed");
    const managed = this.connectors.find((candidate) => candidate.sourceSystem === sourceSystem);
    if (!managed) throw new Error(`Unknown connector sourceSystem '${sourceSystem}'`);
    const checkpoint = this.queue.checkpoint(sourceSystem);
    const batch = await managed.connector.poll(checkpoint);
    if (!batch) return false;

    // This awaited durable write is deliberately before enqueue(), which is the only
    // operation allowed to advance the source checkpoint.
    const archived = await this.archive(this.options.archiveDirectory, sourceSystem, batch.observedAt, batch.rawRecords);
    const runHash = createHash("sha256")
      .update(JSON.stringify({ sourceSystem, checkpointAfter: batch.checkpointAfter, archiveSha256: archived.sha256 }))
      .digest("hex");
    const bundle: IngestBundle = {
      source: { system: sourceSystem, runId: `edge:${runHash}`, actor: this.options.actor },
      assets: batch.assets,
      timeSeries: batch.timeSeries,
      dataPoints: batch.dataPoints,
      documents: batch.documents,
      relations: batch.relations,
    };
    const inserted = this.queue.enqueue(this.createId(), sourceSystem, bundle, batch.checkpointAfter, archived);
    if (!inserted && this.queue.checkpoint(sourceSystem) !== batch.checkpointAfter) {
      throw new Error(`Idempotency collision prevented checkpoint advancement for source '${sourceSystem}'`);
    }
    this.logger.info("Edge source batch archived and queued", {
      sourceSystem,
      checkpointAfter: batch.checkpointAfter,
      records: batch.rawRecords.length,
      archiveSha256: archived.sha256,
    });
    return inserted;
  }

  async pollAllOnce(): Promise<void> {
    for (const managed of this.connectors) {
      try {
        await this.pollConnector(managed.sourceSystem);
      } catch (error) {
        this.logger.error("Edge source poll failed", { sourceSystem: managed.sourceSystem, error: message(error) });
      }
    }
  }

  async drainOne(): Promise<boolean> {
    if (this.closed) throw new Error("Edge agent runner is closed");
    const batch = this.queue.claim(this.options.deliveryLeaseMs);
    if (!batch) return false;
    try {
      await this.delivery.deliver(batch);
      this.queue.markSent(batch.id);
      this.logger.info("Queued ingest batch delivered", {
        sourceSystem: batch.sourceSystem,
        idempotencyKey: batch.idempotencyKey,
        attempt: batch.attemptCount,
      });
    } catch (error) {
      const retryDelay = this.retryDelay(batch.attemptCount, error);
      this.queue.release(batch.id, message(error), retryDelay);
      this.logger.warn("Queued ingest delivery failed", {
        sourceSystem: batch.sourceSystem,
        idempotencyKey: batch.idempotencyKey,
        attempt: batch.attemptCount,
        retryDelayMs: retryDelay,
        error: message(error),
      });
    }
    return true;
  }

  async drainReady(limit = this.options.maxDrainBatch): Promise<number> {
    let count = 0;
    while (count < limit && (await this.drainOne())) count += 1;
    return count;
  }

  async run(externalSignal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Edge agent runner is already running");
    if (this.closed) throw new Error("Edge agent runner is closed");
    this.running = true;
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, this.stopController.signal])
      : this.stopController.signal;
    try {
      await Promise.all([this.pollLoop(signal), this.deliveryLoop(signal)]);
    } finally {
      this.running = false;
      await this.shutdown();
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.stopController.abort();
    for (const managed of this.connectors) {
      try {
        await managed.connector.close();
      } catch (error) {
        this.logger.warn("Edge connector close failed", { sourceSystem: managed.sourceSystem, error: message(error) });
      }
    }

    const deadline = this.now() + this.options.shutdownDrainTimeoutMs;
    while (this.queue.pendingCount() > 0 && this.now() < deadline) {
      const worked = await this.drainReady();
      if (worked === 0) await this.sleep(Math.min(this.options.deliveryIntervalMs, Math.max(0, deadline - this.now())));
    }
    const remaining = this.queue.pendingCount();
    if (remaining > 0) {
      this.logger.warn("Edge agent stopped with durable batches remaining for the next start", { remaining });
    }
    this.closed = true;
    this.queue.close();
  }

  private retryDelay(attempt: number, error: unknown): number {
    const exponent = Math.min(Math.max(0, attempt - 1), 30);
    const unjittered = Math.min(this.options.retry.maxDelayMs, this.options.retry.baseDelayMs * 2 ** exponent);
    const multiplier = 1 - this.options.retry.jitterRatio + 2 * this.options.retry.jitterRatio * this.random();
    const calculated = Math.max(0, Math.round(unjittered * multiplier));
    const retryAfter = error instanceof DeliveryError ? error.retryAfterMs : null;
    return Math.min(this.options.retry.maxDelayMs, Math.max(calculated, retryAfter ?? 0));
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.pollAllOnce();
      await this.sleep(this.options.pollIntervalMs, signal);
    }
  }

  private async deliveryLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const drained = await this.drainReady();
        if (drained === this.options.maxDrainBatch) continue;
      } catch (error) {
        this.logger.error("Edge delivery queue loop failed", { error: message(error) });
      }
      await this.sleep(this.options.deliveryIntervalMs, signal);
    }
  }
}
