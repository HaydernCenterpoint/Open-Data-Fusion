export interface IngestBundle {
  source: {
    system: string;
    runId?: string;
    actor?: string;
  };
  assets?: Array<{
    externalId: string;
    name: string;
    type: string;
    parentExternalId?: string;
    description?: string;
    metadata?: Record<string, string>;
  }>;
  timeSeries?: Array<{
    externalId: string;
    assetExternalId: string;
    name: string;
    unit?: string;
  }>;
  dataPoints?: Array<{
    timeSeriesExternalId: string;
    timestamp: string;
    value: number;
    quality?: string;
  }>;
}

export interface IngestResult {
  id?: string;
  runId?: string;
  status?: string;
  message?: string;
}

export interface ApiAsset {
  externalId: string;
  name: string;
  description: string | null;
  type: string;
  parentExternalId: string | null;
  metadata: Record<string, unknown>;
  sourceSystem: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetListResponse {
  items: ApiAsset[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiTimeSeries {
  externalId: string;
  assetExternalId: string;
  name: string;
  unit: string | null;
  description: string | null;
  sourceSystem: string;
}

export interface ApiDocument {
  externalId: string;
  assetExternalId: string | null;
  title: string;
  mimeType: string | null;
  uri: string | null;
  sourceSystem: string;
}

export interface ApiEntityReference {
  type: string;
  externalId: string;
}

export interface ApiRelation {
  id: string;
  source: ApiEntityReference;
  target: ApiEntityReference;
  type: string;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  confidence: number | null;
  evidence: unknown;
  ruleVersion: string | null;
  reviewer: string | null;
  reviewComment: string | null;
  reviewedAt: string | null;
  sourceSystem: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelationListResponse {
  items: ApiRelation[];
  total: number;
  limit: number;
}

export interface ApiProvenance {
  id: number;
  entityType: string;
  entityId: string;
  sourceSystem: string;
  sourceRecordId: string | null;
  ingestionRunId: string;
  rawHash: string;
  modelVersion: string;
  validFrom: string;
  transactionTime: string;
  metadata: Record<string, unknown>;
}

export interface ApiAuditEvent {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  correlationId: string;
}

export interface AuditListResponse {
  items: ApiAuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface PlatformContext {
  tenantId: string;
  projectId: string;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlatformTenant {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface PlatformProject {
  tenantId: string;
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PlatformDataset {
  tenantId: string;
  projectId: string;
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PlatformSource {
  tenantId: string;
  projectId: string;
  id: string;
  name: string;
  type: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PlatformConnector {
  tenantId: string;
  projectId: string;
  id: string;
  name: string;
  sourceId: string;
  type: string;
  configuration: Record<string, unknown>;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

export type PlatformRawIngestionState = "received" | "accepted" | "failed" | "quarantined";

export interface PlatformRawIngestionRecord {
  id: string;
  tenantId: string;
  projectId: string;
  sourceSystem: string;
  runId: string;
  rawObjectUri: string;
  sha256: string;
  byteSize: number;
  state: PlatformRawIngestionState;
  actor: string;
  correlationId: string;
  errorSummary: string | null;
  createdAt: string;
  completedAt: string | null;
  lastReplayedAt: string | null;
  lastReplayRunId: string | null;
}

export interface PlatformRawIngestionReplayResult extends IngestResult {
  counts?: Record<string, number>;
  completedAt?: string;
  replayedFromRawObjectId: string;
  rawObject: PlatformRawIngestionRecord;
}

export interface PlatformDataModel {
  tenantId: string;
  projectId: string;
  id: string;
  version: number;
  name: string;
  schema: Record<string, unknown>;
  status: "draft" | "published";
  createdBy: string;
  createdAt: string;
}

export interface PlatformPipeline {
  tenantId: string;
  projectId: string;
  id: string;
  name: string;
  sourceId: string | null;
  datasetId: string | null;
  definition: Record<string, unknown>;
  version: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

export interface PlatformPipelineRun {
  tenantId: string;
  projectId: string;
  id: string;
  pipelineId: string;
  idempotencyKey: string;
  status: "processing" | "completed" | "failed";
  inputHash: string;
  result: Record<string, unknown>;
  triggeredBy: string;
  startedAt: string;
  completedAt: string | null;
  replayed?: boolean;
}

export type PlatformQualityCheck =
  | { operator: "required"; field: string }
  | { operator: "equals"; field: string; value: unknown }
  | { operator: "gte"; field: string; value: number }
  | { operator: "lte"; field: string; value: number };

export interface PlatformQualityRule {
  tenantId: string;
  projectId: string;
  id: string;
  name: string;
  targetType: string;
  check: PlatformQualityCheck;
  severity: "info" | "warning" | "error";
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

export interface PlatformQualityResult {
  id: number;
  tenantId: string;
  projectId: string;
  ruleId: string;
  runId: string;
  passed: boolean;
  observed: Record<string, unknown>;
  evaluatedAt: string;
}

export interface PlatformCandidateEndpoint {
  type: string;
  id: string;
}

export interface PlatformContextCandidate {
  tenantId: string;
  projectId: string;
  id: string;
  source: PlatformCandidateEndpoint;
  target: PlatformCandidateEndpoint;
  relationType: string;
  confidence: number;
  evidence: Record<string, unknown>;
  status: "proposed" | "accepted" | "rejected";
  reviewedBy: string | null;
  reviewComment: string | null;
  reviewedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PlatformSearchResult {
  tenantId: string;
  projectId: string;
  entityType: string;
  entityId: string;
  title: string;
  summary: string;
  updatedAt: string;
}

export interface PlatformDiagramTag {
  tag: string;
  kind: "equipment" | "instrument" | "line" | "unknown";
  page: number | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  confidence: number;
}

export interface PlatformDiagramExtraction {
  tenantId: string;
  projectId: string;
  id: string;
  documentExternalId: string;
  textSha256: string;
  tags: PlatformDiagramTag[];
  createdBy: string;
  createdAt: string;
}

export interface PlatformMatchPrediction {
  sourceExternalId: string;
  targetExternalId: string;
  score: number;
}

export interface PlatformMatchGroundTruth {
  sourceExternalId: string;
  targetExternalId: string;
  accepted: boolean;
}

export interface PlatformMatchingMetrics {
  threshold: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  evaluatedPairs: number;
}

export interface PlatformMatchingProposal extends PlatformMatchPrediction {
  state: "proposed";
}

export interface PlatformMatchingEvaluation {
  tenantId: string;
  projectId: string;
  id: string;
  threshold: number;
  inputSha256: string;
  predictionCount: number;
  truthCount: number;
  evaluation: PlatformMatchingMetrics;
  proposals: PlatformMatchingProposal[];
  createdBy: string;
  createdAt: string;
}

export interface PlatformSpatialLink {
  tenantId: string;
  projectId: string;
  id: string;
  assetExternalId: string;
  sceneExternalId: string;
  nodeExternalId: string;
  transform: number[];
  confidence: number;
  reviewState: "proposed" | "accepted" | "rejected";
  reviewedBy: string | null;
  reviewComment: string | null;
  reviewedAt: string | null;
  createdBy: string;
  createdAt: string;
}

export type PlatformWritebackRisk = "low" | "medium" | "high" | "critical";
export type PlatformWritebackState = "draft" | "pending_approval" | "approved" | "executing" | "succeeded" | "failed" | "cancelled";

export interface PlatformWritebackApproval {
  actor: string;
  decision: "approved" | "rejected";
  occurredAt: string;
  comment: string | null;
}

export interface PlatformWritebackDryRun extends Record<string, unknown> {
  safe?: boolean;
  evidence?: unknown;
  performedAt?: string;
  summary?: string;
}

export interface PlatformWritebackSafety {
  allowed: boolean;
  requiredApprovals: number;
  validApprovals: number;
  reasons: string[];
}

export interface PlatformWritebackRequest {
  id: string;
  tenantId: string;
  projectId: string;
  sourceId: string;
  targetExternalId: string;
  operation: string;
  payload: Record<string, unknown>;
  risk: PlatformWritebackRisk;
  state: PlatformWritebackState;
  requestedBy: string;
  requestedAt: string;
  approvals: PlatformWritebackApproval[];
  dryRunResult: PlatformWritebackDryRun | null;
  executedAt: string | null;
  blockedReasons: string[];
  executionResult: Record<string, unknown> | null;
  updatedAt: string;
  safety: PlatformWritebackSafety;
}

export interface AssetDetailResponse {
  asset: ApiAsset;
  parent: ApiAsset | null;
  children: ApiAsset[];
  timeSeries: ApiTimeSeries[];
  documents: ApiDocument[];
  relations: ApiRelation[];
  provenance: ApiProvenance[];
}

export interface TelemetryPoint {
  timestamp: string;
  value: number;
  quality: string;
}

export interface TelemetryResponse {
  assetExternalId: string;
  range: { from: string; to: string };
  series: Array<ApiTimeSeries & { points: TelemetryPoint[] }>;
}

export interface ExplorerSnapshot {
  detail: AssetDetailResponse;
  telemetry: TelemetryResponse;
}

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface CanvasNodeRecord {
  id: string;
  type: string;
  position: CanvasPosition;
  data: Record<string, unknown>;
}

export interface CanvasEdgeRecord {
  id: string;
  source: string;
  target: string;
  type: string;
  data: Record<string, unknown>;
}

export interface CanvasSnapshot {
  viewport: CanvasPosition & { zoom: number };
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
}

export interface ApiWorkspace {
  id: string;
  name: string;
  version: number;
  snapshot: CanvasSnapshot;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceRevision {
  workspaceId: string;
  version: number;
  snapshot: CanvasSnapshot;
  changeSummary: string;
  actor: string;
  createdAt: string;
  correlationId: string;
}

export interface WorkspaceRevisionList {
  items: WorkspaceRevision[];
  total: number;
  limit: number;
  offset: number;
}

export type WorkspaceRole = "owner" | "editor" | "reviewer" | "viewer";

export interface WorkspaceMember {
  workspaceId: string;
  userId: string;
  displayName: string;
  role: WorkspaceRole;
}

export interface WorkspaceMemberList {
  items: WorkspaceMember[];
  total: number;
}

export interface WorkspaceMemberUpsert {
  displayName: string;
  role: WorkspaceRole;
}

export type WorkspaceMemberChange = "added" | "updated" | "removed";

export type WorkspaceOperation =
  | { type: "moveNode"; nodeId: string; position: CanvasPosition }
  | { type: "addNode"; node: CanvasNodeRecord }
  | {
      type: "updateNode";
      nodeId: string;
      patch: { type?: string; position?: CanvasPosition; data?: Record<string, unknown> };
    }
  | { type: "removeNode"; nodeId: string }
  | { type: "addEdge"; edge: CanvasEdgeRecord }
  | {
      type: "updateEdge";
      edgeId: string;
      patch: { type?: string; data?: Record<string, unknown> };
    }
  | { type: "removeEdge"; edgeId: string };

export interface WorkspaceUpdatedEvent {
  workspaceId: string;
  version: number;
  actor: string;
  changeSummary: string;
  operations?: WorkspaceOperation[];
  restoredFromVersion?: number;
  updatedAt: string;
}

export interface WorkspacePresenceEvent {
  workspaceId: string;
  users: Array<Pick<WorkspaceMember, "userId" | "displayName" | "role">>;
  occurredAt: string;
}

export interface WorkspaceMembersUpdatedEvent {
  workspaceId: string;
  actor: string;
  change: WorkspaceMemberChange;
  member: WorkspaceMember;
  occurredAt: string;
}
