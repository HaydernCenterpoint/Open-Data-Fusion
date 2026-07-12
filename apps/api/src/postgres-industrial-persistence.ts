import { createHash } from 'node:crypto';

import {
  ConflictError,
  NotFoundError,
  appendPlatformAuditAndOutbox,
  type PostgresRuntime,
  type ScopedTransaction,
} from '@open-data-fusion/postgres-runtime';

import type { PlatformProjectRole } from './platform.js';
import { industrialIngestRunId, industrialRelationExternalId } from './industrial-persistence.js';
import type {
  IndustrialPersistence,
  IndustrialPersistenceHealth,
  IndustrialRawArchive,
  IndustrialRequestScope,
} from './industrial-persistence.js';
import type {
  AssetListQuery,
  AuditListQuery,
  IngestBundle,
  RelationReview,
  TelemetryAggregateQuery,
  TelemetryLatestQuery,
  TelemetryQuery,
} from './schemas.js';

type Row = Record<string, unknown>;
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;
type EntityType = 'asset' | 'timeSeries' | 'document';
type EntityIdResolver = (type: EntityType, externalId: string) => string;

const DEFAULT_MODEL_SPACE_EXTERNAL_ID = 'default';
const MODEL_VERSION = 'odf-core/0.1';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** RFC-compatible UUID carrying version 8, derived from stable application keys. */
function deterministicUuid(...parts: readonly string[]): string {
  const bytes = createHash('sha256').update(canonical(parts)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function jsonValue(value: unknown, fallback: unknown = {}): unknown {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function entityUuid(scope: IndustrialRequestScope, type: EntityType, externalId: string): string {
  return deterministicUuid('odf-industrial-entity', scope.tenantId, scope.projectId, type, externalId);
}

function relationUuid(scope: IndustrialRequestScope, externalId: string): string {
  return deterministicUuid('odf-industrial-relation', scope.tenantId, scope.projectId, externalId);
}

function runUuid(scope: IndustrialRequestScope, sourceExternalId: string, idempotencyKey: string): string {
  return deterministicUuid('odf-industrial-run', scope.tenantId, scope.projectId, sourceExternalId, idempotencyKey);
}

function assetKind(type: string): 'site' | 'system' | 'equipment' | 'instrument' | 'location' {
  switch (type.toLowerCase()) {
    case 'site': return 'site';
    case 'system': return 'system';
    case 'instrument': return 'instrument';
    case 'location': return 'location';
    default: return 'equipment';
  }
}

function mapAsset(row: Row): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    name: String(row.name),
    description: nullableString(row.description),
    type: String(row.asset_type),
    parentExternalId: nullableString(row.parent_external_id),
    metadata: jsonValue(row.metadata),
    sourceSystem: String(row.source_system),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapSeries(row: Row): Record<string, unknown> {
  const properties = objectValue(row.properties);
  return {
    externalId: String(row.external_id),
    assetExternalId: String(row.asset_external_id),
    name: String(row.name),
    unit: nullableString(row.unit),
    description: nullableString(properties.description),
    metadata: jsonValue(row.metadata),
    sourceSystem: String(row.source_system),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapDocument(row: Row): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    assetExternalId: nullableString(row.asset_external_id),
    title: String(row.title),
    mimeType: nullableString(row.mime_type),
    uri: nullableString(row.storage_uri),
    metadata: jsonValue(row.metadata),
    sourceSystem: String(row.source_system),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function relationEvidence(row: Row): Record<string, unknown> {
  const parsed = jsonValue(row.evidence);
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const envelope = first as Record<string, unknown>;
      return objectValue(envelope.payload ?? envelope);
    }
    return {};
  }
  const envelope = objectValue(parsed);
  return objectValue(envelope.payload ?? envelope);
}

function mapRelation(row: Row): Record<string, unknown> {
  return {
    id: String(row.relation_id),
    source: { type: String(row.source_type), externalId: String(row.source_external_id) },
    target: { type: String(row.target_type), externalId: String(row.target_external_id) },
    type: String(row.relation_type),
    status: String(row.status),
    confidence: numberValue(row.confidence ?? 0),
    evidence: relationEvidence(row),
    ruleVersion: nullableString(row.rule_version),
    reviewer: nullableString(row.reviewer),
    reviewComment: nullableString(row.review_comment),
    reviewedAt: row.reviewed_at === null || row.reviewed_at === undefined ? null : iso(row.reviewed_at),
    sourceSystem: String(row.source_system),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
  };
}

function mapAudit(row: Row): Record<string, unknown> {
  return {
    id: numberValue(row.id),
    timestamp: iso(row.occurred_at),
    actor: String(row.actor),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: nullableString(row.entity_id),
    details: jsonValue(row.details),
    correlationId: String(row.correlation_id),
  };
}

function graphTypeSql(alias: string): string {
  return [
    `CASE`,
    `  WHEN ${alias}_asset.asset_id IS NOT NULL THEN 'asset'`,
    `  WHEN ${alias}_series.time_series_id IS NOT NULL THEN 'timeSeries'`,
    `  ELSE 'document'`,
    `END`,
  ].join('\n');
}

function defaultSpacePredicate(graphAlias: string): string {
  return [
    `${graphAlias}.space_id = (`,
    '  SELECT space.space_id FROM odf.model_spaces AS space',
    `  WHERE space.tenant_id = $1::uuid AND space.project_id = $2::uuid AND space.external_id = '${DEFAULT_MODEL_SPACE_EXTERNAL_ID}'`,
    '  LIMIT 1',
    ')',
  ].join('\n');
}

const RELATION_SELECT = [
  'SELECT COALESCE(relation_graph.external_id, candidate.relation_candidate_id::text) AS relation_id, candidate.relation_candidate_id::text AS relation_uuid, candidate.source_instance_id, candidate.target_instance_id,',
  `  ${graphTypeSql('source')} AS source_type, source_graph.external_id AS source_external_id,`,
  `  ${graphTypeSql('target')} AS target_type, target_graph.external_id AS target_external_id,`,
  '  candidate.relation_type, candidate.state AS status, candidate.confidence, candidate.evidence,',
  '  candidate.rule_version, candidate.reviewer, candidate.review_comment, candidate.reviewed_at,',
  "  COALESCE(candidate.model_version, 'unknown') AS source_system, candidate.created_at,",
  '  COALESCE(candidate.reviewed_at, candidate.created_at) AS updated_at',
  'FROM odf.relation_candidates AS candidate',
  'LEFT JOIN odf.graph_instances AS relation_graph',
  '  ON relation_graph.instance_id = candidate.relation_candidate_id',
  ' AND relation_graph.tenant_id = candidate.tenant_id',
  ' AND relation_graph.project_id = candidate.project_id',
  'JOIN odf.graph_instances AS source_graph ON source_graph.instance_id = candidate.source_instance_id',
  'JOIN odf.graph_instances AS target_graph ON target_graph.instance_id = candidate.target_instance_id',
  'LEFT JOIN odf.assets AS source_asset ON source_asset.asset_id = source_graph.instance_id',
  'LEFT JOIN odf.time_series AS source_series ON source_series.time_series_id = source_graph.instance_id',
  'LEFT JOIN odf.assets AS target_asset ON target_asset.asset_id = target_graph.instance_id',
  'LEFT JOIN odf.time_series AS target_series ON target_series.time_series_id = target_graph.instance_id',
].join('\n');

const ACCEPTED_RELATION_SELECT = [
  'SELECT COALESCE(relation_graph.external_id, relation.relation_id::text) AS relation_id, relation.relation_id::text AS relation_uuid, relation.source_instance_id, relation.target_instance_id,',
  `  ${graphTypeSql('source')} AS source_type, source_graph.external_id AS source_external_id,`,
  `  ${graphTypeSql('target')} AS target_type, target_graph.external_id AS target_external_id,`,
  '  relation.relation_type, relation.state AS status,',
  "  NULLIF(relation.evidence->>'confidence', '')::double precision AS confidence, relation.evidence,",
  "  relation.evidence->>'ruleVersion' AS rule_version, NULL::text AS reviewer, NULL::text AS review_comment,",
  '  NULL::timestamptz AS reviewed_at, relation.source_system, relation.created_at,',
  '  COALESCE(relation.superseded_at, relation.created_at) AS updated_at',
  'FROM odf.relations AS relation',
  'LEFT JOIN odf.graph_instances AS relation_graph',
  '  ON relation_graph.instance_id = relation.relation_id',
  ' AND relation_graph.tenant_id = relation.tenant_id',
  ' AND relation_graph.project_id = relation.project_id',
  'JOIN odf.graph_instances AS source_graph ON source_graph.instance_id = relation.source_instance_id',
  'JOIN odf.graph_instances AS target_graph ON target_graph.instance_id = relation.target_instance_id',
  'LEFT JOIN odf.assets AS source_asset ON source_asset.asset_id = source_graph.instance_id',
  'LEFT JOIN odf.time_series AS source_series ON source_series.time_series_id = source_graph.instance_id',
  'LEFT JOIN odf.assets AS target_asset ON target_asset.asset_id = target_graph.instance_id',
  'LEFT JOIN odf.time_series AS target_series ON target_series.time_series_id = target_graph.instance_id',
].join('\n');

export class PostgresIndustrialPersistence implements IndustrialPersistence {
  readonly mode = 'postgres' as const;

  constructor(private readonly runtime: PostgresRuntime) {}

  async health(): Promise<IndustrialPersistenceHealth> {
    const health = await this.runtime.health();
    return { ...health, mode: 'postgres' };
  }

  async authorize(scope: IndustrialRequestScope, allowedRoles?: readonly PlatformProjectRole[]): Promise<void> {
    await this.runtime.catalog.resolveMember(scope, allowedRoles);
  }

  async listAssets(scope: IndustrialRequestScope, query: AssetListQuery): Promise<Record<string, unknown>> {
    await this.authorize(scope);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const conditions = [
        'asset.tenant_id = $1::uuid',
        'asset.project_id = $2::uuid',
        defaultSpacePredicate('graph'),
        "($3::text IS NULL OR graph.external_id ILIKE '%' || $3 || '%' OR asset.name ILIKE '%' || $3 || '%' OR COALESCE(asset.description, '') ILIKE '%' || $3 || '%')",
        '($4::text IS NULL OR lower(asset.asset_type) = lower($4))',
      ];
      const values = [scope.tenantId, scope.projectId, query.q ?? null, query.type ?? null];
      const rows = await transaction.query({
        text: [
          'SELECT graph.external_id, asset.name, asset.description, asset.asset_type, parent.external_id AS parent_external_id,',
          '  asset.metadata, asset.source_system, asset.created_at, asset.updated_at, count(*) OVER()::bigint AS total',
          'FROM odf.assets AS asset',
          'JOIN odf.graph_instances AS graph ON graph.instance_id = asset.asset_id',
          'LEFT JOIN odf.graph_instances AS parent ON parent.instance_id = asset.parent_asset_id',
          `WHERE ${conditions.join(' AND ')}`,
          'ORDER BY lower(asset.name), graph.external_id',
          'LIMIT $5 OFFSET $6',
        ].join('\n'),
        values: [...values, query.limit, query.offset],
      });
      let total = numberValue(rows.rows[0]?.total ?? 0);
      if (rows.rows.length === 0 && query.offset > 0) {
        const count = await transaction.query({
          text: `SELECT count(*)::bigint AS total FROM odf.assets AS asset JOIN odf.graph_instances AS graph ON graph.instance_id = asset.asset_id WHERE ${conditions.join(' AND ')}`,
          values,
        });
        total = numberValue(count.rows[0]?.total ?? 0);
      }
      return {
        items: rows.rows.map(mapAsset),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async getAsset(scope: IndustrialRequestScope, externalId: string): Promise<Record<string, unknown>> {
    await this.authorize(scope);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const assetResult = await transaction.query({
        text: [
          'SELECT graph.external_id, asset.name, asset.description, asset.asset_type, parent.external_id AS parent_external_id,',
          '  asset.asset_id, asset.metadata, asset.source_system, asset.created_at, asset.updated_at',
          'FROM odf.assets AS asset',
          'JOIN odf.graph_instances AS graph ON graph.instance_id = asset.asset_id',
          'LEFT JOIN odf.graph_instances AS parent ON parent.instance_id = asset.parent_asset_id',
          'WHERE asset.tenant_id = $1::uuid AND asset.project_id = $2::uuid AND graph.external_id = $3',
          `  AND ${defaultSpacePredicate('graph')}`,
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, externalId],
      });
      const row = assetResult.rows[0];
      if (!row) throw new NotFoundError(`Asset '${externalId}' was not found`);
      const assetId = String(row.asset_id);

      const parent = row.parent_external_id === null || row.parent_external_id === undefined
        ? null
        : await this.fetchAssetByExternalId(transaction, scope, String(row.parent_external_id));
      const children = await transaction.query({
        text: [
          'SELECT graph.external_id, asset.name, asset.description, asset.asset_type, parent.external_id AS parent_external_id,',
          '  asset.metadata, asset.source_system, asset.created_at, asset.updated_at',
          'FROM odf.assets AS asset JOIN odf.graph_instances AS graph ON graph.instance_id = asset.asset_id',
          'LEFT JOIN odf.graph_instances AS parent ON parent.instance_id = asset.parent_asset_id',
          'WHERE asset.tenant_id = $1::uuid AND asset.project_id = $2::uuid AND asset.parent_asset_id = $3::uuid',
          `  AND ${defaultSpacePredicate('graph')}`,
          'ORDER BY asset.name',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, assetId],
      });
      const series = await this.fetchSeries(transaction, scope, assetId);
      const documents = await transaction.query({
        text: [
          'SELECT graph.external_id, document.title, document.mime_type, document.storage_uri, document.metadata,',
          '  document.source_system, document.created_at, document.updated_at, asset_graph.external_id AS asset_external_id',
          'FROM odf.document_asset_links AS link',
          'JOIN odf.documents AS document ON document.document_id = link.document_id',
          'JOIN odf.graph_instances AS graph ON graph.instance_id = document.document_id',
          'JOIN odf.graph_instances AS asset_graph ON asset_graph.instance_id = link.asset_id',
          'WHERE link.tenant_id = $1::uuid AND link.project_id = $2::uuid AND link.asset_id = $3::uuid',
          `  AND ${defaultSpacePredicate('graph')}`,
          'ORDER BY document.title',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, assetId],
      });
      const relations = await this.fetchRelations(transaction, scope, undefined, 200, assetId);
      const provenance = await transaction.query({
        text: [
          'SELECT provenance.provenance_id AS id, graph.external_id AS entity_id, provenance.source_system,',
          '  provenance.source_record_id, provenance.ingestion_run_id, provenance.payload_sha256,',
          '  provenance.valid_from, provenance.transaction_time, provenance.metadata',
          'FROM odf.provenance_records AS provenance',
          'JOIN odf.graph_instances AS graph ON graph.instance_id = provenance.instance_id',
          'WHERE provenance.tenant_id = $1::uuid AND provenance.project_id = $2::uuid AND provenance.instance_id = $3::uuid',
          'ORDER BY provenance.transaction_time DESC, provenance.provenance_id DESC',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, assetId],
      });

      return {
        asset: mapAsset(row),
        parent,
        children: children.rows.map(mapAsset),
        timeSeries: series.map(mapSeries),
        documents: documents.rows.map(mapDocument),
        relations: relations.map(mapRelation),
        provenance: provenance.rows.map((item) => ({
          id: numberValue(item.id), entityType: 'asset', entityId: String(item.entity_id),
          sourceSystem: String(item.source_system), sourceRecordId: nullableString(item.source_record_id),
          ingestionRunId: nullableString(item.ingestion_run_id), rawHash: String(item.payload_sha256),
          modelVersion: String(objectValue(item.metadata).modelVersion ?? MODEL_VERSION),
          validFrom: item.valid_from ? iso(item.valid_from) : iso(item.transaction_time),
          transactionTime: iso(item.transaction_time), metadata: jsonValue(item.metadata),
        })),
      };
    });
  }

  async getTelemetry(scope: IndustrialRequestScope, externalId: string, query: TelemetryQuery): Promise<Record<string, unknown>> {
    await this.authorize(scope);
    const from = query.from ?? Date.now() - 24 * 60 * 60 * 1_000;
    const to = query.to ?? Date.now();
    return this.runtime.withTransaction(scope, async (transaction) => {
      const { assetId, series } = await this.requireTelemetrySeries(transaction, scope, externalId, query.timeSeriesExternalId);
      const points = await transaction.query({
        text: [
          'WITH ranked AS (',
          '  SELECT point.time_series_id, point.observed_at, point.numeric_value, point.quality,',
          '    row_number() OVER (PARTITION BY point.time_series_id ORDER BY point.observed_at DESC, point.sequence DESC) AS rank',
          '  FROM odf.time_series_points AS point',
          '  JOIN odf.time_series AS series ON series.time_series_id = point.time_series_id',
          '  JOIN odf.graph_instances AS graph ON graph.instance_id = series.time_series_id',
          '  WHERE point.tenant_id = $1::uuid AND point.project_id = $2::uuid AND series.asset_id = $3::uuid',
          '    AND point.numeric_value IS NOT NULL',
          '    AND point.observed_at >= to_timestamp($4::double precision / 1000.0)',
          '    AND point.observed_at <= to_timestamp($5::double precision / 1000.0)',
          '    AND ($6::text IS NULL OR graph.external_id = $6)',
          ') SELECT * FROM ranked WHERE rank <= $7 ORDER BY time_series_id, observed_at ASC',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, assetId, from, to, query.timeSeriesExternalId ?? null, query.limit],
      });
      const bySeries = new Map<string, Row[]>();
      for (const point of points.rows) {
        const items = bySeries.get(String(point.time_series_id)) ?? [];
        items.push(point);
        bySeries.set(String(point.time_series_id), items);
      }
      return {
        assetExternalId: externalId,
        range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        series: series.map((item) => ({
          ...mapSeries(item),
          points: (bySeries.get(String(item.time_series_id)) ?? []).map((point) => ({
            timestamp: iso(point.observed_at), value: numberValue(point.numeric_value), quality: String(point.quality),
          })),
        })),
      };
    });
  }

  async getLatestTelemetry(scope: IndustrialRequestScope, externalId: string, query: TelemetryLatestQuery): Promise<Record<string, unknown>> {
    await this.authorize(scope);
    const at = query.at ?? Date.now();
    return this.runtime.withTransaction(scope, async (transaction) => {
      const { assetId, series } = await this.requireTelemetrySeries(transaction, scope, externalId, query.timeSeriesExternalId);
      const points = await transaction.query({
        text: [
          'SELECT DISTINCT ON (point.time_series_id) point.time_series_id, point.observed_at, point.numeric_value, point.quality',
          'FROM odf.time_series_points AS point',
          'JOIN odf.time_series AS series ON series.time_series_id = point.time_series_id',
          'JOIN odf.graph_instances AS graph ON graph.instance_id = series.time_series_id',
          'WHERE point.tenant_id = $1::uuid AND point.project_id = $2::uuid AND series.asset_id = $3::uuid',
          '  AND point.numeric_value IS NOT NULL',
          '  AND point.observed_at <= to_timestamp($4::double precision / 1000.0)',
          '  AND ($5::text IS NULL OR graph.external_id = $5)',
          'ORDER BY point.time_series_id, point.observed_at DESC, point.sequence DESC',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, assetId, at, query.timeSeriesExternalId ?? null],
      });
      const bySeries = new Map(points.rows.map((point) => [String(point.time_series_id), point]));
      return {
        assetExternalId: externalId,
        asOf: new Date(at).toISOString(),
        series: series.map((item) => {
          const point = bySeries.get(String(item.time_series_id));
          const mapped = point ? {
            timestamp: iso(point.observed_at), value: numberValue(point.numeric_value), quality: String(point.quality),
          } : null;
          return { ...mapSeries(item), point: mapped, points: mapped ? [mapped] : [] };
        }),
      };
    });
  }

  async getAggregatedTelemetry(
    scope: IndustrialRequestScope,
    externalId: string,
    query: TelemetryAggregateQuery,
  ): Promise<Record<string, unknown>> {
    await this.authorize(scope);
    const from = query.from ?? Date.now() - 24 * 60 * 60 * 1_000;
    const to = query.to ?? Date.now();
    return this.runtime.withTransaction(scope, async (transaction) => {
      const { assetId, series } = await this.requireTelemetrySeries(transaction, scope, externalId, query.timeSeriesExternalId);
      const buckets = await transaction.query({
        text: [
          'WITH filtered AS MATERIALIZED (',
          '  SELECT point.time_series_id, point.observed_at, point.sequence, point.numeric_value, point.quality,',
          '    floor(extract(epoch FROM point.observed_at) * 1000.0 / $6::double precision) * $6::double precision AS bucket_ms',
          '  FROM odf.time_series_points AS point',
          '  JOIN odf.time_series AS series ON series.time_series_id = point.time_series_id',
          '  JOIN odf.graph_instances AS graph ON graph.instance_id = series.time_series_id',
          '  WHERE point.tenant_id = $1::uuid AND point.project_id = $2::uuid AND series.asset_id = $3::uuid',
          '    AND point.numeric_value IS NOT NULL',
          '    AND point.observed_at >= to_timestamp($4::double precision / 1000.0)',
          '    AND point.observed_at <= to_timestamp($5::double precision / 1000.0)',
          '    AND ($7::text IS NULL OR graph.external_id = $7)',
          '), ranked_buckets AS (',
          '  SELECT time_series_id, bucket_ms,',
          '    row_number() OVER (PARTITION BY time_series_id ORDER BY bucket_ms DESC) AS rank',
          '  FROM (SELECT DISTINCT time_series_id, bucket_ms FROM filtered) AS buckets',
          '), selected_points AS (',
          '  SELECT filtered.* FROM filtered',
          '  JOIN ranked_buckets USING (time_series_id, bucket_ms)',
          '  WHERE ranked_buckets.rank <= $8',
          '), enriched AS (',
          '  SELECT selected_points.*,',
          '    first_value(observed_at) OVER first_window AS first_timestamp,',
          '    first_value(numeric_value) OVER first_window AS first_value,',
          '    first_value(observed_at) OVER last_window AS last_timestamp,',
          '    first_value(numeric_value) OVER last_window AS last_value',
          '  FROM selected_points',
          '  WINDOW',
          '    first_window AS (PARTITION BY time_series_id, bucket_ms ORDER BY observed_at ASC, sequence ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING),',
          '    last_window AS (PARTITION BY time_series_id, bucket_ms ORDER BY observed_at DESC, sequence DESC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)',
          ') SELECT time_series_id, bucket_ms, count(*)::bigint AS point_count, avg(numeric_value) AS average_value,',
          '  min(numeric_value) AS minimum_value, max(numeric_value) AS maximum_value, sum(numeric_value) AS sum_value,',
          '  max(first_timestamp) AS first_timestamp, max(first_value) AS first_value,',
          '  max(last_timestamp) AS last_timestamp, max(last_value) AS last_value,',
          "  CASE WHEN bool_or(quality = 'bad') THEN 'bad' WHEN bool_or(quality = 'uncertain') THEN 'uncertain' ELSE 'good' END AS quality",
          'FROM enriched GROUP BY time_series_id, bucket_ms ORDER BY time_series_id, bucket_ms ASC',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, assetId, from, to, query.bucketMs, query.timeSeriesExternalId ?? null, query.limit],
      });
      const bySeries = new Map<string, Row[]>();
      for (const bucket of buckets.rows) {
        const items = bySeries.get(String(bucket.time_series_id)) ?? [];
        items.push(bucket);
        bySeries.set(String(bucket.time_series_id), items);
      }
      const aggregateValue = (row: Row): number => {
        switch (query.aggregation) {
          case 'min': return numberValue(row.minimum_value);
          case 'max': return numberValue(row.maximum_value);
          case 'sum': return numberValue(row.sum_value);
          case 'count': return numberValue(row.point_count);
          default: return numberValue(row.average_value);
        }
      };
      return {
        assetExternalId: externalId,
        range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        bucketMs: query.bucketMs,
        aggregation: query.aggregation,
        series: series.map((item) => {
          const mapped = (bySeries.get(String(item.time_series_id)) ?? []).map((row) => ({
            timestamp: new Date(numberValue(row.bucket_ms)).toISOString(),
            endTimestamp: new Date(Math.min(numberValue(row.bucket_ms) + query.bucketMs, to)).toISOString(),
            value: aggregateValue(row), count: numberValue(row.point_count), min: numberValue(row.minimum_value),
            max: numberValue(row.maximum_value), avg: numberValue(row.average_value), sum: numberValue(row.sum_value),
            first: { timestamp: iso(row.first_timestamp), value: numberValue(row.first_value) },
            last: { timestamp: iso(row.last_timestamp), value: numberValue(row.last_value) }, quality: String(row.quality),
          }));
          return { ...mapSeries(item), buckets: mapped, points: mapped };
        }),
      };
    });
  }

  async ingest(
    scope: IndustrialRequestScope,
    bundle: IngestBundle,
    correlationId: string,
    archive?: IndustrialRawArchive,
  ): Promise<Record<string, unknown>> {
    await this.authorize(scope, ['owner', 'editor']);
    const payloadHash = sha256(bundle);
    const idempotencyKey = industrialIngestRunId(bundle);
    const ingestionRunId = runUuid(scope, bundle.source.system, idempotencyKey);
    const publicRunId = idempotencyKey;
    const counts = {
      assets: bundle.assets.length,
      timeSeries: bundle.timeSeries.length,
      dataPoints: bundle.dataPoints.length,
      documents: bundle.documents.length,
      relations: bundle.relations.length,
    };
    try {
      return await this.runtime.withTransaction(scope, async (transaction) => {
        await transaction.query({
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          values: [canonical(['odf-industrial-ingest', scope.tenantId, scope.projectId, bundle.source.system, idempotencyKey])],
        });
        const defaults = await this.resolveDefaults(transaction, scope, bundle.source.system);
        const prior = await transaction.query({
          text: [
            'SELECT ingestion_run_id, state, checkpoint_before, checkpoint_after, completed_at',
            'FROM odf.ingestion_runs',
            'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND source_connection_id = $3::uuid AND idempotency_key = $4',
            'FOR UPDATE',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, defaults.sourceConnectionId, idempotencyKey],
        });
        const previous = prior.rows[0];
        if (previous) {
          const priorHash = nullableString(objectValue(previous.checkpoint_before).payloadHash);
          if (priorHash !== payloadHash) {
            throw new ConflictError(`Ingestion run '${idempotencyKey}' was already used with a different payload`);
          }
          if (previous.state === 'succeeded') {
            return {
              runId: publicRunId,
              status: 'already_processed',
              counts: objectValue(previous.checkpoint_after).counts ?? counts,
            };
          }
        }
        const effectiveRunId = previous ? String(previous.ingestion_run_id) : ingestionRunId;

        const rawObjectId = await this.upsertRawArchive(transaction, scope, defaults.sourceConnectionId, bundle.source.system, archive);
        const entityId = await this.resolveEntityIds(transaction, scope, defaults.modelSpaceId, bundle);

        await transaction.query({
          text: [
            'INSERT INTO odf.ingestion_runs',
            '  (ingestion_run_id, tenant_id, project_id, source_connection_id, raw_object_id, idempotency_key, state, checkpoint_before, correlation_id)',
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'running', $7::jsonb, $8::uuid)",
            'ON CONFLICT (tenant_id, source_connection_id, idempotency_key) DO UPDATE SET',
            "  state = 'running', raw_object_id = EXCLUDED.raw_object_id, checkpoint_before = EXCLUDED.checkpoint_before,",
            '  checkpoint_after = NULL, accepted_records = 0, rejected_records = 0, started_at = now(), completed_at = NULL,',
            '  error_code = NULL, error_summary = NULL, correlation_id = EXCLUDED.correlation_id',
          ].join('\n'),
          values: [effectiveRunId, scope.tenantId, scope.projectId, defaults.sourceConnectionId, rawObjectId, idempotencyKey, json({ payloadHash }), correlationId],
        });

        const graphRows = [
          ...bundle.assets.map((item) => ({ id: entityId('asset', item.externalId), external_id: item.externalId, kind: 'node', properties: {} })),
          ...bundle.timeSeries.map((item) => ({ id: entityId('timeSeries', item.externalId), external_id: item.externalId, kind: 'node', properties: { description: item.description ?? null } })),
          ...bundle.documents.map((item) => ({ id: entityId('document', item.externalId), external_id: item.externalId, kind: 'node', properties: {} })),
          ...bundle.relations.map((item) => ({ id: relationUuid(scope, industrialRelationExternalId(item)), external_id: industrialRelationExternalId(item), kind: 'edge', properties: {} })),
        ];
        const graphUpsert = await transaction.query({
          text: [
            'INSERT INTO odf.graph_instances (instance_id, tenant_id, project_id, space_id, external_id, instance_kind, properties)',
            'SELECT item.id::uuid, $1::uuid, $2::uuid, $3::uuid, item.external_id, item.kind, item.properties',
            'FROM jsonb_to_recordset($4::jsonb) AS item(id text, external_id text, kind text, properties jsonb)',
            'ON CONFLICT (instance_id) DO UPDATE SET',
            '  properties = odf.graph_instances.properties || EXCLUDED.properties, updated_at = now()',
            'WHERE odf.graph_instances.tenant_id = EXCLUDED.tenant_id',
            '  AND odf.graph_instances.project_id = EXCLUDED.project_id',
            '  AND odf.graph_instances.space_id = EXCLUDED.space_id',
            '  AND odf.graph_instances.external_id = EXCLUDED.external_id',
            '  AND odf.graph_instances.instance_kind = EXCLUDED.instance_kind',
            'RETURNING instance_id, tenant_id, project_id, space_id, external_id, instance_kind',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, defaults.modelSpaceId, json(graphRows)],
        });
        const expectedGraphRows = new Map(graphRows.map((row) => [row.id, row]));
        const persistedGraphRows = new Map(graphUpsert.rows.map((row) => [String(row.instance_id), row]));
        for (const [id, expected] of expectedGraphRows) {
          const persisted = persistedGraphRows.get(id);
          if (!persisted
            || String(persisted.tenant_id) !== scope.tenantId
            || String(persisted.project_id) !== scope.projectId
            || String(persisted.space_id) !== defaults.modelSpaceId
            || String(persisted.external_id) !== expected.external_id
            || String(persisted.instance_kind) !== expected.kind) {
            throw new ConflictError(
              `Graph instance '${expected.external_id}' is already bound to a different project or identity`,
            );
          }
        }

        await this.upsertAssets(transaction, scope, bundle, entityId);
        await this.upsertSeries(transaction, scope, bundle, entityId);
        await this.upsertPoints(transaction, scope, bundle, defaults.sourceConnectionId, effectiveRunId, entityId);
        await this.upsertDocuments(transaction, scope, bundle, rawObjectId, entityId);
        await this.upsertRelations(transaction, scope, bundle, entityId);
        await this.insertProvenance(transaction, scope, bundle, effectiveRunId, rawObjectId, entityId);

        const acceptedRecords = Object.values(counts).reduce((total, count) => total + count, 0);
        const completed = await transaction.query({
          text: [
            'UPDATE odf.ingestion_runs',
            "SET state = 'succeeded', accepted_records = $4::bigint, checkpoint_after = $5::jsonb, completed_at = now()",
            'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND ingestion_run_id = $3::uuid',
            'RETURNING completed_at',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, effectiveRunId, acceptedRecords, json({ payloadHash, counts })],
        });
        const completedAt = iso(completed.rows[0]?.completed_at ?? new Date());
        await appendPlatformAuditAndOutbox(transaction, {
          actor: bundle.source.actor,
          action: 'ingestion.completed',
          entityType: 'ingestionRun',
          entityId: effectiveRunId,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          correlationId,
          details: { tenantId: scope.tenantId, projectId: scope.projectId, sourceSystem: bundle.source.system, counts, payloadHash },
        });
        return { runId: publicRunId, status: 'completed', counts, completedAt };
      });
    } catch (error) {
      if (error instanceof ConflictError && error.message.includes('already used with a different payload')) throw error;
      await this.recordFailedRun(scope, bundle, correlationId, ingestionRunId, idempotencyKey, payloadHash, counts, error, archive);
      throw error;
    }
  }

  async listRelations(
    scope: IndustrialRequestScope,
    status: 'proposed' | 'accepted' | 'rejected' | 'superseded' | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    await this.authorize(scope);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const rows = await this.fetchRelations(transaction, scope, status, limit);
      return { items: rows.map(mapRelation), total: rows.length, limit };
    });
  }

  async reviewRelation(
    scope: IndustrialRequestScope,
    id: string,
    review: RelationReview,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    await this.authorize(scope, ['owner', 'editor', 'reviewer']);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const current = await transaction.query({
        text: [
          'SELECT candidate.relation_candidate_id, candidate.source_instance_id, candidate.target_instance_id, candidate.relation_type,',
          '  candidate.confidence, candidate.evidence, candidate.rule_version, candidate.model_version, candidate.state',
          'FROM odf.relation_candidates AS candidate',
          'LEFT JOIN odf.graph_instances AS graph ON graph.instance_id = candidate.relation_candidate_id',
          'WHERE candidate.tenant_id = $1::uuid AND candidate.project_id = $2::uuid',
          `  AND ((graph.external_id = $3 AND ${defaultSpacePredicate('graph')})`,
          '    OR candidate.relation_candidate_id::text = $3)',
          'FOR UPDATE',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, id],
      });
      const candidate = current.rows[0];
      if (!candidate) throw new NotFoundError(`Relation '${id}' was not found`);
      if (candidate.state !== 'proposed') throw new ConflictError(`Relation '${id}' has already been ${String(candidate.state)}`);
      const candidateId = String(candidate.relation_candidate_id);

      let acceptedRelationId: string | null = null;
      if (review.decision === 'accepted') {
        acceptedRelationId = candidateId;
        await transaction.query({
          text: [
            'INSERT INTO odf.relations',
            '  (relation_id, tenant_id, project_id, source_instance_id, target_instance_id, relation_type, state, source_system, evidence)',
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'accepted', $7,",
            "  CASE WHEN jsonb_typeof($8::jsonb) = 'array' THEN COALESCE($8::jsonb->0, '{}'::jsonb) ELSE $8::jsonb END)",
            'ON CONFLICT (relation_id) DO NOTHING',
          ].join('\n'),
          values: [acceptedRelationId, scope.tenantId, scope.projectId, candidate.source_instance_id, candidate.target_instance_id,
            candidate.relation_type, candidate.model_version ?? 'review', candidate.evidence],
        });
        const accepted = await transaction.query({
          text: [
            'SELECT 1 AS valid_relation FROM odf.relations',
            'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND relation_id = $3::uuid',
            '  AND source_instance_id = $4::uuid AND target_instance_id = $5::uuid',
            "  AND relation_type = $6 AND state = 'accepted'",
            'FOR UPDATE',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, acceptedRelationId, candidate.source_instance_id,
            candidate.target_instance_id, candidate.relation_type],
        });
        if (!accepted.rows[0]) {
          throw new ConflictError(`Relation '${id}' collides with an unrelated accepted relation`);
        }
        await transaction.query({
          text: [
            'UPDATE odf.relation_candidates SET',
            "  state = 'superseded', reviewer = $7, review_comment = $8, reviewed_at = now(), accepted_relation_id = NULL",
            'WHERE tenant_id = $1::uuid AND project_id = $2::uuid',
            '  AND source_instance_id = $3::uuid AND target_instance_id = $4::uuid AND relation_type = $5',
            '  AND relation_candidate_id <> $6::uuid AND state = \'proposed\'',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, candidate.source_instance_id, candidate.target_instance_id,
            candidate.relation_type, candidateId, review.reviewer, review.comment ?? 'Superseded by accepted relation'],
        });
      }
      await transaction.query({
        text: [
          'UPDATE odf.relation_candidates',
          'SET state = $4, reviewer = $5, review_comment = $6, reviewed_at = now(), accepted_relation_id = $7::uuid',
          'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND relation_candidate_id = $3::uuid',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, candidateId, review.decision, review.reviewer, review.comment ?? null, acceptedRelationId],
      });
      await appendPlatformAuditAndOutbox(transaction, {
        actor: review.reviewer,
        action: `relation.${review.decision}`,
        entityType: 'relation',
        entityId: id,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId,
        details: { tenantId: scope.tenantId, projectId: scope.projectId, previousStatus: 'proposed', decision: review.decision, comment: review.comment ?? null },
      });
      const updated = await this.fetchRelations(transaction, scope, review.decision, 1, undefined, id);
      const relation = updated[0];
      if (!relation) throw new NotFoundError(`Relation '${id}' was not found after review`);
      return mapRelation(relation);
    });
  }

  async listAudit(scope: IndustrialRequestScope, query: AuditListQuery): Promise<Record<string, unknown>> {
    await this.authorize(scope);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const filters = [
        'tenant_id = $1::uuid',
        'project_id = $2::uuid',
        '($3::text IS NULL OR action = $3)',
        '($4::text IS NULL OR entity_type = $4)',
        '($5::text IS NULL OR entity_id = $5)',
      ];
      const values = [scope.tenantId, scope.projectId, query.action ?? null, query.entityType ?? null, query.entityId ?? null];
      const count = await transaction.query({
        text: `SELECT count(*)::bigint AS total FROM odf.audit_log WHERE ${filters.join(' AND ')}`,
        values,
      });
      const rows = await transaction.query({
        text: [
          'SELECT id, occurred_at, actor, action, entity_type, entity_id, details, correlation_id',
          'FROM odf.audit_log',
          `WHERE ${filters.join(' AND ')}`,
          'ORDER BY occurred_at DESC, id DESC LIMIT $6 OFFSET $7',
        ].join('\n'),
        values: [...values, query.limit, query.offset],
      });
      return { items: rows.rows.map(mapAudit), total: numberValue(count.rows[0]?.total ?? 0), limit: query.limit, offset: query.offset };
    });
  }

  private async resolveDefaults(transaction: ScopedTransaction, scope: IndustrialRequestScope, sourceExternalId: string): Promise<{ modelSpaceId: string; sourceConnectionId: string }> {
    const result = await transaction.query({
      text: [
        'SELECT space.space_id, source.source_connection_id',
        'FROM odf.model_spaces AS space',
        'JOIN odf.source_connections AS source ON source.tenant_id = space.tenant_id AND source.project_id = space.project_id',
        'WHERE space.tenant_id = $1::uuid AND space.project_id = $2::uuid AND space.external_id = $3',
        '  AND source.external_id = $4 AND source.state NOT IN (\'disabled\', \'draft\')',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, DEFAULT_MODEL_SPACE_EXTERNAL_ID, sourceExternalId],
    });
    const row = result.rows[0];
    if (!row) throw new NotFoundError(`Active source connection '${sourceExternalId}' or model space '${DEFAULT_MODEL_SPACE_EXTERNAL_ID}' was not found`);
    return { modelSpaceId: String(row.space_id), sourceConnectionId: String(row.source_connection_id) };
  }

  private async resolveEntityIds(
    transaction: ScopedTransaction,
    scope: IndustrialRequestScope,
    modelSpaceId: string,
    bundle: IngestBundle,
  ): Promise<EntityIdResolver> {
    const requested = new Map<string, EntityType>();
    const add = (type: EntityType, externalId: string | null | undefined): void => {
      if (!externalId) return;
      const previous = requested.get(externalId);
      if (previous && previous !== type) {
        throw new ConflictError(`External ID '${externalId}' is used as both ${previous} and ${type}`);
      }
      requested.set(externalId, type);
    };
    for (const asset of bundle.assets) {
      add('asset', asset.externalId);
      add('asset', asset.parentExternalId);
    }
    for (const series of bundle.timeSeries) {
      add('timeSeries', series.externalId);
      add('asset', series.assetExternalId);
    }
    for (const point of bundle.dataPoints) add('timeSeries', point.timeSeriesExternalId);
    for (const document of bundle.documents) {
      add('document', document.externalId);
      add('asset', document.assetExternalId);
    }
    for (const relation of bundle.relations) {
      add(relation.sourceType, relation.sourceExternalId);
      add(relation.targetType, relation.targetExternalId);
    }

    const resolved = new Map<string, string>();
    const externalIds = [...requested.keys()];
    if (externalIds.length > 0) {
      const existing = await transaction.query({
        text: [
          'SELECT graph.instance_id, graph.external_id, graph.instance_kind,',
          "  CASE WHEN asset.asset_id IS NOT NULL THEN 'asset'",
          "    WHEN series.time_series_id IS NOT NULL THEN 'timeSeries'",
          "    WHEN document.document_id IS NOT NULL THEN 'document' ELSE NULL END AS entity_type",
          'FROM odf.graph_instances AS graph',
          'LEFT JOIN odf.assets AS asset ON asset.asset_id = graph.instance_id',
          'LEFT JOIN odf.time_series AS series ON series.time_series_id = graph.instance_id',
          'LEFT JOIN odf.documents AS document ON document.document_id = graph.instance_id',
          'WHERE graph.tenant_id = $1::uuid AND graph.project_id = $2::uuid',
          '  AND graph.space_id = $3::uuid AND graph.external_id = ANY($4::text[])',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, modelSpaceId, externalIds],
      });
      for (const row of existing.rows) {
        const externalId = String(row.external_id);
        const expectedType = requested.get(externalId)!;
        const storedType = row.entity_type === null || row.entity_type === undefined
          ? null
          : String(row.entity_type) as EntityType;
        if (row.instance_kind !== 'node' || (storedType && storedType !== expectedType)) {
          throw new ConflictError(`External ID '${externalId}' already belongs to a different graph entity type`);
        }
        resolved.set(`${expectedType}\u0000${externalId}`, String(row.instance_id));
      }
    }
    return (type, externalId) => (
      resolved.get(`${type}\u0000${externalId}`) ?? entityUuid(scope, type, externalId)
    );
  }

  private async upsertRawArchive(
    transaction: ScopedTransaction,
    scope: IndustrialRequestScope,
    sourceConnectionId: string,
    sourceExternalId: string,
    archive?: IndustrialRawArchive,
  ): Promise<string | null> {
    if (!archive) return null;
    const proposedRawObjectId = deterministicUuid(
      'odf-industrial-raw',
      scope.tenantId,
      scope.projectId,
      sourceExternalId,
      archive.sha256,
    );
    const inserted = await transaction.query({
      text: [
        'INSERT INTO odf.raw_ingest_objects',
        '  (raw_object_id, tenant_id, project_id, source_connection_id, storage_uri, content_sha256, content_type, byte_size, metadata)',
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::bigint, '{}'::jsonb)",
        'ON CONFLICT (tenant_id, source_connection_id, content_sha256) DO NOTHING',
        'RETURNING raw_object_id',
      ].join('\n'),
      values: [proposedRawObjectId, scope.tenantId, scope.projectId, sourceConnectionId, archive.storageUri, archive.sha256, archive.contentType, archive.byteSize],
    });
    if (inserted.rows[0]) return String(inserted.rows[0].raw_object_id);

    // A separate statement receives a fresh READ COMMITTED snapshot after a
    // conflicting concurrent insert commits. A single CTE/UNION statement can
    // observe the unique conflict but still miss that row in its old snapshot.
    const existing = await transaction.query({
      text: [
        'SELECT raw_object_id FROM odf.raw_ingest_objects',
        'WHERE tenant_id = $1::uuid AND project_id = $2::uuid',
        '  AND source_connection_id = $3::uuid AND content_sha256 = $4',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, sourceConnectionId, archive.sha256],
    });
    if (!existing.rows[0]) throw new NotFoundError('Raw ingest object could not be resolved');
    return String(existing.rows[0].raw_object_id);
  }

  private async upsertAssets(transaction: ScopedTransaction, scope: IndustrialRequestScope, bundle: IngestBundle, entityId: EntityIdResolver): Promise<void> {
    const rows = bundle.assets.map((item) => ({
      id: entityId('asset', item.externalId),
      parent_id: item.parentExternalId ? entityId('asset', item.parentExternalId) : null,
      parent_set: item.parentExternalId !== undefined,
      kind: assetKind(item.type), type: item.type, name: item.name, description: item.description ?? null,
      metadata: item.metadata ?? {}, source_system: bundle.source.system,
    }));
    await transaction.query({
      text: [
        'INSERT INTO odf.assets (asset_id, tenant_id, project_id, parent_asset_id, asset_kind, asset_type, name, description, source_system, metadata)',
        'SELECT item.id::uuid, $1::uuid, $2::uuid, NULL, item.kind, item.type, item.name, item.description, item.source_system, item.metadata',
        'FROM jsonb_to_recordset($3::jsonb) AS item(id text, parent_id text, kind text, type text, name text, description text, source_system text, metadata jsonb)',
        'ON CONFLICT (asset_id) DO UPDATE SET asset_kind = EXCLUDED.asset_kind, asset_type = EXCLUDED.asset_type, name = EXCLUDED.name,',
        '  description = EXCLUDED.description, source_system = EXCLUDED.source_system, metadata = EXCLUDED.metadata, updated_at = now()',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
    await transaction.query({
      text: [
        'UPDATE odf.assets AS asset SET parent_asset_id = item.parent_id::uuid, updated_at = now()',
        'FROM jsonb_to_recordset($3::jsonb) AS item(id text, parent_id text, parent_set boolean)',
        'WHERE asset.tenant_id = $1::uuid AND asset.project_id = $2::uuid AND asset.asset_id = item.id::uuid AND item.parent_set',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
    const cycle = await transaction.query({
      text: [
        'WITH RECURSIVE walk(root, node, parent, path, cycle) AS (',
        '  SELECT asset_id, asset_id, parent_asset_id, ARRAY[asset_id], false FROM odf.assets',
        '  WHERE tenant_id = $1::uuid AND project_id = $2::uuid',
        '  UNION ALL',
        '  SELECT walk.root, parent.asset_id, parent.parent_asset_id, walk.path || parent.asset_id, parent.asset_id = ANY(walk.path)',
        '  FROM walk JOIN odf.assets AS parent ON parent.asset_id = walk.parent',
        '  WHERE NOT walk.cycle AND parent.tenant_id = $1::uuid AND parent.project_id = $2::uuid',
        ') SELECT root FROM walk WHERE cycle LIMIT 1',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId],
    });
    if (cycle.rows[0]) throw new ConflictError('Asset hierarchy contains a cycle');
  }

  private async upsertSeries(transaction: ScopedTransaction, scope: IndustrialRequestScope, bundle: IngestBundle, entityId: EntityIdResolver): Promise<void> {
    const rows = bundle.timeSeries.map((item) => ({
      id: entityId('timeSeries', item.externalId), asset_id: entityId('asset', item.assetExternalId),
      name: item.name, unit: item.unit ?? null, source_system: bundle.source.system, metadata: item.metadata ?? {},
    }));
    await transaction.query({
      text: [
        'INSERT INTO odf.time_series (time_series_id, tenant_id, project_id, asset_id, name, unit, value_type, interpolation, source_system, metadata)',
        "SELECT item.id::uuid, $1::uuid, $2::uuid, item.asset_id::uuid, item.name, item.unit, 'numeric', 'linear', item.source_system, item.metadata",
        'FROM jsonb_to_recordset($3::jsonb) AS item(id text, asset_id text, name text, unit text, source_system text, metadata jsonb)',
        'ON CONFLICT (time_series_id) DO UPDATE SET asset_id = EXCLUDED.asset_id, name = EXCLUDED.name, unit = EXCLUDED.unit,',
        '  source_system = EXCLUDED.source_system, metadata = EXCLUDED.metadata, updated_at = now()',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
  }

  private async upsertPoints(transaction: ScopedTransaction, scope: IndustrialRequestScope, bundle: IngestBundle, sourceConnectionId: string, ingestionRunId: string, entityId: EntityIdResolver): Promise<void> {
    for (const point of bundle.dataPoints) {
      if (!Number.isSafeInteger(point.timestamp) || Math.abs(point.timestamp) > MAX_JAVASCRIPT_DATE_MS) {
        throw new ConflictError('Telemetry timestamps must be integer epoch milliseconds in the JavaScript Date range');
      }
    }
    const rows = bundle.dataPoints.map((point) => ({
      time_series_id: entityId('timeSeries', point.timeSeriesExternalId), timestamp_ms: point.timestamp,
      numeric_value: point.value, quality: point.quality,
    }));
    if (rows.length === 0) return;
    await transaction.query({
      text: [
        'INSERT INTO odf.time_series_points',
        '  (tenant_id, project_id, time_series_id, observed_at, numeric_value, quality, source_connection_id, ingestion_run_id)',
        'SELECT $1::uuid, $2::uuid, point.time_series_id::uuid, to_timestamp(point.timestamp_ms / 1000.0),',
        '  point.numeric_value, point.quality, $3::uuid, $4::uuid',
        'FROM jsonb_to_recordset($5::jsonb) AS point(time_series_id text, timestamp_ms double precision, numeric_value double precision, quality text)',
        'ON CONFLICT (time_series_id, observed_at, sequence) DO NOTHING',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, sourceConnectionId, ingestionRunId, json(rows)],
    });
    // Verify in a new statement snapshot. This catches both a concurrently
    // committed different value and contradictory duplicates in one bundle;
    // throwing here rolls back every point inserted by the transaction.
    const result = await transaction.query({
      text: [
        'WITH incoming_points AS MATERIALIZED (',
        '  SELECT point.time_series_id::uuid AS time_series_id,',
        '    to_timestamp(point.timestamp_ms / 1000.0) AS observed_at,',
        '    point.numeric_value, point.quality',
        '  FROM jsonb_to_recordset($3::jsonb) AS point(time_series_id text, timestamp_ms double precision, numeric_value double precision, quality text)',
        ') SELECT count(*)::bigint AS expected_count,',
        '  count(existing.time_series_id) FILTER (',
        '    WHERE existing.numeric_value IS NOT DISTINCT FROM incoming.numeric_value',
        '      AND existing.quality IS NOT DISTINCT FROM incoming.quality',
        '  )::bigint AS accepted_count',
        'FROM incoming_points AS incoming',
        'LEFT JOIN odf.time_series_points AS existing',
        '  ON existing.tenant_id = $1::uuid AND existing.project_id = $2::uuid',
        ' AND existing.time_series_id = incoming.time_series_id',
        ' AND existing.observed_at = incoming.observed_at AND existing.sequence = 0',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
    const counts = result.rows[0];
    if (!counts || numberValue(counts.expected_count) !== numberValue(counts.accepted_count)) {
      throw new ConflictError('An immutable telemetry point already exists with a different value');
    }
  }

  private async upsertDocuments(transaction: ScopedTransaction, scope: IndustrialRequestScope, bundle: IngestBundle, rawObjectId: string | null, entityId: EntityIdResolver): Promise<void> {
    const rows = bundle.documents.map((item) => ({
      id: entityId('document', item.externalId), asset_id: item.assetExternalId ? entityId('asset', item.assetExternalId) : null,
      title: item.title, mime_type: item.mimeType ?? null, uri: item.uri ?? null, source_system: bundle.source.system, metadata: item.metadata ?? {},
    }));
    await transaction.query({
      text: [
        'INSERT INTO odf.documents (document_id, tenant_id, project_id, raw_object_id, title, mime_type, storage_uri, source_system, metadata)',
        'SELECT item.id::uuid, $1::uuid, $2::uuid, $3::uuid, item.title, item.mime_type, item.uri, item.source_system, item.metadata',
        'FROM jsonb_to_recordset($4::jsonb) AS item(id text, asset_id text, title text, mime_type text, uri text, source_system text, metadata jsonb)',
        'ON CONFLICT (document_id) DO UPDATE SET raw_object_id = EXCLUDED.raw_object_id, title = EXCLUDED.title, mime_type = EXCLUDED.mime_type,',
        '  storage_uri = EXCLUDED.storage_uri, source_system = EXCLUDED.source_system, metadata = EXCLUDED.metadata, updated_at = now()',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, rawObjectId, json(rows)],
    });
    await transaction.query({
      text: [
        'DELETE FROM odf.document_asset_links AS link',
        'USING jsonb_to_recordset($3::jsonb) AS item(id text, asset_id text)',
        "WHERE link.tenant_id = $1::uuid AND link.project_id = $2::uuid AND link.document_id = item.id::uuid",
        "  AND link.relation_type = 'documents'",
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
    await transaction.query({
      text: [
        'INSERT INTO odf.document_asset_links (tenant_id, project_id, document_id, asset_id, relation_type)',
        "SELECT $1::uuid, $2::uuid, item.id::uuid, item.asset_id::uuid, 'documents'",
        'FROM jsonb_to_recordset($3::jsonb) AS item(id text, asset_id text)',
        'WHERE item.asset_id IS NOT NULL',
        'ON CONFLICT (document_id, asset_id, relation_type) DO NOTHING',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
  }

  private async upsertRelations(transaction: ScopedTransaction, scope: IndustrialRequestScope, bundle: IngestBundle, entityId: EntityIdResolver): Promise<void> {
    if (bundle.relations.length === 0) return;
    const semanticKeys = new Set<string>();
    for (const relation of bundle.relations) {
      if (
        relation.sourceType === relation.targetType
        && relation.sourceExternalId === relation.targetExternalId
      ) {
        throw new ConflictError('Relation source and target must be different entities');
      }
      const key = canonical([
        relation.sourceType,
        relation.sourceExternalId,
        relation.targetType,
        relation.targetExternalId,
        relation.relationType,
      ]);
      if (semanticKeys.has(key)) {
        throw new ConflictError('A bundle cannot contain duplicate semantic relations');
      }
      semanticKeys.add(key);
    }
    const rows = bundle.relations.map((item) => ({
      id: relationUuid(scope, industrialRelationExternalId(item)), external_id: industrialRelationExternalId(item),
      source_id: entityId(item.sourceType, item.sourceExternalId),
      target_id: entityId(item.targetType, item.targetExternalId),
      relation_type: item.relationType, status: item.status, confidence: item.confidence ?? null,
      evidence: { payload: item.evidence, confidence: item.confidence ?? null, ruleVersion: item.ruleVersion ?? null },
      candidate_evidence: [{ payload: item.evidence }], rule_version: item.ruleVersion ?? null,
      source_system: bundle.source.system, reviewer: bundle.source.actor,
      lock_key: canonical([
        'odf-industrial-relation',
        scope.tenantId,
        scope.projectId,
        entityId(item.sourceType, item.sourceExternalId),
        entityId(item.targetType, item.targetExternalId),
        item.relationType,
      ]),
    }));
    await transaction.query({
      text: [
        'WITH relation_locks AS MATERIALIZED (',
        '  SELECT DISTINCT item.lock_key',
        '  FROM jsonb_to_recordset($1::jsonb) AS item(lock_key text)',
        ') SELECT pg_advisory_xact_lock(hashtextextended(relation_locks.lock_key, 0))',
        'FROM relation_locks ORDER BY relation_locks.lock_key',
      ].join('\n'),
      values: [json(rows)],
    });
    await transaction.query({
      text: [
        'WITH incoming AS (',
        '  SELECT * FROM jsonb_to_recordset($3::jsonb) AS item(source_id text, target_id text, relation_type text)',
        ') SELECT candidate.relation_candidate_id',
        'FROM incoming JOIN odf.relation_candidates AS candidate',
        '  ON candidate.tenant_id = $1::uuid AND candidate.project_id = $2::uuid',
        ' AND candidate.source_instance_id = incoming.source_id::uuid',
        ' AND candidate.target_instance_id = incoming.target_id::uuid',
        ' AND candidate.relation_type = incoming.relation_type',
        'FOR UPDATE',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
    const conflicts = await transaction.query({
      text: [
        'WITH incoming AS (',
        '  SELECT * FROM jsonb_to_recordset($3::jsonb) AS item(',
        '    id text, external_id text, source_id text, target_id text, relation_type text, status text',
        '  )',
        '), terminal_candidates AS (',
        '  SELECT incoming.external_id, candidate.state AS existing_state, incoming.status AS incoming_state',
        '  FROM incoming JOIN odf.relation_candidates AS candidate',
        '    ON candidate.tenant_id = $1::uuid AND candidate.project_id = $2::uuid',
        '   AND (candidate.relation_candidate_id = incoming.id::uuid OR (',
        '     candidate.source_instance_id = incoming.source_id::uuid',
        '     AND candidate.target_instance_id = incoming.target_id::uuid',
        '     AND candidate.relation_type = incoming.relation_type',
        '   ))',
        '  WHERE candidate.relation_candidate_id <> incoming.id::uuid',
        '    OR candidate.source_instance_id <> incoming.source_id::uuid',
        '      OR candidate.target_instance_id <> incoming.target_id::uuid',
        '      OR candidate.relation_type <> incoming.relation_type',
        "      OR candidate.state <> 'proposed'",
        '), terminal_relations AS (',
        '  SELECT incoming.external_id, relation.state AS existing_state, incoming.status AS incoming_state',
        '  FROM incoming JOIN odf.relations AS relation',
        '    ON relation.project_id = $2::uuid',
        '   AND (relation.relation_id = incoming.id::uuid OR (',
        '     relation.source_instance_id = incoming.source_id::uuid',
        '     AND relation.target_instance_id = incoming.target_id::uuid',
        '     AND relation.relation_type = incoming.relation_type',
        '   ))',
        '  WHERE relation.tenant_id = $1::uuid',
        '    AND (relation.source_instance_id <> incoming.source_id::uuid',
        '      OR relation.target_instance_id <> incoming.target_id::uuid',
        '      OR relation.relation_type <> incoming.relation_type',
        "      OR relation.state IN ('accepted', 'superseded') OR relation.relation_id <> incoming.id::uuid)",
        ') SELECT * FROM terminal_candidates UNION ALL SELECT * FROM terminal_relations LIMIT 1',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
    if (conflicts.rows[0]) {
      const conflict = conflicts.rows[0];
      throw new ConflictError(
        `Relation '${String(conflict.external_id)}' cannot transition from ${String(conflict.existing_state)} to ${String(conflict.incoming_state)}`,
      );
    }
    await transaction.query({
      text: [
        'INSERT INTO odf.relations (relation_id, tenant_id, project_id, source_instance_id, target_instance_id, relation_type, state, source_system, evidence)',
        "SELECT item.id::uuid, $1::uuid, $2::uuid, item.source_id::uuid, item.target_id::uuid, item.relation_type, 'accepted', item.source_system, item.evidence",
        'FROM jsonb_to_recordset($3::jsonb) AS item(id text, source_id text, target_id text, relation_type text, status text, source_system text, evidence jsonb)',
        "WHERE item.status = 'accepted'",
        'ON CONFLICT (relation_id) DO NOTHING',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
    await transaction.query({
      text: [
        'INSERT INTO odf.relation_candidates',
        '  (relation_candidate_id, tenant_id, project_id, source_instance_id, target_instance_id, relation_type, confidence, evidence, rule_version, model_version, state, reviewer, reviewed_at, accepted_relation_id)',
        "SELECT item.id::uuid, $1::uuid, $2::uuid, item.source_id::uuid, item.target_id::uuid, item.relation_type, COALESCE(item.confidence, 0),",
        "  item.candidate_evidence, item.rule_version, item.source_system, item.status,",
        "  CASE WHEN item.status = 'accepted' THEN item.reviewer ELSE NULL END,",
        "  CASE WHEN item.status = 'accepted' THEN now() ELSE NULL END,",
        "  CASE WHEN item.status = 'accepted' THEN item.id::uuid ELSE NULL END",
        'FROM jsonb_to_recordset($3::jsonb) AS item(id text, source_id text, target_id text, relation_type text, status text, confidence double precision, candidate_evidence jsonb, rule_version text, source_system text, reviewer text)',
        'ON CONFLICT (relation_candidate_id) DO UPDATE SET source_instance_id = EXCLUDED.source_instance_id, target_instance_id = EXCLUDED.target_instance_id,',
        '  relation_type = EXCLUDED.relation_type, confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,',
        '  rule_version = EXCLUDED.rule_version, model_version = EXCLUDED.model_version, state = EXCLUDED.state,',
        '  reviewer = EXCLUDED.reviewer, reviewed_at = EXCLUDED.reviewed_at, accepted_relation_id = EXCLUDED.accepted_relation_id',
        "WHERE odf.relation_candidates.state = 'proposed'",
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, json(rows)],
    });
  }

  private async insertProvenance(transaction: ScopedTransaction, scope: IndustrialRequestScope, bundle: IngestBundle, ingestionRunId: string, rawObjectId: string | null, entityId: EntityIdResolver): Promise<void> {
    const rows = [
      ...bundle.assets.map((item) => ({ id: entityId('asset', item.externalId), external_id: item.externalId, hash: sha256(item) })),
      ...bundle.timeSeries.map((item) => ({ id: entityId('timeSeries', item.externalId), external_id: item.externalId, hash: sha256(item) })),
      ...bundle.documents.map((item) => ({ id: entityId('document', item.externalId), external_id: item.externalId, hash: sha256(item) })),
      ...bundle.relations.map((item) => ({ id: relationUuid(scope, industrialRelationExternalId(item)), external_id: industrialRelationExternalId(item), hash: sha256(item) })),
    ];
    await transaction.query({
      text: [
        'INSERT INTO odf.provenance_records',
        '  (tenant_id, project_id, instance_id, raw_object_id, ingestion_run_id, source_system, source_record_id, payload_sha256, valid_from, metadata)',
        'SELECT $1::uuid, $2::uuid, item.id::uuid, $3::uuid, $4::uuid, $5, item.external_id, item.hash, now(), $6::jsonb',
        'FROM jsonb_to_recordset($7::jsonb) AS item(id text, external_id text, hash text)',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, rawObjectId, ingestionRunId, bundle.source.system, json({ modelVersion: MODEL_VERSION }), json(rows)],
    });
  }

  private async recordFailedRun(
    scope: IndustrialRequestScope,
    bundle: IngestBundle,
    correlationId: string,
    ingestionRunId: string,
    idempotencyKey: string,
    payloadHash: string,
    counts: Record<string, number>,
    error: unknown,
    archive?: IndustrialRawArchive,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unknown ingestion error';
    try {
      await this.runtime.withTransaction(scope, async (transaction) => {
        const source = await transaction.query({
          text: [
            'SELECT source_connection_id FROM odf.source_connections',
            'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, bundle.source.system],
        });
        let failedRunId = ingestionRunId;
        let failedRawObjectId: string | null = null;
        if (source.rows[0]) {
          failedRawObjectId = await this.upsertRawArchive(
            transaction,
            scope,
            String(source.rows[0].source_connection_id),
            bundle.source.system,
            archive,
          );
          const failed = await transaction.query({
            text: [
              'INSERT INTO odf.ingestion_runs',
              '  (ingestion_run_id, tenant_id, project_id, source_connection_id, raw_object_id, idempotency_key, state, checkpoint_before, completed_at, error_code, error_summary, correlation_id)',
              "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'failed', $7::jsonb, now(), 'INGEST_FAILED', $8, $9::uuid)",
              'ON CONFLICT (tenant_id, source_connection_id, idempotency_key) DO UPDATE SET',
              "  state = 'failed', raw_object_id = EXCLUDED.raw_object_id, completed_at = now(), error_code = 'INGEST_FAILED', error_summary = EXCLUDED.error_summary",
              "WHERE odf.ingestion_runs.state <> 'succeeded'",
              'RETURNING ingestion_run_id',
            ].join('\n'),
            values: [ingestionRunId, scope.tenantId, scope.projectId, source.rows[0].source_connection_id, failedRawObjectId, idempotencyKey, json({ payloadHash }), message.slice(0, 2_000), correlationId],
          });
          failedRunId = String(failed.rows[0]?.ingestion_run_id ?? ingestionRunId);
        }
        await appendPlatformAuditAndOutbox(transaction, {
          actor: bundle.source.actor,
          action: 'ingestion.failed',
          entityType: 'ingestionRun',
          entityId: failedRunId,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          correlationId,
          details: {
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            sourceSystem: bundle.source.system,
            counts,
            error: message.slice(0, 2_000),
            rawObjectId: failedRawObjectId,
            rawSha256: archive?.sha256 ?? null,
            rawStorageUri: archive?.storageUri ?? null,
          },
        });
      });
    } catch {
      // Preserve the original domain/database error if failure evidence itself cannot be written.
    }
  }

  private async fetchAssetByExternalId(transaction: ScopedTransaction, scope: IndustrialRequestScope, externalId: string): Promise<Record<string, unknown> | null> {
    const result = await transaction.query({
      text: [
        'SELECT graph.external_id, asset.name, asset.description, asset.asset_type, parent.external_id AS parent_external_id,',
        '  asset.metadata, asset.source_system, asset.created_at, asset.updated_at',
        'FROM odf.assets AS asset JOIN odf.graph_instances AS graph ON graph.instance_id = asset.asset_id',
        'LEFT JOIN odf.graph_instances AS parent ON parent.instance_id = asset.parent_asset_id',
        'WHERE asset.tenant_id = $1::uuid AND asset.project_id = $2::uuid AND graph.external_id = $3',
        `  AND ${defaultSpacePredicate('graph')}`,
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, externalId],
    });
    return result.rows[0] ? mapAsset(result.rows[0]) : null;
  }

  private async fetchSeries(transaction: ScopedTransaction, scope: IndustrialRequestScope, assetId: string, externalId?: string): Promise<Row[]> {
    const result = await transaction.query({
      text: [
        'SELECT series.time_series_id, graph.external_id, asset_graph.external_id AS asset_external_id, series.name, series.unit,',
        '  graph.properties, series.metadata, series.source_system, series.created_at, series.updated_at',
        'FROM odf.time_series AS series',
        'JOIN odf.graph_instances AS graph ON graph.instance_id = series.time_series_id',
        'JOIN odf.graph_instances AS asset_graph ON asset_graph.instance_id = series.asset_id',
        'WHERE series.tenant_id = $1::uuid AND series.project_id = $2::uuid AND series.asset_id = $3::uuid',
        `  AND ${defaultSpacePredicate('graph')}`,
        "  AND series.value_type = 'numeric'",
        '  AND ($4::text IS NULL OR graph.external_id = $4)',
        'ORDER BY series.name',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, assetId, externalId ?? null],
    });
    return result.rows;
  }

  private async requireTelemetrySeries(transaction: ScopedTransaction, scope: IndustrialRequestScope, assetExternalId: string, seriesExternalId?: string): Promise<{ assetId: string; series: Row[] }> {
    const asset = await transaction.query({
      text: [
        'SELECT asset.asset_id FROM odf.assets AS asset JOIN odf.graph_instances AS graph ON graph.instance_id = asset.asset_id',
        'WHERE asset.tenant_id = $1::uuid AND asset.project_id = $2::uuid AND graph.external_id = $3',
        `  AND ${defaultSpacePredicate('graph')}`,
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, assetExternalId],
    });
    if (!asset.rows[0]) throw new NotFoundError(`Asset '${assetExternalId}' was not found`);
    const assetId = String(asset.rows[0].asset_id);
    const series = await this.fetchSeries(transaction, scope, assetId, seriesExternalId);
    if (seriesExternalId && series.length === 0) {
      throw new NotFoundError(`Time series '${seriesExternalId}' was not found on asset '${assetExternalId}'`);
    }
    return { assetId, series };
  }

  private async fetchRelations(
    transaction: ScopedTransaction,
    scope: IndustrialRequestScope,
    status: 'proposed' | 'accepted' | 'rejected' | 'superseded' | undefined,
    limit: number,
    instanceId?: string,
    relationId?: string,
  ): Promise<Row[]> {
    const result = await transaction.query({
      text: [
        'WITH combined AS (',
        RELATION_SELECT.replaceAll('\n', '\n  '),
        '  WHERE candidate.tenant_id = $1::uuid AND candidate.project_id = $2::uuid',
        `    AND ${defaultSpacePredicate('source_graph')}`,
        `    AND ${defaultSpacePredicate('target_graph')}`,
        '  UNION ALL',
        ACCEPTED_RELATION_SELECT.replaceAll('\n', '\n  '),
        '  WHERE relation.tenant_id = $1::uuid AND relation.project_id = $2::uuid',
        `    AND ${defaultSpacePredicate('source_graph')}`,
        `    AND ${defaultSpacePredicate('target_graph')}`,
        '    AND NOT EXISTS (SELECT 1 FROM odf.relation_candidates AS candidate WHERE candidate.accepted_relation_id = relation.relation_id)',
        ') SELECT * FROM combined',
        'WHERE ($3::text IS NULL OR status = $3)',
        '  AND ($4::uuid IS NULL OR source_instance_id = $4::uuid OR target_instance_id = $4::uuid)',
        '  AND ($5::text IS NULL OR relation_id = $5)',
        'ORDER BY created_at DESC LIMIT $6',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, status ?? null, instanceId ?? null, relationId ?? null, limit],
    });
    return result.rows;
  }
}
