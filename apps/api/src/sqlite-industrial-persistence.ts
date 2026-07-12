import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { ConflictError, DataIntegrityError, NotFoundError } from './database.js';
import { industrialIngestRunId, industrialPayloadHash, industrialRelationExternalId } from './industrial-persistence.js';
import type {
  IndustrialPersistence,
  IndustrialPersistenceHealth,
  IndustrialRawArchive,
  IndustrialRequestScope,
} from './industrial-persistence.js';
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

type SqliteRow = Record<string, unknown>;
type IndustrialEntityType = 'asset' | 'timeSeries' | 'document';
const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asAsset(row: SqliteRow): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    name: String(row.name),
    description: nullableString(row.description),
    type: String(row.type),
    parentExternalId: nullableString(row.parent_external_id),
    metadata: parseJson(row.metadata_json),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asTimeSeries(row: SqliteRow): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    assetExternalId: String(row.asset_external_id),
    name: String(row.name),
    unit: nullableString(row.unit),
    description: nullableString(row.description),
    metadata: parseJson(row.metadata_json),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asDocument(row: SqliteRow): Record<string, unknown> {
  return {
    externalId: String(row.external_id),
    assetExternalId: nullableString(row.asset_external_id),
    title: String(row.title),
    mimeType: nullableString(row.mime_type),
    uri: nullableString(row.uri),
    metadata: parseJson(row.metadata_json),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asRelation(row: SqliteRow): Record<string, unknown> {
  return {
    id: String(row.id),
    source: { type: String(row.source_type), externalId: String(row.source_external_id) },
    target: { type: String(row.target_type), externalId: String(row.target_external_id) },
    type: String(row.relation_type),
    status: String(row.status),
    confidence: Number(row.confidence ?? 0),
    evidence: parseJson(row.evidence_json),
    ruleVersion: nullableString(row.rule_version),
    reviewer: nullableString(row.reviewer),
    reviewComment: nullableString(row.review_comment),
    reviewedAt: nullableString(row.reviewed_at),
    sourceSystem: String(row.source_system),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function asProvenance(row: SqliteRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    sourceSystem: String(row.source_system),
    sourceRecordId: nullableString(row.source_record_id),
    ingestionRunId: String(row.ingestion_run_id),
    rawHash: String(row.raw_hash),
    modelVersion: String(row.model_version),
    validFrom: String(row.valid_from),
    transactionTime: String(row.transaction_time),
    metadata: parseJson(row.metadata_json),
  };
}

function asAudit(row: SqliteRow): Record<string, unknown> {
  return {
    id: Number(row.id),
    timestamp: String(row.timestamp),
    actor: String(row.actor),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: nullableString(row.entity_id),
    details: parseJson(row.details_json),
    correlationId: String(row.correlation_id),
  };
}

/**
 * Tenant/project-isolated SQLite industrial persistence. It deliberately uses
 * its own tables so enabling it never changes or reinterprets legacy demo data.
 */
export class SqliteIndustrialPersistence implements IndustrialPersistence {
  readonly mode = 'sqlite' as const;

  constructor(private readonly database: DatabaseSync) {
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.createSchema();
  }

  async health(): Promise<IndustrialPersistenceHealth> {
    try {
      this.database.prepare('SELECT 1 AS healthy').get();
      return { status: 'ok', mode: 'sqlite', database: null, timestamp: nowIso() };
    } catch {
      return { status: 'degraded', mode: 'sqlite', database: null, timestamp: nowIso() };
    }
  }

  async authorize(
    _scope: IndustrialRequestScope,
    _allowedRoles?: readonly PlatformProjectRole[],
  ): Promise<void> {
    // SQLite project membership is enforced by PlatformCatalog at the API edge.
  }

  async listAssets(scope: IndustrialRequestScope, query: AssetListQuery): Promise<Record<string, unknown>> {
    const conditions = ['tenant_id = ?', 'project_id = ?'];
    const parameters: Array<string | number> = [scope.tenantId, scope.projectId];
    if (query.q) {
      conditions.push(
        "(external_id LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE OR COALESCE(description, '') LIKE ? COLLATE NOCASE)",
      );
      const search = `%${query.q}%`;
      parameters.push(search, search, search);
    }
    if (query.type) {
      conditions.push('type = ? COLLATE NOCASE');
      parameters.push(query.type);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS count FROM industrial_assets ${where}`)
      .get(...parameters) as SqliteRow;
    const rows = this.database
      .prepare(`SELECT * FROM industrial_assets ${where} ORDER BY name COLLATE NOCASE, external_id LIMIT ? OFFSET ?`)
      .all(...parameters, query.limit, query.offset) as SqliteRow[];
    return { items: rows.map(asAsset), total: Number(totalRow.count), limit: query.limit, offset: query.offset };
  }

  async getAsset(scope: IndustrialRequestScope, externalId: string): Promise<Record<string, unknown>> {
    const row = this.database.prepare(`
      SELECT * FROM industrial_assets
      WHERE tenant_id = ? AND project_id = ? AND external_id = ?
    `).get(scope.tenantId, scope.projectId, externalId) as SqliteRow | undefined;
    if (!row) throw new NotFoundError(`Asset '${externalId}' was not found`);

    const parent = row.parent_external_id
      ? this.database.prepare(`
          SELECT * FROM industrial_assets
          WHERE tenant_id = ? AND project_id = ? AND external_id = ?
        `).get(scope.tenantId, scope.projectId, String(row.parent_external_id)) as SqliteRow | undefined
      : undefined;
    const children = this.database.prepare(`
      SELECT * FROM industrial_assets
      WHERE tenant_id = ? AND project_id = ? AND parent_external_id = ?
      ORDER BY name
    `).all(scope.tenantId, scope.projectId, externalId) as SqliteRow[];
    const timeSeries = this.database.prepare(`
      SELECT * FROM industrial_time_series
      WHERE tenant_id = ? AND project_id = ? AND asset_external_id = ?
      ORDER BY name
    `).all(scope.tenantId, scope.projectId, externalId) as SqliteRow[];
    const documents = this.database.prepare(`
      SELECT * FROM industrial_documents
      WHERE tenant_id = ? AND project_id = ? AND asset_external_id = ?
      ORDER BY title
    `).all(scope.tenantId, scope.projectId, externalId) as SqliteRow[];
    const relations = this.database.prepare(`
      SELECT * FROM industrial_relations
      WHERE tenant_id = ? AND project_id = ?
        AND (
          (source_type = 'asset' AND source_external_id = ?)
          OR (target_type = 'asset' AND target_external_id = ?)
        )
      ORDER BY CASE status WHEN 'proposed' THEN 0 ELSE 1 END, created_at DESC
    `).all(scope.tenantId, scope.projectId, externalId, externalId) as SqliteRow[];
    const provenance = this.database.prepare(`
      SELECT * FROM industrial_provenance
      WHERE tenant_id = ? AND project_id = ? AND entity_type = 'asset' AND entity_id = ?
      ORDER BY transaction_time DESC
    `).all(scope.tenantId, scope.projectId, externalId) as SqliteRow[];

    return {
      asset: asAsset(row),
      parent: parent ? asAsset(parent) : null,
      children: children.map(asAsset),
      timeSeries: timeSeries.map(asTimeSeries),
      documents: documents.map(asDocument),
      relations: relations.map(asRelation),
      provenance: provenance.map(asProvenance),
    };
  }

  async getTelemetry(
    scope: IndustrialRequestScope,
    assetExternalId: string,
    query: TelemetryQuery,
  ): Promise<Record<string, unknown>> {
    this.assertAssetExists(scope, assetExternalId);
    const from = query.from ?? Date.now() - 24 * 60 * 60 * 1_000;
    const to = query.to ?? Date.now();
    const seriesRows = this.selectSeries(scope, assetExternalId, query.timeSeriesExternalId);
    this.assertRequestedSeriesExists(assetExternalId, query.timeSeriesExternalId, seriesRows);
    const pointStatement = this.database.prepare(`
      SELECT * FROM (
        SELECT timestamp, value, quality
        FROM industrial_data_points
        WHERE tenant_id = ? AND project_id = ? AND time_series_external_id = ?
          AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp ASC
    `);
    return {
      assetExternalId,
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      series: seriesRows.map((seriesRow) => {
        const points = pointStatement.all(
          scope.tenantId,
          scope.projectId,
          String(seriesRow.external_id),
          from,
          to,
          query.limit,
        ) as SqliteRow[];
        return {
          ...asTimeSeries(seriesRow),
          points: points.map((point) => ({
            timestamp: new Date(Number(point.timestamp)).toISOString(),
            value: Number(point.value),
            quality: String(point.quality),
          })),
        };
      }),
    };
  }

  async getLatestTelemetry(
    scope: IndustrialRequestScope,
    assetExternalId: string,
    query: TelemetryLatestQuery,
  ): Promise<Record<string, unknown>> {
    this.assertAssetExists(scope, assetExternalId);
    const asOf = query.at ?? Date.now();
    const seriesRows = this.selectSeries(scope, assetExternalId, query.timeSeriesExternalId);
    this.assertRequestedSeriesExists(assetExternalId, query.timeSeriesExternalId, seriesRows);
    const latest = this.database.prepare(`
      SELECT timestamp, value, quality FROM industrial_data_points
      WHERE tenant_id = ? AND project_id = ? AND time_series_external_id = ? AND timestamp <= ?
      ORDER BY timestamp DESC LIMIT 1
    `);
    return {
      assetExternalId,
      asOf: new Date(asOf).toISOString(),
      series: seriesRows.map((seriesRow) => {
        const point = latest.get(
          scope.tenantId,
          scope.projectId,
          String(seriesRow.external_id),
          asOf,
        ) as SqliteRow | undefined;
        const mappedPoint = point
          ? {
              timestamp: new Date(Number(point.timestamp)).toISOString(),
              value: Number(point.value),
              quality: String(point.quality),
            }
          : null;
        return {
          ...asTimeSeries(seriesRow),
          point: mappedPoint,
          points: mappedPoint ? [mappedPoint] : [],
        };
      }),
    };
  }

  async getAggregatedTelemetry(
    scope: IndustrialRequestScope,
    assetExternalId: string,
    query: TelemetryAggregateQuery,
  ): Promise<Record<string, unknown>> {
    this.assertAssetExists(scope, assetExternalId);
    const from = query.from ?? Date.now() - 24 * 60 * 60 * 1_000;
    const to = query.to ?? Date.now();
    const seriesRows = this.selectSeries(scope, assetExternalId, query.timeSeriesExternalId);
    this.assertRequestedSeriesExists(assetExternalId, query.timeSeriesExternalId, seriesRows);
    const aggregate = this.database.prepare(`
      WITH filtered AS (
        SELECT timestamp, value, quality, CAST(timestamp / ? AS INTEGER) * ? AS bucket_start
        FROM industrial_data_points
        WHERE tenant_id = ? AND project_id = ? AND time_series_external_id = ?
          AND timestamp >= ? AND timestamp <= ?
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY timestamp ASC) AS first_rank,
          ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY timestamp DESC) AS last_rank
        FROM filtered
      )
      SELECT * FROM (
        SELECT bucket_start, COUNT(*) AS point_count, AVG(value) AS average_value,
          MIN(value) AS minimum_value, MAX(value) AS maximum_value, SUM(value) AS sum_value,
          MAX(CASE WHEN first_rank = 1 THEN timestamp END) AS first_timestamp,
          MAX(CASE WHEN first_rank = 1 THEN value END) AS first_value,
          MAX(CASE WHEN last_rank = 1 THEN timestamp END) AS last_timestamp,
          MAX(CASE WHEN last_rank = 1 THEN value END) AS last_value,
          CASE
            WHEN SUM(CASE WHEN quality = 'bad' THEN 1 ELSE 0 END) > 0 THEN 'bad'
            WHEN SUM(CASE WHEN quality = 'uncertain' THEN 1 ELSE 0 END) > 0 THEN 'uncertain'
            ELSE 'good'
          END AS quality
        FROM ranked GROUP BY bucket_start ORDER BY bucket_start DESC LIMIT ?
      ) ORDER BY bucket_start ASC
    `);
    const valueFor = (row: SqliteRow): number => {
      switch (query.aggregation) {
        case 'min': return Number(row.minimum_value);
        case 'max': return Number(row.maximum_value);
        case 'sum': return Number(row.sum_value);
        case 'count': return Number(row.point_count);
        default: return Number(row.average_value);
      }
    };
    return {
      assetExternalId,
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      bucketMs: query.bucketMs,
      aggregation: query.aggregation,
      series: seriesRows.map((seriesRow) => {
        const rows = aggregate.all(
          query.bucketMs,
          query.bucketMs,
          scope.tenantId,
          scope.projectId,
          String(seriesRow.external_id),
          from,
          to,
          query.limit,
        ) as SqliteRow[];
        const buckets = rows.map((row) => ({
          timestamp: new Date(Number(row.bucket_start)).toISOString(),
          endTimestamp: new Date(Math.min(Number(row.bucket_start) + query.bucketMs, to)).toISOString(),
          value: valueFor(row),
          count: Number(row.point_count),
          min: Number(row.minimum_value),
          max: Number(row.maximum_value),
          avg: Number(row.average_value),
          sum: Number(row.sum_value),
          first: {
            timestamp: new Date(Number(row.first_timestamp)).toISOString(),
            value: Number(row.first_value),
          },
          last: {
            timestamp: new Date(Number(row.last_timestamp)).toISOString(),
            value: Number(row.last_value),
          },
          quality: String(row.quality),
        }));
        return { ...asTimeSeries(seriesRow), buckets, points: buckets };
      }),
    };
  }

  async ingest(
    scope: IndustrialRequestScope,
    bundle: IngestBundle,
    correlationId: string,
    archive?: IndustrialRawArchive,
  ): Promise<Record<string, unknown>> {
    const runId = industrialIngestRunId(bundle);
    const payloadHash = industrialPayloadHash(bundle);
    const counts = {
      assets: bundle.assets.length,
      timeSeries: bundle.timeSeries.length,
      dataPoints: bundle.dataPoints.length,
      documents: bundle.documents.length,
      relations: bundle.relations.length,
    };
    const startedAt = nowIso();
    let transactionActive = false;

    try {
      this.database.exec('BEGIN IMMEDIATE');
      transactionActive = true;
      const prior = this.database.prepare(`
        SELECT * FROM industrial_ingestion_runs
        WHERE tenant_id = ? AND project_id = ? AND run_id = ?
      `).get(scope.tenantId, scope.projectId, runId) as SqliteRow | undefined;
      if (prior && String(prior.payload_hash) !== payloadHash) {
        this.database.exec('ROLLBACK');
        transactionActive = false;
        throw new ConflictError(`Ingestion run '${runId}' was already used with a different payload`);
      }
      if (prior?.status === 'completed') {
        this.database.exec('COMMIT');
        transactionActive = false;
        return { runId, status: 'already_processed', counts: parseJson(prior.counts_json) };
      }

      this.database.prepare(`
        INSERT INTO industrial_ingestion_runs(
          tenant_id, project_id, run_id, source_system, status, payload_hash, counts_json,
          error_message, raw_storage_uri, raw_sha256, raw_byte_size, raw_content_type,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'processing', ?, ?, NULL, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(tenant_id, project_id, run_id) DO UPDATE SET
          source_system = excluded.source_system,
          status = 'processing',
          payload_hash = excluded.payload_hash,
          counts_json = excluded.counts_json,
          error_message = NULL,
          raw_storage_uri = excluded.raw_storage_uri,
          raw_sha256 = excluded.raw_sha256,
          raw_byte_size = excluded.raw_byte_size,
          raw_content_type = excluded.raw_content_type,
          started_at = excluded.started_at,
          completed_at = NULL
      `).run(
        scope.tenantId,
        scope.projectId,
        runId,
        bundle.source.system,
        payloadHash,
        JSON.stringify(counts),
        archive?.storageUri ?? null,
        archive?.sha256 ?? null,
        archive?.byteSize ?? null,
        archive?.contentType ?? null,
        startedAt,
      );

      this.ingestAssets(scope, bundle, runId, startedAt);
      this.ingestTimeSeries(scope, bundle, runId, startedAt);
      this.ingestDataPoints(scope, bundle, runId);
      this.ingestDocuments(scope, bundle, runId, startedAt);
      this.ingestRelations(scope, bundle, runId, startedAt);

      const completedAt = nowIso();
      this.database.prepare(`
        UPDATE industrial_ingestion_runs
        SET status = 'completed', completed_at = ?
        WHERE tenant_id = ? AND project_id = ? AND run_id = ?
      `).run(completedAt, scope.tenantId, scope.projectId, runId);
      this.insertAudit(
        scope,
        bundle.source.actor,
        'ingestion.completed',
        'ingestionRun',
        runId,
        { sourceSystem: bundle.source.system, counts, payloadHash },
        correlationId,
        completedAt,
      );
      this.database.exec('COMMIT');
      transactionActive = false;
      return { runId, status: 'completed', counts, completedAt };
    } catch (error) {
      if (!transactionActive) throw error;
      this.database.exec('ROLLBACK');
      transactionActive = false;
      if (error instanceof ConflictError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown ingestion error';
      this.recordFailedIngestion(scope, bundle, runId, payloadHash, counts, message, correlationId, startedAt, archive);
      throw error;
    }
  }

  async listRelations(
    scope: IndustrialRequestScope,
    status: 'proposed' | 'accepted' | 'rejected' | 'superseded' | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    const rows = status
      ? this.database.prepare(`
          SELECT * FROM industrial_relations
          WHERE tenant_id = ? AND project_id = ? AND status = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(scope.tenantId, scope.projectId, status, limit) as SqliteRow[]
      : this.database.prepare(`
          SELECT * FROM industrial_relations
          WHERE tenant_id = ? AND project_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(scope.tenantId, scope.projectId, limit) as SqliteRow[];
    return { items: rows.map(asRelation), total: rows.length, limit };
  }

  async reviewRelation(
    scope: IndustrialRequestScope,
    id: string,
    review: RelationReview,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare(`
        SELECT * FROM industrial_relations
        WHERE tenant_id = ? AND project_id = ? AND id = ?
      `).get(scope.tenantId, scope.projectId, id) as SqliteRow | undefined;
      if (!current) throw new NotFoundError(`Relation '${id}' was not found`);
      if (current.status !== 'proposed') {
        throw new ConflictError(`Relation '${id}' has already been ${String(current.status)}`);
      }
      const reviewedAt = nowIso();
      this.database.prepare(`
        UPDATE industrial_relations
        SET status = ?, reviewer = ?, review_comment = ?, reviewed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND project_id = ? AND id = ?
      `).run(
        review.decision,
        review.reviewer,
        review.comment ?? null,
        reviewedAt,
        reviewedAt,
        scope.tenantId,
        scope.projectId,
        id,
      );
      this.insertAudit(
        scope,
        review.reviewer,
        `relation.${review.decision}`,
        'relation',
        id,
        { previousStatus: 'proposed', decision: review.decision, comment: review.comment ?? null },
        correlationId,
        reviewedAt,
      );
      const updated = this.database.prepare(`
        SELECT * FROM industrial_relations
        WHERE tenant_id = ? AND project_id = ? AND id = ?
      `).get(scope.tenantId, scope.projectId, id) as SqliteRow;
      this.database.exec('COMMIT');
      return asRelation(updated);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async listAudit(scope: IndustrialRequestScope, query: AuditListQuery): Promise<Record<string, unknown>> {
    const conditions = ['tenant_id = ?', 'project_id = ?'];
    const parameters: Array<string | number> = [scope.tenantId, scope.projectId];
    if (query.action) {
      conditions.push('action = ?');
      parameters.push(query.action);
    }
    if (query.entityType) {
      conditions.push('entity_type = ?');
      parameters.push(query.entityType);
    }
    if (query.entityId) {
      conditions.push('entity_id = ?');
      parameters.push(query.entityId);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;
    const totalRow = this.database
      .prepare(`SELECT COUNT(*) AS count FROM industrial_audit ${where}`)
      .get(...parameters) as SqliteRow;
    const rows = this.database
      .prepare(`SELECT * FROM industrial_audit ${where} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, query.limit, query.offset) as SqliteRow[];
    return { items: rows.map(asAudit), total: Number(totalRow.count), limit: query.limit, offset: query.offset };
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS industrial_assets (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        parent_external_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, external_id),
        FOREIGN KEY(tenant_id, project_id, parent_external_id)
          REFERENCES industrial_assets(tenant_id, project_id, external_id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        CHECK(parent_external_id IS NULL OR parent_external_id <> external_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_assets_parent_idx
        ON industrial_assets(tenant_id, project_id, parent_external_id);
      CREATE INDEX IF NOT EXISTS industrial_assets_type_idx
        ON industrial_assets(tenant_id, project_id, type);
      CREATE INDEX IF NOT EXISTS industrial_assets_name_idx
        ON industrial_assets(tenant_id, project_id, name);

      CREATE TABLE IF NOT EXISTS industrial_time_series (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        asset_external_id TEXT NOT NULL,
        name TEXT NOT NULL,
        unit TEXT,
        description TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, external_id),
        FOREIGN KEY(tenant_id, project_id, asset_external_id)
          REFERENCES industrial_assets(tenant_id, project_id, external_id)
          ON UPDATE CASCADE ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_time_series_asset_idx
        ON industrial_time_series(tenant_id, project_id, asset_external_id);

      CREATE TABLE IF NOT EXISTS industrial_data_points (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        time_series_external_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        value REAL NOT NULL,
        quality TEXT NOT NULL DEFAULT 'good' CHECK(quality IN ('good', 'uncertain', 'bad')),
        source_system TEXT NOT NULL,
        ingestion_run_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, time_series_external_id, timestamp),
        FOREIGN KEY(tenant_id, project_id, time_series_external_id)
          REFERENCES industrial_time_series(tenant_id, project_id, external_id)
          ON UPDATE CASCADE ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_data_points_timestamp_idx
        ON industrial_data_points(tenant_id, project_id, timestamp);

      CREATE TABLE IF NOT EXISTS industrial_documents (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        asset_external_id TEXT,
        title TEXT NOT NULL,
        mime_type TEXT,
        uri TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, external_id),
        FOREIGN KEY(tenant_id, project_id, asset_external_id)
          REFERENCES industrial_assets(tenant_id, project_id, external_id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_documents_asset_idx
        ON industrial_documents(tenant_id, project_id, asset_external_id);

      CREATE TABLE IF NOT EXISTS industrial_relations (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('asset', 'timeSeries', 'document')),
        source_external_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK(target_type IN ('asset', 'timeSeries', 'document')),
        target_external_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed', 'accepted', 'rejected', 'superseded')),
        confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
        rule_version TEXT,
        reviewer TEXT,
        review_comment TEXT,
        reviewed_at TEXT,
        source_system TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, id),
        CHECK(source_type <> target_type OR source_external_id <> target_external_id),
        UNIQUE(tenant_id, project_id, source_type, source_external_id, target_type, target_external_id, relation_type)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_relations_source_idx
        ON industrial_relations(tenant_id, project_id, source_type, source_external_id);
      CREATE INDEX IF NOT EXISTS industrial_relations_target_idx
        ON industrial_relations(tenant_id, project_id, target_type, target_external_id);
      CREATE INDEX IF NOT EXISTS industrial_relations_status_idx
        ON industrial_relations(tenant_id, project_id, status);

      CREATE TABLE IF NOT EXISTS industrial_ingestion_runs (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
        payload_hash TEXT NOT NULL,
        counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(counts_json)),
        error_message TEXT,
        raw_storage_uri TEXT,
        raw_sha256 TEXT,
        raw_byte_size INTEGER CHECK(raw_byte_size IS NULL OR raw_byte_size >= 0),
        raw_content_type TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY(tenant_id, project_id, run_id),
        CHECK(
          (raw_storage_uri IS NULL AND raw_sha256 IS NULL AND raw_byte_size IS NULL AND raw_content_type IS NULL)
          OR
          (raw_storage_uri IS NOT NULL AND raw_sha256 IS NOT NULL AND raw_byte_size IS NOT NULL AND raw_content_type IS NOT NULL)
        )
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_ingestion_runs_status_idx
        ON industrial_ingestion_runs(tenant_id, project_id, status, started_at);

      CREATE TABLE IF NOT EXISTS industrial_provenance (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        id INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        source_record_id TEXT,
        ingestion_run_id TEXT NOT NULL,
        raw_hash TEXT NOT NULL,
        model_version TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        transaction_time TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        PRIMARY KEY(tenant_id, project_id, id),
        FOREIGN KEY(tenant_id, project_id, ingestion_run_id)
          REFERENCES industrial_ingestion_runs(tenant_id, project_id, run_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_provenance_entity_idx
        ON industrial_provenance(tenant_id, project_id, entity_type, entity_id, transaction_time DESC);
      CREATE INDEX IF NOT EXISTS industrial_provenance_run_idx
        ON industrial_provenance(tenant_id, project_id, ingestion_run_id);

      CREATE TABLE IF NOT EXISTS industrial_audit (
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        id INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
        correlation_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS industrial_audit_timestamp_idx
        ON industrial_audit(tenant_id, project_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS industrial_audit_entity_idx
        ON industrial_audit(tenant_id, project_id, entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS industrial_audit_action_idx
        ON industrial_audit(tenant_id, project_id, action);
    `);
  }

  private selectSeries(
    scope: IndustrialRequestScope,
    assetExternalId: string,
    timeSeriesExternalId: string | undefined,
  ): SqliteRow[] {
    return timeSeriesExternalId
      ? this.database.prepare(`
          SELECT * FROM industrial_time_series
          WHERE tenant_id = ? AND project_id = ? AND asset_external_id = ? AND external_id = ?
          ORDER BY name
        `).all(scope.tenantId, scope.projectId, assetExternalId, timeSeriesExternalId) as SqliteRow[]
      : this.database.prepare(`
          SELECT * FROM industrial_time_series
          WHERE tenant_id = ? AND project_id = ? AND asset_external_id = ?
          ORDER BY name
        `).all(scope.tenantId, scope.projectId, assetExternalId) as SqliteRow[];
  }

  private assertRequestedSeriesExists(
    assetExternalId: string,
    requestedSeries: string | undefined,
    rows: SqliteRow[],
  ): void {
    if (requestedSeries && rows.length === 0) {
      throw new NotFoundError(`Time series '${requestedSeries}' was not found on asset '${assetExternalId}'`);
    }
  }

  private assertAssetExists(scope: IndustrialRequestScope, externalId: string): void {
    const row = this.database.prepare(`
      SELECT 1 AS found FROM industrial_assets
      WHERE tenant_id = ? AND project_id = ? AND external_id = ?
    `).get(scope.tenantId, scope.projectId, externalId);
    if (!row) throw new NotFoundError(`Asset '${externalId}' was not found`);
  }

  private assertEntityExists(scope: IndustrialRequestScope, type: IndustrialEntityType, externalId: string): void {
    const table = type === 'asset'
      ? 'industrial_assets'
      : type === 'timeSeries'
        ? 'industrial_time_series'
        : 'industrial_documents';
    const row = this.database.prepare(`
      SELECT 1 AS found FROM ${table}
      WHERE tenant_id = ? AND project_id = ? AND external_id = ?
    `).get(scope.tenantId, scope.projectId, externalId);
    if (!row) throw new DataIntegrityError(`${type} '${externalId}' referenced by a relation does not exist`);
  }

  private assertExternalIdType(scope: IndustrialRequestScope, type: IndustrialEntityType, externalId: string): void {
    const existing = this.database.prepare(`
      SELECT entity_type FROM (
        SELECT 'asset' AS entity_type FROM industrial_assets
          WHERE tenant_id = ? AND project_id = ? AND external_id = ?
        UNION ALL
        SELECT 'timeSeries' AS entity_type FROM industrial_time_series
          WHERE tenant_id = ? AND project_id = ? AND external_id = ?
        UNION ALL
        SELECT 'document' AS entity_type FROM industrial_documents
          WHERE tenant_id = ? AND project_id = ? AND external_id = ?
      ) LIMIT 1
    `).get(
      scope.tenantId, scope.projectId, externalId,
      scope.tenantId, scope.projectId, externalId,
      scope.tenantId, scope.projectId, externalId,
    ) as SqliteRow | undefined;
    if (existing && existing.entity_type !== type) {
      throw new ConflictError(
        `External ID '${externalId}' is already used as ${String(existing.entity_type)}; one model space uses a shared entity namespace`,
      );
    }
  }

  private assertNoAssetCycles(scope: IndustrialRequestScope): void {
    const cycle = this.database.prepare(`
      WITH RECURSIVE walk(tenant_id, project_id, root, node, parent, path, cycle) AS (
        SELECT tenant_id, project_id, external_id, external_id, parent_external_id,
          ',' || external_id || ',', 0
        FROM industrial_assets
        WHERE tenant_id = ? AND project_id = ?
        UNION ALL
        SELECT walk.tenant_id, walk.project_id, walk.root, asset.external_id, asset.parent_external_id,
          walk.path || asset.external_id || ',',
          instr(walk.path, ',' || asset.external_id || ',') > 0
        FROM walk
        JOIN industrial_assets AS asset
          ON asset.tenant_id = walk.tenant_id
          AND asset.project_id = walk.project_id
          AND asset.external_id = walk.parent
        WHERE walk.tenant_id = ? AND walk.project_id = ?
          AND walk.parent IS NOT NULL AND walk.cycle = 0
      )
      SELECT root FROM walk
      WHERE tenant_id = ? AND project_id = ? AND cycle = 1
      LIMIT 1
    `).get(
      scope.tenantId,
      scope.projectId,
      scope.tenantId,
      scope.projectId,
      scope.tenantId,
      scope.projectId,
    ) as SqliteRow | undefined;
    if (cycle) throw new DataIntegrityError(`Asset hierarchy contains a cycle involving '${String(cycle.root)}'`);
  }

  private ingestAssets(scope: IndustrialRequestScope, bundle: IngestBundle, runId: string, timestamp: string): void {
    const upsert = this.database.prepare(`
      INSERT INTO industrial_assets(
        tenant_id, project_id, external_id, name, description, type, parent_external_id,
        metadata_json, source_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, project_id, external_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        type = excluded.type,
        metadata_json = excluded.metadata_json,
        source_system = excluded.source_system,
        updated_at = excluded.updated_at
    `);
    for (const asset of bundle.assets) {
      this.assertExternalIdType(scope, 'asset', asset.externalId);
      upsert.run(
        scope.tenantId,
        scope.projectId,
        asset.externalId,
        asset.name,
        asset.description ?? null,
        asset.type,
        JSON.stringify(asset.metadata ?? {}),
        bundle.source.system,
        timestamp,
        timestamp,
      );
      this.insertProvenance(scope, 'asset', asset.externalId, bundle.source.system, runId, asset, timestamp);
    }
    const setParent = this.database.prepare(`
      UPDATE industrial_assets SET parent_external_id = ?, updated_at = ?
      WHERE tenant_id = ? AND project_id = ? AND external_id = ?
    `);
    for (const asset of bundle.assets) {
      if (asset.parentExternalId !== undefined) {
        if (asset.parentExternalId !== null) this.assertEntityExists(scope, 'asset', asset.parentExternalId);
        setParent.run(asset.parentExternalId, timestamp, scope.tenantId, scope.projectId, asset.externalId);
      }
    }
    this.assertNoAssetCycles(scope);
  }

  private ingestTimeSeries(scope: IndustrialRequestScope, bundle: IngestBundle, runId: string, timestamp: string): void {
    const upsert = this.database.prepare(`
      INSERT INTO industrial_time_series(
        tenant_id, project_id, external_id, asset_external_id, name, unit, description,
        metadata_json, source_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, project_id, external_id) DO UPDATE SET
        asset_external_id = excluded.asset_external_id,
        name = excluded.name,
        unit = excluded.unit,
        description = excluded.description,
        metadata_json = excluded.metadata_json,
        source_system = excluded.source_system,
        updated_at = excluded.updated_at
    `);
    for (const series of bundle.timeSeries) {
      this.assertExternalIdType(scope, 'timeSeries', series.externalId);
      this.assertEntityExists(scope, 'asset', series.assetExternalId);
      upsert.run(
        scope.tenantId,
        scope.projectId,
        series.externalId,
        series.assetExternalId,
        series.name,
        series.unit ?? null,
        series.description ?? null,
        JSON.stringify(series.metadata ?? {}),
        bundle.source.system,
        timestamp,
        timestamp,
      );
      this.insertProvenance(scope, 'timeSeries', series.externalId, bundle.source.system, runId, series, timestamp);
    }
  }

  private ingestDataPoints(scope: IndustrialRequestScope, bundle: IngestBundle, runId: string): void {
    const existingPoint = this.database.prepare(`
      SELECT value, quality FROM industrial_data_points
      WHERE tenant_id = ? AND project_id = ?
        AND time_series_external_id = ? AND timestamp = ?
    `);
    const insert = this.database.prepare(`
      INSERT INTO industrial_data_points(
        tenant_id, project_id, time_series_external_id, timestamp, value, quality,
        source_system, ingestion_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const point of bundle.dataPoints) {
      if (!Number.isSafeInteger(point.timestamp) || Math.abs(point.timestamp) > MAX_JAVASCRIPT_DATE_MS) {
        throw new ConflictError('Telemetry timestamps must be integer epoch milliseconds in the JavaScript Date range');
      }
      this.assertEntityExists(scope, 'timeSeries', point.timeSeriesExternalId);
      const existing = existingPoint.get(
        scope.tenantId,
        scope.projectId,
        point.timeSeriesExternalId,
        point.timestamp,
      ) as SqliteRow | undefined;
      if (existing) {
        if (Number(existing.value) !== point.value || String(existing.quality) !== point.quality) {
          throw new ConflictError('An immutable telemetry point already exists with a different value');
        }
        continue;
      }
      insert.run(
        scope.tenantId,
        scope.projectId,
        point.timeSeriesExternalId,
        point.timestamp,
        point.value,
        point.quality,
        bundle.source.system,
        runId,
      );
    }
  }

  private ingestDocuments(scope: IndustrialRequestScope, bundle: IngestBundle, runId: string, timestamp: string): void {
    const upsert = this.database.prepare(`
      INSERT INTO industrial_documents(
        tenant_id, project_id, external_id, asset_external_id, title, mime_type, uri,
        metadata_json, source_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, project_id, external_id) DO UPDATE SET
        asset_external_id = excluded.asset_external_id,
        title = excluded.title,
        mime_type = excluded.mime_type,
        uri = excluded.uri,
        metadata_json = excluded.metadata_json,
        source_system = excluded.source_system,
        updated_at = excluded.updated_at
    `);
    for (const document of bundle.documents) {
      this.assertExternalIdType(scope, 'document', document.externalId);
      if (document.assetExternalId) this.assertEntityExists(scope, 'asset', document.assetExternalId);
      upsert.run(
        scope.tenantId,
        scope.projectId,
        document.externalId,
        document.assetExternalId ?? null,
        document.title,
        document.mimeType ?? null,
        document.uri ?? null,
        JSON.stringify(document.metadata ?? {}),
        bundle.source.system,
        timestamp,
        timestamp,
      );
      this.insertProvenance(scope, 'document', document.externalId, bundle.source.system, runId, document, timestamp);
    }
  }

  private ingestRelations(scope: IndustrialRequestScope, bundle: IngestBundle, runId: string, timestamp: string): void {
    const semanticKeys = new Set<string>();
    const existingTerminal = this.database.prepare(`
      SELECT id, status FROM industrial_relations
      WHERE tenant_id = ? AND project_id = ?
        AND source_type = ? AND source_external_id = ?
        AND target_type = ? AND target_external_id = ? AND relation_type = ?
    `);
    const upsert = this.database.prepare(`
      INSERT INTO industrial_relations(
        tenant_id, project_id, id, source_type, source_external_id, target_type,
        target_external_id, relation_type, status, confidence, evidence_json,
        rule_version, reviewer, reviewed_at, source_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(
        tenant_id, project_id, source_type, source_external_id,
        target_type, target_external_id, relation_type
      ) DO UPDATE SET
        confidence = excluded.confidence,
        evidence_json = excluded.evidence_json,
        rule_version = excluded.rule_version,
        source_system = excluded.source_system,
        updated_at = excluded.updated_at,
        status = excluded.status,
        reviewer = excluded.reviewer,
        reviewed_at = excluded.reviewed_at
      RETURNING id
    `);
    for (const relation of bundle.relations) {
      if (
        relation.sourceType === relation.targetType
        && relation.sourceExternalId === relation.targetExternalId
      ) {
        throw new ConflictError('Relation source and target must be different entities');
      }
      const semanticKey = JSON.stringify([
        relation.sourceType,
        relation.sourceExternalId,
        relation.targetType,
        relation.targetExternalId,
        relation.relationType,
      ]);
      if (semanticKeys.has(semanticKey)) {
        throw new ConflictError('A bundle cannot contain duplicate semantic relations');
      }
      semanticKeys.add(semanticKey);
      this.assertEntityExists(scope, relation.sourceType, relation.sourceExternalId);
      this.assertEntityExists(scope, relation.targetType, relation.targetExternalId);
      const relationId = industrialRelationExternalId(relation);
      const terminal = existingTerminal.get(
        scope.tenantId,
        scope.projectId,
        relation.sourceType,
        relation.sourceExternalId,
        relation.targetType,
        relation.targetExternalId,
        relation.relationType,
      ) as SqliteRow | undefined;
      if (terminal && String(terminal.id) !== relationId) {
        throw new ConflictError(
          `Relation identity '${relationId}' conflicts with existing relation '${String(terminal.id)}' for the same semantic tuple`,
        );
      }
      if (terminal && terminal.status !== 'proposed') {
        throw new ConflictError(
          `Relation '${String(terminal.id)}' cannot transition from ${String(terminal.status)} to ${relation.status}`,
        );
      }
      const stored = upsert.get(
        scope.tenantId,
        scope.projectId,
        relationId,
        relation.sourceType,
        relation.sourceExternalId,
        relation.targetType,
        relation.targetExternalId,
        relation.relationType,
        relation.status,
        relation.confidence ?? 0,
        JSON.stringify(relation.evidence),
        relation.ruleVersion ?? null,
        relation.status === 'accepted' ? bundle.source.actor : null,
        relation.status === 'accepted' ? timestamp : null,
        bundle.source.system,
        timestamp,
        timestamp,
      ) as SqliteRow;
      this.insertProvenance(
        scope,
        'relation',
        String(stored.id),
        bundle.source.system,
        runId,
        relation,
        timestamp,
      );
    }
  }

  private insertProvenance(
    scope: IndustrialRequestScope,
    entityType: string,
    entityId: string,
    sourceSystem: string,
    runId: string,
    sourceRecord: unknown,
    timestamp: string,
  ): void {
    const rawHash = createHash('sha256').update(JSON.stringify(sourceRecord)).digest('hex');
    const next = this.database.prepare(`
      SELECT COALESCE(MAX(id), 0) + 1 AS id FROM industrial_provenance
      WHERE tenant_id = ? AND project_id = ?
    `).get(scope.tenantId, scope.projectId) as SqliteRow;
    this.database.prepare(`
      INSERT INTO industrial_provenance(
        tenant_id, project_id, id, entity_type, entity_id, source_system,
        source_record_id, ingestion_run_id, raw_hash, model_version,
        valid_from, transaction_time, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'odf-core/0.1', ?, ?, '{}')
    `).run(
      scope.tenantId,
      scope.projectId,
      Number(next.id),
      entityType,
      entityId,
      sourceSystem,
      entityId,
      runId,
      rawHash,
      timestamp,
      timestamp,
    );
  }

  private insertAudit(
    scope: IndustrialRequestScope,
    actor: string,
    action: string,
    entityType: string,
    entityId: string | null,
    details: unknown,
    correlationId: string,
    timestamp = nowIso(),
  ): void {
    const next = this.database.prepare(`
      SELECT COALESCE(MAX(id), 0) + 1 AS id FROM industrial_audit
      WHERE tenant_id = ? AND project_id = ?
    `).get(scope.tenantId, scope.projectId) as SqliteRow;
    this.database.prepare(`
      INSERT INTO industrial_audit(
        tenant_id, project_id, id, timestamp, actor, action,
        entity_type, entity_id, details_json, correlation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scope.tenantId,
      scope.projectId,
      Number(next.id),
      timestamp,
      actor,
      action,
      entityType,
      entityId,
      JSON.stringify(details),
      correlationId,
    );
  }

  private recordFailedIngestion(
    scope: IndustrialRequestScope,
    bundle: IngestBundle,
    runId: string,
    payloadHash: string,
    counts: Record<string, number>,
    message: string,
    correlationId: string,
    startedAt: string,
    archive: IndustrialRawArchive | undefined,
  ): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const failedAt = nowIso();
      this.database.prepare(`
        INSERT INTO industrial_ingestion_runs(
          tenant_id, project_id, run_id, source_system, status, payload_hash, counts_json,
          error_message, raw_storage_uri, raw_sha256, raw_byte_size, raw_content_type,
          started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, project_id, run_id) DO UPDATE SET
          source_system = excluded.source_system,
          status = 'failed',
          payload_hash = excluded.payload_hash,
          counts_json = excluded.counts_json,
          error_message = excluded.error_message,
          raw_storage_uri = excluded.raw_storage_uri,
          raw_sha256 = excluded.raw_sha256,
          raw_byte_size = excluded.raw_byte_size,
          raw_content_type = excluded.raw_content_type,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at
      `).run(
        scope.tenantId,
        scope.projectId,
        runId,
        bundle.source.system,
        payloadHash,
        JSON.stringify(counts),
        message,
        archive?.storageUri ?? null,
        archive?.sha256 ?? null,
        archive?.byteSize ?? null,
        archive?.contentType ?? null,
        startedAt,
        failedAt,
      );
      this.insertAudit(
        scope,
        bundle.source.actor,
        'ingestion.failed',
        'ingestionRun',
        runId,
        { sourceSystem: bundle.source.system, error: message },
        correlationId,
        failedAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
