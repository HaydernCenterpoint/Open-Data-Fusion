import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { closeTelemetryServer, OutboxTelemetry, startOutboxTelemetryServer } from "../src/telemetry.js";

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
  if (!address || typeof address === "string") throw new Error("telemetry server did not bind to an IPv4 port");
  return address.port;
}

describe("outbox Prometheus telemetry", () => {
  it("exports cumulative delivery counters and durable PostgreSQL gauges", () => {
    const telemetry = new OutboxTelemetry();
    telemetry.observeCycle(
      { claimed: 3, published: 1, failed: 2, deadLettered: 1 },
      { pendingEvents: 5, deadLetteredEvents: 1, oldestPendingAgeSeconds: 72 },
      false,
      10_000,
    );

    const metrics = telemetry.metrics();
    expect(metrics).toContain("odf_outbox_events_claimed_total 3");
    expect(metrics).toContain("odf_outbox_events_published_total 1");
    expect(metrics).toContain("odf_outbox_dead_letter_events 1");
    expect(metrics).toContain("odf_outbox_oldest_pending_age_seconds 72");
    expect(metrics).toContain("odf_outbox_redis_ready 0");
  });

  it("emits only valid observability probes received through health checks", async () => {
    const probes: string[] = [];
    const server = await startOutboxTelemetryServer(await unusedPort(), new OutboxTelemetry(), (probeId) => probes.push(probeId));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("telemetry server did not bind to an IPv4 port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const probeId = "3d594650-3436-4539-a4a5-12c850af2a62";

    try {
      const valid = await fetch(`${baseUrl}/healthz`, { headers: { "x-odf-observability-probe": probeId } });
      expect(valid.status).toBe(200);
      expect(probes).toEqual([probeId]);

      const invalid = await fetch(`${baseUrl}/healthz`, { headers: { "x-odf-observability-probe": "not-a-uuid" } });
      expect(invalid.status).toBe(200);
      expect(probes).toEqual([probeId]);
    } finally {
      await closeTelemetryServer(server);
    }
  });
});
