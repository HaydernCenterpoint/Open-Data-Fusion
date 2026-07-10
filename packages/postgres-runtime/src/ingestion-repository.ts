import {
  ConflictError,
  ForbiddenError,
} from "./errors.js";
import {
  ingestionRunFromRow,
  json,
  rawIngestObjectFromRow,
} from "./mappers.js";
import type {
  CanonicalIngestInput,
  CanonicalIngestResult,
  IngestionRepository,
  IngestionRunCursor,
  IngestionRunRecord,
  JsonObject,
  KeysetPage,
  RawIngestObjectRecord,
  RawObjectCursor,
  ScopedTransaction,
  TransactionContext,
  TransactionRunner,
} from "./types.js";

const RAW_COLUMNS = [
  "raw_object_id, tenant_id, project_id, dataset_id, source_connection_id,",
  "storage_uri, content_sha256, content_type, byte_size, received_at,",
  "retention_until, encryption_key_ref, metadata",
].join(" ");

const INGESTION_RUN_COLUMNS = [
  "ingestion_run_id, tenant_id, project_id, dataset_id, source_connection_id, raw_object_id,",
  "idempotency_key, state, checkpoint_before, checkpoint_after, accepted_records, rejected_records,",
  "started_at, completed_at, error_code, error_summary, correlation_id",
].join(" ");

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("limit must be an integer between 1 and 200");
  }
  return limit;
}

function assertTenant(context: TransactionContext, tenantId: string): void {
  if (context.platformAdmin === true) return;
  if (context.tenantId !== tenantId) {
    throw new ForbiddenError("Transaction tenant does not match the requested tenant");
  }
}

function nullableJson(value: JsonObject | null | undefined): string | null {
  return value ? json(value) : null;
}

export class PostgresIngestionRepository implements IngestionRepository {
  constructor(private readonly runner: TransactionRunner) {}

  async createCanonicalIngest(input: CanonicalIngestInput): Promise<CanonicalIngestResult> {
    if (!/^[0-9a-f]{64}$/.test(input.raw.contentSha256)) {
      throw new ConflictError("Raw object SHA-256 must be a lowercase 64-character hex value");
    }
    if (!Number.isSafeInteger(input.raw.byteSize) || input.raw.byteSize < 0) {
      throw new ConflictError("Raw object byte size must be a non-negative integer");
    }

    const context: TransactionContext = {
      tenantId: input.tenantId,
      userId: input.actor,
    };
    return this.runner.withTransaction(context, async (transaction) => {
      const rawInsert = await transaction.query({
        text: [
          "INSERT INTO odf.raw_ingest_objects",
          "  (tenant_id, project_id, dataset_id, source_connection_id, storage_uri, content_sha256,",
          "   content_type, byte_size, retention_until, encryption_key_ref, metadata)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::timestamptz, $10, $11::jsonb)",
          "ON CONFLICT (tenant_id, source_connection_id, content_sha256) DO NOTHING",
          "RETURNING " + RAW_COLUMNS,
        ].join("\n"),
        values: [
          input.tenantId,
          input.projectId,
          input.datasetId ?? null,
          input.sourceConnectionId,
          input.raw.storageUri,
          input.raw.contentSha256,
          input.raw.contentType ?? null,
          input.raw.byteSize,
          input.raw.retentionUntil ?? null,
          input.raw.encryptionKeyRef ?? null,
          json(input.raw.metadata ?? {}),
        ],
      });

      let rawObjectCreated = rawInsert.rows.length === 1;
      let rawObject = rawInsert.rows[0] ? rawIngestObjectFromRow(rawInsert.rows[0]) : null;
      if (!rawObject) {
        const existing = await transaction.query({
          text: [
            "SELECT " + RAW_COLUMNS,
            "FROM odf.raw_ingest_objects",
            "WHERE tenant_id = $1::uuid",
            "  AND source_connection_id = $2::uuid",
            "  AND content_sha256 = $3",
          ].join("\n"),
          values: [input.tenantId, input.sourceConnectionId, input.raw.contentSha256],
        });
        const row = existing.rows[0];
        if (!row) throw new ConflictError("Immutable raw object could not be resolved");
        rawObject = rawIngestObjectFromRow(row);
        rawObjectCreated = false;
      }
      if (
        rawObject.projectId !== input.projectId
        || rawObject.byteSize !== input.raw.byteSize
        || rawObject.datasetId !== (input.datasetId ?? null)
      ) {
        throw new ConflictError("Raw content identity is already bound to different ingest metadata");
      }

      const runInsert = await transaction.query({
        text: [
          "INSERT INTO odf.ingestion_runs",
          "  (tenant_id, project_id, dataset_id, source_connection_id, raw_object_id,",
          "   idempotency_key, state, checkpoint_before, correlation_id)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,",
          "        $6, 'queued', $7::jsonb, $8::uuid)",
          "ON CONFLICT (tenant_id, source_connection_id, idempotency_key) DO NOTHING",
          "RETURNING " + INGESTION_RUN_COLUMNS,
        ].join("\n"),
        values: [
          input.tenantId,
          input.projectId,
          input.datasetId ?? null,
          input.sourceConnectionId,
          rawObject.rawObjectId,
          input.idempotencyKey,
          nullableJson(input.checkpointBefore),
          input.correlationId,
        ],
      });

      let ingestionRunCreated = runInsert.rows.length === 1;
      let ingestionRun = runInsert.rows[0] ? ingestionRunFromRow(runInsert.rows[0]) : null;
      if (!ingestionRun) {
        const existing = await transaction.query({
          text: [
            "SELECT " + INGESTION_RUN_COLUMNS,
            "FROM odf.ingestion_runs",
            "WHERE tenant_id = $1::uuid",
            "  AND source_connection_id = $2::uuid",
            "  AND idempotency_key = $3",
          ].join("\n"),
          values: [input.tenantId, input.sourceConnectionId, input.idempotencyKey],
        });
        const row = existing.rows[0];
        if (!row) throw new ConflictError("Ingestion idempotency record could not be resolved");
        ingestionRun = ingestionRunFromRow(row);
        ingestionRunCreated = false;
      }
      if (
        ingestionRun.projectId !== input.projectId
        || ingestionRun.datasetId !== (input.datasetId ?? null)
        || ingestionRun.rawObjectId !== rawObject.rawObjectId
      ) {
        throw new ConflictError("Ingestion idempotency key is already bound to different input");
      }

      if (ingestionRunCreated) {
        const details: JsonObject = {
          rawObjectId: rawObject.rawObjectId,
          contentSha256: rawObject.contentSha256,
          byteSize: rawObject.byteSize,
        };
        await this.insertIngestionEvent(transaction, input, ingestionRun, details);
        await this.insertAuditAndOutbox(transaction, input, ingestionRun, rawObject, details);
      }
      return {
        rawObject,
        ingestionRun,
        rawObjectCreated,
        ingestionRunCreated,
      };
    });
  }

  async listRawObjects(
    context: TransactionContext,
    projectId: string,
    limit: number,
    cursor?: RawObjectCursor,
  ): Promise<KeysetPage<RawIngestObjectRecord, RawObjectCursor>> {
    const bounded = boundedLimit(limit);
    if (!context.tenantId) throw new ForbiddenError("Tenant context is required");
    assertTenant(context, context.tenantId);
    return this.runner.withTransaction(context, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + RAW_COLUMNS,
          "FROM odf.raw_ingest_objects",
          "WHERE tenant_id = $1::uuid",
          "  AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (received_at, raw_object_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY received_at DESC, raw_object_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [
          context.tenantId,
          projectId,
          cursor?.receivedAt ?? null,
          cursor?.rawObjectId ?? null,
          bounded + 1,
        ],
      });
      const rows = result.rows.map(rawIngestObjectFromRow);
      const page = rows.slice(0, bounded);
      const tail = page.at(-1);
      return {
        items: page,
        nextCursor: rows.length > bounded && tail
          ? { receivedAt: tail.receivedAt, rawObjectId: tail.rawObjectId }
          : null,
      };
    });
  }

  async listIngestionRuns(
    context: TransactionContext,
    projectId: string,
    limit: number,
    cursor?: IngestionRunCursor,
  ): Promise<KeysetPage<IngestionRunRecord, IngestionRunCursor>> {
    const bounded = boundedLimit(limit);
    if (!context.tenantId) throw new ForbiddenError("Tenant context is required");
    assertTenant(context, context.tenantId);
    return this.runner.withTransaction(context, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + INGESTION_RUN_COLUMNS,
          "FROM odf.ingestion_runs",
          "WHERE tenant_id = $1::uuid",
          "  AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (started_at, ingestion_run_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY started_at DESC, ingestion_run_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [
          context.tenantId,
          projectId,
          cursor?.startedAt ?? null,
          cursor?.ingestionRunId ?? null,
          bounded + 1,
        ],
      });
      const rows = result.rows.map(ingestionRunFromRow);
      const page = rows.slice(0, bounded);
      const tail = page.at(-1);
      return {
        items: page,
        nextCursor: rows.length > bounded && tail
          ? { startedAt: tail.startedAt, ingestionRunId: tail.ingestionRunId }
          : null,
      };
    });
  }

  private async insertIngestionEvent(
    transaction: ScopedTransaction,
    input: CanonicalIngestInput,
    run: IngestionRunRecord,
    details: JsonObject,
  ): Promise<void> {
    await transaction.query({
      text: [
        "INSERT INTO odf.ingestion_run_events",
        "  (tenant_id, ingestion_run_id, event_type, state, details, actor, correlation_id)",
        "VALUES ($1::uuid, $2::uuid, 'ingestion.raw_landed', 'queued', $3::jsonb, $4, $5::uuid)",
      ].join("\n"),
      values: [input.tenantId, run.ingestionRunId, json(details), input.actor, input.correlationId],
    });
  }

  private async insertAuditAndOutbox(
    transaction: ScopedTransaction,
    input: CanonicalIngestInput,
    run: IngestionRunRecord,
    raw: RawIngestObjectRecord,
    details: JsonObject,
  ): Promise<void> {
    await transaction.query({
      text: [
        "INSERT INTO odf.audit_log",
        "  (actor, action, entity_type, entity_id, details, correlation_id)",
        "VALUES ($1, 'ingestion.raw_landed', 'ingestionRun', $2, $3::jsonb, $4::uuid)",
      ].join("\n"),
      values: [input.actor, run.ingestionRunId, json(details), input.correlationId],
    });
    await transaction.query({
      text: [
        "INSERT INTO odf.outbox_events",
        "  (aggregate_type, aggregate_id, event_type, topic, message_key, payload, headers, deduplication_key, correlation_id)",
        "VALUES ('ingestionRun', $1, 'ingestion.run_queued', 'ingestion-events', $2, $3::jsonb, '{}'::jsonb, $4, $5::uuid)",
        "ON CONFLICT (aggregate_type, aggregate_id, event_type, deduplication_key) DO NOTHING",
      ].join("\n"),
      values: [
        run.ingestionRunId,
        raw.sourceConnectionId,
        json({
          ingestionRunId: run.ingestionRunId,
          rawObjectId: raw.rawObjectId,
          contentSha256: raw.contentSha256,
          byteSize: raw.byteSize,
        }),
        "ingestion:" + raw.sourceConnectionId + ":" + run.idempotencyKey,
        input.correlationId,
      ],
    });
  }
}
