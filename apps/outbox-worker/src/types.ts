export interface OutboxEvent {
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
  attemptCount: number;
}

export interface OutboxOperationalSnapshot {
  pendingEvents: number;
  deadLetteredEvents: number;
  oldestPendingAgeSeconds: number;
}

export interface DeadLetteredOutboxEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  correlationId: string;
  occurredAt: string;
  attemptCount: number;
  lastError: string;
}

export interface OutboxRepository {
  claim(batchSize: number, workerId: string, leaseMilliseconds: number): Promise<OutboxEvent[]>;
  markPublished(eventId: string, workerId: string): Promise<void>;
  release(eventId: string, workerId: string, error: string, delayMilliseconds: number): Promise<void>;
  deadLetter(eventId: string, workerId: string, error: string): Promise<void>;
  operationalSnapshot(): Promise<OutboxOperationalSnapshot>;
}

export interface SharedEventPublisher {
  publish(event: OutboxEvent): Promise<void>;
  close(): Promise<void>;
}
