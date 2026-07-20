import { createHash, randomUUID } from 'node:crypto';

import type { WritebackRequest, WritebackRisk } from '@open-data-fusion/contracts';
import {
  appendPlatformAuditAndOutbox,
  ConflictError as RuntimeConflictError,
  DatabaseUnavailableError as RuntimeDatabaseUnavailableError,
  ForbiddenError as RuntimeForbiddenError,
  NotFoundError as RuntimeNotFoundError,
  type JsonObject,
  type PostgresRuntime,
  type ProjectRole,
  type ScopedTransaction,
} from '@open-data-fusion/postgres-runtime';
import { evaluateWritebackSafety, type WritebackSafetyPolicy } from '@open-data-fusion/platform-core';
import { z } from 'zod';

import type {
  WritebackApprovalCreate,
  WritebackRequestCreate,
} from './advanced-platform-schemas.js';
import type { IndustrialWritebackExecution } from './advanced-platform.js';
import { ConflictError, ForbiddenError, NotFoundError } from './database.js';
import type {
  CandidateCreate,
  CandidateReview,
  CursorListQuery,
  DataModelVersionCreate,
  PipelineCreate,
  PipelineRunTrigger,
  PlatformContext,
  QualityRuleCreate,
} from './platform-schemas.js';

type Row = Record<string, unknown>;
type Scope = PlatformContext & { userId: string };

const uuidSchema = z.string().uuid();
const modelCursorSchema = z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict();
const textCursorSchema = z.object({ id: z.string().min(1) }).strict();
const numericCursorSchema = z.object({ id: z.number().int().nonnegative() }).strict();

const readRoles: readonly ProjectRole[] = ['owner', 'editor', 'reviewer', 'viewer'];
const writeRoles: readonly ProjectRole[] = ['owner', 'editor'];
const reviewRoles: readonly ProjectRole[] = ['owner', 'editor', 'reviewer'];
const approvalRoles: readonly ProjectRole[] = ['owner', 'reviewer'];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode<T>(cursor: string | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (!cursor) return fallback;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // Zod supplies the request-shape error below.
  }
  return schema.parse(parsed);
}

function scope(context: PlatformContext, userId: string): Scope {
  return {
    tenantId: uuidSchema.parse(context.tenantId),
    projectId: uuidSchema.parse(context.projectId),
    userId: z.string().trim().min(1).max(512).parse(userId),
  };
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new TypeError(`PostgreSQL returned invalid ${key}`);
  return value;
}

function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function boolean(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new TypeError(`PostgreSQL returned invalid ${key}`);
  return value;
}

function number(row: Row, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new TypeError(`PostgreSQL returned invalid ${key}`);
  return value;
}

function timestamp(row: Row, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new TypeError(`PostgreSQL returned invalid ${key}`);
  return date.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('PostgreSQL returned invalid JSON object');
  return parsed as Record<string, unknown>;
}

function jsonValues(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new TypeError('PostgreSQL returned invalid JSON array');
  return parsed;
}

function valueAtPath(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function runtimeError(error: unknown): Error {
  if (error instanceof RuntimeForbiddenError) return new ForbiddenError(error.message);
  if (error instanceof RuntimeNotFoundError) return new NotFoundError(error.message);
  if (error instanceof RuntimeConflictError) return new ConflictError(error.message);
  if (error instanceof RuntimeDatabaseUnavailableError) return error;
  return error instanceof Error ? error : new Error('PostgreSQL platform compatibility operation failed');
}

function asJson(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

function nonApprovalReasons(decision: ReturnType<typeof evaluateWritebackSafety>): string[] {
  return decision.reasons.filter((reason) => !/distinct non-requester approval\(s\) required$/u.test(reason));
}

export interface PostgresPlatformCompatibilityPersistence {
  readonly mode: 'postgres';
  assertReady(): Promise<void>;
  listDataModels(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createDataModelVersion(context: PlatformContext, userId: string, modelId: string, input: DataModelVersionCreate, correlationId: string): Promise<Record<string, unknown>>;
  listPipelines(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createPipeline(context: PlatformContext, userId: string, input: PipelineCreate, correlationId: string): Promise<Record<string, unknown>>;
  triggerPipelineRun(context: PlatformContext, userId: string, pipelineId: string, input: PipelineRunTrigger, correlationId: string): Promise<Record<string, unknown>>;
  listPipelineRuns(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  listQualityRules(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createQualityRule(context: PlatformContext, userId: string, input: QualityRuleCreate, correlationId: string): Promise<Record<string, unknown>>;
  listQualityResults(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  listCandidates(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createCandidate(context: PlatformContext, userId: string, input: CandidateCreate, correlationId: string): Promise<Record<string, unknown>>;
  reviewCandidate(context: PlatformContext, userId: string, candidateId: string, input: CandidateReview, correlationId: string): Promise<Record<string, unknown>>;
  listWritebackRequests(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
  createWritebackRequest(context: PlatformContext, userId: string, input: WritebackRequestCreate, correlationId: string): Promise<Record<string, unknown>>;
  approveWritebackRequest(context: PlatformContext, userId: string, requestId: string, input: WritebackApprovalCreate, correlationId: string): Promise<Record<string, unknown>>;
  assertWritebackExecutable(context: PlatformContext, userId: string, requestId: string): Promise<void>;
  beginWritebackExecution(context: PlatformContext, userId: string, requestId: string, correlationId: string): Promise<IndustrialWritebackExecution>;
  recordUnavailableExecutor(context: PlatformContext, userId: string, requestId: string, correlationId: string): Promise<void>;
  completeWritebackExecution(context: PlatformContext, userId: string, requestId: string, correlationId: string, outcome: { succeeded: true; result: Record<string, unknown> } | { succeeded: false; error: string }): Promise<Record<string, unknown>>;
  listWritebackEvents(context: PlatformContext, userId: string, requestId: string, query: CursorListQuery): Promise<Record<string, unknown>>;
}

/**
 * Preserves the public v1 platform records in the PostgreSQL data plane. The
 * compatibility tables are scoped by forced RLS and are never mirrored to
 * local SQLite files.
 */
export class PostgresPlatformCompatibilityStore implements PostgresPlatformCompatibilityPersistence {
  readonly mode = 'postgres' as const;

  constructor(
    private readonly runtime: PostgresRuntime,
    private readonly writebackPolicy: WritebackSafetyPolicy,
  ) {}

  async assertReady(): Promise<void> {
    try {
      const result = await this.runtime.withTransaction({ tenantId: null, userId: 'odf-api-platform-compatibility-readiness' }, (transaction) => transaction.query<Row>({
        text: [
          'SELECT (',
          "  to_regclass('odf.platform_legacy_model_versions') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_pipelines') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_pipeline_runs') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_quality_rules') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_quality_results') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_context_candidates') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_writeback_requests') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_writeback_approvals') IS NOT NULL",
          "  AND to_regclass('odf.platform_legacy_writeback_events') IS NOT NULL",
          "  AND to_regclass('odf.model_spaces') IS NOT NULL",
          "  AND to_regclass('odf.data_models') IS NOT NULL",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_model_versions', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_model_versions', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.model_spaces', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.data_models', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_pipelines', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_pipelines', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_pipeline_runs', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_pipeline_runs', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_pipeline_runs', 'UPDATE')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_quality_rules', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_quality_rules', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_quality_results', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_quality_results', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_context_candidates', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_context_candidates', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_context_candidates', 'UPDATE')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_writeback_requests', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_writeback_requests', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_writeback_requests', 'UPDATE')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_writeback_approvals', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_writeback_approvals', 'INSERT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_writeback_events', 'SELECT')",
          "  AND has_table_privilege(current_user, 'odf.platform_legacy_writeback_events', 'INSERT')",
          ') AS ready',
        ].join('\n'),
      }));
      if (result.rows[0]?.ready !== true) throw new Error('PostgreSQL platform compatibility migration is not ready');
    } catch (error) { throw runtimeError(error); }
  }

  async listDataModels(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, modelCursorSchema, { id: '', version: 0 });
    return this.read(requestScope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: `SELECT tenant_id::text, project_id::text, model_id, version, name, schema_json, status, created_by, created_at
          FROM odf.platform_legacy_model_versions
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
            AND (model_id > $3 OR (model_id = $3 AND version > $4))
          ORDER BY model_id ASC, version ASC LIMIT $5`,
        values: [requestScope.tenantId, requestScope.projectId, cursor.id, cursor.version, query.limit + 1],
      });
      return this.page(result.rows, query.limit, (row) => this.model(row), (row) => ({ id: text(row, 'model_id'), version: number(row, 'version') }));
    });
  }

  async createDataModelVersion(context: PlatformContext, userId: string, modelId: string, input: DataModelVersionCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, writeRoles, async (transaction) => {
      await transaction.query({ text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', values: [`odf:legacy-model:${requestScope.tenantId}:${requestScope.projectId}:${modelId}`] });
      const selectedSpace = await transaction.query<Row>({
        text: `SELECT space_id::text
          FROM odf.model_spaces
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid
          ORDER BY created_at ASC, space_id ASC LIMIT 1`,
        values: [requestScope.tenantId, requestScope.projectId],
      });
      const spaceRow = selectedSpace.rows[0];
      if (!spaceRow) throw new NotFoundError('Project model space was not found');
      const spaceId = text(spaceRow, 'space_id');
      const next = await transaction.query<Row>({
        text: 'SELECT COALESCE(max(version), 0) + 1 AS version FROM odf.platform_legacy_model_versions WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND model_id = $3',
        values: [requestScope.tenantId, requestScope.projectId, modelId],
      });
      const version = number(next.rows[0] ?? {}, 'version');
      const inserted = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_model_versions
          (tenant_id, project_id, model_id, version, name, schema_json, status, created_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8)
          RETURNING tenant_id::text, project_id::text, model_id, version, name, schema_json, status, created_by, created_at`,
        values: [requestScope.tenantId, requestScope.projectId, modelId, version, input.name, JSON.stringify(input.schema), input.status, requestScope.userId],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError('Data-model version could not be created');
      const createdAt = timestamp(row, 'created_at');
      const normalized = await transaction.query<Row>({
        text: `INSERT INTO odf.data_models
          (tenant_id, project_id, space_id, external_id, version, name, definition, state, created_by, created_at, published_at)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb, $8, $9, $10::timestamptz,
            CASE WHEN $8 = 'published' THEN $10::timestamptz ELSE NULL END)
          ON CONFLICT (space_id, external_id, version) DO NOTHING
          RETURNING data_model_id::text`,
        values: [
          requestScope.tenantId,
          requestScope.projectId,
          spaceId,
          modelId,
          String(version),
          input.name,
          JSON.stringify(input.schema),
          input.status,
          requestScope.userId,
          createdAt,
        ],
      });
      if (!normalized.rows[0]) throw new ConflictError(`Data-model '${modelId}@${version}' already exists in normalized storage`);
      const model = this.model(row);
      await this.audit(transaction, requestScope, 'platform.data_model_version_created', 'dataModel', `${modelId}@${version}`, correlationId, { modelId, version, name: input.name, status: input.status });
      return model;
    });
  }

  async listPipelines(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, textCursorSchema, { id: '' });
    return this.read(requestScope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: `SELECT tenant_id::text, project_id::text, pipeline_id, name, source_id, dataset_id, definition_json, version, enabled, created_by, created_at
          FROM odf.platform_legacy_pipelines
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_id > $3
          ORDER BY pipeline_id ASC LIMIT $4`,
        values: [requestScope.tenantId, requestScope.projectId, cursor.id, query.limit + 1],
      });
      return this.page(result.rows, query.limit, (row) => this.pipeline(row), (row) => ({ id: text(row, 'pipeline_id') }));
    });
  }

  async createPipeline(context: PlatformContext, userId: string, input: PipelineCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, writeRoles, async (transaction) => {
      await this.assertSourceAndDataset(transaction, requestScope, input.sourceId ?? null, input.datasetId ?? null);
      const inserted = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_pipelines
          (tenant_id, project_id, pipeline_id, name, source_id, dataset_id, definition_json, enabled, created_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9)
          ON CONFLICT (tenant_id, project_id, pipeline_id) DO NOTHING
          RETURNING tenant_id::text, project_id::text, pipeline_id, name, source_id, dataset_id, definition_json, version, enabled, created_by, created_at`,
        values: [requestScope.tenantId, requestScope.projectId, input.id, input.name, input.sourceId ?? null, input.datasetId ?? null, JSON.stringify(input.definition), input.enabled, requestScope.userId],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError(`Pipeline '${input.id}' already exists`);
      const pipeline = this.pipeline(row);
      await this.audit(transaction, requestScope, 'platform.pipeline_created', 'pipeline', input.id, correlationId, { sourceId: input.sourceId ?? null, datasetId: input.datasetId ?? null });
      return pipeline;
    });
  }

  async triggerPipelineRun(context: PlatformContext, userId: string, pipelineId: string, input: PipelineRunTrigger, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, writeRoles, async (transaction) => {
      await transaction.query({ text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', values: [`odf:legacy-pipeline-run:${requestScope.tenantId}:${requestScope.projectId}:${pipelineId}:${input.idempotencyKey}`] });
      const pipelineResult = await transaction.query<Row>({
        text: `SELECT pipeline_id, version, enabled FROM odf.platform_legacy_pipelines
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_id = $3`,
        values: [requestScope.tenantId, requestScope.projectId, pipelineId],
      });
      const pipeline = pipelineResult.rows[0];
      if (!pipeline) throw new NotFoundError(`Pipeline '${pipelineId}' was not found`);
      if (!boolean(pipeline, 'enabled')) throw new ConflictError(`Pipeline '${pipelineId}' is disabled`);
      const inputHash = createHash('sha256').update(canonical({ pipelineVersion: number(pipeline, 'version'), input: input.input })).digest('hex');
      const previous = await transaction.query<Row>({
        text: `SELECT tenant_id::text, project_id::text, run_id, pipeline_id, idempotency_key, input_hash, input_json, status, result_json, triggered_by, started_at, completed_at
          FROM odf.platform_legacy_pipeline_runs
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_id = $3 AND idempotency_key = $4`,
        values: [requestScope.tenantId, requestScope.projectId, pipelineId, input.idempotencyKey],
      });
      if (previous.rows[0]) {
        const row = previous.rows[0];
        if (text(row, 'input_hash') !== inputHash) throw new ConflictError(`Pipeline run key '${input.idempotencyKey}' was already used with different input`);
        return this.pipelineRun(row, true);
      }
      const runId = `run-${createHash('sha256').update(`${requestScope.tenantId}:${requestScope.projectId}:${pipelineId}:${input.idempotencyKey}`).digest('hex').slice(0, 32)}`;
      const inserted = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_pipeline_runs
          (tenant_id, project_id, run_id, pipeline_id, idempotency_key, input_hash, input_json, status, result_json, triggered_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, 'processing', '{}'::jsonb, $8)
          RETURNING tenant_id::text, project_id::text, run_id, pipeline_id, idempotency_key, input_hash, input_json, status, result_json, triggered_by, started_at, completed_at`,
        values: [requestScope.tenantId, requestScope.projectId, runId, pipelineId, input.idempotencyKey, inputHash, JSON.stringify(input.input), requestScope.userId],
      });
      if (!inserted.rows[0]) throw new ConflictError('Pipeline run could not be created');
      const quality = await this.evaluateQuality(transaction, requestScope, runId, input.input);
      const result = { fingerprint: inputHash, quality };
      const completed = await transaction.query<Row>({
        text: `UPDATE odf.platform_legacy_pipeline_runs
          SET status = 'completed', result_json = $4::jsonb, completed_at = now()
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND run_id = $3 AND status = 'processing'
          RETURNING tenant_id::text, project_id::text, run_id, pipeline_id, idempotency_key, input_hash, input_json, status, result_json, triggered_by, started_at, completed_at`,
        values: [requestScope.tenantId, requestScope.projectId, runId, JSON.stringify(result)],
      });
      const row = completed.rows[0];
      if (!row) throw new ConflictError('Pipeline run completion lost its processing state');
      await this.audit(transaction, requestScope, 'platform.pipeline_run_completed', 'pipelineRun', runId, correlationId, { pipelineId, idempotencyKey: input.idempotencyKey, inputHash, quality });
      return this.pipelineRun(row, false);
    });
  }

  async listPipelineRuns(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, textCursorSchema, { id: '' });
    return this.read(requestScope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: `SELECT tenant_id::text, project_id::text, run_id, pipeline_id, idempotency_key, input_hash, input_json, status, result_json, triggered_by, started_at, completed_at
          FROM odf.platform_legacy_pipeline_runs
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND run_id > $3
          ORDER BY run_id ASC LIMIT $4`,
        values: [requestScope.tenantId, requestScope.projectId, cursor.id, query.limit + 1],
      });
      return this.page(result.rows, query.limit, (row) => this.pipelineRun(row, false), (row) => ({ id: text(row, 'run_id') }));
    });
  }

  async listQualityRules(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, textCursorSchema, { id: '' });
    return this.read(requestScope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: `SELECT tenant_id::text, project_id::text, rule_id, name, target_type, check_json, severity, enabled, created_by, created_at
          FROM odf.platform_legacy_quality_rules
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND rule_id > $3
          ORDER BY rule_id ASC LIMIT $4`,
        values: [requestScope.tenantId, requestScope.projectId, cursor.id, query.limit + 1],
      });
      return this.page(result.rows, query.limit, (row) => this.qualityRule(row), (row) => ({ id: text(row, 'rule_id') }));
    });
  }

  async createQualityRule(context: PlatformContext, userId: string, input: QualityRuleCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, writeRoles, async (transaction) => {
      const inserted = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_quality_rules
          (tenant_id, project_id, rule_id, name, target_type, check_json, severity, enabled, created_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8, $9)
          ON CONFLICT (tenant_id, project_id, rule_id) DO NOTHING
          RETURNING tenant_id::text, project_id::text, rule_id, name, target_type, check_json, severity, enabled, created_by, created_at`,
        values: [requestScope.tenantId, requestScope.projectId, input.id, input.name, input.targetType, JSON.stringify(input.check), input.severity, input.enabled, requestScope.userId],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError(`Quality rule '${input.id}' already exists`);
      const rule = this.qualityRule(row);
      await this.audit(transaction, requestScope, 'platform.quality_rule_created', 'qualityRule', input.id, correlationId, { targetType: input.targetType, severity: input.severity });
      return rule;
    });
  }

  async listQualityResults(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, numericCursorSchema, { id: 0 });
    return this.read(requestScope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: `SELECT result_id, tenant_id::text, project_id::text, rule_id, run_id, passed, observed_json, evaluated_at
          FROM odf.platform_legacy_quality_results
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND result_id > $3::bigint
          ORDER BY result_id ASC LIMIT $4`,
        values: [requestScope.tenantId, requestScope.projectId, cursor.id, query.limit + 1],
      });
      return this.page(result.rows, query.limit, (row) => this.qualityResult(row), (row) => ({ id: number(row, 'result_id') }));
    });
  }

  async listCandidates(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, textCursorSchema, { id: '' });
    return this.read(requestScope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: `SELECT tenant_id::text, project_id::text, candidate_id, source_type, source_id, target_type, target_id, relation_type, confidence, evidence_json, status, reviewed_by, review_comment, reviewed_at, created_by, created_at
          FROM odf.platform_legacy_context_candidates
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND candidate_id > $3
          ORDER BY candidate_id ASC LIMIT $4`,
        values: [requestScope.tenantId, requestScope.projectId, cursor.id, query.limit + 1],
      });
      return this.page(result.rows, query.limit, (row) => this.candidate(row), (row) => ({ id: text(row, 'candidate_id') }));
    });
  }

  async createCandidate(context: PlatformContext, userId: string, input: CandidateCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const candidateId = input.id ?? randomUUID();
    return this.write(requestScope, writeRoles, async (transaction) => {
      const inserted = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_context_candidates
          (tenant_id, project_id, candidate_id, source_type, source_id, target_type, target_id, relation_type, confidence, evidence_json, status, created_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'proposed', $11)
          ON CONFLICT (tenant_id, project_id, candidate_id) DO NOTHING
          RETURNING tenant_id::text, project_id::text, candidate_id, source_type, source_id, target_type, target_id, relation_type, confidence, evidence_json, status, reviewed_by, review_comment, reviewed_at, created_by, created_at`,
        values: [requestScope.tenantId, requestScope.projectId, candidateId, input.source.type, input.source.id, input.target.type, input.target.id, input.relationType, input.confidence, JSON.stringify(input.evidence), requestScope.userId],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError(`Contextualization candidate '${candidateId}' already exists`);
      const candidate = this.candidate(row);
      await this.audit(transaction, requestScope, 'platform.context_candidate_created', 'contextCandidate', candidateId, correlationId, { relationType: input.relationType, confidence: input.confidence });
      return candidate;
    });
  }

  async reviewCandidate(context: PlatformContext, userId: string, candidateId: string, input: CandidateReview, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, reviewRoles, async (transaction) => {
      const updated = await transaction.query<Row>({
        text: `UPDATE odf.platform_legacy_context_candidates
          SET status = $4, reviewed_by = $5, review_comment = $6, reviewed_at = now()
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND candidate_id = $3 AND status = 'proposed'
          RETURNING tenant_id::text, project_id::text, candidate_id, source_type, source_id, target_type, target_id, relation_type, confidence, evidence_json, status, reviewed_by, review_comment, reviewed_at, created_by, created_at`,
        values: [requestScope.tenantId, requestScope.projectId, candidateId, input.decision, requestScope.userId, input.comment ?? null],
      });
      const row = updated.rows[0];
      if (!row) throw new ConflictError(`Contextualization candidate '${candidateId}' is not proposed`);
      const candidate = this.candidate(row);
      await this.audit(transaction, requestScope, `platform.context_candidate_${input.decision}`, 'contextCandidate', candidateId, correlationId, { comment: input.comment ?? null });
      return candidate;
    });
  }

  async listWritebackRequests(context: PlatformContext, userId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, textCursorSchema, { id: '' });
    return this.read(requestScope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: `SELECT tenant_id::text, project_id::text, request_id, source_id, target_external_id, operation, payload_json, risk, state, dry_run_json, blocked_reasons_json, requested_by, requested_at, executed_at, execution_result_json, updated_at
          FROM odf.platform_legacy_writeback_requests
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND request_id > $3
          ORDER BY request_id ASC LIMIT $4`,
        values: [requestScope.tenantId, requestScope.projectId, cursor.id, query.limit + 1],
      });
      const items: Record<string, unknown>[] = [];
      for (const row of result.rows.slice(0, query.limit)) items.push(await this.writeback(transaction, requestScope, row));
      const tail = result.rows.length > query.limit ? result.rows[query.limit - 1] : undefined;
      return { items, nextCursor: tail ? encodeCursor({ id: text(tail, 'request_id') }) : null };
    });
  }

  async createWritebackRequest(context: PlatformContext, userId: string, input: WritebackRequestCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const requestId = input.id ?? randomUUID();
    return this.write(requestScope, writeRoles, async (transaction) => {
      await this.assertSourceAndDataset(transaction, requestScope, input.sourceId, null);
      const pending: WritebackRequest = {
        id: requestId, tenantId: requestScope.tenantId, projectId: requestScope.projectId, sourceId: input.sourceId,
        targetExternalId: input.targetExternalId, operation: input.operation, payload: input.payload,
        risk: input.risk, state: 'pending_approval', requestedBy: requestScope.userId, requestedAt: new Date().toISOString(), approvals: [], dryRunResult: input.dryRunResult, executedAt: null,
      };
      const decision = evaluateWritebackSafety(pending, this.writebackPolicy);
      const blockedReasons = nonApprovalReasons(decision);
      const initialState = blockedReasons.length > 0 ? 'cancelled' : 'pending_approval';
      const inserted = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_writeback_requests
          (tenant_id, project_id, request_id, source_id, target_external_id, operation, payload_json, risk, state, dry_run_json, blocked_reasons_json, requested_by)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12)
          ON CONFLICT (tenant_id, project_id, request_id) DO NOTHING
          RETURNING tenant_id::text, project_id::text, request_id, source_id, target_external_id, operation, payload_json, risk, state, dry_run_json, blocked_reasons_json, requested_by, requested_at, executed_at, execution_result_json, updated_at`,
        values: [requestScope.tenantId, requestScope.projectId, requestId, input.sourceId, input.targetExternalId, input.operation, JSON.stringify(input.payload), input.risk, initialState, JSON.stringify(input.dryRunResult), JSON.stringify(blockedReasons), requestScope.userId],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError(`Write-back request '${requestId}' already exists`);
      const eventType = initialState === 'cancelled' ? 'request.blocked' : 'request.created';
      await this.writebackEvent(transaction, requestScope, requestId, eventType, requestScope.userId, { blockedReasons, safety: decision }, correlationId);
      await this.audit(transaction, requestScope, initialState === 'cancelled' ? 'platform.writeback_request_blocked' : 'platform.writeback_request_created', 'writebackRequest', requestId, correlationId, { operation: input.operation, risk: input.risk, targetExternalId: input.targetExternalId, blockedReasons });
      return this.writeback(transaction, requestScope, row);
    });
  }

  async approveWritebackRequest(context: PlatformContext, userId: string, requestId: string, input: WritebackApprovalCreate, correlationId: string): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, approvalRoles, async (transaction) => {
      const existing = await this.writebackRow(transaction, requestScope, requestId);
      if (text(existing, 'state') !== 'pending_approval') throw new ConflictError(`Write-back request '${requestId}' is not pending approval`);
      if (text(existing, 'requested_by') === requestScope.userId) throw new ForbiddenError('The requester cannot approve or reject their own write-back request');
      const approval = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_writeback_approvals (tenant_id, project_id, request_id, actor, decision, comment)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
          ON CONFLICT (tenant_id, project_id, request_id, actor) DO NOTHING
          RETURNING approval_id`,
        values: [requestScope.tenantId, requestScope.projectId, requestId, requestScope.userId, input.decision, input.comment ?? null],
      });
      if (!approval.rows[0]) throw new ConflictError(`Actor '${requestScope.userId}' has already reviewed write-back request '${requestId}'`);
      const interim = await this.writeback(transaction, requestScope, existing);
      const safety = interim.safety as ReturnType<typeof evaluateWritebackSafety>;
      let nextState: string = 'pending_approval';
      if (input.decision === 'rejected') nextState = 'cancelled';
      else if (safety.allowed) nextState = 'approved';
      else if (nonApprovalReasons(safety).length > 0) nextState = 'cancelled';
      let row = existing;
      if (nextState !== 'pending_approval') {
        const updated = await transaction.query<Row>({
          text: `UPDATE odf.platform_legacy_writeback_requests SET state = $4, updated_at = now()
            WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND request_id = $3 AND state = 'pending_approval'
            RETURNING tenant_id::text, project_id::text, request_id, source_id, target_external_id, operation, payload_json, risk, state, dry_run_json, blocked_reasons_json, requested_by, requested_at, executed_at, execution_result_json, updated_at`,
          values: [requestScope.tenantId, requestScope.projectId, requestId, nextState],
        });
        row = updated.rows[0] ?? existing;
      }
      await this.writebackEvent(transaction, requestScope, requestId, `approval.${input.decision}`, requestScope.userId, { decision: input.decision, comment: input.comment ?? null, resultingState: nextState }, correlationId);
      await this.audit(transaction, requestScope, `platform.writeback_${input.decision}`, 'writebackRequest', requestId, correlationId, { resultingState: nextState, comment: input.comment ?? null });
      return this.writeback(transaction, requestScope, row);
    });
  }

  async assertWritebackExecutable(context: PlatformContext, userId: string, requestId: string): Promise<void> {
    const requestScope = scope(context, userId);
    await this.write(requestScope, writeRoles, async (transaction) => {
      const current = await this.writebackRow(transaction, requestScope, requestId);
      const request = await this.writeback(transaction, requestScope, current);
      this.assertWritebackExecutableRow(requestId, current, request);
    });
  }

  async beginWritebackExecution(context: PlatformContext, userId: string, requestId: string, correlationId: string): Promise<IndustrialWritebackExecution> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, writeRoles, async (transaction) => {
      const current = await this.writebackRow(transaction, requestScope, requestId);
      const request = await this.writeback(transaction, requestScope, current);
      const safety = this.assertWritebackExecutableRow(requestId, current, request);
      const updated = await transaction.query<Row>({
        text: `UPDATE odf.platform_legacy_writeback_requests SET state = 'executing', updated_at = now()
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND request_id = $3 AND state = 'approved'
          RETURNING request_id`,
        values: [requestScope.tenantId, requestScope.projectId, requestId],
      });
      if (!updated.rows[0]) throw new ConflictError(`Write-back request '${requestId}' is no longer approved for execution`);
      await this.writebackEvent(transaction, requestScope, requestId, 'execution.started', requestScope.userId, { safety }, correlationId);
      await this.audit(transaction, requestScope, 'platform.writeback_execution_started', 'writebackRequest', requestId, correlationId, { safety });
      const approvals = request.approvals as Array<{ actor: string; decision: string }>;
      return { tenantId: requestScope.tenantId, projectId: requestScope.projectId, requestId, sourceId: String(request.sourceId), targetExternalId: String(request.targetExternalId), operation: String(request.operation), payload: request.payload as Record<string, unknown>, risk: request.risk as WritebackRisk, requestedBy: String(request.requestedBy), approvedBy: approvals.filter((approval) => approval.decision === 'approved').map((approval) => approval.actor), executedBy: requestScope.userId, correlationId };
    });
  }

  async recordUnavailableExecutor(context: PlatformContext, userId: string, requestId: string, correlationId: string): Promise<void> {
    const requestScope = scope(context, userId);
    await this.write(requestScope, writeRoles, async (transaction) => {
      const current = await this.writebackRow(transaction, requestScope, requestId);
      const request = await this.writeback(transaction, requestScope, current);
      this.assertWritebackExecutableRow(requestId, current, request);
      const details = { reason: 'No industrial write-back executor is configured; request was not executed' };
      await this.writebackEvent(transaction, requestScope, requestId, 'execution.blocked', requestScope.userId, details, correlationId);
      await this.audit(transaction, requestScope, 'platform.writeback_execution_blocked', 'writebackRequest', requestId, correlationId, details);
    });
  }

  async completeWritebackExecution(context: PlatformContext, userId: string, requestId: string, correlationId: string, outcome: { succeeded: true; result: Record<string, unknown> } | { succeeded: false; error: string }): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    return this.write(requestScope, writeRoles, async (transaction) => {
      const state = outcome.succeeded ? 'succeeded' : 'failed';
      const result = outcome.succeeded ? outcome.result : { error: outcome.error };
      const updated = await transaction.query<Row>({
        text: `UPDATE odf.platform_legacy_writeback_requests
          SET state = $4, executed_at = now(), execution_result_json = $5::jsonb, updated_at = now()
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND request_id = $3 AND state = 'executing'
          RETURNING tenant_id::text, project_id::text, request_id, source_id, target_external_id, operation, payload_json, risk, state, dry_run_json, blocked_reasons_json, requested_by, requested_at, executed_at, execution_result_json, updated_at`,
        values: [requestScope.tenantId, requestScope.projectId, requestId, state, JSON.stringify(result)],
      });
      const row = updated.rows[0];
      if (!row) throw new ConflictError(`Write-back request '${requestId}' is not executing`);
      await this.writebackEvent(transaction, requestScope, requestId, `execution.${state}`, requestScope.userId, result, correlationId);
      await this.audit(transaction, requestScope, `platform.writeback_execution_${state}`, 'writebackRequest', requestId, correlationId, result);
      return this.writeback(transaction, requestScope, row);
    });
  }

  async listWritebackEvents(context: PlatformContext, userId: string, requestId: string, query: CursorListQuery): Promise<Record<string, unknown>> {
    const requestScope = scope(context, userId);
    const cursor = decode(query.cursor, numericCursorSchema, { id: 0 });
    return this.read(requestScope, async (transaction) => {
      await this.writebackRow(transaction, requestScope, requestId);
      const result = await transaction.query<Row>({
        text: `SELECT event_id, tenant_id::text, project_id::text, request_id, event_type, actor, details_json, correlation_id::text, occurred_at
          FROM odf.platform_legacy_writeback_events
          WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND request_id = $3 AND event_id > $4::bigint
          ORDER BY event_id ASC LIMIT $5`,
        values: [requestScope.tenantId, requestScope.projectId, requestId, cursor.id, query.limit + 1],
      });
      return this.page(result.rows, query.limit, (row) => ({ id: number(row, 'event_id'), tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), requestId: text(row, 'request_id'), type: text(row, 'event_type'), actor: text(row, 'actor'), details: jsonObject(row.details_json), correlationId: text(row, 'correlation_id'), occurredAt: timestamp(row, 'occurred_at') }), (row) => ({ id: number(row, 'event_id') }));
    });
  }

  private async read<T>(requestScope: Scope, operation: (transaction: ScopedTransaction) => Promise<T>): Promise<T> {
    try {
      await this.runtime.catalog.resolveMember(requestScope, readRoles);
      return await this.runtime.withTransaction(requestScope, operation);
    } catch (error) { throw runtimeError(error); }
  }

  private async write<T>(requestScope: Scope, roles: readonly ProjectRole[], operation: (transaction: ScopedTransaction) => Promise<T>): Promise<T> {
    try {
      await this.runtime.catalog.resolveMember(requestScope, roles);
      return await this.runtime.withTransaction(requestScope, operation);
    } catch (error) { throw runtimeError(error); }
  }

  private page(rows: Row[], limit: number, map: (row: Row) => Record<string, unknown>, cursor: (row: Row) => unknown): Record<string, unknown> {
    const items = rows.slice(0, limit).map(map);
    const tail = rows.length > limit ? rows[limit - 1] : undefined;
    return { items, nextCursor: tail ? encodeCursor(cursor(tail)) : null };
  }

  private model(row: Row): Record<string, unknown> {
    return { tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), id: text(row, 'model_id'), version: number(row, 'version'), name: text(row, 'name'), schema: jsonObject(row.schema_json), status: text(row, 'status'), createdBy: text(row, 'created_by'), createdAt: timestamp(row, 'created_at') };
  }

  private pipeline(row: Row): Record<string, unknown> {
    return { tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), id: text(row, 'pipeline_id'), name: text(row, 'name'), sourceId: optionalText(row, 'source_id'), datasetId: optionalText(row, 'dataset_id'), definition: jsonObject(row.definition_json), version: number(row, 'version'), enabled: boolean(row, 'enabled'), createdBy: text(row, 'created_by'), createdAt: timestamp(row, 'created_at') };
  }

  private pipelineRun(row: Row, replayed: boolean): Record<string, unknown> {
    return { tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), id: text(row, 'run_id'), pipelineId: text(row, 'pipeline_id'), idempotencyKey: text(row, 'idempotency_key'), status: text(row, 'status'), inputHash: text(row, 'input_hash'), result: jsonObject(row.result_json), triggeredBy: text(row, 'triggered_by'), startedAt: timestamp(row, 'started_at'), completedAt: optionalText(row, 'completed_at') ? timestamp(row, 'completed_at') : null, replayed };
  }

  private qualityRule(row: Row): Record<string, unknown> {
    return { tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), id: text(row, 'rule_id'), name: text(row, 'name'), targetType: text(row, 'target_type'), check: jsonObject(row.check_json), severity: text(row, 'severity'), enabled: boolean(row, 'enabled'), createdBy: text(row, 'created_by'), createdAt: timestamp(row, 'created_at') };
  }

  private qualityResult(row: Row): Record<string, unknown> {
    return { id: number(row, 'result_id'), tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), ruleId: text(row, 'rule_id'), runId: text(row, 'run_id'), passed: boolean(row, 'passed'), observed: jsonObject(row.observed_json), evaluatedAt: timestamp(row, 'evaluated_at') };
  }

  private candidate(row: Row): Record<string, unknown> {
    return { tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), id: text(row, 'candidate_id'), source: { type: text(row, 'source_type'), id: text(row, 'source_id') }, target: { type: text(row, 'target_type'), id: text(row, 'target_id') }, relationType: text(row, 'relation_type'), confidence: number(row, 'confidence'), evidence: jsonObject(row.evidence_json), status: text(row, 'status'), reviewedBy: optionalText(row, 'reviewed_by'), reviewComment: optionalText(row, 'review_comment'), reviewedAt: optionalText(row, 'reviewed_at') ? timestamp(row, 'reviewed_at') : null, createdBy: text(row, 'created_by'), createdAt: timestamp(row, 'created_at') };
  }

  private async assertSourceAndDataset(transaction: ScopedTransaction, requestScope: Scope, sourceId: string | null, datasetId: string | null): Promise<void> {
    if (sourceId) {
      const source = await transaction.query<Row>({ text: 'SELECT 1 AS found FROM odf.source_connections WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3', values: [requestScope.tenantId, requestScope.projectId, sourceId] });
      if (!source.rows[0]) throw new NotFoundError(`Source '${sourceId}' was not found`);
    }
    if (datasetId) {
      const dataset = await transaction.query<Row>({ text: 'SELECT 1 AS found FROM odf.datasets WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND external_id = $3', values: [requestScope.tenantId, requestScope.projectId, datasetId] });
      if (!dataset.rows[0]) throw new NotFoundError(`Dataset '${datasetId}' was not found`);
    }
  }

  private async evaluateQuality(
    transaction: ScopedTransaction,
    requestScope: Scope,
    runId: string,
    input: Record<string, unknown>,
  ): Promise<{ total: number; passed: number; failed: number }> {
    const rules = await transaction.query<Row>({
      text: `SELECT rule_id, check_json FROM odf.platform_legacy_quality_rules
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND enabled = true ORDER BY rule_id ASC`,
      values: [requestScope.tenantId, requestScope.projectId],
    });
    let passedCount = 0;
    for (const rule of rules.rows) {
      const check = jsonObject(rule.check_json);
      const field = typeof check.field === 'string' ? check.field : '';
      const operator = typeof check.operator === 'string' ? check.operator : '';
      const value = valueAtPath(input, field);
      let passed = false;
      if (operator === 'required') passed = value !== undefined && value !== null && String(value).trim() !== '';
      if (operator === 'equals') passed = canonical(value) === canonical(check.value);
      if (operator === 'gte') passed = typeof value === 'number' && typeof check.value === 'number' && value >= check.value;
      if (operator === 'lte') passed = typeof value === 'number' && typeof check.value === 'number' && value <= check.value;
      if (passed) passedCount += 1;
      const observed = { actual: value ?? null };
      const result = await transaction.query<Row>({
        text: `INSERT INTO odf.platform_legacy_quality_results (tenant_id, project_id, rule_id, run_id, passed, observed_json)
          VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)
          RETURNING result_id, evaluated_at`,
        values: [requestScope.tenantId, requestScope.projectId, text(rule, 'rule_id'), runId, passed, JSON.stringify(observed)],
      });
      number(result.rows[0] ?? {}, 'result_id');
    }
    return { total: rules.rows.length, passed: passedCount, failed: rules.rows.length - passedCount };
  }

  private async writebackRow(transaction: ScopedTransaction, requestScope: Scope, requestId: string): Promise<Row> {
    const result = await transaction.query<Row>({
      text: `SELECT tenant_id::text, project_id::text, request_id, source_id, target_external_id, operation, payload_json, risk, state, dry_run_json, blocked_reasons_json, requested_by, requested_at, executed_at, execution_result_json, updated_at
        FROM odf.platform_legacy_writeback_requests
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND request_id = $3`,
      values: [requestScope.tenantId, requestScope.projectId, requestId],
    });
    if (!result.rows[0]) throw new NotFoundError(`Write-back request '${requestId}' was not found`);
    return result.rows[0];
  }

  private async writeback(transaction: ScopedTransaction, requestScope: Scope, row: Row): Promise<Record<string, unknown>> {
    const approvalsResult = await transaction.query<Row>({
      text: `SELECT actor, decision, comment, occurred_at FROM odf.platform_legacy_writeback_approvals
        WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND request_id = $3 ORDER BY approval_id ASC`,
      values: [requestScope.tenantId, requestScope.projectId, text(row, 'request_id')],
    });
    const approvals = approvalsResult.rows.map((approval) => ({ actor: text(approval, 'actor'), decision: text(approval, 'decision') as 'approved' | 'rejected', comment: optionalText(approval, 'comment'), occurredAt: timestamp(approval, 'occurred_at') }));
    const request: WritebackRequest = {
      id: text(row, 'request_id'), tenantId: text(row, 'tenant_id'), projectId: text(row, 'project_id'), sourceId: text(row, 'source_id'), targetExternalId: text(row, 'target_external_id'), operation: text(row, 'operation'), payload: jsonObject(row.payload_json), risk: text(row, 'risk') as WritebackRisk, state: text(row, 'state') as WritebackRequest['state'], requestedBy: text(row, 'requested_by'), requestedAt: timestamp(row, 'requested_at'), approvals, dryRunResult: jsonObject(row.dry_run_json), executedAt: optionalText(row, 'executed_at') ? timestamp(row, 'executed_at') : null,
    };
    return {
      ...request,
      blockedReasons: jsonValues(row.blocked_reasons_json).map((item) => (
        item && typeof item === 'object' && !Array.isArray(item) && 'reason' in item
          ? String((item as Record<string, unknown>).reason)
          : String(item)
      )),
      executionResult: row.execution_result_json === null ? null : jsonObject(row.execution_result_json),
      updatedAt: timestamp(row, 'updated_at'),
      safety: evaluateWritebackSafety(request, this.writebackPolicy),
    };
  }

  private assertWritebackExecutableRow(
    requestId: string,
    row: Row,
    request: Record<string, unknown>,
  ): ReturnType<typeof evaluateWritebackSafety> {
    if (text(row, 'state') !== 'approved') {
      throw new ConflictError(`Write-back request '${requestId}' is not approved for execution`);
    }
    const safety = request.safety as ReturnType<typeof evaluateWritebackSafety>;
    if (!safety.allowed) {
      throw new ForbiddenError(`Write-back safety gates failed: ${safety.reasons.join('; ')}`);
    }
    return safety;
  }

  private async writebackEvent(transaction: ScopedTransaction, requestScope: Scope, requestId: string, eventType: string, actor: string, details: Record<string, unknown>, correlationId: string): Promise<void> {
    await transaction.query({
      text: `INSERT INTO odf.platform_legacy_writeback_events (tenant_id, project_id, request_id, event_type, actor, details_json, correlation_id)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid)`,
      values: [requestScope.tenantId, requestScope.projectId, requestId, eventType, actor, JSON.stringify(details), correlationId],
    });
  }

  private async audit(transaction: ScopedTransaction, requestScope: Scope, action: string, entityType: string, entityId: string, correlationId: string, details: Record<string, unknown>): Promise<void> {
    await appendPlatformAuditAndOutbox(transaction, {
      actor: requestScope.userId, action, entityType, entityId, tenantId: requestScope.tenantId, projectId: requestScope.projectId, correlationId, details: asJson(details),
    });
  }
}
