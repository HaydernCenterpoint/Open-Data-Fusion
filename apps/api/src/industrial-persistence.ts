import { createHash } from 'node:crypto';

import type { FusionDatabase } from './database.js';
import type { PlatformContext } from './platform-schemas.js';
import type { PlatformProjectRole } from './platform.js';
import type {
  AssetListQuery,
  AuditListQuery,
  IngestBundle,
  RelationReview,
  TelemetryAggregateQuery,
  TelemetryLatestQuery,
  TelemetryQuery,
} from './schemas.js';

export interface IndustrialRequestScope extends PlatformContext {
  userId: string;
}

export interface IndustrialRawArchive {
  storageUri: string;
  sha256: string;
  byteSize: number;
  contentType: string;
}

export interface IndustrialPersistenceHealth {
  status: 'ok' | 'degraded';
  mode: 'sqlite' | 'postgres';
  database: string | null;
  timestamp: string;
}

function canonicalIndustrialValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalIndustrialValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalIndustrialValue(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function industrialPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalIndustrialValue(value)).digest('hex');
}

/** Stable idempotency key used when a connector does not supply source.runId. */
export function industrialIngestRunId(bundle: IngestBundle): string {
  return bundle.source.runId ?? `content-${industrialPayloadHash(bundle)}`;
}

/** Stable public relation identity shared by every authoritative backend. */
export function industrialRelationExternalId(relation: IngestBundle['relations'][number]): string {
  if (relation.id) return relation.id;
  const tuple = [
    relation.sourceType,
    relation.sourceExternalId,
    relation.relationType,
    relation.targetType,
    relation.targetExternalId,
  ];
  return `rel-${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`;
}

/**
 * Public industrial data-plane contract. A process selects exactly one
 * implementation at startup; writes are never mirrored between backends.
 */
export interface IndustrialPersistence {
  readonly mode: 'sqlite' | 'postgres';
  health(): Promise<IndustrialPersistenceHealth>;
  authorize(scope: IndustrialRequestScope, allowedRoles?: readonly PlatformProjectRole[]): Promise<void>;
  listAssets(scope: IndustrialRequestScope, query: AssetListQuery): Promise<Record<string, unknown>>;
  getAsset(scope: IndustrialRequestScope, externalId: string): Promise<Record<string, unknown>>;
  getTelemetry(scope: IndustrialRequestScope, externalId: string, query: TelemetryQuery): Promise<Record<string, unknown>>;
  getLatestTelemetry(scope: IndustrialRequestScope, externalId: string, query: TelemetryLatestQuery): Promise<Record<string, unknown>>;
  getAggregatedTelemetry(scope: IndustrialRequestScope, externalId: string, query: TelemetryAggregateQuery): Promise<Record<string, unknown>>;
  ingest(
    scope: IndustrialRequestScope,
    bundle: IngestBundle,
    correlationId: string,
    archive?: IndustrialRawArchive,
  ): Promise<Record<string, unknown>>;
  listRelations(
    scope: IndustrialRequestScope,
    status: 'proposed' | 'accepted' | 'rejected' | 'superseded' | undefined,
    limit: number,
  ): Promise<Record<string, unknown>>;
  reviewRelation(
    scope: IndustrialRequestScope,
    id: string,
    review: RelationReview,
    correlationId: string,
  ): Promise<Record<string, unknown>>;
  listAudit(scope: IndustrialRequestScope, query: AuditListQuery): Promise<Record<string, unknown>>;
}

/** Explicit compatibility adapter for legacy fixture tests; never selected by server defaults. */
export class LegacySqliteIndustrialPersistence implements IndustrialPersistence {
  readonly mode = 'sqlite' as const;

  constructor(private readonly database: FusionDatabase) {}

  async health(): Promise<IndustrialPersistenceHealth> {
    const health = this.database.health();
    return {
      status: health.status === 'ok' ? 'ok' : 'degraded',
      mode: 'sqlite',
      database: null,
      timestamp: typeof health.timestamp === 'string' ? health.timestamp : new Date().toISOString(),
    };
  }

  async authorize(_scope: IndustrialRequestScope, _allowedRoles?: readonly PlatformProjectRole[]): Promise<void> {}

  async listAssets(_scope: IndustrialRequestScope, query: AssetListQuery): Promise<Record<string, unknown>> {
    return this.database.listAssets(query);
  }

  async getAsset(_scope: IndustrialRequestScope, externalId: string): Promise<Record<string, unknown>> {
    return this.database.getAsset(externalId);
  }

  async getTelemetry(_scope: IndustrialRequestScope, externalId: string, query: TelemetryQuery): Promise<Record<string, unknown>> {
    return this.database.getTelemetry(externalId, query);
  }

  async getLatestTelemetry(
    _scope: IndustrialRequestScope,
    externalId: string,
    query: TelemetryLatestQuery,
  ): Promise<Record<string, unknown>> {
    return this.database.getLatestTelemetry(externalId, query);
  }

  async getAggregatedTelemetry(
    _scope: IndustrialRequestScope,
    externalId: string,
    query: TelemetryAggregateQuery,
  ): Promise<Record<string, unknown>> {
    return this.database.getAggregatedTelemetry(externalId, query);
  }

  async ingest(
    _scope: IndustrialRequestScope,
    bundle: IngestBundle,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    return this.database.ingest(bundle, correlationId);
  }

  async listRelations(
    _scope: IndustrialRequestScope,
    status: 'proposed' | 'accepted' | 'rejected' | 'superseded' | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    return this.database.listRelations(status, limit);
  }

  async reviewRelation(
    _scope: IndustrialRequestScope,
    id: string,
    review: RelationReview,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    return this.database.reviewRelation(id, review, correlationId);
  }

  async listAudit(_scope: IndustrialRequestScope, query: AuditListQuery): Promise<Record<string, unknown>> {
    return this.database.listAudit(query);
  }
}
