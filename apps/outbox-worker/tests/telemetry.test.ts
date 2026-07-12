import { describe, expect, it } from "vitest";

import { OutboxTelemetry } from "../src/telemetry.js";

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
});
