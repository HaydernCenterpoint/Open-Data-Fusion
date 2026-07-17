import { normalizeModelView, normalizeModelViews } from "@open-data-fusion/platform-core";
import { ConflictError, NotFoundError } from "./errors.js";
import { appendPlatformAuditAndOutbox } from "./platform-events.js";
import { insertGraphInstanceIdempotent } from "./graph-helpers.js";
import { json } from "./mappers.js";
import {
  dataModelFromRow,
  modelViewFromRow,
  publicModelVersionFromRow,
} from "./platform-mappers.js";
import { PolicyAwareRepository } from "./platform-repository-base.js";
import { boundedPageSize, pageFromRows, requiredText } from "./platform-support.js";
import type {
  CreateDataModelInput,
  CreateGraphInstanceInput,
  CreateModelViewInput,
  CreatePublicModelVersionInput,
  CreatePublicModelViewInput,
  DataModelRecord,
  GraphInstanceRecord,
  ModelRepository,
  ModelVersionCursor,
  ModelViewRecord,
  ProjectAccessResolver,
  ProjectScope,
  PublicModelVersion,
  PublicModelView,
  PublicModelViewDefinition,
  TimestampIdCursor,
} from "./platform-types.js";
import type { JsonObject, KeysetPage, ScopedTransaction, TransactionRunner } from "./types.js";

const DATA_MODEL_COLUMNS = [
  "data_model_id, tenant_id, project_id, space_id, external_id, version, name, description, definition,",
  "state, created_by, created_at, published_at",
].join(" ");

const MODEL_VIEW_COLUMNS = [
  "model_view_id, tenant_id, data_model_id, external_id, version, name, definition, created_at",
].join(" ");

const PUBLIC_VERSION_PREDICATE = "version ~ '^[1-9][0-9]*$' AND length(version) <= 9";

async function setModelStatementTimeout(transaction: ScopedTransaction): Promise<void> {
  await transaction.query({
    text: "SELECT set_config('statement_timeout', $1, true)",
    values: ["5000ms"],
  });
}

function modelCursor(model: PublicModelVersion): ModelVersionCursor {
  return { createdAt: model.createdAt, modelId: model.id, version: model.version };
}

function publicView(record: ModelViewRecord, modelId: string, modelVersion: number): PublicModelView {
  const definition = normalizeModelView(record.definition as unknown as PublicModelViewDefinition);
  return {
    ...definition,
    modelId,
    modelVersion,
    createdAt: record.createdAt,
  };
}

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

  async createModelViewRecord(scope: ProjectScope, input: CreateModelViewInput): Promise<ModelViewRecord> {
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

  async listModelVersions(
    scope: ProjectScope,
    limit: number,
    cursor?: ModelVersionCursor,
  ): Promise<KeysetPage<PublicModelVersion, ModelVersionCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      await setModelStatementTimeout(transaction);
      const result = await transaction.query({
        text: [
          "SELECT " + DATA_MODEL_COLUMNS,
          "FROM odf.data_models",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND state IN ('draft', 'published') AND " + PUBLIC_VERSION_PREDICATE,
          "  AND ($3::timestamptz IS NULL OR (created_at, external_id, version::integer) < ($3::timestamptz, $4, $5::integer))",
          "ORDER BY created_at DESC, external_id DESC, version::integer DESC",
          "LIMIT $6",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.createdAt ?? null, cursor?.modelId ?? null, cursor?.version ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, publicModelVersionFromRow, modelCursor);
    });
  }

  async listVersionsForModel(
    scope: ProjectScope,
    modelIdInput: string,
    limit: number,
    cursor?: ModelVersionCursor,
  ): Promise<KeysetPage<PublicModelVersion, ModelVersionCursor>> {
    const modelId = requiredText(modelIdInput, "modelId");
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      await setModelStatementTimeout(transaction);
      const result = await transaction.query({
        text: [
          "SELECT " + DATA_MODEL_COLUMNS,
          "FROM odf.data_models",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3",
          "  AND state IN ('draft', 'published') AND " + PUBLIC_VERSION_PREDICATE,
          "  AND ($4::timestamptz IS NULL OR (created_at, version::integer) < ($4::timestamptz, $5::integer))",
          "ORDER BY created_at DESC, version::integer DESC",
          "LIMIT $6",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, modelId, cursor?.createdAt ?? null, cursor?.version ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, publicModelVersionFromRow, modelCursor);
    });
  }

  async getModelVersion(scope: ProjectScope, modelIdInput: string, version: number): Promise<PublicModelVersion> {
    const modelId = requiredText(modelIdInput, "modelId");
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("version must be a positive integer");
    return this.read(scope, async (transaction) => {
      await setModelStatementTimeout(transaction);
      const found = await transaction.query({
        text: [
          "SELECT " + DATA_MODEL_COLUMNS,
          "FROM odf.data_models",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3 AND version = $4",
          "  AND state IN ('draft', 'published')",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, modelId, String(version)],
      });
      if (!found.rows[0]) throw new NotFoundError("Model version was not found");
      return publicModelVersionFromRow(found.rows[0]);
    });
  }

  async createModelVersion(
    scope: ProjectScope,
    modelIdInput: string,
    input: CreatePublicModelVersionInput,
  ): Promise<PublicModelVersion> {
    const modelId = requiredText(modelIdInput, "modelId");
    const correlationId = requiredText(input.correlationId, "correlationId");
    const views = normalizeModelViews(input.views ?? []);
    const requestedStatus = input.status ?? "draft";
    if (requestedStatus === "published" && views.length === 0) {
      throw new ConflictError("A published model version requires at least one view");
    }
    return this.write(scope, async (transaction) => {
      await setModelStatementTimeout(transaction);
      const defaultSpace = await transaction.query({
        text: [
          "SELECT model_spaces.space_id",
          "FROM odf.model_spaces model_spaces",
          "WHERE model_spaces.tenant_id = $1::uuid AND model_spaces.project_id = $2::uuid",
          "ORDER BY model_spaces.created_at, model_spaces.space_id",
          "LIMIT 1",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId],
      });
      const spaceId = defaultSpace.rows[0]?.space_id;
      if (typeof spaceId !== "string") throw new NotFoundError("Project model space was not found");

      await transaction.query({
        text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        values: [`odf:model:${scope.tenantId}:${scope.projectId}:${modelId}`],
      });
      const allocation = await transaction.query({
        text: [
          "SELECT COALESCE(MAX(version::integer) FILTER (WHERE " + PUBLIC_VERSION_PREDICATE + "), 0) + 1 AS next_version",
          "FROM odf.data_models",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND space_id = $3::uuid AND external_id = $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, spaceId, modelId],
      });
      const version = Number(allocation.rows[0]?.next_version);
      if (!Number.isSafeInteger(version) || version < 1) throw new ConflictError("Model version could not be allocated");

      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.data_models",
          "  (tenant_id, project_id, space_id, external_id, version, name, definition, state, created_by)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, 'draft', $8)",
          "RETURNING " + DATA_MODEL_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, spaceId, modelId, String(version), input.name, json(input.schema), scope.userId],
      });
      const modelRow = inserted.rows[0];
      if (!modelRow) throw new ConflictError("Model version was not created");
      const dataModelId = String(modelRow.data_model_id);
      const createdViews: PublicModelView[] = [];
      for (const view of views) {
        const insertedView = await transaction.query({
          text: [
            "INSERT INTO odf.model_views (model_view_id, tenant_id, data_model_id, external_id, version, name, definition)",
            "VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)",
            "RETURNING " + MODEL_VIEW_COLUMNS,
          ].join("\n"),
          values: [scope.tenantId, dataModelId, view.externalId, String(version), view.name, json(view as unknown as JsonObject)],
        });
        const row = insertedView.rows[0];
        if (!row) throw new ConflictError("Model view was not created");
        createdViews.push(publicView(modelViewFromRow(row), modelId, version));
      }

      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: "platform.model_version_created",
        entityType: "dataModel",
        entityId: `${modelId}@${version}`,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId,
        details: { modelId, version, status: "draft" },
      });
      for (const view of createdViews) {
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId,
          action: "platform.model_view_created",
          entityType: "modelView",
          entityId: `${modelId}@${version}:${view.externalId}`,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          correlationId,
          details: { modelId, version, viewExternalId: view.externalId, usedFor: view.usedFor },
        });
      }

      let resultRow = modelRow;
      if (requestedStatus === "published") {
        const published = await transaction.query({
          text: [
            "UPDATE odf.data_models SET state = 'published'",
            "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND data_model_id = $3::uuid AND state = 'draft'",
            "RETURNING " + DATA_MODEL_COLUMNS,
          ].join("\n"),
          values: [scope.tenantId, scope.projectId, dataModelId],
        });
        if (!published.rows[0]) throw new ConflictError("Model version could not be published");
        resultRow = published.rows[0];
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId,
          action: "platform.model_version_published",
          entityType: "dataModel",
          entityId: `${modelId}@${version}`,
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          correlationId,
          details: { modelId, version },
        });
      }
      return publicModelVersionFromRow(resultRow);
    });
  }

  async listModelViews(scope: ProjectScope, modelIdInput: string, version: number): Promise<PublicModelView[]> {
    const modelId = requiredText(modelIdInput, "modelId");
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("version must be a positive integer");
    return this.read(scope, async (transaction) => {
      await setModelStatementTimeout(transaction);
      const model = await transaction.query({
        text: "SELECT data_model_id FROM odf.data_models WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3 AND version = $4 AND state IN ('draft', 'published')",
        values: [scope.tenantId, scope.projectId, modelId, String(version)],
      });
      const dataModelId = model.rows[0]?.data_model_id;
      if (typeof dataModelId !== "string") throw new NotFoundError("Model version was not found");
      const views = await transaction.query({
        text: "SELECT " + MODEL_VIEW_COLUMNS + " FROM odf.model_views WHERE tenant_id = $1::uuid AND data_model_id = $2::uuid ORDER BY created_at, external_id, model_view_id",
        values: [scope.tenantId, dataModelId],
      });
      return views.rows.map((row) => publicView(modelViewFromRow(row), modelId, version));
    });
  }

  async createModelView(
    scope: ProjectScope,
    modelIdInput: string,
    version: number,
    input: CreatePublicModelViewInput,
  ): Promise<PublicModelView> {
    const modelId = requiredText(modelIdInput, "modelId");
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("version must be a positive integer");
    const correlationId = requiredText(input.correlationId, "correlationId");
    const { correlationId: _correlationId, ...viewInput } = input;
    const view = normalizeModelView(viewInput);
    return this.write(scope, async (transaction) => {
      await setModelStatementTimeout(transaction);
      const model = await transaction.query({
        text: "SELECT " + DATA_MODEL_COLUMNS + " FROM odf.data_models WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3 AND version = $4 AND state IN ('draft', 'published')",
        values: [scope.tenantId, scope.projectId, modelId, String(version)],
      });
      const row = model.rows[0];
      if (!row) throw new NotFoundError("Model version was not found");
      const modelVersion = publicModelVersionFromRow(row);
      if (modelVersion.status !== "draft") throw new ConflictError("Published model versions are immutable");
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.model_views (model_view_id, tenant_id, data_model_id, external_id, version, name, definition)",
          "VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)",
          "ON CONFLICT (data_model_id, external_id, version) DO NOTHING",
          "RETURNING " + MODEL_VIEW_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, String(row.data_model_id), view.externalId, String(version), view.name, json(view as unknown as JsonObject)],
      });
      if (!inserted.rows[0]) throw new ConflictError("Model view already exists");
      const created = publicView(modelViewFromRow(inserted.rows[0]), modelId, version);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: "platform.model_view_created",
        entityType: "modelView",
        entityId: `${modelId}@${version}:${created.externalId}`,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId,
        details: { modelId, version, viewExternalId: created.externalId, usedFor: created.usedFor },
      });
      return created;
    });
  }

  async publishModelVersion(
    scope: ProjectScope,
    modelIdInput: string,
    version: number,
    correlationIdInput: string,
  ): Promise<PublicModelVersion> {
    const modelId = requiredText(modelIdInput, "modelId");
    if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("version must be a positive integer");
    const correlationId = requiredText(correlationIdInput, "correlationId");
    return this.write(scope, async (transaction) => {
      await setModelStatementTimeout(transaction);
      const model = await transaction.query({
        text: "SELECT " + DATA_MODEL_COLUMNS + " FROM odf.data_models WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3 AND version = $4 AND state IN ('draft', 'published')",
        values: [scope.tenantId, scope.projectId, modelId, String(version)],
      });
      const row = model.rows[0];
      if (!row) throw new NotFoundError("Model version was not found");
      if (publicModelVersionFromRow(row).status !== "draft") throw new ConflictError("Model version is already published");
      const viewCount = await transaction.query({
        text: "SELECT count(*)::integer AS view_count FROM odf.model_views WHERE tenant_id = $1::uuid AND data_model_id = $2::uuid",
        values: [scope.tenantId, String(row.data_model_id)],
      });
      if (Number(viewCount.rows[0]?.view_count) < 1) throw new ConflictError("A model version requires at least one view before publication");
      const published = await transaction.query({
        text: [
          "UPDATE odf.data_models SET state = 'published'",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND data_model_id = $3::uuid AND state = 'draft'",
          "RETURNING " + DATA_MODEL_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, String(row.data_model_id)],
      });
      if (!published.rows[0]) throw new ConflictError("Model version publication conflicted");
      const result = publicModelVersionFromRow(published.rows[0]);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: "platform.model_version_published",
        entityType: "dataModel",
        entityId: `${modelId}@${version}`,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId,
        details: { modelId, version },
      });
      return result;
    });
  }
}
