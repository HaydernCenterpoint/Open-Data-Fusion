import { hostname } from "node:os";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Pool } from "pg";
import { createClient } from "redis";

import { OutboxPump } from "./outbox.js";
import { OutboxHealthFile } from "./health.js";
import { OutboxLogger } from "./logger.js";
import { PostgresOutboxRepository } from "./postgres.js";
import { RedisStreamPublisher } from "./redis.js";
import { closeTelemetryServer, OutboxTelemetry, startOutboxTelemetryServer } from "./telemetry.js";

try {
  loadEnvFile();
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

function required(name: string): string {
  const literal = process.env[name]?.trim();
  const file = process.env[`${name}_FILE`]?.trim();
  if (literal && file) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  const value = file ? readFileSync(file, "utf8").trim() : literal;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optionalPath(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const healthFile = new OutboxHealthFile(optionalPath("ODF_OUTBOX_HEALTH_FILE", "/tmp/odf-outbox-health.json"));
const healthMaximumAgeMilliseconds = positiveInteger("ODF_OUTBOX_HEALTH_MAX_AGE_MS", 30_000);
await healthFile.reset();

const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const logger = new OutboxLogger(workerId);
const pool = new Pool({
  connectionString: required("ODF_POSTGRES_URL"),
  max: positiveInteger("ODF_OUTBOX_DB_POOL_SIZE", 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  application_name: "open-data-fusion-outbox",
});
const redis = createClient({ url: required("ODF_REDIS_URL") });
redis.on("error", (error) => logger.log("error", "redis_connection_error", { error }));
await redis.connect();

const publisher = new RedisStreamPublisher(redis);
const repository = new PostgresOutboxRepository(pool);
const pump = new OutboxPump(repository, publisher, {
  workerId,
  batchSize: positiveInteger("ODF_OUTBOX_BATCH_SIZE", 50),
  leaseMilliseconds: positiveInteger("ODF_OUTBOX_LEASE_MS", 30_000),
  maximumRetryDelayMilliseconds: positiveInteger("ODF_OUTBOX_MAX_RETRY_DELAY_MS", 300_000),
  maximumDeliveryAttempts: positiveInteger("ODF_OUTBOX_MAX_ATTEMPTS", 12),
});
const pollMilliseconds = positiveInteger("ODF_OUTBOX_POLL_MS", 1_000);
const telemetry = new OutboxTelemetry();
const telemetryServer = await startOutboxTelemetryServer(
  positiveInteger("ODF_OUTBOX_METRICS_PORT", 9_465),
  telemetry,
  (probeId) => logger.log("info", "observability_probe", { probeId }),
);
let stopping = false;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.log("info", "stopping", { signal });
  await Promise.allSettled([closeTelemetryServer(telemetryServer), publisher.close(), pool.end(), logger.shutdown()]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
logger.log("info", "started", { healthMaximumAgeMilliseconds });

while (!stopping) {
  try {
    const result = await pump.runOnce();
    const snapshot = await repository.operationalSnapshot();
    telemetry.observeCycle(result, snapshot, redis.isReady);
    if (result.failed === 0 && snapshot.deadLetteredEvents === 0 && redis.isReady) {
      await healthFile.markSuccess();
    } else {
      logger.log("error", "delivery_dependency_unavailable", {
        failed: result.failed,
        deadLettered: result.deadLettered,
        deadLetteredEvents: snapshot.deadLetteredEvents,
        pendingEvents: snapshot.pendingEvents,
        oldestPendingAgeSeconds: snapshot.oldestPendingAgeSeconds,
        redisReady: redis.isReady,
      });
    }
    if (result.claimed === 0) await delay(pollMilliseconds);
    else logger.log("info", "cycle_completed", { ...result });
  } catch (error) {
    telemetry.observeLoopError(redis.isReady);
    logger.log("error", "loop_error", { error });
    await delay(pollMilliseconds);
  }
}
