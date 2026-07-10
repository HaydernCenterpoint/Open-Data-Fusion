export type AssetKind =
  | "site"
  | "system"
  | "pump"
  | "exchanger"
  | "tower"
  | "valve"
  | "meter"
  | "boiler"
  | "utility";

export interface AssetNode {
  id: string;
  name: string;
  kind: AssetKind;
  children?: AssetNode[];
}

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

export interface AssetDetailResponse {
  asset: ApiAsset;
  parent: ApiAsset | null;
  children: ApiAsset[];
  timeSeries: ApiTimeSeries[];
  documents: ApiDocument[];
  relations: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
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
