import { ConflictError, NotFoundError } from "./errors.js";
import { appendPlatformAuditAndOutbox } from "./platform-events.js";
import {
  pipelineFromRow,
  pipelineRunV2FromRow,
  pipelineVersionFromRow,
  qualityResultFromRow,
  qualityRuleFromRow,
} from "./platform-mappers.js";
import { PolicyAwareRepository } from "./platform-repository-base.js";
import { boundedPageSize, pageFromRows, requiredText } from "./platform-support.js";
import { json } from "./mappers.js";
import type {
  CreatePipelineInput,
  CreatePipelineRunInput,
  CreatePipelineVersionInput,
  CreateQualityRuleInput,
  PipelineQualityRepository,
  PipelineRecord,
  PipelineRunRecordV2,
  PipelineVersionRecord,
  ProjectAccessResolver,
  ProjectScope,
  QualityResultRecord,
  QualityRuleRecord,
  RecordQualityResultInput,
  TextCursor,
  TransitionPipelineRunInput,
} from "./platform-types.js";
import type { KeysetPage, TransactionRunner } from "./types.js";

const PIPELINE_COLUMNS = "pipeline_id, tenant_id, project_id, external_id, name, description, current_version, enabled, created_by, created_at, updated_at";
const PIPELINE_VERSION_COLUMNS = "pipeline_version_id, tenant_id, project_id, pipeline_id, version, definition, schedule, created_by, created_at";
const PIPELINE_RUN_COLUMNS = "pipeline_run_id, tenant_id, project_id, pipeline_id, pipeline_version, state, trigger_type, correlation_id, started_at, completed_at, summary";
const QUALITY_RULE_COLUMNS = [
  "quality_rule_id, tenant_id, project_id, external_id, version, name, rule_kind, target_model_external_id,",
  "field_name, configuration, severity, enabled, created_at",
].join(" ");
const QUALITY_RESULT_COLUMNS = "quality_result_id, tenant_id, project_id, quality_rule_id, pipeline_run_id, passed, checked_records, failed_records, sample_failures, occurred_at";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, nested]) => JSON.stringify(key) + ":" + canonical(nested)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function samePipeline(row: PipelineRecord, input: CreatePipelineInput): boolean {
  return row.pipelineId === input.pipelineId
    && row.externalId === input.externalId
    && row.name === input.name
    && row.description === (input.description ?? null)
    && row.enabled === (input.enabled ?? true);
}

function validTransition(current: PipelineRunRecordV2["state"], next: PipelineRunRecordV2["state"]): boolean {
  return (current === "queued" && (next === "running" || next === "cancelled"))
    || (current === "running" && (next === "succeeded" || next === "failed" || next === "cancelled"));
}

/** Immutable pipeline versions, durable run transitions, and quality evidence. */
export class PostgresPipelineQualityRepository extends PolicyAwareRepository implements PipelineQualityRepository {
  constructor(runner: TransactionRunner, policy: ProjectAccessResolver) {
    super(runner, policy);
  }

  async createPipeline(scope: ProjectScope, input: CreatePipelineInput): Promise<PipelineRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.pipelines (pipeline_id, tenant_id, project_id, external_id, name, description, current_version, enabled, created_by)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 1, $7, $8)",
          "ON CONFLICT (tenant_id, project_id, pipeline_id) DO NOTHING",
          "RETURNING " + PIPELINE_COLUMNS,
        ].join("\n"),
        values: [input.pipelineId, scope.tenantId, scope.projectId, input.externalId, input.name, input.description ?? null, input.enabled ?? true, scope.userId],
      });
      const row = inserted.rows[0];
      if (row) {
        const version = await transaction.query({
          text: [
            "INSERT INTO odf.pipeline_versions",
            "  (pipeline_version_id, tenant_id, project_id, pipeline_id, version, definition, schedule, created_by)",
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::jsonb, $6, $7)",
            "RETURNING " + PIPELINE_VERSION_COLUMNS,
          ].join("\n"),
          values: [input.pipelineVersionId, scope.tenantId, scope.projectId, input.pipelineId, json(input.definition), input.schedule ?? null, scope.userId],
        });
        if (!version.rows[0]) throw new ConflictError("Initial pipeline version could not be created");
        const pipeline = pipelineFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.pipeline_created", entityType: "pipeline", entityId: pipeline.pipelineId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: pipeline.externalId, version: 1, enabled: pipeline.enabled },
        });
        return pipeline;
      }
      const existing = await transaction.query({
        text: "SELECT " + PIPELINE_COLUMNS + " FROM odf.pipelines WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.pipelineId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Pipeline idempotency record could not be resolved");
      const pipeline = pipelineFromRow(existingRow);
      if (!samePipeline(pipeline, input)) throw new ConflictError("Pipeline identifier is already bound to different input");
      const version = await transaction.query({
        text: "SELECT " + PIPELINE_VERSION_COLUMNS + " FROM odf.pipeline_versions WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_version_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.pipelineVersionId],
      });
      const versionRow = version.rows[0];
      const initialVersion = versionRow ? pipelineVersionFromRow(versionRow) : null;
      if (!initialVersion || initialVersion.pipelineId !== input.pipelineId || initialVersion.version !== 1
        || canonical(initialVersion.definition) !== canonical(input.definition) || initialVersion.schedule !== (input.schedule ?? null)) {
        throw new ConflictError("Pipeline initial version identifier is already bound to different input");
      }
      return pipeline;
    });
  }

  async appendPipelineVersion(scope: ProjectScope, pipelineId: string, input: CreatePipelineVersionInput): Promise<PipelineVersionRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      // One short transaction per pipeline makes retry-by-version-id safe and
      // keeps current_version increment order deterministic.
      await transaction.query({
        text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        values: ["odf:pipeline-version:" + pipelineId],
      });
      const prior = await transaction.query({
        text: "SELECT " + PIPELINE_VERSION_COLUMNS + " FROM odf.pipeline_versions WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_version_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.pipelineVersionId],
      });
      const priorRow = prior.rows[0];
      if (priorRow) {
        const version = pipelineVersionFromRow(priorRow);
        if (version.pipelineId !== pipelineId || canonical(version.definition) !== canonical(input.definition) || version.schedule !== (input.schedule ?? null)) {
          throw new ConflictError("Pipeline version identifier is already bound to different input");
        }
        return version;
      }
      const advanced = await transaction.query({
        text: [
          "UPDATE odf.pipelines",
          "SET current_version = current_version + 1, updated_at = now()",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_id = $3::uuid",
          "RETURNING current_version",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, pipelineId],
      });
      const nextVersion = advanced.rows[0]?.current_version;
      if (nextVersion === undefined) throw new NotFoundError("Pipeline was not found");
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.pipeline_versions",
          "  (pipeline_version_id, tenant_id, project_id, pipeline_id, version, definition, schedule, created_by)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6::jsonb, $7, $8)",
          "RETURNING " + PIPELINE_VERSION_COLUMNS,
        ].join("\n"),
        values: [input.pipelineVersionId, scope.tenantId, scope.projectId, pipelineId, nextVersion, json(input.definition), input.schedule ?? null, scope.userId],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError("Pipeline version could not be created");
      const version = pipelineVersionFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.pipeline_version_created", entityType: "pipeline", entityId: pipelineId,
        tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
        details: { pipelineVersionId: version.pipelineVersionId, version: version.version },
      });
      return version;
    });
  }

  async getPipelineVersion(scope: ProjectScope, pipelineId: string, version: number): Promise<PipelineVersionRecord> {
    if (!Number.isInteger(version) || version < 1) throw new RangeError("version must be a positive integer");
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + PIPELINE_VERSION_COLUMNS,
          "FROM odf.pipeline_versions",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_id = $3::uuid AND version = $4::integer",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, pipelineId, version],
      });
      const row = result.rows[0];
      if (!row) throw new NotFoundError("Pipeline version was not found");
      return pipelineVersionFromRow(row);
    });
  }

  async createPipelineRun(scope: ProjectScope, input: CreatePipelineRunInput): Promise<PipelineRunRecordV2> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const version = await transaction.query({
        text: [
          "SELECT pipeline_version.version",
          "FROM odf.pipeline_versions AS pipeline_version",
          "JOIN odf.pipelines AS pipeline",
          "  ON pipeline.tenant_id = pipeline_version.tenant_id",
          " AND pipeline.project_id = pipeline_version.project_id",
          " AND pipeline.pipeline_id = pipeline_version.pipeline_id",
          "WHERE pipeline_version.tenant_id = $1::uuid AND pipeline_version.project_id = $2::uuid",
          "  AND pipeline_version.pipeline_id = $3::uuid AND pipeline_version.version = $4::integer",
          "  AND pipeline.enabled = true",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, input.pipelineId, input.pipelineVersion],
      });
      if (!version.rows[0]) throw new NotFoundError("Pipeline version was not found");
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.pipeline_runs",
          "  (pipeline_run_id, tenant_id, project_id, pipeline_id, pipeline_version, state, trigger_type, correlation_id, summary)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 'queued', $6, $7::uuid, $8::jsonb)",
          "ON CONFLICT (tenant_id, project_id, pipeline_run_id) DO NOTHING",
          "RETURNING " + PIPELINE_RUN_COLUMNS,
        ].join("\n"),
        values: [input.pipelineRunId, scope.tenantId, scope.projectId, input.pipelineId, input.pipelineVersion, input.triggerType, input.correlationId, json(input.summary ?? {})],
      });
      const row = inserted.rows[0];
      if (row) {
        const run = pipelineRunV2FromRow(row);
        await transaction.query({
          text: [
            "INSERT INTO odf.pipeline_run_events (tenant_id, pipeline_run_id, event_type, state, details)",
            "VALUES ($1::uuid, $2::uuid, 'pipeline.queued', 'queued', $3::jsonb)",
          ].join("\n"),
          values: [scope.tenantId, run.pipelineRunId, json({ triggerType: run.triggerType })],
        });
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.pipeline_run_queued", entityType: "pipelineRun", entityId: run.pipelineRunId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { pipelineId: run.pipelineId, pipelineVersion: run.pipelineVersion, triggerType: run.triggerType },
        });
        return run;
      }
      const existing = await transaction.query({
        text: "SELECT " + PIPELINE_RUN_COLUMNS + " FROM odf.pipeline_runs WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_run_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.pipelineRunId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Pipeline run idempotency record could not be resolved");
      const run = pipelineRunV2FromRow(existingRow);
      if (run.pipelineId !== input.pipelineId || run.pipelineVersion !== input.pipelineVersion || run.triggerType !== input.triggerType
        || run.correlationId !== input.correlationId || canonical(run.summary) !== canonical(input.summary ?? {})) {
        throw new ConflictError("Pipeline run identifier is already bound to different input");
      }
      return run;
    });
  }

  async transitionPipelineRun(scope: ProjectScope, input: TransitionPipelineRunInput): Promise<PipelineRunRecordV2> {
    requiredText(input.correlationId, "correlationId");
    if (!validTransition(input.expectedState, input.nextState)) {
      throw new ConflictError("Pipeline run transition is not permitted");
    }
    return this.write(scope, async (transaction) => {
      const transitioned = await transaction.query({
        text: [
          "UPDATE odf.pipeline_runs",
          "SET state = $4,",
          "    started_at = CASE WHEN $4 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,",
          "    completed_at = CASE WHEN $4 IN ('succeeded', 'failed', 'cancelled') THEN now() ELSE NULL END,",
          "    summary = COALESCE($5::jsonb, summary)",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_run_id = $3::uuid AND state = $6",
          "RETURNING " + PIPELINE_RUN_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, input.pipelineRunId, input.nextState, input.summary === undefined ? null : json(input.summary), input.expectedState],
      });
      const row = transitioned.rows[0];
      if (!row) {
        const existing = await transaction.query({
          text: "SELECT " + PIPELINE_RUN_COLUMNS + " FROM odf.pipeline_runs WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_run_id = $3::uuid",
          values: [scope.tenantId, scope.projectId, input.pipelineRunId],
        });
        const existingRow = existing.rows[0];
        if (!existingRow) throw new NotFoundError("Pipeline run was not found");
        const run = pipelineRunV2FromRow(existingRow);
        if (run.state === input.nextState) return run;
        throw new ConflictError("Pipeline run state is no longer current");
      }
      const run = pipelineRunV2FromRow(row);
      await transaction.query({
        text: [
          "INSERT INTO odf.pipeline_run_events (tenant_id, pipeline_run_id, event_type, state, details)",
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)",
        ].join("\n"),
        values: [scope.tenantId, run.pipelineRunId, "pipeline." + run.state, run.state, json({ previousState: input.expectedState })],
      });
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.pipeline_run_" + run.state, entityType: "pipelineRun", entityId: run.pipelineRunId,
        tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
        details: { previousState: input.expectedState, nextState: run.state },
      });
      return run;
    });
  }

  async listPipelineRuns(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<PipelineRunRecordV2, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + PIPELINE_RUN_COLUMNS,
          "FROM odf.pipeline_runs",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND pipeline_run_id > $3::uuid",
          "ORDER BY pipeline_run_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "00000000-0000-0000-0000-000000000000", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, pipelineRunV2FromRow, (run) => ({ value: run.pipelineRunId }));
    });
  }

  async createQualityRule(scope: ProjectScope, input: CreateQualityRuleInput): Promise<QualityRuleRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.quality_rules",
          "  (quality_rule_id, tenant_id, project_id, external_id, version, name, rule_kind, target_model_external_id, field_name, configuration, severity, enabled)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::integer, $6, $7, $8, $9, $10::jsonb, $11, $12)",
          "ON CONFLICT (tenant_id, project_id, quality_rule_id) DO NOTHING",
          "RETURNING " + QUALITY_RULE_COLUMNS,
        ].join("\n"),
        values: [
          input.qualityRuleId, scope.tenantId, scope.projectId, input.externalId, input.version ?? 1, input.name, input.ruleKind,
          input.targetModelExternalId, input.fieldName ?? null, json(input.configuration), input.severity, input.enabled ?? true,
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const rule = qualityRuleFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.quality_rule_created", entityType: "qualityRule", entityId: rule.qualityRuleId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { externalId: rule.externalId, version: rule.version, ruleKind: rule.ruleKind },
        });
        return rule;
      }
      const existing = await transaction.query({
        text: "SELECT " + QUALITY_RULE_COLUMNS + " FROM odf.quality_rules WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND quality_rule_id = $3::uuid",
        values: [scope.tenantId, scope.projectId, input.qualityRuleId],
      });
      const existingRow = existing.rows[0];
      if (!existingRow) throw new ConflictError("Quality rule idempotency record could not be resolved");
      const rule = qualityRuleFromRow(existingRow);
      if (rule.externalId !== input.externalId || rule.version !== (input.version ?? 1) || rule.name !== input.name
        || rule.ruleKind !== input.ruleKind || rule.targetModelExternalId !== input.targetModelExternalId
        || rule.fieldName !== (input.fieldName ?? null) || rule.severity !== input.severity
        || rule.enabled !== (input.enabled ?? true) || canonical(rule.configuration) !== canonical(input.configuration)) {
        throw new ConflictError("Quality rule identifier is already bound to different input");
      }
      return rule;
    });
  }

  async listEnabledQualityRules(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<QualityRuleRecord, TextCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + QUALITY_RULE_COLUMNS,
          "FROM odf.quality_rules",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND enabled = true AND quality_rule_id > $3::uuid",
          "ORDER BY quality_rule_id ASC",
          "LIMIT $4",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.value ?? "00000000-0000-0000-0000-000000000000", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, qualityRuleFromRow, (rule) => ({ value: rule.qualityRuleId }));
    });
  }

  async recordQualityResult(scope: ProjectScope, input: RecordQualityResultInput): Promise<QualityResultRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const deduplicationKey = "platform:platform.quality_result_recorded:" + input.correlationId;
      await transaction.query({
        text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        values: ["odf:quality-result:" + input.correlationId],
      });
      const previous = await transaction.query({
        text: [
          "SELECT payload ->> 'entityId' AS quality_result_id",
          "FROM odf.outbox_events",
          "WHERE aggregate_type = 'qualityResult' AND event_type = 'platform.quality_result_recorded' AND deduplication_key = $1",
        ].join("\n"),
        values: [deduplicationKey],
      });
      const previousId = previous.rows[0]?.quality_result_id;
      if (typeof previousId === "string") {
        const existing = await transaction.query({
          text: "SELECT " + QUALITY_RESULT_COLUMNS + " FROM odf.quality_results WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND quality_result_id = $3::bigint",
          values: [scope.tenantId, scope.projectId, previousId],
        });
        const existingRow = existing.rows[0];
        if (!existingRow) throw new ConflictError("Quality result idempotency record could not be resolved");
        return qualityResultFromRow(existingRow);
      }
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.quality_results",
          "  (tenant_id, project_id, quality_rule_id, pipeline_run_id, passed, checked_records, failed_records, sample_failures, occurred_at)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, $7::bigint, $8::jsonb, COALESCE($9::timestamptz, now()))",
          "RETURNING " + QUALITY_RESULT_COLUMNS,
        ].join("\n"),
        values: [
          scope.tenantId, scope.projectId, input.qualityRuleId, input.pipelineRunId ?? null, input.passed, input.checkedRecords,
          input.failedRecords, JSON.stringify(input.sampleFailures ?? []), input.occurredAt ?? null,
        ],
      });
      const row = inserted.rows[0];
      if (!row) throw new ConflictError("Quality result could not be created");
      const result = qualityResultFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.quality_result_recorded", entityType: "qualityResult", entityId: result.qualityResultId,
        tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
        details: { qualityRuleId: result.qualityRuleId, pipelineRunId: result.pipelineRunId, passed: result.passed },
      });
      return result;
    });
  }
}
