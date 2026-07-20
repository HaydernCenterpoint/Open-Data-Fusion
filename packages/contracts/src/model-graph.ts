export type ModelPropertyType =
  | "text"
  | "int64"
  | "float64"
  | "boolean"
  | "timestamp"
  | "date"
  | "json"
  | "direct";

export interface InstanceKey {
  space: string;
  externalId: string;
}

export interface ModelPropertyDefinition {
  type: ModelPropertyType;
  required?: boolean;
  nullable?: boolean;
  list?: boolean;
}

export interface ModelViewDefinition {
  externalId: string;
  name: string;
  usedFor: "node" | "edge";
  properties: Record<string, ModelPropertyDefinition>;
}

export interface ModelVersion {
  tenantId: string;
  projectId: string;
  id: string;
  version: number;
  name: string;
  schema: Record<string, unknown>;
  status: "draft" | "published";
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface ModelView extends ModelViewDefinition {
  modelId: string;
  modelVersion: number;
  createdAt: string;
}

export interface ModelGraphInstance extends InstanceKey {
  kind: "node" | "edge";
  viewExternalId: string;
  source?: InstanceKey;
  target?: InstanceKey;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type ModelFilter =
  | { equals: { property: string; value: unknown } }
  | { in: { property: string; values: unknown[] } }
  | { range: { property: string; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown } }
  | { exists: { property: string } }
  | { and: ModelFilter[] }
  | { or: ModelFilter[] }
  | { not: ModelFilter };

export interface CreateModelVersionRequest {
  name: string;
  schema: Record<string, unknown>;
  status?: "draft" | "published";
  views?: ModelViewDefinition[];
}

export interface InstanceUpsertItem extends InstanceKey {
  kind: "node" | "edge";
  viewExternalId: string;
  source?: InstanceKey;
  target?: InstanceKey;
  properties: Record<string, unknown>;
}

export interface InstanceUpsertRequest {
  idempotencyKey: string;
  instances: InstanceUpsertItem[];
}

export interface InstanceUpsertResult {
  modelId: string;
  version: number;
  total: number;
  created: number;
  updated: number;
  replayed: boolean;
  requestHash: string;
}

export interface InstanceQueryRequest {
  viewExternalId: string;
  projection?: string[];
  filter?: ModelFilter;
  sort?: { property: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string;
}

export interface InstanceQueryResult {
  items: ModelGraphInstance[];
  nextCursor: string | null;
}

export interface InstanceTraverseRequest {
  starts: InstanceKey[];
  direction: "in" | "out" | "both";
  edgeViewExternalId?: string;
  maxHops?: number;
  limit?: number;
}

export interface InstancePath {
  instances: InstanceKey[];
  edges: InstanceKey[];
}

export interface InstanceTraverseResult {
  paths: InstancePath[];
  truncated: boolean;
}

export interface InstanceAggregateMetric {
  name: string;
  operation: "count" | "min" | "max" | "sum" | "avg";
  property?: string;
}

export interface InstanceAggregateRequest {
  viewExternalId: string;
  filter?: ModelFilter;
  groupBy?: string[];
  metrics: InstanceAggregateMetric[];
  limit?: number;
}

export interface InstanceAggregateGroup {
  group: Record<string, unknown>;
  metrics: Record<string, number | null>;
}

export interface InstanceAggregateResult {
  groups: InstanceAggregateGroup[];
  truncated: boolean;
}
