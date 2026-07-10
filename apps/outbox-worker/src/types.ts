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

export interface OutboxRepository {
  claim(batchSize: number, workerId: string, leaseMilliseconds: number): Promise<OutboxEvent[]>;
  markPublished(eventId: string, workerId: string): Promise<void>;
  release(eventId: string, workerId: string, error: string, delayMilliseconds: number): Promise<void>;
}

export interface SharedEventPublisher {
  publish(event: OutboxEvent): Promise<void>;
  close(): Promise<void>;
}
