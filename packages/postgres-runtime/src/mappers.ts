import type {
  IngestionRunRecord,
  JsonObject,
  OutboxEventRecord,
  PipelineRunRecord,
  RawIngestObjectRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
  WorkspaceRevisionRecord,
  WorkspaceRole,
} from "./types.js";

type Row = Record<string, unknown>;

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new TypeError("Expected non-empty " + key + " from PostgreSQL");
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function requiredNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new TypeError("Expected numeric " + key + " from PostgreSQL");
  return value;
}

function jsonObject(value: unknown, key: string): JsonObject {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Expected JSON object " + key + " from PostgreSQL");
  }
  return parsed as JsonObject;
}

export function workspaceFromRow(row: Row): WorkspaceRecord {
  return {
    id: requiredString(row, "id"),
    name: requiredString(row, "name"),
    snapshot: jsonObject(row.snapshot, "snapshot"),
    version: requiredNumber(row, "version"),
    createdBy: requiredString(row, "created_by"),
    createdAt: requiredString(row, "created_at"),
    updatedBy: requiredString(row, "updated_by"),
    updatedAt: requiredString(row, "updated_at"),
  };
}

export function workspaceRevisionFromRow(row: Row): WorkspaceRevisionRecord {
  return {
    workspaceId: requiredString(row, "workspace_id"),
    version: requiredNumber(row, "version"),
    snapshot: jsonObject(row.snapshot, "snapshot"),
    changeSummary: requiredString(row, "change_summary"),
    actor: requiredString(row, "actor"),
    createdAt: requiredString(row, "created_at"),
    correlationId: requiredString(row, "correlation_id"),
  };
}

export function workspaceMemberFromRow(row: Row): WorkspaceMemberRecord {
  const role = requiredString(row, "role");
  if (role !== "owner" && role !== "editor" && role !== "reviewer" && role !== "viewer") {
    throw new TypeError("Expected workspace member role from PostgreSQL");
  }
  return {
    workspaceId: requiredString(row, "workspace_id"),
    userId: requiredString(row, "user_id"),
    displayName: requiredString(row, "display_name"),
    role: role as WorkspaceRole,
    createdAt: requiredString(row, "created_at"),
  };
}

export function rawIngestObjectFromRow(row: Row): RawIngestObjectRecord {
  return {
    rawObjectId: requiredString(row, "raw_object_id"),
    tenantId: requiredString(row, "tenant_id"),
    projectId: requiredString(row, "project_id"),
    datasetId: nullableString(row, "dataset_id"),
    sourceConnectionId: requiredString(row, "source_connection_id"),
    storageUri: requiredString(row, "storage_uri"),
    contentSha256: requiredString(row, "content_sha256"),
    contentType: nullableString(row, "content_type"),
    byteSize: requiredNumber(row, "byte_size"),
    receivedAt: requiredString(row, "received_at"),
    retentionUntil: nullableString(row, "retention_until"),
    encryptionKeyRef: nullableString(row, "encryption_key_ref"),
    metadata: jsonObject(row.metadata, "metadata"),
  };
}

export function ingestionRunFromRow(row: Row): IngestionRunRecord {
  const state = requiredString(row, "state");
  if (!["queued", "running", "succeeded", "partially_succeeded", "failed", "quarantined"].includes(state)) {
    throw new TypeError("Expected ingestion run state from PostgreSQL");
  }
  return {
    ingestionRunId: requiredString(row, "ingestion_run_id"),
    tenantId: requiredString(row, "tenant_id"),
    projectId: requiredString(row, "project_id"),
    datasetId: nullableString(row, "dataset_id"),
    sourceConnectionId: requiredString(row, "source_connection_id"),
    rawObjectId: nullableString(row, "raw_object_id"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    state: state as IngestionRunRecord["state"],
    checkpointBefore: row.checkpoint_before === null || row.checkpoint_before === undefined
      ? null
      : jsonObject(row.checkpoint_before, "checkpoint_before"),
    checkpointAfter: row.checkpoint_after === null || row.checkpoint_after === undefined
      ? null
      : jsonObject(row.checkpoint_after, "checkpoint_after"),
    acceptedRecords: requiredNumber(row, "accepted_records"),
    rejectedRecords: requiredNumber(row, "rejected_records"),
    startedAt: requiredString(row, "started_at"),
    completedAt: nullableString(row, "completed_at"),
    errorCode: nullableString(row, "error_code"),
    errorSummary: nullableString(row, "error_summary"),
    correlationId: requiredString(row, "correlation_id"),
  };
}

export function outboxEventFromRow(row: Row): OutboxEventRecord {
  return {
    eventId: requiredString(row, "event_id"),
    aggregateType: requiredString(row, "aggregate_type"),
    aggregateId: requiredString(row, "aggregate_id"),
    eventType: requiredString(row, "event_type"),
    eventVersion: requiredNumber(row, "event_version"),
    topic: requiredString(row, "topic"),
    messageKey: requiredString(row, "message_key"),
    payload: jsonObject(row.payload, "payload"),
    headers: jsonObject(row.headers, "headers"),
    deduplicationKey: requiredString(row, "deduplication_key"),
    correlationId: requiredString(row, "correlation_id"),
    occurredAt: requiredString(row, "occurred_at"),
    attemptCount: requiredNumber(row, "attempt_count"),
  };
}

export function pipelineRunFromRow(row: Row): PipelineRunRecord {
  const state = requiredString(row, "state");
  const triggerType = requiredString(row, "trigger_type");
  if (!["queued", "running", "succeeded", "failed", "cancelled"].includes(state)) {
    throw new TypeError("Expected pipeline run state from PostgreSQL");
  }
  if (!["manual", "schedule", "event"].includes(triggerType)) {
    throw new TypeError("Expected pipeline trigger type from PostgreSQL");
  }
  return {
    pipelineRunId: requiredString(row, "pipeline_run_id"),
    tenantId: requiredString(row, "tenant_id"),
    projectId: requiredString(row, "project_id"),
    pipelineId: requiredString(row, "pipeline_id"),
    pipelineVersion: requiredNumber(row, "pipeline_version"),
    state: state as PipelineRunRecord["state"],
    triggerType: triggerType as PipelineRunRecord["triggerType"],
    correlationId: requiredString(row, "correlation_id"),
    startedAt: nullableString(row, "started_at"),
    completedAt: nullableString(row, "completed_at"),
    summary: jsonObject(row.summary, "summary"),
  };
}

export function json(value: JsonObject): string {
  return JSON.stringify(value);
}
