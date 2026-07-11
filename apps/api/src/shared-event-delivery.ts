import { randomUUID } from "node:crypto";

import { createClient } from "redis";

/**
 * The wire-compatible shape emitted by the PostgreSQL outbox worker. Keeping
 * this format here lets API instances consume the same Redis Streams without a
 * second, API-only event schema.
 */
export interface SharedEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  topic: string;
  messageKey: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  deduplicationKey: string;
  correlationId: string;
  occurredAt: string;
}

export interface SharedEventInput {
  topic: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventId?: string;
  eventVersion?: number;
  messageKey?: string;
  headers?: Record<string, unknown>;
  deduplicationKey?: string;
  correlationId?: string;
  occurredAt?: string;
}

export type SharedEventListener = (event: SharedEvent) => void;

export interface SharedEventDelivery {
  /** The selected transport at creation time. */
  readonly mode: "memory" | "redis";
  publish(input: SharedEventInput): Promise<SharedEvent>;
  subscribe(topic: string, listener: SharedEventListener): () => void;
  close(): Promise<void>;
}

export interface SharedEventLogger {
  warn(message: string): void;
}

export interface RedisStreamMessage {
  id: string;
  message: Map<string, string> | Record<string, string>;
}

export interface RedisStreamReadReply {
  name: string;
  messages: RedisStreamMessage[];
}

/**
 * The small subset of node-redis used by this module. It deliberately keeps
 * tests independent of a running Redis server and avoids exposing node-redis
 * types through the API package's public surface.
 */
export interface RedisStreamClient {
  readonly isOpen: boolean;
  connect(): Promise<void>;
  duplicate(): RedisStreamClient;
  quit(): Promise<void>;
  xAdd(
    key: string,
    id: string,
    message: Record<string, string>,
    options: { TRIM: { strategy: "MAXLEN"; strategyModifier: "~"; threshold: number } },
  ): Promise<string>;
  xRead(
    streams: Array<{ key: string; id: string }>,
    options: { COUNT: number; BLOCK: number },
  ): Promise<RedisStreamReadReply[] | null>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface SharedEventDeliveryOptions {
  /** Defaults to ODF_REDIS_URL. An empty value selects local-only delivery. */
  redisUrl?: string;
  /** Dependency injection point for tests and non-default Redis clients. */
  createRedisClient?: (url: string) => RedisStreamClient;
  logger?: SharedEventLogger;
  streamMaxLength?: number;
  readBatchSize?: number;
  readBlockMilliseconds?: number;
  seenEventLimit?: number;
}

const DEFAULT_STREAM_MAX_LENGTH = 100_000;
const DEFAULT_READ_BATCH_SIZE = 100;
const DEFAULT_READ_BLOCK_MILLISECONDS = 1_000;
const DEFAULT_SEEN_EVENT_LIMIT = 10_000;
const INTERNAL_ORIGIN_HEADER = "x-odf-delivery-origin";

function streamName(topic: string): string {
  const safeTopic = topic.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `odf:${safeTopic || "events"}`;
}

function nonEmptyString(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate <= 0) throw new Error(`${field} must be a positive integer`);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventFromInput(input: SharedEventInput): SharedEvent {
  const eventId = input.eventId === undefined ? randomUUID() : nonEmptyString(input.eventId, "eventId");
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const headers = input.headers ?? {};
  if (!isRecord(headers)) throw new Error("headers must be an object");
  if (INTERNAL_ORIGIN_HEADER in headers) throw new Error(`${INTERNAL_ORIGIN_HEADER} is reserved for event delivery`);
  if (!isRecord(input.payload)) throw new Error("payload must be an object");

  return {
    eventId,
    aggregateType: nonEmptyString(input.aggregateType, "aggregateType"),
    aggregateId: nonEmptyString(input.aggregateId, "aggregateId"),
    eventType: nonEmptyString(input.eventType, "eventType"),
    eventVersion: positiveInteger(input.eventVersion, 1, "eventVersion"),
    topic: nonEmptyString(input.topic, "topic"),
    messageKey: nonEmptyString(input.messageKey ?? input.aggregateId, "messageKey"),
    payload: input.payload,
    headers,
    deduplicationKey: nonEmptyString(input.deduplicationKey ?? eventId, "deduplicationKey"),
    correlationId: nonEmptyString(input.correlationId ?? eventId, "correlationId"),
    occurredAt: nonEmptyString(occurredAt, "occurredAt"),
  };
}

function fieldsFromMessage(message: Map<string, string> | Record<string, string>): Record<string, string> {
  if (message instanceof Map) return Object.fromEntries(message.entries());
  return message;
}

function parseObject(value: string | undefined, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function eventFromStream(topic: string, message: Map<string, string> | Record<string, string>): SharedEvent | undefined {
  const fields = fieldsFromMessage(message);
  const payload = parseObject(fields.payload, "payload");
  const rawHeaders = parseObject(fields.headers, "headers");
  if (!payload || !rawHeaders) return undefined;
  if (
    !fields.eventId?.trim() ||
    !fields.aggregateType?.trim() ||
    !fields.aggregateId?.trim() ||
    !fields.eventType?.trim() ||
    !fields.messageKey?.trim() ||
    !fields.deduplicationKey?.trim() ||
    !fields.correlationId?.trim() ||
    !fields.occurredAt?.trim()
  ) {
    return undefined;
  }

  const { [INTERNAL_ORIGIN_HEADER]: _origin, ...headers } = rawHeaders;
  try {
    return eventFromInput({
      topic,
      eventId: fields.eventId,
      aggregateType: fields.aggregateType ?? "",
      aggregateId: fields.aggregateId ?? "",
      eventType: fields.eventType ?? "",
      eventVersion: Number(fields.eventVersion),
      messageKey: fields.messageKey,
      payload,
      headers,
      deduplicationKey: fields.deduplicationKey,
      correlationId: fields.correlationId,
      occurredAt: fields.occurredAt,
    });
  } catch {
    return undefined;
  }
}

function streamFields(event: SharedEvent, originId: string): Record<string, string> {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    eventVersion: String(event.eventVersion),
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    messageKey: event.messageKey,
    deduplicationKey: event.deduplicationKey,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    headers: JSON.stringify({ ...event.headers, [INTERNAL_ORIGIN_HEADER]: originId }),
    payload: JSON.stringify(event.payload),
  };
}

class BoundedSet {
  private readonly values = new Set<string>();

  constructor(private readonly limit: number) {}

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    if (this.values.has(value)) return;
    this.values.add(value);
    if (this.values.size <= this.limit) return;
    const oldest = this.values.values().next().value;
    if (oldest !== undefined) this.values.delete(oldest);
  }
}

/** Local process fan-out used both as the development transport and Redis fallback. */
export class InMemorySharedEventDelivery implements SharedEventDelivery {
  readonly mode: "memory" | "redis" = "memory";
  private readonly subscriptions = new Map<string, Set<SharedEventListener>>();
  protected closed = false;

  constructor(protected readonly logger?: SharedEventLogger) {}

  async publish(input: SharedEventInput): Promise<SharedEvent> {
    const event = eventFromInput(input);
    this.dispatch(event);
    return event;
  }

  subscribe(topic: string, listener: SharedEventListener): () => void {
    if (this.closed) return () => undefined;
    const normalizedTopic = nonEmptyString(topic, "topic");
    const listeners = this.subscriptions.get(normalizedTopic) ?? new Set<SharedEventListener>();
    listeners.add(listener);
    this.subscriptions.set(normalizedTopic, listeners);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.subscriptions.get(normalizedTopic);
      current?.delete(listener);
      if (current?.size === 0) this.subscriptions.delete(normalizedTopic);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscriptions.clear();
  }

  protected dispatch(event: SharedEvent): void {
    const listeners = this.subscriptions.get(event.topic);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // Delivery is advisory; an SSE disconnect must not make a committed
        // mutation fail or prevent unrelated listeners from receiving it.
        listeners.delete(listener);
        this.logger?.warn("Shared event listener failed and was removed.");
      }
    }
    if (listeners.size === 0) this.subscriptions.delete(event.topic);
  }

  protected hasSubscribers(topic: string): boolean {
    return (this.subscriptions.get(topic)?.size ?? 0) > 0;
  }

  protected subscribedTopics(): string[] {
    return [...this.subscriptions.keys()];
  }
}

/**
 * Redis Streams-backed fan-out. Local delivery is always retained so a Redis
 * outage only removes cross-instance propagation; it never breaks the request
 * path or the local SSE clients that are already connected.
 */
export class RedisStreamEventDelivery extends InMemorySharedEventDelivery {
  override readonly mode = "redis" as const;
  private readonly originId = randomUUID();
  private readonly seenEventIds: BoundedSet;
  private readonly streamCursors = new Map<string, string>();
  private readonly streamTopics = new Map<string, string>();
  private readonly streamMaxLength: number;
  private readonly readBatchSize: number;
  private readonly readBlockMilliseconds: number;
  private redisActive = true;
  private readerStarted = false;
  private disabling: Promise<void> | undefined;

  constructor(
    private readonly publisher: RedisStreamClient,
    private readonly reader: RedisStreamClient,
    options: SharedEventDeliveryOptions = {},
  ) {
    super(options.logger);
    this.streamMaxLength = positiveInteger(options.streamMaxLength, DEFAULT_STREAM_MAX_LENGTH, "streamMaxLength");
    this.readBatchSize = positiveInteger(options.readBatchSize, DEFAULT_READ_BATCH_SIZE, "readBatchSize");
    this.readBlockMilliseconds = positiveInteger(
      options.readBlockMilliseconds,
      DEFAULT_READ_BLOCK_MILLISECONDS,
      "readBlockMilliseconds",
    );
    this.seenEventIds = new BoundedSet(positiveInteger(options.seenEventLimit, DEFAULT_SEEN_EVENT_LIMIT, "seenEventLimit"));
    this.publisher.on?.("error", () => void this.disableRedis());
    this.reader.on?.("error", () => void this.disableRedis());
  }

  override async publish(input: SharedEventInput): Promise<SharedEvent> {
    const event = eventFromInput(input);
    this.seenEventIds.add(event.eventId);

    // Local SSE listeners must not wait for a Redis round trip. The stream is
    // still the cross-instance delivery path, and the event id suppresses an
    // eventual echo from the local stream reader.
    this.dispatch(event);

    if (this.redisActive) {
      try {
        await this.publisher.xAdd(streamName(event.topic), "*", streamFields(event, this.originId), {
          TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: this.streamMaxLength },
        });
      } catch {
        await this.disableRedis();
      }
    }

    return event;
  }

  override subscribe(topic: string, listener: SharedEventListener): () => void {
    const normalizedTopic = nonEmptyString(topic, "topic");
    const unsubscribe = super.subscribe(normalizedTopic, listener);
    if (this.redisActive && !this.streamCursors.has(normalizedTopic)) {
      const name = streamName(normalizedTopic);
      this.streamCursors.set(normalizedTopic, "$");
      this.streamTopics.set(name, normalizedTopic);
    }
    this.startReader();
    return () => {
      unsubscribe();
      if (!this.hasSubscribers(normalizedTopic)) {
        this.streamCursors.delete(normalizedTopic);
        this.streamTopics.delete(streamName(normalizedTopic));
      }
    };
  }

  override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await super.close();
    await this.disableRedis(false);
  }

  private startReader(): void {
    if (this.readerStarted || this.closed || !this.redisActive || this.subscribedTopics().length === 0) return;
    this.readerStarted = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    try {
      while (!this.closed && this.redisActive && this.subscribedTopics().length > 0) {
        const streams = [...this.streamCursors.entries()].map(([topic, id]) => ({ key: streamName(topic), id }));
        if (streams.length === 0) break;

        let reply: RedisStreamReadReply[] | null;
        try {
          reply = await this.reader.xRead(streams, { COUNT: this.readBatchSize, BLOCK: this.readBlockMilliseconds });
        } catch {
          if (!this.closed) await this.disableRedis();
          break;
        }
        if (!reply) continue;
        this.consume(reply);
      }
    } finally {
      this.readerStarted = false;
      this.startReader();
    }
  }

  private consume(reply: RedisStreamReadReply[]): void {
    for (const stream of reply) {
      const topic = this.streamTopics.get(stream.name);
      if (!topic) continue;
      for (const message of stream.messages) {
        this.streamCursors.set(topic, message.id);
        const event = eventFromStream(topic, message.message);
        if (!event || this.seenEventIds.has(event.eventId)) continue;
        this.seenEventIds.add(event.eventId);
        this.dispatch(event);
      }
    }
  }

  private async disableRedis(report = true): Promise<void> {
    if (this.disabling) return this.disabling;
    if (!this.redisActive) return;
    this.redisActive = false;
    if (report) this.logger?.warn("Redis event delivery is unavailable; using in-memory delivery for this API instance.");
    this.disabling = Promise.allSettled([closeRedisClient(this.publisher), closeRedisClient(this.reader)]).then(() => undefined);
    return this.disabling;
  }
}

async function closeRedisClient(client: RedisStreamClient): Promise<void> {
  if (!client.isOpen) return;
  try {
    await client.quit();
  } catch {
    // The in-memory transport is already active. Shutdown must remain best effort.
  }
}

function defaultRedisClientFactory(url: string): RedisStreamClient {
  // node-redis has a significantly wider generic surface than this module
  // needs. The runtime contract is narrowed once at this boundary.
  return createClient({ url }) as unknown as RedisStreamClient;
}

/**
 * Select shared Redis Streams delivery only after both connections succeed.
 * A missing or unavailable Redis endpoint intentionally leaves the API in the
 * existing local-first mode rather than making startup or workspace writes fail.
 */
export async function createSharedEventDelivery(
  options: SharedEventDeliveryOptions = {},
): Promise<SharedEventDelivery> {
  const redisUrl = (options.redisUrl ?? process.env.ODF_REDIS_URL ?? "").trim();
  if (!redisUrl) return new InMemorySharedEventDelivery(options.logger);

  let publisher: RedisStreamClient | undefined;
  let reader: RedisStreamClient | undefined;
  try {
    const factory = options.createRedisClient ?? defaultRedisClientFactory;
    publisher = factory(redisUrl);
    reader = publisher.duplicate();
    publisher.on?.("error", () => undefined);
    reader.on?.("error", () => undefined);
    await Promise.all([publisher.isOpen ? Promise.resolve() : publisher.connect(), reader.isOpen ? Promise.resolve() : reader.connect()]);
    return new RedisStreamEventDelivery(publisher, reader, options);
  } catch {
    options.logger?.warn("Redis event delivery could not connect; using in-memory delivery for this API instance.");
    await Promise.allSettled([
      publisher ? closeRedisClient(publisher) : Promise.resolve(),
      reader ? closeRedisClient(reader) : Promise.resolve(),
    ]);
    return new InMemorySharedEventDelivery(options.logger);
  }
}

export { streamName as redisStreamName };
