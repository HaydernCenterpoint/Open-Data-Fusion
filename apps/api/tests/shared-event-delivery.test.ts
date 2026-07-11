import { describe, expect, it, vi } from 'vitest';

import {
  createSharedEventDelivery,
  InMemorySharedEventDelivery,
  RedisStreamEventDelivery,
  type RedisStreamClient,
  type RedisStreamReadReply,
  type SharedEvent,
} from '../src/shared-event-delivery.js';

class FakeRedisClient implements RedisStreamClient {
  isOpen = true;
  connectError: Error | undefined;
  xAddError: Error | undefined;
  duplicateClient: RedisStreamClient | undefined;
  quitCalls = 0;
  readonly xAddCalls: Array<{
    key: string;
    id: string;
    message: Record<string, string>;
    options: { TRIM: { strategy: 'MAXLEN'; strategyModifier: '~'; threshold: number } };
  }> = [];
  readonly xReadCalls: Array<{
    streams: Array<{ key: string; id: string }>;
    options: { COUNT: number; BLOCK: number };
  }> = [];
  readReplies: Array<RedisStreamReadReply[] | null> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.isOpen = true;
  }

  duplicate(): RedisStreamClient {
    if (!this.duplicateClient) throw new Error('duplicate client was not configured');
    return this.duplicateClient;
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
    this.isOpen = false;
  }

  async xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
    options: { TRIM: { strategy: 'MAXLEN'; strategyModifier: '~'; threshold: number } },
  ): Promise<string> {
    this.xAddCalls.push({ key, id, message, options });
    if (this.xAddError) throw this.xAddError;
    return '1-0';
  }

  async xRead(
    streams: Array<{ key: string; id: string }>,
    options: { COUNT: number; BLOCK: number },
  ): Promise<RedisStreamReadReply[] | null> {
    this.xReadCalls.push({ streams, options });
    const reply = this.readReplies.shift();
    if (reply !== undefined) return reply;
    return new Promise<RedisStreamReadReply[] | null>(() => undefined);
  }

  on(_event: 'error', listener: (error: Error) => void): unknown {
    this.errorListeners.push(listener);
    return this;
  }

  emitError(error = new Error('redis unavailable')): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

const workspaceEvent = {
  topic: 'workspace-events',
  eventType: 'workspace.updated',
  aggregateType: 'workspace',
  aggregateId: 'cooling-water-system',
  payload: { workspaceId: 'cooling-water-system', version: 2 },
};

describe('shared event delivery', () => {
  it('uses isolated in-memory fan-out when Redis is not configured', async () => {
    const delivery = await createSharedEventDelivery({ redisUrl: '' });
    const received: SharedEvent[] = [];
    const unsubscribe = delivery.subscribe('workspace-events', (event) => received.push(event));
    const published = await delivery.publish(workspaceEvent);

    expect(delivery).toBeInstanceOf(InMemorySharedEventDelivery);
    expect(delivery.mode).toBe('memory');
    expect(delivery.health()).toEqual({ status: 'ok', mode: 'memory' });
    expect(received).toEqual([published]);
    expect(published.messageKey).toBe('cooling-water-system');
    expect(published.correlationId).toBe(published.eventId);

    unsubscribe();
    await delivery.close();
  });

  it('falls back to memory when the configured Redis connection cannot be established', async () => {
    const publisher = new FakeRedisClient();
    publisher.isOpen = false;
    publisher.connectError = new Error('connection refused');
    const reader = new FakeRedisClient();
    reader.isOpen = false;
    publisher.duplicateClient = reader;
    const logger = { warn: vi.fn() };

    const delivery = await createSharedEventDelivery({
      redisUrl: 'redis://unavailable:6379/0',
      createRedisClient: () => publisher,
      logger,
    });
    const received: SharedEvent[] = [];
    delivery.subscribe('workspace-events', (event) => received.push(event));
    await delivery.publish(workspaceEvent);

    expect(delivery.mode).toBe('memory');
    expect(received).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Redis event delivery could not connect; using in-memory delivery for this API instance.',
    );
    expect(reader.quitCalls).toBe(1);

    await delivery.close();
  });

  it('writes an outbox-compatible Redis Stream record while retaining immediate local fan-out', async () => {
    const publisher = new FakeRedisClient();
    const reader = new FakeRedisClient();
    const delivery = new RedisStreamEventDelivery(publisher, reader);
    const received: SharedEvent[] = [];
    delivery.subscribe('workspace-events', (event) => received.push(event));

    const published = await delivery.publish({
      ...workspaceEvent,
      eventId: 'workspace-event-1',
      correlationId: 'correlation-1',
      headers: { tenantId: 'tenant-a' },
    });

    expect(received).toEqual([published]);
    expect(publisher.xAddCalls).toHaveLength(1);
    expect(delivery.health()).toEqual({ status: 'ok', mode: 'redis' });
    expect(publisher.xAddCalls[0]).toMatchObject({
      key: 'odf:workspace-events',
      id: '*',
      options: { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 100_000 } },
    });
    expect(publisher.xAddCalls[0]?.message).toMatchObject({
      eventId: 'workspace-event-1',
      eventType: 'workspace.updated',
      eventVersion: '1',
      aggregateType: 'workspace',
      aggregateId: 'cooling-water-system',
      messageKey: 'cooling-water-system',
      deduplicationKey: 'workspace-event-1',
      correlationId: 'correlation-1',
    });
    expect(JSON.parse(publisher.xAddCalls[0]?.message.payload ?? '')).toEqual(workspaceEvent.payload);
    expect(JSON.parse(publisher.xAddCalls[0]?.message.headers ?? '')).toMatchObject({ tenantId: 'tenant-a' });

    await delivery.close();
  });

  it('delivers valid events written by another API instance through Redis Streams', async () => {
    const publisher = new FakeRedisClient();
    const reader = new FakeRedisClient();
    reader.readReplies.push([
      {
        name: 'odf:workspace-events',
        messages: [
          {
            id: '42-0',
            message: new Map([
              ['eventId', 'remote-event-1'],
              ['eventType', 'workspace.updated'],
              ['eventVersion', '1'],
              ['aggregateType', 'workspace'],
              ['aggregateId', 'cooling-water-system'],
              ['messageKey', 'cooling-water-system'],
              ['deduplicationKey', 'remote-event-1'],
              ['correlationId', 'correlation-remote'],
              ['occurredAt', '2026-07-12T00:00:00.000Z'],
              ['headers', JSON.stringify({ source: 'api-b' })],
              ['payload', JSON.stringify({ workspaceId: 'cooling-water-system', version: 3 })],
            ]),
          },
        ],
      },
    ]);
    const delivery = new RedisStreamEventDelivery(publisher, reader);
    const received: SharedEvent[] = [];
    delivery.subscribe('workspace-events', (event) => received.push(event));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      eventId: 'remote-event-1',
      topic: 'workspace-events',
      headers: { source: 'api-b' },
      payload: { workspaceId: 'cooling-water-system', version: 3 },
    });
    expect(reader.xReadCalls[0]).toEqual({
      streams: [{ key: 'odf:workspace-events', id: '$' }],
      options: { COUNT: 100, BLOCK: 1_000 },
    });

    await delivery.close();
  });

  it('keeps local delivery available when Redis fails after startup', async () => {
    const publisher = new FakeRedisClient();
    publisher.xAddError = new Error('connection lost');
    const reader = new FakeRedisClient();
    const logger = { warn: vi.fn() };
    const delivery = new RedisStreamEventDelivery(publisher, reader, { logger });
    const received: SharedEvent[] = [];
    delivery.subscribe('workspace-events', (event) => received.push(event));

    await delivery.publish(workspaceEvent);

    expect(received).toHaveLength(1);
    expect(publisher.xAddCalls).toHaveLength(1);
    expect(publisher.quitCalls).toBe(1);
    expect(reader.quitCalls).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Redis event delivery is unavailable; using in-memory delivery for this API instance.',
    );
    expect(delivery.health()).toEqual({ status: 'degraded', mode: 'redis' });

    await delivery.close();
  });
});
