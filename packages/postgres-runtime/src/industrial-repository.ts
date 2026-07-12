import { ConflictError, NotFoundError } from "./errors.js";
import { insertGraphInstanceIdempotent } from "./graph-helpers.js";
import { json } from "./mappers.js";
import { appendPlatformAuditAndOutbox } from "./platform-events.js";
import {
  assetFromRow,
  documentAssetLinkFromRow,
  documentFromRow,
  relationCandidateFromRow,
  relationFromRow,
  requiredRowNumber,
  requiredRowString,
  timeSeriesFromRow,
  timeSeriesPointFromRow,
} from "./platform-mappers.js";
import { PolicyAwareRepository } from "./platform-repository-base.js";
import { boundedPageSize, pageFromRows, requiredText } from "./platform-support.js";
import type {
  AssetRecord,
  CreateAssetInput,
  CreateDocumentInput,
  CreateGraphInstanceInput,
  CreateRelationCandidateInput,
  CreateRelationInput,
  CreateTimeSeriesInput,
  DiagramMatchingSpatialRepository,
  DocumentAssetLinkRecord,
  DocumentRecord,
  IndustrialRepository,
  ProjectAccessResolver,
  ProjectScope,
  RelationCandidateRecord,
  RelationRecord,
  ReviewRelationCandidateInput,
  TextCursor,
  TimeSeriesBucket,
  TimeSeriesPointInput,
  TimeSeriesPointRecord,
  TimeSeriesRecord,
  TimestampIdCursor,
} from "./platform-types.js";
import type { KeysetPage, TransactionRunner } from "./types.js";

const ASSET_COLUMNS = [
  "asset_id, tenant_id, project_id, parent_asset_id, asset_kind, asset_type, name, description, site,",
  "source_system, metadata, created_at, updated_at",
].join(" ");
const TIME_SERIES_COLUMNS = [
  "time_series_id, tenant_id, project_id, dataset_id, asset_id, name, unit, value_type, interpolation,",
  "source_system, metadata, created_at, updated_at",
].join(" ");
const TIME_SERIES_POINT_COLUMNS = [
  "tenant_id, project_id, time_series_id, observed_at, sequence, numeric_value, text_value, quality,",
  "source_connection_id, ingestion_run_id, received_at",
].join(" ");
const DOCUMENT_COLUMNS = [
  "document_id, tenant_id, project_id, dataset_id, raw_object_id, title, mime_type, storage_uri, byte_size,",
  "content_sha256, source_system, metadata, created_at, updated_at",
].join(" ");
const DOCUMENT_ASSET_LINK_COLUMNS = "tenant_id, project_id, document_id, asset_id, relation_type, created_at";
const RELATION_COLUMNS = [
  "relation_id, tenant_id, project_id, dataset_id, source_instance_id, target_instance_id, relation_type,",
  "state, source_system, evidence, created_at, superseded_at",
].join(" ");
const RELATION_CANDIDATE_COLUMNS = [
  "relation_candidate_id, tenant_id, project_id, source_instance_id, target_instance_id, relation_type, confidence,",
  "evidence, rule_version, model_version, state, reviewer, reviewed_at, review_comment, accepted_relation_id, created_at",
].join(" ");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, nested]) => JSON.stringify(key) + ":" + canonical(nested)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function sameAsset(row: AssetRecord, input: CreateAssetInput): boolean {
  return row.assetId === input.instanceId
    && row.parentAssetId === (input.parentAssetId ?? null)
    && row.assetKind === input.assetKind
    && row.assetType === input.assetType
    && row.name === input.name
    && row.description === (input.description ?? null)
    && row.site === (input.site ?? null)
    && row.sourceSystem === input.sourceSystem
    && canonical(row.metadata) === canonical(input.metadata ?? {});
}

function sameTimeSeries(row: TimeSeriesRecord, input: CreateTimeSeriesInput): boolean {
  return row.timeSeriesId === input.instanceId
    && row.datasetId === (input.datasetId ?? null)
    && row.assetId === (input.assetId ?? null)
    && row.name === input.name
    && row.unit === (input.unit ?? null)
    && row.valueType === (input.valueType ?? "numeric")
    && row.interpolation === (input.interpolation ?? "linear")
    && row.sourceSystem === input.sourceSystem
    && canonical(row.metadata) === canonical(input.metadata ?? {});
}

function sameDocument(row: DocumentRecord, input: CreateDocumentInput): boolean {
  return row.documentId === input.instanceId
    && row.datasetId === (input.datasetId ?? null)
    && row.rawObjectId === (input.rawObjectId ?? null)
    && row.title === input.title
    && row.mimeType === (input.mimeType ?? null)
    && row.storageUri === (input.storageUri ?? null)
    && row.byteSize === (input.byteSize ?? null)
    && row.contentSha256 === (input.contentSha256 ?? null)
    && row.sourceSystem === input.sourceSystem
    && canonical(row.metadata) === canonical(input.metadata ?? {});
}

function sameRelation(row: RelationRecord, input: CreateRelationInput): boolean {
  return row.relationId === input.relationId
    && row.datasetId === (input.datasetId ?? null)
    && row.sourceInstanceId === input.sourceInstanceId
    && row.targetInstanceId === input.targetInstanceId
    && row.relationType === input.relationType
    && row.sourceSystem === input.sourceSystem
    && canonical(row.evidence) === canonical(input.evidence ?? {});
}

function sameRelationCandidate(row: RelationCandidateRecord, input: CreateRelationCandidateInput): boolean {
  return row.relationCandidateId === input.relationCandidateId
    && row.sourceInstanceId === input.sourceInstanceId
    && row.targetInstanceId === input.targetInstanceId
    && row.relationType === input.relationType
    && row.confidence === input.confidence
    && row.ruleVersion === (input.ruleVersion ?? null)
    && row.modelVersion === (input.modelVersion ?? null)
    && canonical(row.evidence) === canonical(input.evidence ?? []);
}

function assertPoint(point: TimeSeriesPointInput): void {
  const numeric = point.numericValue !== undefined;
  const text = point.textValue !== undefined;
  if (numeric === text) throw new ConflictError("A time-series point must have exactly one value");
  if (numeric && !Number.isFinite(point.numericValue as number)) throw new ConflictError("Numeric point value must be finite");
}

function samePoint(row: TimeSeriesPointRecord, point: TimeSeriesPointInput): boolean {
  return row.observedAt === point.observedAt
    && row.sequence === (point.sequence ?? "0")
    && row.numericValue === (point.numericValue ?? null)
    && row.textValue === (point.textValue ?? null)
    && row.quality === (point.quality ?? "good")
    && row.sourceConnectionId === (point.sourceConnectionId ?? null)
    && row.ingestionRunId === (point.ingestionRunId ?? null);
}

/**
 * Asset, time-series, document, and contextualization persistence using only
 * migration-003 recovery boundaries. Diagram/matching/spatial wrappers map to
 * document metadata and relation-candidate evidence rather than imaginary
 * tables.
 */
export class PostgresIndustrialRepository extends PolicyAwareRepository implements IndustrialRepository, DiagramMatchingSpatialRepository {
  constructor(runner: TransactionRunner, policy: ProjectAccessResolver) {
    super(runner, policy);
  }

  async createAsset(scope: ProjectScope, input: CreateAssetInput): Promise<AssetRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const graphInput: CreateGraphInstanceInput = {
        instanceId: input.instanceId, datasetId: input.datasetId ?? null, spaceId: input.spaceId, externalId: input.externalId,
        instanceKind: "node", dataModelId: input.dataModelId ?? null, properties: input.properties ?? {}, validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null, correlationId: input.correlationId,
      };
      await insertGraphInstanceIdempotent(transaction, scope, graphInput);
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.assets",
          "  (asset_id, tenant_id, project_id, parent_asset_id, asset_kind, asset_type, name, description, site, source_system, metadata)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb)",
          "ON CONFLICT (tenant_id, project_id, asset_id) DO NOTHING",
          "RETURNING " + ASSET_COLUMNS,
        ].join("\n"),
        values: [
          input.instanceId, scope.tenantId, scope.projectId, input.parentAssetId ?? null, input.assetKind, input.assetType, input.name,
          input.description ?? null, input.site ?? null, input.sourceSystem, json(input.metadata ?? {}),
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const asset = assetFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.asset_created", entityType: "asset", entityId: asset.assetId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: input.externalId, assetKind: asset.assetKind, sourceSystem: asset.sourceSystem },
        });
        return asset;
      }
      const existing = await transaction.query({
        text: "SELECT " + ASSET_COLUMNS + " FROM odf.assets WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND asset_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.instanceId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Asset idempotency record could not be resolved");
      const asset = assetFromRow(existingRow);
      if (!sameAsset(asset, input)) throw new ConflictError("Asset identifier is already bound to different input");
      return asset;
    });
  }

  async listAssets(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<AssetRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + ASSET_COLUMNS,
          "FROM odf.assets",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (updated_at, asset_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY updated_at DESC, asset_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, assetFromRow, (asset) => ({ timestamp: asset.updatedAt, id: asset.assetId }));
    });
  }

  async createTimeSeries(scope: ProjectScope, input: CreateTimeSeriesInput): Promise<TimeSeriesRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const graphInput: CreateGraphInstanceInput = {
        instanceId: input.instanceId, datasetId: input.datasetId ?? null, spaceId: input.spaceId, externalId: input.externalId,
        instanceKind: "node", dataModelId: input.dataModelId ?? null, properties: input.properties ?? {}, validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null, correlationId: input.correlationId,
      };
      await insertGraphInstanceIdempotent(transaction, scope, graphInput);
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.time_series",
          "  (time_series_id, tenant_id, project_id, dataset_id, asset_id, name, unit, value_type, interpolation, source_system, metadata)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11::jsonb)",
          "ON CONFLICT (tenant_id, project_id, time_series_id) DO NOTHING",
          "RETURNING " + TIME_SERIES_COLUMNS,
        ].join("\n"),
        values: [
          input.instanceId, scope.tenantId, scope.projectId, input.datasetId ?? null, input.assetId ?? null, input.name, input.unit ?? null,
          input.valueType ?? "numeric", input.interpolation ?? "linear", input.sourceSystem, json(input.metadata ?? {}),
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const series = timeSeriesFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.time_series_created", entityType: "timeSeries", entityId: series.timeSeriesId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: input.externalId, valueType: series.valueType, sourceSystem: series.sourceSystem },
        });
        return series;
      }
      const existing = await transaction.query({
        text: "SELECT " + TIME_SERIES_COLUMNS + " FROM odf.time_series WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND time_series_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.instanceId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Time-series idempotency record could not be resolved");
      const series = timeSeriesFromRow(existingRow);
      if (!sameTimeSeries(series, input)) throw new ConflictError("Time-series identifier is already bound to different input");
      return series;
    });
  }

  async listTimeSeries(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<TimeSeriesRecord, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + TIME_SERIES_COLUMNS,
          "FROM odf.time_series",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND time_series_id > $3::uuid",
          "ORDER BY time_series_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "00000000-0000-0000-0000-000000000000", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, timeSeriesFromRow, (series) => ({ value: series.timeSeriesId }));
    });
  }

  async upsertTimeSeriesPoints(
    scope: ProjectScope,
    timeSeriesId: string,
    points: readonly TimeSeriesPointInput[],
    correlationId: string,
  ): Promise<TimeSeriesPointRecord[]> {
    requiredText(correlationId, "correlationId");
    if (!points.length || points.length > 500) throw new RangeError("points must contain between 1 and 500 entries");
    points.forEach(assertPoint);
    return this.write(scope, async (transaction) => {
      const returned: TimeSeriesPointRecord[] = [];
      let created = 0;
      for (const point of points) {
        const inserted = await transaction.query({
          text: [
            "INSERT INTO odf.time_series_points",
            "  (tenant_id, project_id, time_series_id, observed_at, sequence, numeric_value, text_value, quality, source_connection_id, ingestion_run_id)",
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::bigint, $6::double precision, $7, $8, $9::uuid, $10::uuid)",
            "ON CONFLICT (time_series_id, observed_at, sequence) DO NOTHING",
            "RETURNING " + TIME_SERIES_POINT_COLUMNS,
          ].join("\n"),
          values: [
            scope.tenantId, scope.projectId, timeSeriesId, point.observedAt, point.sequence ?? "0", point.numericValue ?? null,
            point.textValue ?? null, point.quality ?? "good", point.sourceConnectionId ?? null, point.ingestionRunId ?? null,
          ],
        });
        const row = inserted.rows[0];
        if (row) {
          created += 1;
          returned.push(timeSeriesPointFromRow(row));
          continue;
        }
        const existing = await transaction.query({
          text: [
            "SELECT " + TIME_SERIES_POINT_COLUMNS,
            "FROM odf.time_series_points",
            "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND time_series_id = $3::uuid",
            "  AND observed_at = $4::timestamptz AND sequence = $5::bigint",
          ].join("\n"),
          values: [scope.tenantId, scope.projectId, timeSeriesId, point.observedAt, point.sequence ?? "0"],
        });
        const existingRow = existing.rows[0];
        if (!existingRow) throw new ConflictError("Time-series point idempotency record could not be resolved");
        const current = timeSeriesPointFromRow(existingRow);
        if (!samePoint(current, point)) throw new ConflictError("Time-series point identity is already bound to different input");
        returned.push(current);
      }
      if (created) {
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.time_series_points_landed", entityType: "timeSeries", entityId: timeSeriesId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId,
          details: { insertedCount: created, inputCount: points.length },
        });
      }
      return returned;
    });
  }

  async latestTimeSeriesPoint(scope: ProjectScope, timeSeriesId: string): Promise<TimeSeriesPointRecord | null> {
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + TIME_SERIES_POINT_COLUMNS,
          "FROM odf.time_series_points",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND time_series_id = $3::uuid",
          "ORDER BY observed_at DESC, sequence DESC",
          "LIMIT 1",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, timeSeriesId],
      });
      const row = result.rows[0];
      return row ? timeSeriesPointFromRow(row) : null;
    });
  }

  async bucketTimeSeries(
    scope: ProjectScope,
    timeSeriesId: string,
    from: string,
    to: string,
    bucketSeconds: number,
  ): Promise<TimeSeriesBucket[]> {
    if (!Number.isInteger(bucketSeconds) || bucketSeconds < 1 || bucketSeconds > 86_400) {
      throw new RangeError("bucketSeconds must be an integer between 1 and 86400");
    }
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT",
          "  to_timestamp(floor(extract(epoch FROM observed_at) / $6::double precision) * $6::double precision) AS bucket_start,",
          "  count(*)::text AS point_count,",
          "  min(numeric_value) AS numeric_minimum, max(numeric_value) AS numeric_maximum, avg(numeric_value) AS numeric_average,",
          "  (array_agg(text_value ORDER BY observed_at DESC, sequence DESC) FILTER (WHERE text_value IS NOT NULL))[1] AS latest_text_value",
          "FROM odf.time_series_points",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND time_series_id = $3::uuid",
          "  AND observed_at >= $4::timestamptz AND observed_at < $5::timestamptz",
          "GROUP BY bucket_start",
          "ORDER BY bucket_start ASC",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, timeSeriesId, from, to, bucketSeconds],
      });
      return result.rows.map((row) => ({
        bucketStart: requiredRowString(row, "bucket_start"), pointCount: requiredRowString(row, "point_count"),
        numericMinimum: row.numeric_minimum === null || row.numeric_minimum === undefined ? null : requiredRowNumber(row, "numeric_minimum"),
        numericMaximum: row.numeric_maximum === null || row.numeric_maximum === undefined ? null : requiredRowNumber(row, "numeric_maximum"),
        numericAverage: row.numeric_average === null || row.numeric_average === undefined ? null : requiredRowNumber(row, "numeric_average"),
        latestTextValue: row.latest_text_value === null || row.latest_text_value === undefined ? null : requiredRowString(row, "latest_text_value"),
      }));
    });
  }

  async createDocument(scope: ProjectScope, input: CreateDocumentInput): Promise<DocumentRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const graphInput: CreateGraphInstanceInput = {
        instanceId: input.instanceId, datasetId: input.datasetId ?? null, spaceId: input.spaceId, externalId: input.externalId,
        instanceKind: "node", dataModelId: input.dataModelId ?? null, properties: input.properties ?? {}, validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null, correlationId: input.correlationId,
      };
      await insertGraphInstanceIdempotent(transaction, scope, graphInput);
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.documents",
          "  (document_id, tenant_id, project_id, dataset_id, raw_object_id, title, mime_type, storage_uri, byte_size, content_sha256, source_system, metadata)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::bigint, $10, $11, $12::jsonb)",
          "ON CONFLICT (tenant_id, project_id, document_id) DO NOTHING",
          "RETURNING " + DOCUMENT_COLUMNS,
        ].join("\n"),
        values: [
          input.instanceId, scope.tenantId, scope.projectId, input.datasetId ?? null, input.rawObjectId ?? null, input.title,
          input.mimeType ?? null, input.storageUri ?? null, input.byteSize ?? null, input.contentSha256 ?? null, input.sourceSystem, json(input.metadata ?? {}),
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const document = documentFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.document_created", entityType: "document", entityId: document.documentId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { title: document.title, rawObjectId: document.rawObjectId, sourceSystem: document.sourceSystem },
        });
        return document;
      }
      const existing = await transaction.query({
        text: "SELECT " + DOCUMENT_COLUMNS + " FROM odf.documents WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND document_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.instanceId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Document idempotency record could not be resolved");
      const document = documentFromRow(existingRow);
      if (!sameDocument(document, input)) throw new ConflictError("Document identifier is already bound to different input");
      return document;
    });
  }

  async listDocuments(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<DocumentRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + DOCUMENT_COLUMNS,
          "FROM odf.documents",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (updated_at, document_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY updated_at DESC, document_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, documentFromRow, (document) => ({ timestamp: document.updatedAt, id: document.documentId }));
    });
  }

  async linkDocumentAsset(scope: ProjectScope, documentId: string, assetId: string, relationType: string, correlationId: string): Promise<DocumentAssetLinkRecord> {
    requiredText(correlationId, "correlationId");
    requiredText(relationType, "relationType");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.document_asset_links (tenant_id, project_id, document_id, asset_id, relation_type)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)",
          "ON CONFLICT (document_id, asset_id, relation_type) DO NOTHING",
          "RETURNING " + DOCUMENT_ASSET_LINK_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, documentId, assetId, relationType],
      });
      const row = inserted.rows[0];
      if (row) {
        const link = documentAssetLinkFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.document_asset_linked", entityType: "document", entityId: documentId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId,
          details: { assetId, relationType },
        });
        return link;
      }
      const existing = await transaction.query({
        text: [
          "SELECT " + DOCUMENT_ASSET_LINK_COLUMNS,
          "FROM odf.document_asset_links",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND document_id = $3::uuid AND asset_id = $4::uuid AND relation_type = $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, documentId, assetId, relationType],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Document asset link could not be resolved");
      return documentAssetLinkFromRow(existingRow);
    });
  }

  async createRelation(scope: ProjectScope, input: CreateRelationInput): Promise<RelationRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.relations",
          "  (relation_id, tenant_id, project_id, dataset_id, source_instance_id, target_instance_id, relation_type, state, source_system, evidence)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, 'accepted', $8, $9::jsonb)",
          "ON CONFLICT (tenant_id, project_id, relation_id) DO NOTHING",
          "RETURNING " + RELATION_COLUMNS,
        ].join("\n"),
        values: [
          input.relationId, scope.tenantId, scope.projectId, input.datasetId ?? null, input.sourceInstanceId, input.targetInstanceId,
          input.relationType, input.sourceSystem, json(input.evidence ?? {}),
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const relation = relationFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.relation_created", entityType: "relation", entityId: relation.relationId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { sourceInstanceId: relation.sourceInstanceId, targetInstanceId: relation.targetInstanceId, relationType: relation.relationType },
        });
        return relation;
      }
      const existing = await transaction.query({
        text: "SELECT " + RELATION_COLUMNS + " FROM odf.relations WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND relation_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.relationId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Relation idempotency record could not be resolved");
      const relation = relationFromRow(existingRow);
      if (!sameRelation(relation, input)) {
        throw new ConflictError("Relation identifier is already bound to different input");
      }
      return relation;
    });
  }

  async listRelations(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<RelationRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + RELATION_COLUMNS,
          "FROM odf.relations",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (created_at, relation_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY created_at DESC, relation_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, relationFromRow, (relation) => ({ timestamp: relation.createdAt, id: relation.relationId }));
    });
  }

  async createRelationCandidate(scope: ProjectScope, input: CreateRelationCandidateInput): Promise<RelationCandidateRecord> {
    requiredText(input.correlationId, "correlationId");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new RangeError("confidence must be between 0 and 1");
    }
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.relation_candidates",
          "  (relation_candidate_id, tenant_id, project_id, source_instance_id, target_instance_id, relation_type, confidence, evidence, rule_version, model_version, state)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::double precision, $8::jsonb, $9, $10, 'proposed')",
          "ON CONFLICT (tenant_id, project_id, relation_candidate_id) DO NOTHING",
          "RETURNING " + RELATION_CANDIDATE_COLUMNS,
        ].join("\n"),
        values: [
          input.relationCandidateId, scope.tenantId, scope.projectId, input.sourceInstanceId, input.targetInstanceId, input.relationType,
          input.confidence, JSON.stringify(input.evidence ?? []), input.ruleVersion ?? null, input.modelVersion ?? null,
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const candidate = relationCandidateFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.relation_candidate_proposed", entityType: "relationCandidate", entityId: candidate.relationCandidateId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { sourceInstanceId: candidate.sourceInstanceId, targetInstanceId: candidate.targetInstanceId, relationType: candidate.relationType, confidence: candidate.confidence },
        });
        return candidate;
      }
      const existing = await transaction.query({
        text: "SELECT " + RELATION_CANDIDATE_COLUMNS + " FROM odf.relation_candidates WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND relation_candidate_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.relationCandidateId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Relation candidate idempotency record could not be resolved");
      const candidate = relationCandidateFromRow(existingRow);
      if (!sameRelationCandidate(candidate, input)) {
        throw new ConflictError("Relation candidate identifier is already bound to different input");
      }
      return candidate;
    });
  }

  async listRelationCandidates(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<RelationCandidateRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + RELATION_CANDIDATE_COLUMNS,
          "FROM odf.relation_candidates",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (created_at, relation_candidate_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY created_at DESC, relation_candidate_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, relationCandidateFromRow, (candidate) => ({ timestamp: candidate.createdAt, id: candidate.relationCandidateId }));
    });
  }

  async reviewRelationCandidate(scope: ProjectScope, candidateId: string, input: ReviewRelationCandidateInput): Promise<RelationCandidateRecord> {
    requiredText(input.correlationId, "correlationId");
    // Legacy contextualization review permits editors as well as dedicated
    // reviewers. Keep the authorization check explicit instead of widening
    // the shared review policy used by unrelated repositories.
    await this.resolveRole(scope, ["owner", "editor", "reviewer"]);
    return this.runner.withTransaction(scope, async (transaction) => {
      const selected = await transaction.query({
        text: [
          "SELECT " + RELATION_CANDIDATE_COLUMNS,
          "FROM odf.relation_candidates",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND relation_candidate_id = $3::uuid",
          "FOR UPDATE",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, candidateId],
      });
      const selectedRow = selected.rows[0];
      if (!selectedRow) throw new NotFoundError("Relation candidate was not found");
      const candidate = relationCandidateFromRow(selectedRow);
      if (candidate.state !== "proposed") {
        if ((input.decision === "accepted" && candidate.state === "accepted") || (input.decision === "rejected" && candidate.state === "rejected")) return candidate;
        throw new ConflictError("Relation candidate has already been reviewed");
      }
      let acceptedRelationId: string | null = null;
      if (input.decision === "accepted") {
        const relation = await transaction.query({
          text: [
            "INSERT INTO odf.relations",
            "  (tenant_id, project_id, source_instance_id, target_instance_id, relation_type, state, source_system, evidence)",
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'accepted', $6, $7::jsonb)",
            "ON CONFLICT (project_id, source_instance_id, target_instance_id, relation_type) DO NOTHING",
            "RETURNING " + RELATION_COLUMNS,
          ].join("\n"),
          values: [
            scope.tenantId, scope.projectId, candidate.sourceInstanceId, candidate.targetInstanceId, candidate.relationType,
            input.sourceSystem ?? "contextualization", json({ relationCandidateId: candidate.relationCandidateId, evidence: candidate.evidence }),
          ],
        });
        const relationRow = relation.rows[0];
        if (relationRow) {
          acceptedRelationId = relationFromRow(relationRow).relationId;
        } else {
          const existing = await transaction.query({
            text: [
              "SELECT " + RELATION_COLUMNS,
              "FROM odf.relations",
              "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND source_instance_id = $3::uuid",
              "  AND target_instance_id = $4::uuid AND relation_type = $5",
            ].join("\n"),
            values: [scope.tenantId, scope.projectId, candidate.sourceInstanceId, candidate.targetInstanceId, candidate.relationType],
          });
          const existingRow = existing.rows[0];
          if (!existingRow) throw new ConflictError("Accepted relation could not be resolved");
          const relationRecord = relationFromRow(existingRow);
          if (relationRecord.state !== "accepted") throw new ConflictError("Matching relation is superseded");
          acceptedRelationId = relationRecord.relationId;
        }
      }
      const updated = await transaction.query({
        text: [
          "UPDATE odf.relation_candidates",
          "SET state = $4, reviewer = $5, reviewed_at = now(), review_comment = $6, accepted_relation_id = $7::uuid",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND relation_candidate_id = $3::uuid AND state = 'proposed'",
          "RETURNING " + RELATION_CANDIDATE_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, candidateId, input.decision, scope.userId, input.comment ?? null, acceptedRelationId],
      });
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new ConflictError("Relation candidate is no longer proposed");
      const reviewed = relationCandidateFromRow(updatedRow);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.relation_candidate_" + input.decision, entityType: "relationCandidate", entityId: reviewed.relationCandidateId,
        tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
        details: { decision: input.decision, acceptedRelationId: reviewed.acceptedRelationId, comment: reviewed.reviewComment },
      });
      return reviewed;
    });
  }

  async createDiagramDocument(scope: ProjectScope, input: CreateDocumentInput): Promise<DocumentRecord> {
    return this.createDocument(scope, {
      ...input,
      metadata: { ...(input.metadata ?? {}), artifactKind: "diagram" },
    });
  }

  async createMatchingCandidate(scope: ProjectScope, input: CreateRelationCandidateInput): Promise<RelationCandidateRecord> {
    return this.createRelationCandidate(scope, input);
  }

  async createSpatialLinkCandidate(scope: ProjectScope, input: CreateRelationCandidateInput): Promise<RelationCandidateRecord> {
    return this.createRelationCandidate(scope, input);
  }
}
