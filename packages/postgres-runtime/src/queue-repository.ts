import { ConflictError } from "./errors.js";
import {
  outboxEventFromRow,
  pipelineRunFromRow,
} from "./mappers.js";
import type {
  ClaimOutboxInput,
  ClaimPipelineRunsInput,
  OutboxEventRecord,
  PipelineRunRecord,
  QueueRepository,
  TransactionContext,
  TransactionRunner,
} from "./types.js";

const OUTBOX_COLUMNS = [
  "event_id, aggregate_type, aggregate_id, event_type, event_version, topic, message_key,",
  "payload, headers, deduplication_key, correlation_id, occurred_at, attempt_count",
].join(" ");

const OUTBOX_RETURNING_COLUMNS = [
  "event.event_id AS event_id, event.aggregate_type AS aggregate_type,",
  "event.aggregate_id AS aggregate_id, event.event_type AS event_type,",
  "event.event_version AS event_version, event.topic AS topic, event.message_key AS message_key,",
  "event.payload AS payload, event.headers AS headers,",
  "event.deduplication_key AS deduplication_key, event.correlation_id AS correlation_id,",
  "event.occurred_at AS occurred_at, event.attempt_count AS attempt_count",
].join(" ");

const PIPELINE_RUN_COLUMNS = [
  "pipeline_run_id, tenant_id, project_id, pipeline_id, pipeline_version, state, trigger_type,",
  "correlation_id, started_at, completed_at, summary",
].join(" ");

const PIPELINE_RUN_RETURNING_COLUMNS = [
  "run.pipeline_run_id AS pipeline_run_id, run.tenant_id AS tenant_id,",
  "run.project_id AS project_id, run.pipeline_id AS pipeline_id,",
  "run.pipeline_version AS pipeline_version, run.state AS state,",
  "run.trigger_type AS trigger_type, run.correlation_id AS correlation_id,",
  "run.started_at AS started_at, run.completed_at AS completed_at, run.summary AS summary",
].join(" ");

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be an integer between " + String(minimum) + " and " + String(maximum));
  }
  return value;
}

function workerContext(workerId: string): TransactionContext {
  if (!workerId.trim()) throw new Error("workerId is required");
  return {
    tenantId: null,
    userId: workerId,
    platformAdmin: true,
  };
}

function sanitizeError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 2_000);
}

export class PostgresQueueRepository implements QueueRepository {
  constructor(private readonly runner: TransactionRunner) {}

  async claimOutboxEvents(input: ClaimOutboxInput): Promise<OutboxEventRecord[]> {
    const batchSize = bounded(input.batchSize, 1, 500, "batchSize");
    const leaseMilliseconds = bounded(input.leaseMilliseconds, 1_000, 300_000, "leaseMilliseconds");
    return this.runner.withTransaction(workerContext(input.workerId), async (transaction) => {
      const result = await transaction.query({
        text: [
          "WITH candidates AS (",
          "  SELECT event_id",
          "  FROM odf.outbox_events",
          "  WHERE published_at IS NULL",
          "    AND available_at <= now()",
          "    AND (lease_expires_at IS NULL OR lease_expires_at < now())",
          "  ORDER BY available_at ASC, occurred_at ASC, event_id ASC",
          "  LIMIT $1",
          "  FOR UPDATE SKIP LOCKED",
          "), claimed AS (",
          "  UPDATE odf.outbox_events AS event",
          "  SET lease_owner = $2,",
          "      lease_expires_at = now() + ($3 * interval '1 millisecond'),",
          "      attempt_count = event.attempt_count + 1,",
          "      last_error = NULL",
          "  FROM candidates",
          "  WHERE event.event_id = candidates.event_id",
          "  RETURNING " + OUTBOX_RETURNING_COLUMNS,
          ")",
          "SELECT " + OUTBOX_COLUMNS + " FROM claimed",
          "ORDER BY event_id ASC",
        ].join("\n"),
        values: [batchSize, input.workerId, leaseMilliseconds],
      });
      return result.rows.map(outboxEventFromRow);
    });
  }

  async markOutboxPublished(eventId: string, workerId: string): Promise<void> {
    await this.runner.withTransaction(workerContext(workerId), async (transaction) => {
      const result = await transaction.query({
        text: [
          "UPDATE odf.outbox_events",
          "SET published_at = now(), lease_owner = NULL, lease_expires_at = NULL, last_error = NULL",
          "WHERE event_id = $1::bigint",
          "  AND lease_owner = $2",
          "  AND published_at IS NULL",
          "RETURNING event_id",
        ].join("\n"),
        values: [eventId, workerId],
      });
      if (result.rowCount !== 1) throw new ConflictError("Outbox event lease is no longer owned by this worker");
    });
  }

  async releaseOutboxEvent(
    eventId: string,
    workerId: string,
    errorMessage: string,
    delayMilliseconds: number,
  ): Promise<void> {
    const delay = bounded(delayMilliseconds, 0, 300_000, "delayMilliseconds");
    await this.runner.withTransaction(workerContext(workerId), async (transaction) => {
      const result = await transaction.query({
        text: [
          "UPDATE odf.outbox_events",
          "SET lease_owner = NULL,",
          "    lease_expires_at = NULL,",
          "    available_at = now() + ($3 * interval '1 millisecond'),",
          "    last_error = $4",
          "WHERE event_id = $1::bigint",
          "  AND lease_owner = $2",
          "  AND published_at IS NULL",
          "RETURNING event_id",
        ].join("\n"),
        values: [eventId, workerId, delay, sanitizeError(errorMessage)],
      });
      if (result.rowCount !== 1) throw new ConflictError("Outbox event lease is no longer owned by this worker");
    });
  }

  async claimPipelineRuns(input: ClaimPipelineRunsInput): Promise<PipelineRunRecord[]> {
    const batchSize = bounded(input.batchSize, 1, 200, "batchSize");
    if (!input.tenantId.trim() || !input.projectId.trim() || !input.workerId.trim() || !input.correlationId.trim()) {
      throw new Error("tenantId, projectId, workerId, and correlationId are required");
    }
    return this.runner.withTransaction({
      tenantId: input.tenantId,
      userId: input.workerId,
    }, async (transaction) => {
      const result = await transaction.query({
        text: [
          "WITH candidates AS (",
          "  SELECT pipeline_run_id",
          "  FROM odf.pipeline_runs",
          "  WHERE tenant_id = $1::uuid",
          "    AND project_id = $2::uuid",
          "    AND state = 'queued'",
          "  ORDER BY pipeline_run_id ASC",
          "  LIMIT $3",
          "  FOR UPDATE SKIP LOCKED",
          "), claimed AS (",
          "  UPDATE odf.pipeline_runs AS run",
          "  SET state = 'running',",
          "      started_at = COALESCE(run.started_at, now())",
          "  FROM candidates",
          "  WHERE run.tenant_id = $1::uuid",
          "    AND run.project_id = $2::uuid",
          "    AND run.pipeline_run_id = candidates.pipeline_run_id",
          "  RETURNING " + PIPELINE_RUN_RETURNING_COLUMNS,
          "), events AS (",
          "  INSERT INTO odf.pipeline_run_events",
          "    (tenant_id, pipeline_run_id, event_type, state, details)",
          "  SELECT tenant_id, pipeline_run_id, 'pipeline.claimed', 'running',",
          "         jsonb_build_object('workerId', $4::text, 'correlationId', $5::text)",
          "  FROM claimed",
          ")",
          "SELECT " + PIPELINE_RUN_COLUMNS + " FROM claimed",
          "ORDER BY pipeline_run_id ASC",
        ].join("\n"),
        values: [
          input.tenantId,
          input.projectId,
          batchSize,
          input.workerId,
          input.correlationId,
        ],
      });
      return result.rows.map(pipelineRunFromRow);
    });
  }
}
