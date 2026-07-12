import { ConflictError, NotFoundError } from "./errors.js";
import { appendPlatformAuditAndOutbox } from "./platform-events.js";
import { PolicyAwareRepository } from "./platform-repository-base.js";
import { boundedPageSize, pageFromRows, requiredText } from "./platform-support.js";
import {
  optionalRowString,
  requiredRowNumber,
  requiredRowString,
  rowJsonObject,
  rowJsonObjectArray,
} from "./platform-mappers.js";
import type { ProjectAccessResolver, ProjectScope, TextCursor } from "./platform-types.js";
import type { JsonObject, KeysetPage, TransactionRunner } from "./types.js";

type Row = Record<string, unknown>;

export interface DiagramExtractionRecord {
  tenantId: string;
  projectId: string;
  diagramExtractionId: string;
  documentExternalId: string;
  textSha256: string;
  tags: JsonObject[];
  createdBy: string;
  createdAt: string;
}

export interface MatchingEvaluationRecord {
  tenantId: string;
  projectId: string;
  matchingEvaluationId: string;
  threshold: number;
  inputSha256: string;
  predictionCount: number;
  truthCount: number;
  evaluation: JsonObject;
  proposals: JsonObject[];
  createdBy: string;
  createdAt: string;
}

export interface SpatialAssetLinkRecord {
  tenantId: string;
  projectId: string;
  spatialLinkId: string;
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

export interface CreateDiagramExtractionInput {
  diagramExtractionId: string;
  documentExternalId: string;
  textSha256: string;
  tags: JsonObject[];
  correlationId: string;
}

export interface CreateMatchingEvaluationInput {
  matchingEvaluationId: string;
  threshold: number;
  inputSha256: string;
  predictionCount: number;
  truthCount: number;
  evaluation: JsonObject;
  proposals: JsonObject[];
  correlationId: string;
}

export interface CreateSpatialAssetLinkInput {
  spatialLinkId: string;
  assetExternalId: string;
  sceneExternalId: string;
  nodeExternalId: string;
  transform: readonly number[];
  confidence: number;
  correlationId: string;
}

export interface ReviewSpatialAssetLinkInput {
  decision: "accepted" | "rejected";
  comment?: string | null;
  correlationId: string;
}

const DIAGRAM_COLUMNS = [
  "tenant_id::text AS tenant_id, project_id::text AS project_id, diagram_extraction_id, document_external_id,",
  "text_sha256, tags, created_by, created_at",
].join(" ");
const MATCHING_COLUMNS = [
  "tenant_id::text AS tenant_id, project_id::text AS project_id, matching_evaluation_id, threshold, input_sha256,",
  "prediction_count, truth_count, evaluation, proposals, created_by, created_at",
].join(" ");
const SPATIAL_COLUMNS = [
  "tenant_id::text AS tenant_id, project_id::text AS project_id, spatial_link_id, asset_external_id, scene_external_id,",
  "node_external_id, transform, confidence, review_state, reviewed_by, review_comment, reviewed_at, created_by, created_at",
].join(" ");

function asFiniteTransform(value: unknown): number[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.length !== 16 || parsed.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new TypeError("Expected a finite 4x4 transform from PostgreSQL");
  }
  return [...parsed];
}

function spatialState(row: Row): SpatialAssetLinkRecord["reviewState"] {
  const state = requiredRowString(row, "review_state");
  if (state !== "proposed" && state !== "accepted" && state !== "rejected") {
    throw new TypeError("Unexpected spatial link review state from PostgreSQL");
  }
  return state;
}

function diagramFromRow(row: Row): DiagramExtractionRecord {
  return {
    tenantId: requiredRowString(row, "tenant_id"),
    projectId: requiredRowString(row, "project_id"),
    diagramExtractionId: requiredRowString(row, "diagram_extraction_id"),
    documentExternalId: requiredRowString(row, "document_external_id"),
    textSha256: requiredRowString(row, "text_sha256"),
    tags: rowJsonObjectArray(row, "tags"),
    createdBy: requiredRowString(row, "created_by"),
    createdAt: requiredRowString(row, "created_at"),
  };
}

function matchingFromRow(row: Row): MatchingEvaluationRecord {
  return {
    tenantId: requiredRowString(row, "tenant_id"),
    projectId: requiredRowString(row, "project_id"),
    matchingEvaluationId: requiredRowString(row, "matching_evaluation_id"),
    threshold: requiredRowNumber(row, "threshold"),
    inputSha256: requiredRowString(row, "input_sha256"),
    predictionCount: requiredRowNumber(row, "prediction_count"),
    truthCount: requiredRowNumber(row, "truth_count"),
    evaluation: rowJsonObject(row, "evaluation"),
    proposals: rowJsonObjectArray(row, "proposals"),
    createdBy: requiredRowString(row, "created_by"),
    createdAt: requiredRowString(row, "created_at"),
  };
}

function spatialFromRow(row: Row): SpatialAssetLinkRecord {
  return {
    tenantId: requiredRowString(row, "tenant_id"),
    projectId: requiredRowString(row, "project_id"),
    spatialLinkId: requiredRowString(row, "spatial_link_id"),
    assetExternalId: requiredRowString(row, "asset_external_id"),
    sceneExternalId: requiredRowString(row, "scene_external_id"),
    nodeExternalId: requiredRowString(row, "node_external_id"),
    transform: asFiniteTransform(row.transform),
    confidence: requiredRowNumber(row, "confidence"),
    reviewState: spatialState(row),
    reviewedBy: optionalRowString(row, "reviewed_by"),
    reviewComment: optionalRowString(row, "review_comment"),
    reviewedAt: optionalRowString(row, "reviewed_at"),
    createdBy: requiredRowString(row, "created_by"),
    createdAt: requiredRowString(row, "created_at"),
  };
}

/**
 * Advanced contextualization records which do not map one-to-one to the
 * normalized industrial data plane. Each operation stays inside the existing
 * project policy/RLS transaction boundary and writes audit/outbox evidence.
 */
export class PostgresAdvancedPlatformRepository extends PolicyAwareRepository {
  constructor(runner: TransactionRunner, policy: ProjectAccessResolver) {
    super(runner, policy);
  }

  async listDiagramExtractions(
    scope: ProjectScope,
    limit: number,
    cursor?: TextCursor,
  ): Promise<KeysetPage<DiagramExtractionRecord, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: [
          "SELECT " + DIAGRAM_COLUMNS,
          "FROM odf.platform_diagram_extractions",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND diagram_extraction_id > $3",
          "ORDER BY diagram_extraction_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, diagramFromRow, (item) => ({ value: item.diagramExtractionId }));
    });
  }

  async createDiagramExtraction(scope: ProjectScope, input: CreateDiagramExtractionInput): Promise<DiagramExtractionRecord> {
    requiredText(input.diagramExtractionId, "diagramExtractionId");
    requiredText(input.documentExternalId, "documentExternalId");
    requiredText(input.textSha256, "textSha256");
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query<Row>({
        text: [
          "INSERT INTO odf.platform_diagram_extractions",
          "  (tenant_id, project_id, diagram_extraction_id, document_external_id, text_sha256, tags, created_by)",
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7)",
          "ON CONFLICT (tenant_id, project_id, diagram_extraction_id) DO NOTHING",
          "RETURNING " + DIAGRAM_COLUMNS,
        ].join("\n"),
        values: [
          scope.tenantId, scope.projectId, input.diagramExtractionId, input.documentExternalId,
          input.textSha256, JSON.stringify(input.tags), scope.userId,
        ],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError("Diagram extraction identifier already exists");
      const record = diagramFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: "platform.diagram_tags_extracted",
        entityType: "diagramExtraction",
        entityId: record.diagramExtractionId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId: input.correlationId,
        details: {
          documentExternalId: record.documentExternalId,
          textSha256: record.textSha256,
          tagCount: record.tags.length,
        },
      });
      return record;
    });
  }

  async listMatchingEvaluations(
    scope: ProjectScope,
    limit: number,
    cursor?: TextCursor,
  ): Promise<KeysetPage<MatchingEvaluationRecord, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: [
          "SELECT " + MATCHING_COLUMNS,
          "FROM odf.platform_matching_evaluations",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND matching_evaluation_id > $3",
          "ORDER BY matching_evaluation_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, matchingFromRow, (item) => ({ value: item.matchingEvaluationId }));
    });
  }

  async createMatchingEvaluation(scope: ProjectScope, input: CreateMatchingEvaluationInput): Promise<MatchingEvaluationRecord> {
    requiredText(input.matchingEvaluationId, "matchingEvaluationId");
    requiredText(input.inputSha256, "inputSha256");
    requiredText(input.correlationId, "correlationId");
    if (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1) {
      throw new RangeError("threshold must be between 0 and 1");
    }
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query<Row>({
        text: [
          "INSERT INTO odf.platform_matching_evaluations",
          "  (tenant_id, project_id, matching_evaluation_id, threshold, input_sha256, prediction_count, truth_count, evaluation, proposals, created_by)",
          "VALUES ($1::uuid, $2::uuid, $3, $4::double precision, $5, $6::integer, $7::integer, $8::jsonb, $9::jsonb, $10)",
          "ON CONFLICT (tenant_id, project_id, matching_evaluation_id) DO NOTHING",
          "RETURNING " + MATCHING_COLUMNS,
        ].join("\n"),
        values: [
          scope.tenantId, scope.projectId, input.matchingEvaluationId, input.threshold, input.inputSha256,
          input.predictionCount, input.truthCount, JSON.stringify(input.evaluation), JSON.stringify(input.proposals), scope.userId,
        ],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError("Matching evaluation identifier already exists");
      const record = matchingFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: "platform.matching_evaluated",
        entityType: "matchingEvaluation",
        entityId: record.matchingEvaluationId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId: input.correlationId,
        details: {
          inputSha256: record.inputSha256,
          evaluation: record.evaluation,
          proposalCount: record.proposals.length,
          allProposalsRemainProposed: record.proposals.every((proposal) => proposal.state === "proposed"),
        },
      });
      return record;
    });
  }

  async listSpatialAssetLinks(
    scope: ProjectScope,
    limit: number,
    cursor?: TextCursor,
  ): Promise<KeysetPage<SpatialAssetLinkRecord, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: [
          "SELECT " + SPATIAL_COLUMNS,
          "FROM odf.platform_spatial_asset_links",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND spatial_link_id > $3",
          "ORDER BY spatial_link_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, spatialFromRow, (item) => ({ value: item.spatialLinkId }));
    });
  }

  async createSpatialAssetLink(scope: ProjectScope, input: CreateSpatialAssetLinkInput): Promise<SpatialAssetLinkRecord> {
    requiredText(input.spatialLinkId, "spatialLinkId");
    requiredText(input.assetExternalId, "assetExternalId");
    requiredText(input.sceneExternalId, "sceneExternalId");
    requiredText(input.nodeExternalId, "nodeExternalId");
    requiredText(input.correlationId, "correlationId");
    if (input.transform.length !== 16 || input.transform.some((item) => !Number.isFinite(item)) || Math.abs(input.transform[15] ?? 0) < Number.EPSILON) {
      throw new RangeError("transform must be a finite 4x4 matrix with a non-zero homogeneous scale");
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new RangeError("confidence must be between 0 and 1");
    }
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query<Row>({
        text: [
          "INSERT INTO odf.platform_spatial_asset_links",
          "  (tenant_id, project_id, spatial_link_id, asset_external_id, scene_external_id, node_external_id, transform, confidence, review_state, created_by)",
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::double precision, 'proposed', $9)",
          "ON CONFLICT (tenant_id, project_id, spatial_link_id) DO NOTHING",
          "RETURNING " + SPATIAL_COLUMNS,
        ].join("\n"),
        values: [
          scope.tenantId, scope.projectId, input.spatialLinkId, input.assetExternalId, input.sceneExternalId,
          input.nodeExternalId, JSON.stringify(input.transform), input.confidence, scope.userId,
        ],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError("Spatial asset link identifier already exists");
      const record = spatialFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: "platform.spatial_link_proposed",
        entityType: "spatialAssetLink",
        entityId: record.spatialLinkId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId: input.correlationId,
        details: {
          assetExternalId: record.assetExternalId,
          sceneExternalId: record.sceneExternalId,
          nodeExternalId: record.nodeExternalId,
          transform: record.transform,
          confidence: record.confidence,
          reviewState: record.reviewState,
        },
      });
      return record;
    });
  }

  async reviewSpatialAssetLink(
    scope: ProjectScope,
    spatialLinkId: string,
    input: ReviewSpatialAssetLinkInput,
  ): Promise<SpatialAssetLinkRecord> {
    requiredText(spatialLinkId, "spatialLinkId");
    requiredText(input.correlationId, "correlationId");
    await this.resolveRole(scope, ["owner", "editor", "reviewer"]);
    return this.runner.withTransaction(scope, async (transaction) => {
      const updated = await transaction.query<Row>({
        text: [
          "UPDATE odf.platform_spatial_asset_links",
          "SET review_state = $4, reviewed_by = $5, review_comment = $6, reviewed_at = now()",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND spatial_link_id = $3 AND review_state = 'proposed'",
          "RETURNING " + SPATIAL_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, spatialLinkId, input.decision, scope.userId, input.comment ?? null],
      });
      const row = updated.rows[0];
      if (!row) {
        const existing = await transaction.query<Row>({
          text: [
            "SELECT review_state",
            "FROM odf.platform_spatial_asset_links",
            "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND spatial_link_id = $3",
          ].join("\n"),
          values: [scope.tenantId, scope.projectId, spatialLinkId],
        });
        if (!existing.rows[0]) throw new NotFoundError("Spatial asset link was not found");
        throw new ConflictError("Spatial asset link has already been reviewed");
      }
      const record = spatialFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: "platform.spatial_link_" + input.decision,
        entityType: "spatialAssetLink",
        entityId: record.spatialLinkId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId: input.correlationId,
        details: { decision: input.decision, comment: input.comment ?? null },
      });
      return record;
    });
  }
}
