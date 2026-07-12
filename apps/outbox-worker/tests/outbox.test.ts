import { describe, expect, it } from "vitest";

import { OutboxPump } from "../src/outbox.js";
import type { OutboxEvent, OutboxRepository, SharedEventPublisher } from "../src/types.js";

const event = (eventId: string, attemptCount = 1): OutboxEvent => ({
  eventId,
  aggregateType: "workspace",
  aggregateId: "cooling-water-system",
  eventType: "workspace.updated",
  eventVersion: 1,
  topic: "workspace-events",
  messageKey: "cooling-water-system",
  payload: { version: 2 },
  headers: {},
  deduplicationKey: `workspace:cooling-water-system:${eventId}`,
  correlationId: "f7ca67c2-36db-4d79-92ea-eccdf507f2fc",
  occurredAt: "2026-07-11T00:00:00.000Z",
  attemptCount,
});

class FakeRepository implements OutboxRepository {
  readonly published: string[] = [];
  readonly released: Array<{ eventId: string; error: string; delay: number }> = [];
  readonly deadLetters: Array<{ eventId: string; error: string }> = [];

  constructor(private readonly events: OutboxEvent[]) {}
  async claim(): Promise<OutboxEvent[]> { return this.events; }
  async markPublished(eventId: string): Promise<void> { this.published.push(eventId); }
  async release(eventId: string, _workerId: string, error: string, delay: number): Promise<void> {
    this.released.push({ eventId, error, delay });
  }
  async deadLetter(eventId: string, _workerId: string, error: string): Promise<void> {
    this.deadLetters.push({ eventId, error });
  }
  async operationalSnapshot() {
    return { pendingEvents: 0, deadLetteredEvents: this.deadLetters.length, oldestPendingAgeSeconds: 0 };
  }
}

class FakePublisher implements SharedEventPublisher {
  readonly events: string[] = [];
  constructor(private readonly failingId?: string) {}
  async publish(item: OutboxEvent): Promise<void> {
    if (item.eventId === this.failingId) throw new Error("broker\nfailed with a transient error");
    this.events.push(item.eventId);
  }
  async close(): Promise<void> {}
}

describe("OutboxPump", () => {
  it("publishes claimed events before marking them complete", async () => {
    const repository = new FakeRepository([event("1"), event("2")]);
    const publisher = new FakePublisher();
    const result = await new OutboxPump(repository, publisher, { workerId: "worker" }).runOnce();
    expect(result).toEqual({ claimed: 2, published: 2, failed: 0, deadLettered: 0 });
    expect(publisher.events).toEqual(["1", "2"]);
    expect(repository.published).toEqual(["1", "2"]);
  });

  it("releases failed events with sanitized bounded backoff", async () => {
    const repository = new FakeRepository([event("1", 4), event("2")]);
    const result = await new OutboxPump(repository, new FakePublisher("1"), {
      workerId: "worker",
      maximumRetryDelayMilliseconds: 10_000,
    }).runOnce();
    expect(result).toEqual({ claimed: 2, published: 1, failed: 1, deadLettered: 0 });
    expect(repository.released).toEqual([{ eventId: "1", error: "broker failed with a transient error", delay: 10_000 }]);
    expect(repository.published).toEqual(["2"]);
  });

  it("does not publish a later claimed event while an earlier event is still in flight", async () => {
    const repository = new FakeRepository([event("1"), event("2")]);
    let releaseFirstEvent: (() => void) | undefined;
    const firstEventGate = new Promise<void>((resolve) => { releaseFirstEvent = resolve; });
    let signalFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    const started: string[] = [];
    const publisher: SharedEventPublisher = {
      async publish(item) {
        started.push(item.eventId);
        if (item.eventId === "1") {
          signalFirstStarted?.();
          await firstEventGate;
        }
      },
      async close() {},
    };
    const pump = new OutboxPump(repository, publisher, { workerId: "worker" });

    const running = pump.runOnce();
    await firstStarted;
    expect(started).toEqual(["1"]);
    expect(repository.published).toEqual([]);

    releaseFirstEvent?.();
    await expect(running).resolves.toEqual({ claimed: 2, published: 2, failed: 0, deadLettered: 0 });
    expect(started).toEqual(["1", "2"]);
    expect(repository.published).toEqual(["1", "2"]);
  });

  it("dead-letters a poison event after the configured attempt ceiling", async () => {
    const repository = new FakeRepository([event("poison", 3)]);
    const result = await new OutboxPump(repository, new FakePublisher("poison"), {
      workerId: "worker",
      maximumDeliveryAttempts: 3,
    }).runOnce();

    expect(result).toEqual({ claimed: 1, published: 0, failed: 1, deadLettered: 1 });
    expect(repository.released).toEqual([]);
    expect(repository.deadLetters).toEqual([{ eventId: "poison", error: "broker failed with a transient error" }]);
  });
});
