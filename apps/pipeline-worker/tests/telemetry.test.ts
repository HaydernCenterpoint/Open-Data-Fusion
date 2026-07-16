import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  closePipelineTelemetryServer,
  PipelineTelemetry,
  startPipelineTelemetryServer,
} from "../src/telemetry.js";

async function unusedPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      reservation.off("error", reject);
      resolve();
    });
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => error ? reject(error) : resolve());
  });
  if (!address || typeof address === "string") throw new Error("failed to reserve an IPv4 test port");
  return address.port;
}

describe("pipeline Prometheus telemetry", () => {
  it("exports cycle, scope, run, duration, and last-success metrics", () => {
    const telemetry = new PipelineTelemetry();
    expect(telemetry.observeCycle({
      scopesPolled: 2,
      claimed: 3,
      succeeded: 2,
      failed: 0,
      transitionConflicts: 1,
      pollErrors: 0,
    }, 250, 10_000)).toBe(true);
    expect(telemetry.observeCycle({
      scopesPolled: 1,
      claimed: 2,
      succeeded: 0,
      failed: 1,
      transitionConflicts: 0,
      pollErrors: 1,
    }, 1_250, 20_000)).toBe(false);

    const metrics = telemetry.metrics();
    expect(metrics).toContain('odf_pipeline_cycles_total{outcome="success"} 1');
    expect(metrics).toContain('odf_pipeline_cycles_total{outcome="failure"} 1');
    expect(metrics).toContain("odf_pipeline_scopes_polled_total 3");
    expect(metrics).toContain("odf_pipeline_runs_claimed_total 5");
    expect(metrics).toContain('odf_pipeline_runs_processed_total{outcome="succeeded"} 2');
    expect(metrics).toContain('odf_pipeline_runs_processed_total{outcome="failed"} 1');
    expect(metrics).toContain('odf_pipeline_runs_processed_total{outcome="transition_conflict"} 1');
    expect(metrics).toContain("odf_pipeline_cycle_duration_seconds_sum 1.5");
    expect(metrics).toContain("odf_pipeline_cycle_duration_seconds_count 2");
    expect(metrics).toContain("odf_pipeline_last_successful_cycle_timestamp_seconds 10");
  });

  it("serves metrics and heartbeat-backed health without an HTTP framework", async () => {
    const telemetry = new PipelineTelemetry();
    telemetry.observeCycle({
      scopesPolled: 1,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      transitionConflicts: 0,
      pollErrors: 0,
    }, 10, 10_000);
    let healthy = false;
    const server = await startPipelineTelemetryServer(await unusedPort(), telemetry, () => healthy);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("telemetry server did not bind to an IPv4 port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const metrics = await fetch(`${baseUrl}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get("content-type")).toContain("text/plain; version=0.0.4");
      expect(await metrics.text()).toContain("odf_pipeline_scopes_polled_total 1");

      const unhealthy = await fetch(`${baseUrl}/healthz`);
      expect(unhealthy.status).toBe(503);
      expect(await unhealthy.json()).toEqual({ status: "unhealthy" });

      healthy = true;
      const fresh = await fetch(`${baseUrl}/healthz`);
      expect(fresh.status).toBe(200);
      expect(await fresh.json()).toEqual({ status: "ok" });
    } finally {
      await closePipelineTelemetryServer(server);
    }
  });

  it("emits only valid observability probes received through health checks", async () => {
    const probes: string[] = [];
    const server = await startPipelineTelemetryServer(
      await unusedPort(),
      new PipelineTelemetry(),
      () => true,
      (probeId) => probes.push(probeId),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("telemetry server did not bind to an IPv4 port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const probeId = "e2551a8b-0dd8-419d-964d-623abb6440dc";

    try {
      const valid = await fetch(`${baseUrl}/healthz`, { headers: { "x-odf-observability-probe": probeId } });
      expect(valid.status).toBe(200);
      expect(probes).toEqual([probeId]);

      const invalid = await fetch(`${baseUrl}/healthz`, { headers: { "x-odf-observability-probe": "not-a-uuid" } });
      expect(invalid.status).toBe(200);
      expect(probes).toEqual([probeId]);
    } finally {
      await closePipelineTelemetryServer(server);
    }
  });

  it("rejects invalid listening ports", async () => {
    await expect(startPipelineTelemetryServer(0, new PipelineTelemetry())).rejects.toThrow("between 1 and 65535");
  });
});
