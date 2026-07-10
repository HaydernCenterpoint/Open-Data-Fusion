export type IsoTimestamp = string;
export type EntityId = string;
export type DataPlanePermission =
  | "data:read"
  | "data:ingest"
  | "relations:review"
  | "audit:read"
  | "platform:admin"
  | "writeback:request"
  | "writeback:approve"
  | "writeback:execute";

export type ProjectRole = "owner" | "editor" | "reviewer" | "viewer";

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Tenant {
  id: EntityId;
  slug: string;
  name: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Project {
  id: EntityId;
  tenantId: EntityId;
  slug: string;
  name: string;
  description: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface DataSet {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  externalId: string;
  name: string;
  description: string | null;
  classification: "public" | "internal" | "confidential" | "restricted";
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type ConnectorKind = "opcua" | "jdbc" | "csv" | "http";
export type ConnectorState = "draft" | "ready" | "running" | "degraded" | "disabled";

export interface SourceConnection {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  dataSetId: EntityId;
  externalId: string;
  name: string;
  kind: ConnectorKind;
  state: ConnectorState;
  endpoint: string | null;
  secretRef: string | null;
  checkpoint: string | null;
  lastSuccessfulRunAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type IngestionRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "quarantined";

export interface IngestionRun {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  sourceId: EntityId;
  idempotencyKey: string;
  state: IngestionRunState;
  checkpointBefore: string | null;
  checkpointAfter: string | null;
  acceptedRecords: number;
  rejectedRecords: number;
  rawObjectUri: string | null;
  rawSha256: string | null;
  startedAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  errorCode: string | null;
  errorSummary: string | null;
}

export interface QuarantinedRecord {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  runId: EntityId;
  recordKey: string;
  rawObjectUri: string;
  reasonCode: string;
  reasonSummary: string;
  state: "open" | "reprocessing" | "resolved" | "discarded";
  createdAt: IsoTimestamp;
  resolvedAt: IsoTimestamp | null;
  resolvedBy: string | null;
}

export interface RawLandingObject {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  sourceSystem: string;
  runId: string;
  rawObjectUri: string;
  sha256: string;
  byteSize: number;
  state: "received" | "accepted" | "failed" | "quarantined";
  actor: string;
  correlationId: string;
  errorSummary: string | null;
  createdAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  lastReplayedAt: IsoTimestamp | null;
  lastReplayRunId: string | null;
}

export type ModelFieldType =
  | "string"
  | "number"
  | "boolean"
  | "timestamp"
  | "json"
  | "direct_relation";

export interface ModelFieldDefinition {
  name: string;
  type: ModelFieldType;
  nullable: boolean;
  list: boolean;
  unit?: string;
  targetModelExternalId?: string;
}

export interface DataModelDefinition {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  space: string;
  externalId: string;
  version: string;
  name: string;
  description: string | null;
  fields: ModelFieldDefinition[];
  state: "draft" | "published" | "deprecated";
  createdBy: string;
  createdAt: IsoTimestamp;
  publishedAt: IsoTimestamp | null;
}

export interface GraphInstance {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  dataSetId: EntityId;
  space: string;
  externalId: string;
  modelExternalId: string;
  modelVersion: string;
  properties: Record<string, unknown>;
  validFrom: IsoTimestamp | null;
  validTo: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type PipelineStepKind = "extract" | "transform" | "quality" | "contextualize" | "publish";

export interface PipelineStepDefinition {
  id: string;
  kind: PipelineStepKind;
  name: string;
  dependsOn: string[];
  configuration: Record<string, unknown>;
  timeoutSeconds: number;
  maxAttempts: number;
}

export interface PipelineDefinition {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  externalId: string;
  version: number;
  name: string;
  description: string | null;
  schedule: string | null;
  enabled: boolean;
  steps: PipelineStepDefinition[];
  createdBy: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PipelineRun {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  pipelineId: EntityId;
  pipelineVersion: number;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  trigger: "manual" | "schedule" | "event";
  correlationId: string;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  summary: Record<string, unknown>;
}

export type QualityRuleKind = "required" | "range" | "regex" | "unique" | "reference";

export interface QualityRule {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  externalId: string;
  name: string;
  kind: QualityRuleKind;
  targetModelExternalId: string;
  field: string | null;
  configuration: Record<string, unknown>;
  severity: "info" | "warning" | "error";
  enabled: boolean;
}

export interface QualityResult {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  ruleId: EntityId;
  pipelineRunId: EntityId | null;
  passed: boolean;
  checkedRecords: number;
  failedRecords: number;
  sampleFailures: Array<Record<string, unknown>>;
  occurredAt: IsoTimestamp;
}

export interface ContextualizationEvidence {
  kind: "exact" | "fuzzy" | "rule" | "model" | "spatial";
  field: string;
  sourceValue: string;
  targetValue: string;
  score: number;
  explanation: string;
}

export interface ContextualizationCandidate {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  sourceType: string;
  sourceExternalId: string;
  targetType: string;
  targetExternalId: string;
  relationType: string;
  confidence: number;
  evidence: ContextualizationEvidence[];
  ruleVersion: string | null;
  modelVersion: string | null;
  state: "proposed" | "accepted" | "rejected" | "superseded";
  reviewer: string | null;
  reviewedAt: IsoTimestamp | null;
  reviewComment: string | null;
  createdAt: IsoTimestamp;
}

export interface UnifiedSearchResult {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  type: "asset" | "time_series" | "document" | "model" | "pipeline";
  externalId: string;
  title: string;
  subtitle: string;
  score: number;
  highlights: string[];
}

export interface DiagramTag {
  tag: string;
  kind: "equipment" | "instrument" | "line" | "unknown";
  page: number | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  confidence: number;
}

export interface MatchingEvaluation {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  modelVersion: string;
  threshold: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  evaluatedPairs: number;
  actor: string;
  createdAt: IsoTimestamp;
}

export interface SpatialAssetLink {
  assetExternalId: string;
  sceneExternalId: string;
  nodeExternalId: string;
  transform: number[];
  confidence: number;
  reviewState: "proposed" | "accepted" | "rejected";
}

export type WritebackRisk = "low" | "medium" | "high" | "critical";

export interface WritebackRequest {
  id: EntityId;
  tenantId: EntityId;
  projectId: EntityId;
  sourceId: EntityId;
  targetExternalId: string;
  operation: string;
  payload: Record<string, unknown>;
  risk: WritebackRisk;
  state: "draft" | "pending_approval" | "approved" | "executing" | "succeeded" | "failed" | "cancelled";
  requestedBy: string;
  requestedAt: IsoTimestamp;
  approvals: Array<{ actor: string; decision: "approved" | "rejected"; occurredAt: IsoTimestamp; comment: string | null }>;
  dryRunResult: Record<string, unknown> | null;
  executedAt: IsoTimestamp | null;
}
