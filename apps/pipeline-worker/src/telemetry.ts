import { createServer, type Server } from "node:http";

import type { PipelinePollResult } from "./worker.js";

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
const CYCLE_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, Number.POSITIVE_INFINITY];
const OBSERVABILITY_PROBE_HEADER = "x-odf-observability-probe";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type HealthCheck = () => boolean | Promise<boolean>;
type ObservabilityProbe = (probeId: string) => void;

function observabilityProbeId(value: string | string[] | undefined): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function nonNegativeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeSeconds(milliseconds: number): number {
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1_000 : 0;
}

function timestampSeconds(now: number): number {
  return Number.isFinite(now) && now >= 0 ? now / 1_000 : 0;
}

/** A transition conflict is expected under concurrent updates, not a failed worker cycle. */
export function isSuccessfulPipelineCycle(result: PipelinePollResult): boolean {
  return result.failed === 0 && result.pollErrors === 0;
}

export class PipelineTelemetry {
  private successfulCycles = 0;
  private failedCycles = 0;
  private scopesPolled = 0;
  private runsClaimed = 0;
  private runsSucceeded = 0;
  private runsFailed = 0;
  private transitionConflicts = 0;
  private pollErrors = 0;
  private readonly cycleDurationBucketCounts = CYCLE_DURATION_BUCKETS.map(() => 0);
  private cycleDurationSumSeconds = 0;
  private cycleDurationCount = 0;
  private lastSuccessfulCycleAtSeconds = 0;

  observeCycle(result: PipelinePollResult, durationMilliseconds: number, now = Date.now()): boolean {
    const successful = isSuccessfulPipelineCycle(result);
    if (successful) {
      this.successfulCycles += 1;
      this.lastSuccessfulCycleAtSeconds = timestampSeconds(now);
    } else {
      this.failedCycles += 1;
    }

    this.scopesPolled += nonNegativeCount(result.scopesPolled);
    this.runsClaimed += nonNegativeCount(result.claimed);
    this.runsSucceeded += nonNegativeCount(result.succeeded);
    this.runsFailed += nonNegativeCount(result.failed);
    this.transitionConflicts += nonNegativeCount(result.transitionConflicts);
    this.pollErrors += nonNegativeCount(result.pollErrors);

    const durationSeconds = nonNegativeSeconds(durationMilliseconds);
    this.cycleDurationSumSeconds += durationSeconds;
    this.cycleDurationCount += 1;
    for (const [index, bucket] of CYCLE_DURATION_BUCKETS.entries()) {
      if (durationSeconds <= bucket) {
        this.cycleDurationBucketCounts[index] = (this.cycleDurationBucketCounts[index] ?? 0) + 1;
      }
    }
    return successful;
  }

  metrics(): string {
    const durationBuckets = CYCLE_DURATION_BUCKETS.map((bucket, index) => {
      const label = Number.isFinite(bucket) ? String(bucket) : "+Inf";
      return `odf_pipeline_cycle_duration_seconds_bucket{le="${label}"} ${this.cycleDurationBucketCounts[index] ?? 0}`;
    });
    const lines = [
      "# HELP odf_pipeline_cycles_total Completed pipeline worker cycles by outcome.",
      "# TYPE odf_pipeline_cycles_total counter",
      `odf_pipeline_cycles_total{outcome="success"} ${this.successfulCycles}`,
      `odf_pipeline_cycles_total{outcome="failure"} ${this.failedCycles}`,
      "# HELP odf_pipeline_scopes_polled_total Pipeline scopes visited by polling cycles.",
      "# TYPE odf_pipeline_scopes_polled_total counter",
      `odf_pipeline_scopes_polled_total ${this.scopesPolled}`,
      "# HELP odf_pipeline_runs_claimed_total Pipeline runs claimed for processing.",
      "# TYPE odf_pipeline_runs_claimed_total counter",
      `odf_pipeline_runs_claimed_total ${this.runsClaimed}`,
      "# HELP odf_pipeline_runs_processed_total Pipeline runs processed by outcome.",
      "# TYPE odf_pipeline_runs_processed_total counter",
      `odf_pipeline_runs_processed_total{outcome="succeeded"} ${this.runsSucceeded}`,
      `odf_pipeline_runs_processed_total{outcome="failed"} ${this.runsFailed}`,
      `odf_pipeline_runs_processed_total{outcome="transition_conflict"} ${this.transitionConflicts}`,
      "# HELP odf_pipeline_poll_errors_total Scope claim failures encountered by polling cycles.",
      "# TYPE odf_pipeline_poll_errors_total counter",
      `odf_pipeline_poll_errors_total ${this.pollErrors}`,
      "# HELP odf_pipeline_cycle_duration_seconds Duration of completed pipeline worker cycles.",
      "# TYPE odf_pipeline_cycle_duration_seconds histogram",
      ...durationBuckets,
      `odf_pipeline_cycle_duration_seconds_sum ${this.cycleDurationSumSeconds}`,
      `odf_pipeline_cycle_duration_seconds_count ${this.cycleDurationCount}`,
      "# HELP odf_pipeline_last_successful_cycle_timestamp_seconds Unix timestamp of the last healthy pipeline worker cycle.",
      "# TYPE odf_pipeline_last_successful_cycle_timestamp_seconds gauge",
      `odf_pipeline_last_successful_cycle_timestamp_seconds ${this.lastSuccessfulCycleAtSeconds}`,
    ];
    return `${lines.join("\n")}\n`;
  }
}

async function healthStatus(check: HealthCheck | undefined): Promise<boolean> {
  if (!check) return true;
  try {
    return await check();
  } catch {
    return false;
  }
}

export async function startPipelineTelemetryServer(
  port: number,
  telemetry: PipelineTelemetry,
  healthCheck?: HealthCheck,
  onObservabilityProbe?: ObservabilityProbe,
): Promise<Server> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Pipeline metrics port must be between 1 and 65535");
  }
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics") {
      response.statusCode = 200;
      response.setHeader("content-type", PROMETHEUS_CONTENT_TYPE);
      response.setHeader("cache-control", "no-store");
      response.end(telemetry.metrics());
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      const probeId = observabilityProbeId(request.headers[OBSERVABILITY_PROBE_HEADER]);
      if (probeId) {
        try {
          onObservabilityProbe?.(probeId);
        } catch {
          // A telemetry probe must not make the worker's health check fail.
        }
      }
      void healthStatus(healthCheck).then((healthy) => {
        response.statusCode = healthy ? 200 : 503;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(`${JSON.stringify({ status: healthy ? "ok" : "unhealthy" })}\n`);
      });
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

export async function closePipelineTelemetryServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
