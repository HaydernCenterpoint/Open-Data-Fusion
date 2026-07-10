export interface IngestAsset {
  externalId: string;
  name: string;
  type: string;
  parentExternalId?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IngestTimeSeries {
  externalId: string;
  assetExternalId: string;
  name: string;
  unit?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IngestDataPoint {
  timeSeriesExternalId: string;
  timestamp: string;
  value: number;
  quality: "good" | "uncertain" | "bad";
}

export interface IngestDocument {
  externalId: string;
  assetExternalId?: string | null;
  title: string;
  mimeType?: string | null;
  uri?: string | null;
  metadata?: Record<string, unknown>;
}

export interface IngestRelation {
  id?: string;
  sourceType: "asset" | "timeSeries" | "document";
  sourceExternalId: string;
  targetType: "asset" | "timeSeries" | "document";
  targetExternalId: string;
  relationType: string;
  status: "proposed" | "accepted";
  confidence?: number | null;
  evidence: Record<string, unknown>;
  ruleVersion?: string | null;
}

export interface ConnectorBatch {
  checkpointAfter: string;
  observedAt: string;
  assets: IngestAsset[];
  timeSeries: IngestTimeSeries[];
  dataPoints: IngestDataPoint[];
  documents: IngestDocument[];
  relations: IngestRelation[];
  rawRecords: Array<Record<string, unknown>>;
}

export interface EdgeConnector {
  poll(checkpoint: string | null): Promise<ConnectorBatch | null>;
  close(): Promise<void>;
}

export interface IngestBundle {
  source: { system: string; runId: string; actor: string };
  assets: IngestAsset[];
  timeSeries: IngestTimeSeries[];
  dataPoints: IngestDataPoint[];
  documents: IngestDocument[];
  relations: IngestRelation[];
}

export interface ArchivedPayload {
  path: string;
  sha256: string;
  bytes: number;
}

export interface QueuedBatch {
  id: string;
  sourceSystem: string;
  idempotencyKey: string;
  bundle: IngestBundle;
  archivePath: string;
  archiveSha256: string;
  checkpointAfter: string;
  attemptCount: number;
}
