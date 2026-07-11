import { hostname } from "node:os";
import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { createClient } from "redis";

import { OutboxPump } from "./outbox.js";
import { OutboxHealthFile } from "./health.js";
import { PostgresOutboxRepository } from "./postgres.js";
import { RedisStreamPublisher } from "./redis.js";

try {
  loadEnvFile();
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
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

const pool = new Pool({
  connectionString: required("ODF_POSTGRES_URL"),
  max: positiveInteger("ODF_OUTBOX_DB_POOL_SIZE", 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  application_name: "open-data-fusion-outbox",
});
const redis = createClient({ url: required("ODF_REDIS_URL") });
redis.on("error", (error) => console.error(JSON.stringify({ level: "error", component: "redis", message: error.message })));
await redis.connect();

const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const publisher = new RedisStreamPublisher(redis);
const pump = new OutboxPump(new PostgresOutboxRepository(pool), publisher, {
  workerId,
  batchSize: positiveInteger("ODF_OUTBOX_BATCH_SIZE", 50),
  leaseMilliseconds: positiveInteger("ODF_OUTBOX_LEASE_MS", 30_000),
});
const pollMilliseconds = positiveInteger("ODF_OUTBOX_POLL_MS", 1_000);
let stopping = false;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", component: "outbox", message: "stopping", signal, workerId }));
  await Promise.allSettled([publisher.close(), pool.end()]);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
console.log(JSON.stringify({
  level: "info",
  component: "outbox",
  message: "started",
  workerId,
  healthMaximumAgeMilliseconds,
}));

while (!stopping) {
  try {
    const result = await pump.runOnce();
    if (result.failed === 0 && redis.isReady) {
      await healthFile.markSuccess();
    } else {
      console.error(JSON.stringify({
        level: "error",
        component: "outbox",
        message: "delivery dependency is unavailable or an event could not be published",
        failed: result.failed,
        redisReady: redis.isReady,
      }));
    }
    if (result.claimed === 0) await delay(pollMilliseconds);
    else console.log(JSON.stringify({ level: "info", component: "outbox", ...result }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", component: "outbox", message: error instanceof Error ? error.message : "unknown error" }));
    await delay(pollMilliseconds);
  }
}
