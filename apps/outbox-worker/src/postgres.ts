import type { Pool } from "pg";

import type {
  DeadLetteredOutboxEvent,
  OutboxEvent,
  OutboxOperationalSnapshot,
  OutboxRepository,
} from "./types.js";

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

interface OperationalSnapshotRow {
  pending_events: string | number;
  dead_lettered_events: string | number;
  oldest_pending_age_seconds: string | number;
}

interface DeadLetterRow {
  event_id: string | number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  correlation_id: string;
  occurred_at: Date | string;
  attempt_count: number;
  last_error: string;
}

export const DEAD_LETTER_ERROR_PREFIX = "dead-letter: ";

function nonNegativeNumber(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`PostgreSQL returned an invalid ${label}`);
  return parsed;
}

function deadLetterFromRow(row: DeadLetterRow): DeadLetteredOutboxEvent {
  return {
    eventId: String(row.event_id),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
  };
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
    const result = await this.pool.query(`
      UPDATE odf.outbox_events
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          available_at = now() + ($3 * interval '1 millisecond'),
          last_error = $4
      WHERE event_id = $1 AND lease_owner = $2 AND published_at IS NULL
    `, [eventId, workerId, delayMilliseconds, error]);
    if (result.rowCount !== 1) throw new Error(`Outbox lease for event '${eventId}' is no longer owned by this worker`);
  }

  async deadLetter(eventId: string, workerId: string, error: string): Promise<void> {
    const result = await this.pool.query(`
      UPDATE odf.outbox_events
      SET lease_owner = NULL,
          lease_expires_at = NULL,
          available_at = 'infinity'::timestamptz,
          last_error = $3
      WHERE event_id = $1 AND lease_owner = $2 AND published_at IS NULL
    `, [eventId, workerId, `${DEAD_LETTER_ERROR_PREFIX}${error}`.slice(0, 2_000)]);
    if (result.rowCount !== 1) throw new Error(`Outbox lease for event '${eventId}' is no longer owned by this worker`);
  }

  async operationalSnapshot(): Promise<OutboxOperationalSnapshot> {
    const result = await this.pool.query<OperationalSnapshotRow>(`
      SELECT
        count(*) FILTER (
          WHERE published_at IS NULL AND available_at <> 'infinity'::timestamptz
        ) AS pending_events,
        count(*) FILTER (
          WHERE published_at IS NULL AND available_at = 'infinity'::timestamptz
        ) AS dead_lettered_events,
        COALESCE(
          extract(epoch FROM now() - min(occurred_at) FILTER (
            WHERE published_at IS NULL AND available_at <> 'infinity'::timestamptz
          )),
          0
        ) AS oldest_pending_age_seconds
      FROM odf.outbox_events
    `);
    const row = result.rows[0];
    if (!row) throw new Error("PostgreSQL did not return an outbox operational snapshot");
    return {
      pendingEvents: nonNegativeNumber(row.pending_events, "pending-event count"),
      deadLetteredEvents: nonNegativeNumber(row.dead_lettered_events, "dead-letter count"),
      oldestPendingAgeSeconds: nonNegativeNumber(row.oldest_pending_age_seconds, "oldest-pending age"),
    };
  }

  async listDeadLetters(limit: number): Promise<DeadLetteredOutboxEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Dead-letter list limit must be between 1 and 500");
    const result = await this.pool.query<DeadLetterRow>(`
      SELECT event_id, aggregate_type, aggregate_id, event_type,
             correlation_id::text AS correlation_id, occurred_at,
             attempt_count, COALESCE(last_error, '') AS last_error
      FROM odf.outbox_events
      WHERE published_at IS NULL AND available_at = 'infinity'::timestamptz
      ORDER BY occurred_at, event_id
      LIMIT $1
    `, [limit]);
    return result.rows.map(deadLetterFromRow);
  }

  async requeueDeadLetter(eventId: string, reason: string): Promise<boolean> {
    const normalizedReason = reason.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 500);
    if (!normalizedReason) throw new Error("A non-empty recovery reason is required");
    const result = await this.pool.query(`
      UPDATE odf.outbox_events
      SET available_at = now(),
          attempt_count = 0,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = left('requeued: ' || $2 || '; previous: ' || COALESCE(last_error, ''), 2000)
      WHERE event_id = $1
        AND published_at IS NULL
        AND available_at = 'infinity'::timestamptz
    `, [eventId, normalizedReason]);
    return result.rowCount === 1;
  }
}
