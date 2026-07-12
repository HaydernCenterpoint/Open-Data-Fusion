import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictError as RuntimeConflictError,
  DatabaseUnavailableError as RuntimeDatabaseUnavailableError,
  ForbiddenError as RuntimeForbiddenError,
  NotFoundError as RuntimeNotFoundError,
  type PostgresRuntime,
  type JsonObject,
  type UnifiedSearchCursor,
} from '@open-data-fusion/postgres-runtime';
import {
  createProposedSpatialLink,
  evaluateMatchingPredictions,
  extractDiagramTags,
  rankProposedMatches,
} from '@open-data-fusion/platform-core';
import { z } from 'zod';

import { ConflictError, ForbiddenError, NotFoundError } from './database.js';
import type {
  ConnectorCreate,
  CursorListQuery,
  DatasetCreate,
  PlatformContext,
  PlatformSearchQuery,
  SourceCreate,
} from './platform-schemas.js';
import type {
  DiagramExtractionCreate,
  MatchingEvaluationCreate,
  SpatialLinkCreate,
  SpatialLinkReview,
} from './advanced-platform-schemas.js';
import type { PlatformProjectRole } from './platform.js';

type Row = Record<string, unknown>;
type Scope = PlatformContext & { userId: string };

const uuidSchema = z.string().uuid();
const textCursorSchema = z.object({ id: z.string().min(1) }).strict();
const searchCursorSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
}).strict();
const connectorKindSchema = z.enum(['opcua', 'jdbc', 'csv', 'http']);
const compatibilitySearchEntityTypes = new Set([
  'dataModel',
  'pipeline',
  'qualityRule',
  'contextCandidate',
  'writebackRequest',
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function deterministicUuid(...parts: readonly string[]): string {
  const bytes = createHash('sha256').update(canonical(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode<T>(cursor: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!cursor) return undefined;
  let value: unknown = null;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // Let Zod expose the standard request validation failure.
  }
  return schema.parse(value);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return parsed.toISOString();
}

function object(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('PostgreSQL returned invalid JSON object');
  return parsed as Record<string, unknown>;
}

function runtimeError(error: unknown): Error {
  if (error instanceof RuntimeForbiddenError) return new ForbiddenError(error.message);
  if (error instanceof RuntimeNotFoundError) return new NotFoundError(error.message);
  if (error instanceof RuntimeConflictError) return new ConflictError(error.message);
  if (error instanceof RuntimeDatabaseUnavailableError) return error;
  return error instanceof Error ? error : new Error('PostgreSQL platform data operation failed');
}

function scope(context: PlatformContext, userId: string): Scope {
  return {
    tenantId: uuidSchema.parse(context.tenantId),
    projectId: uuidSchema.parse(context.projectId),
    userId: z.string().trim().min(1).max(512).parse(userId),
  };
}

function catalogMarker(value: Record<string, unknown>): Record<string, unknown> | null {
  const marker = value.__odfPlatformCatalog;
  return marker && typeof marker === 'object' && !Array.isArray(marker) ? marker as Record<string, unknown> : null;
}

function catalogCreatedBy(row: Row): string {
  const value = row.created_by;
  return typeof value === 'string' && value ? value : 'system';
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new TypeError(`PostgreSQL returned invalid ${label}`);
  return value;
}

function publicSearchEntityId(entityType: string, entityId: string): string {
  // Migration 014 namespaces compatibility entries inside the shared
  // projection to prevent them colliding with normalized records. The cursor
  // remains opaque and uses the stored value; callers retain the legacy ID.
  if (compatibilitySearchEntityTypes.has(entityType) && entityId.startsWith('legacy:')) {
    return entityId.slice('legacy:'.length);
  }
  return entityId;
}

export interface PostgresPlatformDataPersistence {
  readonly mode: 'postgres';
  assertReady(): Promise<void>;
  listDatasets(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createDataset(context: PlatformContext, userId: string, input: DatasetCreate, correlationId: string): Promise<Record<string, unknown>>;
  listSources(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createSource(context: PlatformContext, userId: string, input: SourceCreate, correlationId: string): Promise<Record<string, unknown>>;
  listConnectors(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createConnector(context: PlatformContext, userId: string, input: ConnectorCreate, correlationId: string): Promise<Record<string, unknown>>;
  listDiagramExtractions(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createDiagramExtraction(context: PlatformContext, userId: string, input: DiagramExtractionCreate, correlationId: string): Promise<Record<string, unknown>>;
  listMatchingEvaluations(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createMatchingEvaluation(context: PlatformContext, userId: string, input: MatchingEvaluationCreate, correlationId: string): Promise<Record<string, unknown>>;
  listSpatialLinks(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createSpatialLink(context: PlatformContext, userId: string, input: SpatialLinkCreate, correlationId: string): Promise<Record<string, unknown>>;
  reviewSpatialLink(context: PlatformContext, userId: string, id: string, input: SpatialLinkReview, correlationId: string): Promise<Record<string, unknown>>;
  search(context: PlatformContext, userId: string, query: PlatformSearchQuery): Promise<Record<string, unknown>>;
}

/**
 * API-shape adapter over the existing PostgreSQL catalog runtime plus the
 * migration-013 advanced repository. It never reads or writes the embedded
 * SQLite catalog when selected for a PostgreSQL process.
 */
export class PostgresPlatformDataStore implements PostgresPlatformDataPersistence {
  readonly mode = 'postgres' as const;

  constructor(private readonly runtime: PostgresRuntime) {}

  async assertReady(): Promise<void> {
    try {
      const result = await this.runtime.withTransaction({ tenantId: null, userId: 'odf-api-platform-readiness' }, (transaction) => transaction.query<Row>({
        text: [
          'SELECT (',
          "  to_regclass('odf.platform_diagram_extractions') IS NOT NULL",
          "  AND to_regclass('odf.platform_matching_evaluations') IS NOT NULL",
          "  AND to_regclass('odf.platform_spatial_asset_links') IS NOT NULL",
          "  AND to_regclass('odf.platform_search_index') IS NOT NULL",
          "  AND has_table_privilege(current_user, 'odf.platform_diagram_extractions', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_diagram_extractions', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_matching_evaluations', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_matching_evaluations', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_spatial_asset_links', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_spatial_asset_links', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_spatial_asset_links', 'UPDATE')",
          "  AND has_table_privilege(current_user, 'odf.platform_search_index', 'SELECT')",
          ') AS ready',
        ].join('\n'),
      }));
      if (result.rows[0]?.ready !== true) throw new Error('PostgreSQL platform-data migration is not ready');
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async listDatasets(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, textCursorSchema)?.id ?? '';
    try {
      await this.runtime.catalog.resolveMember(requestScope);
      const result = await this.runtime.withTransaction(requestScope, (transaction) => transaction.query<Row>({
        text: [
          'SELECT dataset.tenant_id::text AS tenant_id, dataset.project_id::text AS project_id, dataset.external_id, dataset.name, dataset.description, dataset.created_at,',
          "  COALESCE((SELECT audit.actor FROM odf.audit_log AS audit WHERE audit.entity_type = 'dataset' AND audit.entity_id = dataset.dataset_id::text ORDER BY audit.id ASC LIMIT 1), 'system') AS created_by",
          'FROM odf.datasets AS dataset',
          'WHERE dataset.tenant_id = $1::uuid AND dataset.project_id = $2::uuid AND dataset.external_id > $3',
          'ORDER BY dataset.external_id ASC LIMIT $4',
        ].join('\n'),
        values: [requestScope.tenantId, requestScope.projectId, cursor, query.limit + 1],
      }));
      return this.textPage(result.rows, query.limit, (row) => ({
        tenantId: text(row.tenant_id, 'tenant ID'), projectId: text(row.project_id, 'project ID'), id: text(row.external_id, 'dataset ID'),
        name: text(row.name, 'dataset name'), description: row.description === null ? null : String(row.description),
        createdBy: catalogCreatedBy(row), createdAt: iso(row.created_at),
      }), (item) => String(item.id));
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async createDataset(context: PlatformContext, userId: string, input: DatasetCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    try {
      const record = await this.runtime.catalog.createDataset(requestScope, {
        datasetId: deterministicUuid('odf-platform-dataset', requestScope.tenantId, requestScope.projectId, input.id),
        externalId: input.id,
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        correlationId,
      });
      return { tenantId: record.tenantId, projectId: record.projectId, id: record.externalId, name: record.name, description: record.description, createdBy: requestScope.userId, createdAt: record.createdAt };
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async listSources(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    return this.listConnections(context, userId, query, 'source');
  }

  async createSource(context: PlatformContext, userId: string, input: SourceCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const connectorKind = connectorKindSchema.parse(input.type);
    try {
      const record = await this.runtime.catalog.createSourceConnection(requestScope, {
        sourceConnectionId: deterministicUuid('odf-platform-source', requestScope.tenantId, requestScope.projectId, input.id),
        externalId: input.id,
        name: input.name,
        connectorKind,
        state: 'ready',
        connectorConfig: { __odfPlatformCatalog: { kind: 'source', type: input.type, description: input.description ?? null } },
        correlationId,
      });
      return { tenantId: record.tenantId, projectId: record.projectId, id: record.externalId, name: record.name, type: input.type, description: input.description ?? null, createdBy: requestScope.userId, createdAt: record.createdAt };
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async listConnectors(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    return this.listConnections(context, userId, query, 'connector');
  }

  async createConnector(context: PlatformContext, userId: string, input: ConnectorCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const connectorKind = connectorKindSchema.parse(input.type);
    try {
      await this.runtime.catalog.resolveMember(requestScope, ['owner', 'editor']);
      const source = await this.runtime.withTransaction(requestScope, (transaction) => transaction.query<Row>({
        text: [
          'SELECT source_connection_id FROM odf.source_connections',
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3 AND connector_config -> '__odfPlatformCatalog' ->> 'kind' = 'source'",
        ].join('\n'),
        values: [requestScope.tenantId, requestScope.projectId, input.sourceId],
      }));
      if (!source.rows[0]) throw new NotFoundError(`Source '${input.sourceId}' was not found`);
      const record = await this.runtime.catalog.createSourceConnection(requestScope, {
        sourceConnectionId: deterministicUuid('odf-platform-connector', requestScope.tenantId, requestScope.projectId, input.id),
        externalId: input.id,
        name: input.name,
        connectorKind,
        state: input.enabled ? 'ready' : 'disabled',
        connectorConfig: {
          ...input.configuration,
          __odfPlatformCatalog: { kind: 'connector', sourceId: input.sourceId, type: input.type },
        },
        correlationId,
      });
      return { tenantId: record.tenantId, projectId: record.projectId, id: record.externalId, name: record.name, sourceId: input.sourceId, type: input.type, configuration: input.configuration, enabled: input.enabled, createdBy: requestScope.userId, createdAt: record.createdAt };
    } catch (error) {
      throw runtimeError(error);
    }
  }

  async listDiagramExtractions(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    try {
      const page = await this.runtime.advanced.listDiagramExtractions(requestScope, query.limit, this.textCursor(query.cursor));
      return this.page(page.items, page.nextCursor?.value ?? null, (item) => ({ tenantId: item.tenantId, projectId: item.projectId, id: item.diagramExtractionId, documentExternalId: item.documentExternalId, textSha256: item.textSha256, tags: item.tags, createdBy: item.createdBy, createdAt: item.createdAt }));
    } catch (error) { throw runtimeError(error); }
  }

  async createDiagramExtraction(context: PlatformContext, userId: string, input: DiagramExtractionCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const id = input.id ?? randomUUID();
    const tags = extractDiagramTags(input.text).map((tag) => ({ ...tag, page: input.page ?? tag.page }));
    try {
      const item = await this.runtime.advanced.createDiagramExtraction(requestScope, { diagramExtractionId: id, documentExternalId: input.documentExternalId, textSha256: createHash('sha256').update(input.text).digest('hex'), tags, correlationId });
      return { tenantId: item.tenantId, projectId: item.projectId, id: item.diagramExtractionId, documentExternalId: item.documentExternalId, textSha256: item.textSha256, tags: item.tags, createdBy: item.createdBy, createdAt: item.createdAt };
    } catch (error) { throw runtimeError(error); }
  }

  async listMatchingEvaluations(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    try {
      const page = await this.runtime.advanced.listMatchingEvaluations(requestScope, query.limit, this.textCursor(query.cursor));
      return this.page(page.items, page.nextCursor?.value ?? null, (item) => ({ tenantId: item.tenantId, projectId: item.projectId, id: item.matchingEvaluationId, threshold: item.threshold, inputSha256: item.inputSha256, predictionCount: item.predictionCount, truthCount: item.truthCount, evaluation: item.evaluation, proposals: item.proposals, createdBy: item.createdBy, createdAt: item.createdAt }));
    } catch (error) { throw runtimeError(error); }
  }

  async createMatchingEvaluation(context: PlatformContext, userId: string, input: MatchingEvaluationCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const id = input.id ?? randomUUID();
    const evaluation = evaluateMatchingPredictions(input.predictions, input.truth, input.threshold);
    const proposals = rankProposedMatches(input.predictions);
    try {
      const item = await this.runtime.advanced.createMatchingEvaluation(requestScope, {
        matchingEvaluationId: id, threshold: input.threshold,
        inputSha256: createHash('sha256').update(JSON.stringify({ predictions: input.predictions, truth: input.truth })).digest('hex'),
        predictionCount: input.predictions.length,
        truthCount: input.truth.length,
        evaluation: evaluation as unknown as JsonObject,
        proposals: proposals as unknown as JsonObject[],
        correlationId,
      });
      return { tenantId: item.tenantId, projectId: item.projectId, id: item.matchingEvaluationId, threshold: item.threshold, inputSha256: item.inputSha256, predictionCount: item.predictionCount, truthCount: item.truthCount, evaluation: item.evaluation, proposals: item.proposals, createdBy: item.createdBy, createdAt: item.createdAt };
    } catch (error) { throw runtimeError(error); }
  }

  async listSpatialLinks(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    try {
      const page = await this.runtime.advanced.listSpatialAssetLinks(requestScope, query.limit, this.textCursor(query.cursor));
      return this.page(page.items, page.nextCursor?.value ?? null, (item) => this.spatial(item));
    } catch (error) { throw runtimeError(error); }
  }

  async createSpatialLink(context: PlatformContext, userId: string, input: SpatialLinkCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const id = input.id ?? randomUUID();
    const proposed = createProposedSpatialLink(input);
    try {
      const item = await this.runtime.advanced.createSpatialAssetLink(requestScope, { spatialLinkId: id, ...proposed, correlationId });
      return this.spatial(item);
    } catch (error) { throw runtimeError(error); }
  }

  async reviewSpatialLink(context: PlatformContext, userId: string, id: string, input: SpatialLinkReview, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    try {
      return this.spatial(await this.runtime.advanced.reviewSpatialAssetLink(requestScope, id, { decision: input.decision, ...(input.comment !== undefined ? { comment: input.comment } : {}), correlationId }));
    } catch (error) { throw runtimeError(error); }
  }

  async search(context: PlatformContext, userId: string, query: PlatformSearchQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, searchCursorSchema);
    try {
      const page = await this.runtime.search.search(requestScope, query.q, query.limit, cursor as UnifiedSearchCursor | undefined, query.entityType);
      const items = page.items.map((item) => ({
        tenantId: requestScope.tenantId,
        projectId: requestScope.projectId,
        entityType: item.entityType,
        entityId: publicSearchEntityId(item.entityType, item.entityId),
        title: item.title,
        summary: item.summary.slice(0, 1_000),
        updatedAt: item.updatedAt,
      }));
      return { items, nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null };
    } catch (error) { throw runtimeError(error); }
  }

  private async listConnections(context: PlatformContext, userId: string, query: CursorListQuery, kind: 'source' | 'connector'): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, textCursorSchema)?.id ?? '';
    try {
      await this.runtime.catalog.resolveMember(requestScope);
      const result = await this.runtime.withTransaction(requestScope, (transaction) => transaction.query<Row>({
        text: [
          'SELECT connection.tenant_id::text AS tenant_id, connection.project_id::text AS project_id, connection.external_id, connection.name, connection.connector_config, connection.state, connection.created_at,',
          "  COALESCE((SELECT audit.actor FROM odf.audit_log AS audit WHERE audit.entity_type = 'sourceConnection' AND audit.entity_id = connection.source_connection_id::text ORDER BY audit.id ASC LIMIT 1), 'system') AS created_by",
          'FROM odf.source_connections AS connection',
          "WHERE connection.tenant_id = $1::uuid AND connection.project_id = $2::uuid AND connection.connector_config -> '__odfPlatformCatalog' ->> 'kind' = $3",
          '  AND connection.external_id > $4',
          'ORDER BY connection.external_id ASC LIMIT $5',
        ].join('\n'),
        values: [requestScope.tenantId, requestScope.projectId, kind, cursor, query.limit + 1],
      }));
      return this.textPage(result.rows, query.limit, (row) => {
        const config = object(row.connector_config);
        const marker = catalogMarker(config);
        if (!marker || marker.kind !== kind || typeof marker.type !== 'string') throw new TypeError('PostgreSQL source connection lacks catalog marker');
        const base = { tenantId: text(row.tenant_id, 'tenant ID'), projectId: text(row.project_id, 'project ID'), id: text(row.external_id, 'catalog ID'), name: text(row.name, 'catalog name'), type: marker.type, createdBy: catalogCreatedBy(row), createdAt: iso(row.created_at) };
        if (kind === 'source') return { ...base, description: marker.description === null || marker.description === undefined ? null : String(marker.description) };
        const { __odfPlatformCatalog: _marker, ...configuration } = config;
        return { ...base, sourceId: text(marker.sourceId, 'connector source ID'), configuration, enabled: row.state !== 'disabled' };
      }, (item) => String(item.id));
    } catch (error) { throw runtimeError(error); }
  }

  private textCursor(cursor: string | undefined): { value: string } | undefined {
    const id = decode(cursor, textCursorSchema)?.id;
    return id ? { value: id } : undefined;
  }

  private textPage(rows: readonly Row[], limit: number, mapper: (row: Row) => Record<string, unknown>, id: (item: Record<string, unknown>) => string): Record<string, unknown> {
    const items = rows.slice(0, limit).map(mapper);
    const tail = items.at(-1);
    return { items, nextCursor: rows.length > limit && tail ? encodeCursor({ id: id(tail) }) : null };
  }

  private page<T>(items: readonly T[], next: string | null, mapper: (item: T) => Record<string, unknown>): Record<string, unknown> {
    return { items: items.map(mapper), nextCursor: next ? encodeCursor({ id: next }) : null };
  }

  private spatial(item: Awaited<ReturnType<PostgresRuntime['advanced']['createSpatialAssetLink']>>): Record<string, unknown> {
    return { tenantId: item.tenantId, projectId: item.projectId, id: item.spatialLinkId, assetExternalId: item.assetExternalId, sceneExternalId: item.sceneExternalId, nodeExternalId: item.nodeExternalId, transform: item.transform, confidence: item.confidence, reviewState: item.reviewState, reviewedBy: item.reviewedBy, reviewComment: item.reviewComment, reviewedAt: item.reviewedAt, createdBy: item.createdBy, createdAt: item.createdAt };
  }
}
