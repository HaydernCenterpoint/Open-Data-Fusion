import type {
  AssetRecord,
  DataModelRecord,
  DatasetRecord,
  DocumentAssetLinkRecord,
  DocumentRecord,
  GraphInstanceRecord,
  ModelSpaceRecord,
  ModelViewRecord,
  PipelineRecord,
  PipelineRunRecordV2,
  PipelineVersionRecord,
  ProjectRecord,
  ProjectMemberRecord,
  QualityResultRecord,
  QualityRuleRecord,
  RelationCandidateRecord,
  RelationRecord,
  SourceConnectionRecord,
  TenantRecord,
  TenantMemberRecord,
  TimeSeriesPointRecord,
  TimeSeriesRecord,
  WritebackApprovalRecord,
  WritebackEventRecord,
  WritebackRequestRecord,
} from "./platform-types.js";
import type { JsonObject } from "./types.js";

type Row = Record<string, unknown>;

export function requiredRowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new TypeError("Expected non-empty " + key + " from PostgreSQL");
}

export function optionalRowString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function requiredRowNumber(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new TypeError("Expected numeric " + key + " from PostgreSQL");
  return value;
}

export function requiredRowBoolean(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "t" || value === "true") return true;
  if (value === 0 || value === "0" || value === "f" || value === "false") return false;
  throw new TypeError("Expected boolean " + key + " from PostgreSQL");
}

export function rowJsonObject(row: Row, key: string): JsonObject {
  const value = row[key];
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Expected JSON object " + key + " from PostgreSQL");
  }
  return parsed as JsonObject;
}

export function rowJsonObjectArray(row: Row, key: string): JsonObject[] {
  const value = row[key];
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new TypeError("Expected JSON object array " + key + " from PostgreSQL");
  }
  return parsed as JsonObject[];
}

function oneOf<T extends string>(value: string, values: readonly T[], key: string): T {
  if (!(values as readonly string[]).includes(value)) throw new TypeError("Unexpected " + key + " from PostgreSQL");
  return value as T;
}

export function tenantFromRow(row: Row): TenantRecord {
  return {
    tenantId: requiredRowString(row, "tenant_id"), slug: requiredRowString(row, "slug"), name: requiredRowString(row, "name"),
    status: oneOf(requiredRowString(row, "status"), ["active", "suspended", "retired"], "tenant status"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function projectFromRow(row: Row): ProjectRecord {
  return {
    projectId: requiredRowString(row, "project_id"), tenantId: requiredRowString(row, "tenant_id"),
    slug: requiredRowString(row, "slug"), name: requiredRowString(row, "name"), description: optionalRowString(row, "description"),
    status: oneOf(requiredRowString(row, "status"), ["active", "suspended", "archived"], "project status"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function tenantMemberFromRow(row: Row): TenantMemberRecord {
  const role = oneOf(requiredRowString(row, "role"), ["owner", "admin", "viewer"], "tenant member role");
  return {
    tenantId: requiredRowString(row, "tenant_id"),
    userId: requiredRowString(row, "user_id"),
    role,
    createdBy: requiredRowString(row, "created_by"),
    createdAt: requiredRowString(row, "created_at"),
    updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function projectMemberFromRow(row: Row): ProjectMemberRecord {
  const role = oneOf(requiredRowString(row, "role"), ["owner", "editor", "reviewer", "viewer"], "project member role");
  return {
    tenantId: requiredRowString(row, "tenant_id"),
    projectId: requiredRowString(row, "project_id"),
    userId: requiredRowString(row, "user_id"),
    role,
    createdBy: requiredRowString(row, "created_by"),
    createdAt: requiredRowString(row, "created_at"),
    updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function datasetFromRow(row: Row): DatasetRecord {
  return {
    datasetId: requiredRowString(row, "dataset_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    externalId: requiredRowString(row, "external_id"), name: requiredRowString(row, "name"), description: optionalRowString(row, "description"),
    classification: oneOf(requiredRowString(row, "classification"), ["public", "internal", "confidential", "restricted"], "dataset classification"),
    retentionUntil: optionalRowString(row, "retention_until"), createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function modelSpaceFromRow(row: Row): ModelSpaceRecord {
  return {
    spaceId: requiredRowString(row, "space_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    externalId: requiredRowString(row, "external_id"), name: requiredRowString(row, "name"), description: optionalRowString(row, "description"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function sourceConnectionFromRow(row: Row): SourceConnectionRecord {
  return {
    sourceConnectionId: requiredRowString(row, "source_connection_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    datasetId: optionalRowString(row, "dataset_id"), externalId: requiredRowString(row, "external_id"), name: requiredRowString(row, "name"),
    connectorKind: oneOf(requiredRowString(row, "connector_kind"), ["opcua", "jdbc", "csv", "http"], "connector kind"),
    state: oneOf(requiredRowString(row, "state"), ["draft", "ready", "running", "degraded", "disabled"], "connection state"),
    endpoint: optionalRowString(row, "endpoint"), secretRef: optionalRowString(row, "secret_ref"), connectorConfig: rowJsonObject(row, "connector_config"),
    lastSuccessfulRunAt: optionalRowString(row, "last_successful_run_at"), createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function dataModelFromRow(row: Row): DataModelRecord {
  return {
    dataModelId: requiredRowString(row, "data_model_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    spaceId: requiredRowString(row, "space_id"), externalId: requiredRowString(row, "external_id"), version: requiredRowString(row, "version"),
    name: requiredRowString(row, "name"), description: optionalRowString(row, "description"), definition: rowJsonObject(row, "definition"),
    state: oneOf(requiredRowString(row, "state"), ["draft", "published", "deprecated"], "data model state"),
    createdBy: requiredRowString(row, "created_by"), createdAt: requiredRowString(row, "created_at"), publishedAt: optionalRowString(row, "published_at"),
  };
}

export function modelViewFromRow(row: Row): ModelViewRecord {
  return {
    modelViewId: requiredRowString(row, "model_view_id"), tenantId: requiredRowString(row, "tenant_id"), dataModelId: requiredRowString(row, "data_model_id"),
    externalId: requiredRowString(row, "external_id"), version: requiredRowString(row, "version"), name: requiredRowString(row, "name"),
    definition: rowJsonObject(row, "definition"), createdAt: requiredRowString(row, "created_at"),
  };
}

export function graphInstanceFromRow(row: Row): GraphInstanceRecord {
  return {
    instanceId: requiredRowString(row, "instance_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    datasetId: optionalRowString(row, "dataset_id"), spaceId: requiredRowString(row, "space_id"), externalId: requiredRowString(row, "external_id"),
    instanceKind: oneOf(requiredRowString(row, "instance_kind"), ["node", "edge"], "instance kind"), dataModelId: optionalRowString(row, "data_model_id"),
    properties: rowJsonObject(row, "properties"), validFrom: optionalRowString(row, "valid_from"), validTo: optionalRowString(row, "valid_to"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function assetFromRow(row: Row): AssetRecord {
  return {
    assetId: requiredRowString(row, "asset_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    parentAssetId: optionalRowString(row, "parent_asset_id"), assetKind: oneOf(requiredRowString(row, "asset_kind"), ["site", "system", "equipment", "instrument", "location"], "asset kind"),
    assetType: requiredRowString(row, "asset_type"), name: requiredRowString(row, "name"), description: optionalRowString(row, "description"),
    site: optionalRowString(row, "site"), sourceSystem: requiredRowString(row, "source_system"), metadata: rowJsonObject(row, "metadata"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function timeSeriesFromRow(row: Row): TimeSeriesRecord {
  return {
    timeSeriesId: requiredRowString(row, "time_series_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    datasetId: optionalRowString(row, "dataset_id"), assetId: optionalRowString(row, "asset_id"), name: requiredRowString(row, "name"), unit: optionalRowString(row, "unit"),
    valueType: oneOf(requiredRowString(row, "value_type"), ["numeric", "string", "state"], "time series value type"),
    interpolation: oneOf(requiredRowString(row, "interpolation"), ["linear", "step", "none"], "time series interpolation"),
    sourceSystem: requiredRowString(row, "source_system"), metadata: rowJsonObject(row, "metadata"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function timeSeriesPointFromRow(row: Row): TimeSeriesPointRecord {
  return {
    tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"), timeSeriesId: requiredRowString(row, "time_series_id"),
    observedAt: requiredRowString(row, "observed_at"), sequence: requiredRowString(row, "sequence"),
    numericValue: row.numeric_value === null || row.numeric_value === undefined ? null : requiredRowNumber(row, "numeric_value"),
    textValue: optionalRowString(row, "text_value"), quality: oneOf(requiredRowString(row, "quality"), ["good", "uncertain", "bad", "unknown"], "point quality"),
    sourceConnectionId: optionalRowString(row, "source_connection_id"), ingestionRunId: optionalRowString(row, "ingestion_run_id"), receivedAt: requiredRowString(row, "received_at"),
  };
}

export function documentFromRow(row: Row): DocumentRecord {
  return {
    documentId: requiredRowString(row, "document_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    datasetId: optionalRowString(row, "dataset_id"), rawObjectId: optionalRowString(row, "raw_object_id"), title: requiredRowString(row, "title"),
    mimeType: optionalRowString(row, "mime_type"), storageUri: optionalRowString(row, "storage_uri"), byteSize: optionalRowString(row, "byte_size"),
    contentSha256: optionalRowString(row, "content_sha256"), sourceSystem: requiredRowString(row, "source_system"), metadata: rowJsonObject(row, "metadata"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function documentAssetLinkFromRow(row: Row): DocumentAssetLinkRecord {
  return {
    tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"), documentId: requiredRowString(row, "document_id"),
    assetId: requiredRowString(row, "asset_id"), relationType: requiredRowString(row, "relation_type"), createdAt: requiredRowString(row, "created_at"),
  };
}

export function relationFromRow(row: Row): RelationRecord {
  return {
    relationId: requiredRowString(row, "relation_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    datasetId: optionalRowString(row, "dataset_id"), sourceInstanceId: requiredRowString(row, "source_instance_id"), targetInstanceId: requiredRowString(row, "target_instance_id"),
    relationType: requiredRowString(row, "relation_type"), state: oneOf(requiredRowString(row, "state"), ["accepted", "superseded"], "relation state"),
    sourceSystem: requiredRowString(row, "source_system"), evidence: rowJsonObject(row, "evidence"), createdAt: requiredRowString(row, "created_at"), supersededAt: optionalRowString(row, "superseded_at"),
  };
}

export function relationCandidateFromRow(row: Row): RelationCandidateRecord {
  return {
    relationCandidateId: requiredRowString(row, "relation_candidate_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    sourceInstanceId: requiredRowString(row, "source_instance_id"), targetInstanceId: requiredRowString(row, "target_instance_id"), relationType: requiredRowString(row, "relation_type"),
    confidence: requiredRowNumber(row, "confidence"), evidence: rowJsonObjectArray(row, "evidence"), ruleVersion: optionalRowString(row, "rule_version"),
    modelVersion: optionalRowString(row, "model_version"), state: oneOf(requiredRowString(row, "state"), ["proposed", "accepted", "rejected", "superseded"], "candidate state"),
    reviewer: optionalRowString(row, "reviewer"), reviewedAt: optionalRowString(row, "reviewed_at"), reviewComment: optionalRowString(row, "review_comment"),
    acceptedRelationId: optionalRowString(row, "accepted_relation_id"), createdAt: requiredRowString(row, "created_at"),
  };
}

export function pipelineFromRow(row: Row): PipelineRecord {
  return {
    pipelineId: requiredRowString(row, "pipeline_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    externalId: requiredRowString(row, "external_id"), name: requiredRowString(row, "name"), description: optionalRowString(row, "description"),
    currentVersion: requiredRowNumber(row, "current_version"), enabled: requiredRowBoolean(row, "enabled"), createdBy: requiredRowString(row, "created_by"),
    createdAt: requiredRowString(row, "created_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function pipelineVersionFromRow(row: Row): PipelineVersionRecord {
  return {
    pipelineVersionId: requiredRowString(row, "pipeline_version_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    pipelineId: requiredRowString(row, "pipeline_id"), version: requiredRowNumber(row, "version"), definition: rowJsonObject(row, "definition"),
    schedule: optionalRowString(row, "schedule"), createdBy: requiredRowString(row, "created_by"), createdAt: requiredRowString(row, "created_at"),
  };
}

export function pipelineRunV2FromRow(row: Row): PipelineRunRecordV2 {
  return {
    pipelineRunId: requiredRowString(row, "pipeline_run_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    pipelineId: requiredRowString(row, "pipeline_id"), pipelineVersion: requiredRowNumber(row, "pipeline_version"),
    state: oneOf(requiredRowString(row, "state"), ["queued", "running", "succeeded", "failed", "cancelled"], "pipeline run state"),
    triggerType: oneOf(requiredRowString(row, "trigger_type"), ["manual", "schedule", "event"], "pipeline trigger type"),
    correlationId: requiredRowString(row, "correlation_id"), startedAt: optionalRowString(row, "started_at"), completedAt: optionalRowString(row, "completed_at"), summary: rowJsonObject(row, "summary"),
  };
}

export function qualityRuleFromRow(row: Row): QualityRuleRecord {
  return {
    qualityRuleId: requiredRowString(row, "quality_rule_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    externalId: requiredRowString(row, "external_id"), version: requiredRowNumber(row, "version"), name: requiredRowString(row, "name"),
    ruleKind: oneOf(requiredRowString(row, "rule_kind"), ["required", "range", "regex", "unique", "reference"], "quality rule kind"),
    targetModelExternalId: requiredRowString(row, "target_model_external_id"), fieldName: optionalRowString(row, "field_name"), configuration: rowJsonObject(row, "configuration"),
    severity: oneOf(requiredRowString(row, "severity"), ["info", "warning", "error"], "quality severity"), enabled: requiredRowBoolean(row, "enabled"), createdAt: requiredRowString(row, "created_at"),
  };
}

export function qualityResultFromRow(row: Row): QualityResultRecord {
  return {
    qualityResultId: requiredRowString(row, "quality_result_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    qualityRuleId: requiredRowString(row, "quality_rule_id"), pipelineRunId: optionalRowString(row, "pipeline_run_id"), passed: requiredRowBoolean(row, "passed"),
    checkedRecords: requiredRowString(row, "checked_records"), failedRecords: requiredRowString(row, "failed_records"), sampleFailures: rowJsonObjectArray(row, "sample_failures"), occurredAt: requiredRowString(row, "occurred_at"),
  };
}

export function writebackRequestFromRow(row: Row): WritebackRequestRecord {
  return {
    writebackRequestId: requiredRowString(row, "writeback_request_id"), tenantId: requiredRowString(row, "tenant_id"), projectId: requiredRowString(row, "project_id"),
    sourceConnectionId: requiredRowString(row, "source_connection_id"), targetInstanceId: optionalRowString(row, "target_instance_id"), targetExternalId: requiredRowString(row, "target_external_id"),
    operation: requiredRowString(row, "operation"), payload: rowJsonObject(row, "payload"), risk: oneOf(requiredRowString(row, "risk"), ["low", "medium", "high", "critical"], "writeback risk"),
    state: oneOf(requiredRowString(row, "state"), ["draft", "pending_approval", "approved", "executing", "succeeded", "failed", "cancelled"], "writeback state"),
    requestedBy: requiredRowString(row, "requested_by"), requestedAt: requiredRowString(row, "requested_at"), dryRunResult: row.dry_run_result === null || row.dry_run_result === undefined ? null : rowJsonObject(row, "dry_run_result"),
    executedAt: optionalRowString(row, "executed_at"), updatedAt: requiredRowString(row, "updated_at"),
  };
}

export function writebackApprovalFromRow(row: Row): WritebackApprovalRecord {
  return {
    writebackApprovalId: requiredRowString(row, "writeback_approval_id"), tenantId: requiredRowString(row, "tenant_id"), writebackRequestId: requiredRowString(row, "writeback_request_id"),
    actor: requiredRowString(row, "actor"), decision: oneOf(requiredRowString(row, "decision"), ["approved", "rejected"], "writeback decision"),
    comment: optionalRowString(row, "comment"), occurredAt: requiredRowString(row, "occurred_at"),
  };
}

export function writebackEventFromRow(row: Row): WritebackEventRecord {
  return {
    id: requiredRowString(row, "id"), actor: requiredRowString(row, "actor"), action: requiredRowString(row, "action"), entityId: optionalRowString(row, "entity_id"),
    details: rowJsonObject(row, "details"), correlationId: requiredRowString(row, "correlation_id"), occurredAt: requiredRowString(row, "occurred_at"),
  };
}
