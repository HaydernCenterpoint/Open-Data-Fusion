import { ConflictError, NotFoundError } from "./errors.js";
import { appendPlatformAuditAndOutbox } from "./platform-events.js";
import {
  datasetFromRow,
  modelSpaceFromRow,
  projectFromRow,
  sourceConnectionFromRow,
  tenantFromRow,
} from "./platform-mappers.js";
import { PolicyAwareRepository } from "./platform-repository-base.js";
import {
  authorizeTenantManagement,
  boundedPageSize,
  cleanOptionalText,
  pageFromRows,
  requiredText,
} from "./platform-support.js";
import { json } from "./mappers.js";
import type {
  CatalogRepository,
  CreateDatasetInput,
  CreateModelSpaceInput,
  CreateProjectInput,
  CreateSourceConnectionInput,
  DatasetRecord,
  ModelSpaceRecord,
  ProjectRecord,
  SourceConnectionRecord,
  TenantProjectRepository,
  TenantRecord,
  TenantScope,
  TextCursor,
  TimestampIdCursor,
  UpdateProjectInput,
  ProjectScope,
} from "./platform-types.js";
import type { KeysetPage, TransactionRunner } from "./types.js";
import type { ProjectAccessResolver } from "./platform-types.js";

const TENANT_COLUMNS = "tenant_id, slug, name, status, created_at, updated_at";
const PROJECT_COLUMNS = "project_id, tenant_id, slug, name, description, status, created_at, updated_at";
const DATASET_COLUMNS = "dataset_id, tenant_id, project_id, external_id, name, description, classification, retention_until, created_at, updated_at";
const MODEL_SPACE_COLUMNS = "space_id, tenant_id, project_id, external_id, name, description, created_at, updated_at";
const SOURCE_CONNECTION_COLUMNS = [
  "source_connection_id, tenant_id, project_id, dataset_id, external_id, name, connector_kind, state,",
  "endpoint, secret_ref, connector_config, last_successful_run_at, created_at, updated_at",
].join(" ");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, nested]) => JSON.stringify(key) + ":" + canonical(nested)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function sameProject(row: ProjectRecord, input: CreateProjectInput): boolean {
  return row.projectId === input.projectId
    && row.slug === input.slug
    && row.name === input.name
    && row.description === (input.description ?? null)
    && row.status === (input.status ?? "active");
}

function sameDataset(row: DatasetRecord, input: CreateDatasetInput): boolean {
  return row.datasetId === input.datasetId
    && row.externalId === input.externalId
    && row.name === input.name
    && row.description === (input.description ?? null)
    && row.classification === (input.classification ?? "internal")
    && row.retentionUntil === (input.retentionUntil ?? null);
}

function sameModelSpace(row: ModelSpaceRecord, input: CreateModelSpaceInput): boolean {
  return row.spaceId === input.spaceId
    && row.externalId === input.externalId
    && row.name === input.name
    && row.description === (input.description ?? null);
}

function sameSourceConnection(row: SourceConnectionRecord, input: CreateSourceConnectionInput): boolean {
  return row.sourceConnectionId === input.sourceConnectionId
    && row.datasetId === (input.datasetId ?? null)
    && row.externalId === input.externalId
    && row.name === input.name
    && row.connectorKind === input.connectorKind
    && row.state === (input.state ?? "draft")
    && row.endpoint === (input.endpoint ?? null)
    && row.secretRef === (input.secretRef ?? null)
    && canonical(row.connectorConfig) === canonical(input.connectorConfig ?? {});
}

/**
 * Covers tenant/project metadata plus datasets, model spaces, and connector
 * configurations. Project membership is deliberately delegated to the
 * injected policy because migration 003 has no membership relation.
 */
export class PostgresCatalogRepository extends PolicyAwareRepository implements TenantProjectRepository, CatalogRepository {
  constructor(runner: TransactionRunner, policy: ProjectAccessResolver) {
    super(runner, policy);
  }

  async getTenant(scope: TenantScope): Promise<TenantRecord> {
    requiredText(scope.tenantId, "tenantId");
    return this.runner.withTransaction(scope, async (transaction) => {
      const result = await transaction.query({
        text: "SELECT " + TENANT_COLUMNS + " FROM odf.tenants WHERE tenant_id = $1::uuid",
        values: [scope.tenantId],
      });
      const row = result.rows[0];
      if (!row) throw new NotFoundError("Tenant was not found");
      return tenantFromRow(row);
    });
  }

  async getProject(scope: ProjectScope): Promise<ProjectRecord> {
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + PROJECT_COLUMNS,
          "FROM odf.projects",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId],
      });
      const row = result.rows[0];
      if (!row) throw new NotFoundError("Project was not found");
      return projectFromRow(row);
    });
  }

  async listProjects(
    scope: TenantScope,
    limit: number,
    cursor?: TimestampIdCursor,
  ): Promise<KeysetPage<ProjectRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    await authorizeTenantManagement(this.policy, scope);
    return this.runner.withTransaction(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + PROJECT_COLUMNS,
          "FROM odf.projects",
          "WHERE tenant_id = $1::uuid",
          "  AND ($2::timestamptz IS NULL OR (created_at, project_id) < ($2::timestamptz, $3::uuid))",
          "ORDER BY created_at DESC, project_id DESC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, projectFromRow, (project) => ({ timestamp: project.createdAt, id: project.projectId }));
    });
  }

  async createProject(scope: TenantScope, input: CreateProjectInput): Promise<ProjectRecord> {
    requiredText(input.correlationId, "correlationId");
    await authorizeTenantManagement(this.policy, scope);
    return this.runner.withTransaction(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.projects (project_id, tenant_id, slug, name, description, status)",
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)",
          "ON CONFLICT (tenant_id, project_id) DO NOTHING",
          "RETURNING " + PROJECT_COLUMNS,
        ].join("\n"),
        values: [input.projectId, scope.tenantId, input.slug, input.name, cleanOptionalText(input.description), input.status ?? "active"],
      });
      const row = inserted.rows[0];
      if (row) {
        const project = projectFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.project_created", entityType: "project", entityId: project.projectId,
          tenantId: scope.tenantId, projectId: project.projectId, correlationId: input.correlationId,
          details: { slug: project.slug, name: project.name, status: project.status },
        });
        return project;
      }
      const existing = await transaction.query({
        text: "SELECT " + PROJECT_COLUMNS + " FROM odf.projects WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
        values: [scope.tenantId, input.projectId],
      });
      const projectRow = existing.rows[0];
      if (!projectRow) throw new ConflictError("Project idempotency record could not be resolved");
      const project = projectFromRow(projectRow);
      if (!sameProject(project, input)) throw new ConflictError("Project identifier is already bound to different input");
      return project;
    });
  }

  async updateProject(scope: ProjectScope, input: UpdateProjectInput): Promise<ProjectRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "UPDATE odf.projects",
          "SET name = COALESCE($3, name),",
          "    description = CASE WHEN $4::boolean THEN $5 ELSE description END,",
          "    status = COALESCE($6, status),",
          "    updated_at = now()",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "RETURNING " + PROJECT_COLUMNS,
        ].join("\n"),
        values: [
          scope.tenantId, input.projectId, input.name ?? null,
          input.description !== undefined, cleanOptionalText(input.description), input.status ?? null,
        ],
      });
      const row = result.rows[0];
      if (!row) throw new NotFoundError("Project was not found");
      const project = projectFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.project_updated", entityType: "project", entityId: project.projectId,
        tenantId: scope.tenantId, projectId: project.projectId, correlationId: input.correlationId,
        details: { name: project.name, status: project.status },
      });
      return project;
    });
  }

  async resolveMember(scope: ProjectScope, allowedRoles?: readonly import("./platform-types.js").ProjectRole[]): Promise<import("./platform-types.js").ProjectRole> {
    return this.resolveRole(scope, allowedRoles);
  }

  async listDatasets(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<DatasetRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + DATASET_COLUMNS,
          "FROM odf.datasets",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (created_at, dataset_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY created_at DESC, dataset_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, datasetFromRow, (dataset) => ({ timestamp: dataset.createdAt, id: dataset.datasetId }));
    });
  }

  async createDataset(scope: ProjectScope, input: CreateDatasetInput): Promise<DatasetRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.datasets (dataset_id, tenant_id, project_id, external_id, name, description, classification, retention_until)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::timestamptz)",
          "ON CONFLICT (tenant_id, project_id, dataset_id) DO NOTHING",
          "RETURNING " + DATASET_COLUMNS,
        ].join("\n"),
        values: [input.datasetId, scope.tenantId, scope.projectId, input.externalId, input.name, cleanOptionalText(input.description), input.classification ?? "internal", input.retentionUntil ?? null],
      });
      const row = inserted.rows[0];
      if (row) {
        const dataset = datasetFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.dataset_created", entityType: "dataset", entityId: dataset.datasetId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: dataset.externalId, classification: dataset.classification },
        });
        return dataset;
      }
      const existing = await transaction.query({
        text: "SELECT " + DATASET_COLUMNS + " FROM odf.datasets WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND dataset_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.datasetId],
      });
      const datasetRow = existing.rows[0];
      if (!datasetRow) throw new ConflictError("Dataset idempotency record could not be resolved");
      const dataset = datasetFromRow(datasetRow);
      if (!sameDataset(dataset, input)) throw new ConflictError("Dataset identifier is already bound to different input");
      return dataset;
    });
  }

  async listModelSpaces(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<ModelSpaceRecord, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + MODEL_SPACE_COLUMNS,
          "FROM odf.model_spaces",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND space_id > $3::uuid",
          "ORDER BY space_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "00000000-0000-0000-0000-000000000000", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, modelSpaceFromRow, (space) => ({ value: space.spaceId }));
    });
  }

  async createModelSpace(scope: ProjectScope, input: CreateModelSpaceInput): Promise<ModelSpaceRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.model_spaces (space_id, tenant_id, project_id, external_id, name, description)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)",
          "ON CONFLICT (tenant_id, project_id, space_id) DO NOTHING",
          "RETURNING " + MODEL_SPACE_COLUMNS,
        ].join("\n"),
        values: [input.spaceId, scope.tenantId, scope.projectId, input.externalId, input.name, cleanOptionalText(input.description)],
      });
      const row = inserted.rows[0];
      if (row) {
        const space = modelSpaceFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.model_space_created", entityType: "modelSpace", entityId: space.spaceId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: space.externalId, name: space.name },
        });
        return space;
      }
      const existing = await transaction.query({
        text: "SELECT " + MODEL_SPACE_COLUMNS + " FROM odf.model_spaces WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND space_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.spaceId],
      });
      const spaceRow = existing.rows[0];
      if (!spaceRow) throw new ConflictError("Model space idempotency record could not be resolved");
      const space = modelSpaceFromRow(spaceRow);
      if (!sameModelSpace(space, input)) throw new ConflictError("Model space identifier is already bound to different input");
      return space;
    });
  }

  async listSourceConnections(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<SourceConnectionRecord, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + SOURCE_CONNECTION_COLUMNS,
          "FROM odf.source_connections",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND source_connection_id > $3::uuid",
          "ORDER BY source_connection_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "00000000-0000-0000-0000-000000000000", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, sourceConnectionFromRow, (source) => ({ value: source.sourceConnectionId }));
    });
  }

  async createSourceConnection(scope: ProjectScope, input: CreateSourceConnectionInput): Promise<SourceConnectionRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.source_connections",
          "  (source_connection_id, tenant_id, project_id, dataset_id, external_id, name, connector_kind, state, endpoint, secret_ref, connector_config)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11::jsonb)",
          "ON CONFLICT (tenant_id, project_id, source_connection_id) DO NOTHING",
          "RETURNING " + SOURCE_CONNECTION_COLUMNS,
        ].join("\n"),
        values: [
          input.sourceConnectionId, scope.tenantId, scope.projectId, input.datasetId ?? null, input.externalId, input.name,
          input.connectorKind, input.state ?? "draft", cleanOptionalText(input.endpoint), cleanOptionalText(input.secretRef), json(input.connectorConfig ?? {}),
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const source = sourceConnectionFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.source_connection_created", entityType: "sourceConnection", entityId: source.sourceConnectionId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: source.externalId, connectorKind: source.connectorKind, state: source.state },
        });
        return source;
      }
      const existing = await transaction.query({
        text: "SELECT " + SOURCE_CONNECTION_COLUMNS + " FROM odf.source_connections WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND source_connection_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.sourceConnectionId],
      });
      const sourceRow = existing.rows[0];
      if (!sourceRow) throw new ConflictError("Source connection idempotency record could not be resolved");
      const source = sourceConnectionFromRow(sourceRow);
      if (!sameSourceConnection(source, input)) throw new ConflictError("Source connection identifier is already bound to different input");
      return source;
    });
  }
}
