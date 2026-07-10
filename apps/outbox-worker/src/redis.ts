import type { RedisClientType } from "redis";

import type { OutboxEvent, SharedEventPublisher } from "./types.js";

function streamName(topic: string): string {
  const safeTopic = topic.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `odf:${safeTopic || "events"}`;
}

export class RedisStreamPublisher implements SharedEventPublisher {
  constructor(private readonly client: RedisClientType) {}

  async publish(event: OutboxEvent): Promise<void> {
    await this.client.xAdd(streamName(event.topic), "*", {
      eventId: event.eventId,
      eventType: event.eventType,
      eventVersion: String(event.eventVersion),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      messageKey: event.messageKey,
      deduplicationKey: event.deduplicationKey,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
      headers: JSON.stringify(event.headers),
      payload: JSON.stringify(event.payload),
    }, { TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: 100_000 } });
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.quit();
  }
}
