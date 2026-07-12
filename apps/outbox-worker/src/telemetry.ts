import { createServer, type Server } from "node:http";

import type { OutboxPumpResult } from "./outbox.js";
import type { OutboxOperationalSnapshot } from "./types.js";

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export class OutboxTelemetry {
  private cycles = 0;
  private claimed = 0;
  private published = 0;
  private failed = 0;
  private deadLettered = 0;
  private loopErrors = 0;
  private lastSuccessfulCycleAtSeconds = 0;
  private snapshot: OutboxOperationalSnapshot = {
    pendingEvents: 0,
    deadLetteredEvents: 0,
    oldestPendingAgeSeconds: 0,
  };
  private redisReady = false;

  observeCycle(result: OutboxPumpResult, snapshot: OutboxOperationalSnapshot, redisReady: boolean, now = Date.now()): void {
    this.cycles += 1;
    this.claimed += result.claimed;
    this.published += result.published;
    this.failed += result.failed;
    this.deadLettered += result.deadLettered;
    this.snapshot = snapshot;
    this.redisReady = redisReady;
    if (result.failed === 0 && snapshot.deadLetteredEvents === 0 && redisReady) {
      this.lastSuccessfulCycleAtSeconds = now / 1_000;
    }
  }

  observeLoopError(redisReady: boolean): void {
    this.loopErrors += 1;
    this.redisReady = redisReady;
  }

  metrics(): string {
    const lines = [
      "# HELP odf_outbox_cycles_total Completed outbox polling cycles.",
      "# TYPE odf_outbox_cycles_total counter",
      `odf_outbox_cycles_total ${this.cycles}`,
      "# HELP odf_outbox_events_claimed_total Outbox events leased for delivery.",
      "# TYPE odf_outbox_events_claimed_total counter",
      `odf_outbox_events_claimed_total ${this.claimed}`,
      "# HELP odf_outbox_events_published_total Outbox events acknowledged by the broker and PostgreSQL.",
      "# TYPE odf_outbox_events_published_total counter",
      `odf_outbox_events_published_total ${this.published}`,
      "# HELP odf_outbox_publish_failures_total Broker publish or acknowledgement failures.",
      "# TYPE odf_outbox_publish_failures_total counter",
      `odf_outbox_publish_failures_total ${this.failed}`,
      "# HELP odf_outbox_dead_lettered_total Events moved to durable dead-letter state.",
      "# TYPE odf_outbox_dead_lettered_total counter",
      `odf_outbox_dead_lettered_total ${this.deadLettered}`,
      "# HELP odf_outbox_loop_errors_total Worker loop failures outside an individual publish attempt.",
      "# TYPE odf_outbox_loop_errors_total counter",
      `odf_outbox_loop_errors_total ${this.loopErrors}`,
      "# HELP odf_outbox_pending_events Current unpublished, non-dead-letter event count from PostgreSQL.",
      "# TYPE odf_outbox_pending_events gauge",
      `odf_outbox_pending_events ${this.snapshot.pendingEvents}`,
      "# HELP odf_outbox_dead_letter_events Current durable dead-letter event count from PostgreSQL.",
      "# TYPE odf_outbox_dead_letter_events gauge",
      `odf_outbox_dead_letter_events ${this.snapshot.deadLetteredEvents}`,
      "# HELP odf_outbox_oldest_pending_age_seconds Age of the oldest deliverable event in PostgreSQL.",
      "# TYPE odf_outbox_oldest_pending_age_seconds gauge",
      `odf_outbox_oldest_pending_age_seconds ${this.snapshot.oldestPendingAgeSeconds}`,
      "# HELP odf_outbox_redis_ready Whether the Redis broker client is currently ready.",
      "# TYPE odf_outbox_redis_ready gauge",
      `odf_outbox_redis_ready ${this.redisReady ? 1 : 0}`,
      "# HELP odf_outbox_last_successful_cycle_timestamp_seconds Unix timestamp of the last healthy polling cycle.",
      "# TYPE odf_outbox_last_successful_cycle_timestamp_seconds gauge",
      `odf_outbox_last_successful_cycle_timestamp_seconds ${this.lastSuccessfulCycleAtSeconds}`,
    ];
    return `${lines.join("\n")}\n`;
  }
}

export async function startOutboxTelemetryServer(port: number, telemetry: OutboxTelemetry): Promise<Server> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Outbox metrics port must be between 1 and 65535");
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics") {
      response.statusCode = 200;
      response.setHeader("content-type", PROMETHEUS_CONTENT_TYPE);
      response.setHeader("cache-control", "no-store");
      response.end(telemetry.metrics());
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end('{"status":"ok"}\n');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export async function closeTelemetryServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
