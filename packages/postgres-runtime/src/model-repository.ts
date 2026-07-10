import { ConflictError, NotFoundError } from "./errors.js";
import { appendPlatformAuditAndOutbox } from "./platform-events.js";
import { insertGraphInstanceIdempotent } from "./graph-helpers.js";
import { json } from "./mappers.js";
import {
  dataModelFromRow,
  modelViewFromRow,
} from "./platform-mappers.js";
import { PolicyAwareRepository } from "./platform-repository-base.js";
import { boundedPageSize, pageFromRows, requiredText } from "./platform-support.js";
import type {
  CreateDataModelInput,
  CreateGraphInstanceInput,
  CreateModelViewInput,
  DataModelRecord,
  GraphInstanceRecord,
  ModelRepository,
  ModelViewRecord,
  ProjectAccessResolver,
  ProjectScope,
  TimestampIdCursor,
} from "./platform-types.js";
import type { KeysetPage, TransactionRunner } from "./types.js";

const DATA_MODEL_COLUMNS = [
  "data_model_id, tenant_id, project_id, space_id, external_id, version, name, description, definition,",
  "state, created_by, created_at, published_at",
].join(" ");

const MODEL_VIEW_COLUMNS = [
  "model_view_id, tenant_id, data_model_id, external_id, version, name, definition, created_at",
].join(" ");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, nested]) => JSON.stringify(key) + ":" + canonical(nested)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function sameDataModel(row: DataModelRecord, input: CreateDataModelInput): boolean {
  return row.dataModelId === input.dataModelId
    && row.spaceId === input.spaceId
    && row.externalId === input.externalId
    && row.version === input.version
    && row.name === input.name
    && row.description === (input.description ?? null)
    && row.state === (input.state ?? "draft")
    && canonical(row.definition) === canonical(input.definition);
}

function sameModelView(row: ModelViewRecord, input: CreateModelViewInput): boolean {
  return row.modelViewId === input.modelViewId
    && row.dataModelId === input.dataModelId
    && row.externalId === input.externalId
    && row.version === input.version
    && row.name === input.name
    && canonical(row.definition) === canonical(input.definition);
}

/** Immutable model/version operations and the graph instance anchor. */
export class PostgresModelRepository extends PolicyAwareRepository implements ModelRepository {
  constructor(runner: TransactionRunner, policy: ProjectAccessResolver) {
    super(runner, policy);
  }

  async createDataModel(scope: ProjectScope, input: CreateDataModelInput): Promise<DataModelRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const state = input.state ?? "draft";
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.data_models",
          "  (data_model_id, tenant_id, project_id, space_id, external_id, version, name, description, definition, state, created_by, published_at)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10, $11,",
          "        CASE WHEN $10 IN ('published', 'deprecated') THEN now() ELSE NULL END)",
          "ON CONFLICT (tenant_id, project_id, data_model_id) DO NOTHING",
          "RETURNING " + DATA_MODEL_COLUMNS,
        ].join("\n"),
        values: [
          input.dataModelId, scope.tenantId, scope.projectId, input.spaceId, input.externalId, input.version,
          input.name, input.description ?? null, json(input.definition), state, scope.userId,
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const model = dataModelFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.data_model_version_created", entityType: "dataModel", entityId: model.dataModelId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: model.externalId, version: model.version, state: model.state },
        });
        return model;
      }
      const existing = await transaction.query({
        text: "SELECT " + DATA_MODEL_COLUMNS + " FROM odf.data_models WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND data_model_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.dataModelId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Data model idempotency record could not be resolved");
      const model = dataModelFromRow(existingRow);
      if (!sameDataModel(model, input)) throw new ConflictError("Data model identifier is already bound to different input");
      return model;
    });
  }

  async listDataModels(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<DataModelRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + DATA_MODEL_COLUMNS,
          "FROM odf.data_models",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (created_at, data_model_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY created_at DESC, data_model_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, dataModelFromRow, (model) => ({ timestamp: model.createdAt, id: model.dataModelId }));
    });
  }

  async createModelView(scope: ProjectScope, input: CreateModelViewInput): Promise<ModelViewRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const model = await transaction.query({
        text: [
          "SELECT data_model_id FROM odf.data_models",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND data_model_id = $3::uuid",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, input.dataModelId],
      });
      if (!model.rows[0]) throw new NotFoundError("Data model was not found");
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.model_views (model_view_id, tenant_id, data_model_id, external_id, version, name, definition)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb)",
          "ON CONFLICT (tenant_id, model_view_id) DO NOTHING",
          "RETURNING " + MODEL_VIEW_COLUMNS,
        ].join("\n"),
        values: [input.modelViewId, scope.tenantId, input.dataModelId, input.externalId, input.version, input.name, json(input.definition)],
      });
      const row = inserted.rows[0];
      if (row) {
        const view = modelViewFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.model_view_created", entityType: "modelView", entityId: view.modelViewId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { dataModelId: view.dataModelId, externalId: view.externalId, version: view.version },
        });
        return view;
      }
      const existing = await transaction.query({
        text: "SELECT " + MODEL_VIEW_COLUMNS + " FROM odf.model_views WHERE tenant_id = $1::uuid AND model_view_id = $2::uuid",
        values: [scope.tenantId, input.modelViewId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Model view idempotency record could not be resolved");
      const view = modelViewFromRow(existingRow);
      if (!sameModelView(view, input)) throw new ConflictError("Model view identifier is already bound to different input");
      return view;
    });
  }

  async createGraphInstance(scope: ProjectScope, input: CreateGraphInstanceInput): Promise<GraphInstanceRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const result = await insertGraphInstanceIdempotent(transaction, scope, input);
      if (result.created) {
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.graph_instance_created", entityType: "graphInstance", entityId: result.graph.instanceId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: result.graph.externalId, instanceKind: result.graph.instanceKind, spaceId: result.graph.spaceId },
        });
      }
      return result.graph;
    });
  }
}
