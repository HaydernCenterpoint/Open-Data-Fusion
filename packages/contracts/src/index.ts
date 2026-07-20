export type AssetKind =
  | "site"
  | "system"
  | "equipment"
  | "instrument"
  | "location";

export type ReviewState = "proposed" | "accepted" | "rejected" | "superseded";
export type QualityState = "good" | "uncertain" | "bad" | "unknown";

export interface Provenance {
  sourceSystem: string;
  sourceRecord: string;
  ingestionRunId: string;
  observedAt: string;
  ingestedAt: string;
  modelVersion: string;
  payloadHash: string;
}

export interface Asset {
  id: string;
  externalId: string;
  name: string;
  kind: AssetKind;
  type: string;
  parentId: string | null;
  site: string;
  source: string;
  description: string | null;
  updatedAt: string;
  provenance: Provenance;
}

export interface TimeSeries {
  id: string;
  assetId: string;
  externalId: string;
  name: string;
  unit: string;
  source: string;
  quality: QualityState;
}

export interface DataPoint {
  timestamp: string;
  value: number;
  quality: QualityState;
}

export interface IndustrialDocument {
  id: string;
  assetId: string;
  externalId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  updatedAt: string;
}

export interface RelationEvidence {
  field: string;
  value: string;
  source: string;
}

export interface Relation {
  id: string;
  sourceAssetId: string;
  targetAssetId: string;
  relationType: string;
  directionLabel: string;
  reviewState: ReviewState;
  confidence: number;
  ruleVersion: string;
  reviewer: string | null;
  reviewedAt: string | null;
  evidence: RelationEvidence[];
}

export interface AuditEvent {
  id: string;
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
  correlationId: string;
  occurredAt: string;
  details: Record<string, unknown>;
}

export interface IngestAssetInput {
  externalId: string;
  name: string;
  kind: AssetKind;
  type: string;
  parentExternalId?: string;
  site: string;
  description?: string;
}

export interface IngestDataPointInput {
  timeSeriesExternalId: string;
  timestamp: string;
  value: number;
  quality?: QualityState;
}

export interface IngestBundle {
  sourceSystem: string;
  sourceRunId: string;
  observedAt: string;
  assets?: IngestAssetInput[];
  dataPoints?: IngestDataPointInput[];
}

export interface AssetSummaryResponse {
  assets: Asset[];
  total: number;
}

export interface AssetTelemetryResponse {
  asset: Asset;
  series: Array<TimeSeries & { dataPoints: DataPoint[] }>;
  documents: IndustrialDocument[];
  relations: Relation[];
}

export interface CanvasPosition {
  x: number;
  y: number;
}

export interface CanvasWorkspaceSnapshot {
  viewport: CanvasPosition & { zoom: number };
  nodes: Array<{
    id: string;
    type: string;
    position: CanvasPosition;
    data: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    data: Record<string, unknown>;
  }>;
}

export interface WorkspaceRevision {
  workspaceId: string;
  version: number;
  snapshot: CanvasWorkspaceSnapshot;
  changeSummary: string;
  actor: string;
  createdAt: string;
  correlationId: string;
}

export interface Workspace {
  id: string;
  name: string;
  version: number;
  snapshot: CanvasWorkspaceSnapshot;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export type WorkspaceRole = "owner" | "editor" | "reviewer" | "viewer";

type AtLeastOne<T> = {
  [Key in keyof T]: Required<Pick<T, Key>> & Partial<Omit<T, Key>>;
}[keyof T];

export type WorkspaceNodePatch = AtLeastOne<{
  type: string;
  position: CanvasPosition;
  data: Record<string, unknown>;
}>;

export type WorkspaceEdgePatch = AtLeastOne<{
  type: string;
  data: Record<string, unknown>;
}>;

export type WorkspaceOperation =
  | { type: "moveNode"; nodeId: string; position: CanvasPosition }
  | { type: "addNode"; node: CanvasWorkspaceSnapshot["nodes"][number] }
  | { type: "removeNode"; nodeId: string }
  | { type: "updateNode"; nodeId: string; patch: WorkspaceNodePatch }
  | { type: "addEdge"; edge: CanvasWorkspaceSnapshot["edges"][number] }
  | { type: "removeEdge"; edgeId: string }
  | { type: "updateEdge"; edgeId: string; patch: WorkspaceEdgePatch };

export interface WorkspaceOperationRequest {
  baseVersion: number;
  changeSummary: string;
  operations: WorkspaceOperation[];
}

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

export interface WorkspaceMemberUpsertRequest {
  displayName: string;
  role: WorkspaceRole;
}

export type WorkspaceMemberChange = "added" | "updated" | "removed";

export type WorkspaceLiveEvent =
  | {
      type: "workspace.updated";
      workspaceId: string;
      version: number;
      actor: string;
      changeSummary: string;
      operations?: WorkspaceOperation[];
      updatedAt?: string;
    }
  | {
      type: "presence.updated";
      workspaceId: string;
      users: Array<Pick<WorkspaceMember, "userId" | "displayName" | "role">>;
      occurredAt: string;
    }
  | {
      type: "members.updated";
      workspaceId: string;
      actor: string;
      change: WorkspaceMemberChange;
      member: WorkspaceMember;
      occurredAt: string;
    };

export * from "./platform.js";
export * from "./model-graph.js";
