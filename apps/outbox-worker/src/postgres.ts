import type { Pool } from "pg";

import type { OutboxEvent, OutboxRepository } from "./types.js";

interface OutboxRow {
  event_id: string | number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  topic: string;
  message_key: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  deduplication_key: string;
  correlation_id: string;
  occurred_at: Date | string;
  attempt_count: number;
}

function mapRow(row: OutboxRow): OutboxEvent {
  return {
    eventId: String(row.event_id),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    topic: row.topic,
    messageKey: row.message_key,
    payload: row.payload,
    headers: row.headers,
    deduplicationKey: row.deduplication_key,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    attemptCount: row.attempt_count,
  };
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly pool: Pool) {}

  async claim(batchSize: number, workerId: string, leaseMilliseconds: number): Promise<OutboxEvent[]> {
    const result = await this.pool.query<OutboxRow>(`
      WITH candidate AS (
        SELECT event.event_id
        FROM odf.outbox_events AS event
        WHERE event.published_at IS NULL
          AND event.available_at <= now()
          AND (event.lease_expires_at IS NULL OR event.lease_expires_at < now())
          AND NOT EXISTS (
            SELECT 1 FROM odf.outbox_events AS predecessor
            WHERE predecessor.aggregate_type = event.aggregate_type
              AND predecessor.aggregate_id = event.aggregate_id
              AND predecessor.published_at IS NULL
              AND (predecessor.occurred_at, predecessor.event_id) < (event.occurred_at, event.event_id)
          )
        ORDER BY event.available_at, event.occurred_at, event.event_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      ), claimed AS (
        UPDATE odf.outbox_events AS event
        SET lease_owner = $2,
            lease_expires_at = now() + ($3 * interval '1 millisecond'),
            attempt_count = event.attempt_count + 1,
            last_error = NULL
        FROM candidate
        WHERE event.event_id = candidate.event_id
        RETURNING event.*
      )
      SELECT * FROM claimed ORDER BY event_id ASC
    `, [batchSize, workerId, leaseMilliseconds]);
    return result.rows.map(mapRow);
  }

  async markPublished(eventId: string, workerId: string): Promise<void> {
    const result = await this.pool.query(`
      UPDATE odf.outbox_events
      SET published_at = now(), lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE event_id = $1 AND lease_owner = $2 AND published_at IS NULL
    `, [eventId, workerId]);
    if (result.rowCount !== 1) throw new Error(`Outbox lease for event '${eventId}' is no longer owned by this worker`);
  }

  async release(eventId: string, workerId: string, error: string, delayMilliseconds: number): Promise<void> {
    await this.pool.query(`
      UPDATE odf.outbox_events
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          available_at = now() + ($3 * interval '1 millisecond'),
          last_error = $4
      WHERE event_id = $1 AND lease_owner = $2 AND published_at IS NULL
    `, [eventId, workerId, delayMilliseconds, error]);
  }
}
