import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { WritebackRequest, WritebackRisk } from '@open-data-fusion/contracts';
import {
  createProposedSpatialLink,
  evaluateMatchingPredictions,
  evaluateWritebackSafety,
  extractDiagramTags,
  rankProposedMatches,
  type WritebackSafetyDecision,
  type WritebackSafetyPolicy,
} from '@open-data-fusion/platform-core';
import { z } from 'zod';

import type {
  DiagramExtractionCreate,
  MatchingEvaluationCreate,
  ProjectMemberUpsert,
  SpatialLinkCreate,
  SpatialLinkReview,
  WritebackApprovalCreate,
  WritebackRequestCreate,
} from './advanced-platform-schemas.js';
import { ConflictError, ForbiddenError, NotFoundError } from './database.js';
import type { CursorListQuery, PlatformContext } from './platform-schemas.js';
import type { PlatformProjectRole } from './platform.js';

type SqliteRow = Record<string, unknown>;

interface PersistedWritebackRequest extends WritebackRequest {
  blockedReasons: string[];
  executionResult: Record<string, unknown> | null;
  updatedAt: string;
}

export interface IndustrialWritebackExecution {
  tenantId: string;
  projectId: string;
  requestId: string;
  sourceId: string;
  targetExternalId: string;
  operation: string;
  payload: Record<string, unknown>;
  risk: WritebackRisk;
  requestedBy: string;
  approvedBy: string[];
  executedBy: string;
  correlationId: string;
}

export interface IndustrialWritebackExecutor {
  execute(request: IndustrialWritebackExecution): Promise<Record<string, unknown>>;
}

export interface AdvancedPlatformOptions {
  writebackPolicy?: WritebackSafetyPolicy;
}

export type WritebackEnvironment = Record<string, string | undefined>;

const defaultPolicy: WritebackSafetyPolicy = {
  enabled: false,
  allowedOperations: [],
  maximumRisk: 'low',
  requireDryRun: true,
  approvalRequirements: { low: 1, medium: 1, high: 2, critical: 2 },
};

function environmentBoolean(environment: WritebackEnvironment, name: string, fallback: boolean): boolean {
  const value = environment[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function environmentApprovalCount(environment: WritebackEnvironment, name: string, fallback: number): number {
  const value = environment[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

export function writebackPolicyFromEnvironment(environment: WritebackEnvironment = process.env): WritebackSafetyPolicy {
  const maximumRisk = z.enum(['low', 'medium', 'high', 'critical'])
    .parse(environment.ODF_WRITEBACK_MAXIMUM_RISK?.trim().toLowerCase() || 'low');
  return normalizePolicy({
    enabled: environmentBoolean(environment, 'ODF_WRITEBACK_ENABLED', false),
    allowedOperations: (environment.ODF_WRITEBACK_ALLOWED_OPERATIONS ?? '')
      .split(',')
      .map((operation) => operation.trim())
      .filter(Boolean),
    maximumRisk,
    requireDryRun: environmentBoolean(environment, 'ODF_WRITEBACK_REQUIRE_DRY_RUN', true),
    approvalRequirements: {
      low: environmentApprovalCount(environment, 'ODF_WRITEBACK_APPROVALS_LOW', 1),
      medium: environmentApprovalCount(environment, 'ODF_WRITEBACK_APPROVALS_MEDIUM', 1),
      high: environmentApprovalCount(environment, 'ODF_WRITEBACK_APPROVALS_HIGH', 2),
      critical: environmentApprovalCount(environment, 'ODF_WRITEBACK_APPROVALS_CRITICAL', 2),
    },
  });
}

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

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, key: string): string {
  if (!cursor) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    parsed = null;
  }
  const record = z.record(z.unknown()).parse(parsed);
  return z.string().min(1).parse(record[key]);
}

function decodeNumericCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    parsed = null;
  }
  const record = z.record(z.unknown()).parse(parsed);
  return z.number().int().nonnegative().parse(record.eventId);
}

function normalizePolicy(policy: WritebackSafetyPolicy | undefined): WritebackSafetyPolicy {
  const configured = policy ?? defaultPolicy;
  if (!configured.requireDryRun) throw new Error('Industrial write-back policy must require a safe dry-run');
  const risks: WritebackRisk[] = ['low', 'medium', 'high', 'critical'];
  if (!risks.includes(configured.maximumRisk)) throw new Error('Write-back maximumRisk is invalid');
  const operations = [...new Set(configured.allowedOperations.map((operation) => operation.trim()))];
  if (operations.some((operation) => !operation || operation.length > 255)) {
    throw new Error('Write-back allowedOperations contains an invalid operation');
  }
  const requirement = (risk: WritebackRisk, minimum: number): number => {
    const value = configured.approvalRequirements?.[risk] ?? defaultPolicy.approvalRequirements?.[risk] ?? minimum;
    if (!Number.isInteger(value) || value < minimum || value > 20) {
      throw new Error(`Write-back approval requirement for '${risk}' must be between ${minimum} and 20`);
    }
    return value;
  };
  return {
    enabled: configured.enabled,
    allowedOperations: operations,
    maximumRisk: configured.maximumRisk,
    requireDryRun: configured.requireDryRun,
    approvalRequirements: {
      low: requirement('low', 1),
      medium: requirement('medium', 1),
      high: requirement('high', 2),
      critical: requirement('critical', 2),
    },
  };
}

function nonApprovalReasons(decision: WritebackSafetyDecision): string[] {
  return decision.reasons.filter((reason) => !/distinct non-requester approval\(s\) required$/u.test(reason));
}

function asDiagramExtraction(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    id: String(row.id),
    documentExternalId: String(row.document_external_id),
    textSha256: String(row.text_sha256),
    tags: parseJson(row.tags_json),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

function asMatchingEvaluation(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    id: String(row.id),
    threshold: Number(row.threshold),
    inputSha256: String(row.input_sha256),
    predictionCount: Number(row.prediction_count),
    truthCount: Number(row.truth_count),
    evaluation: parseJson(row.evaluation_json),
    proposals: parseJson(row.proposals_json),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

function asSpatialLink(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    id: String(row.id),
    assetExternalId: String(row.asset_external_id),
    sceneExternalId: String(row.scene_external_id),
    nodeExternalId: String(row.node_external_id),
    transform: parseJson(row.transform_json),
    confidence: Number(row.confidence),
    reviewState: String(row.review_state),
    reviewedBy: nullableString(row.reviewed_by),
    reviewComment: nullableString(row.review_comment),
    reviewedAt: nullableString(row.reviewed_at),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

function asApproval(row: SqliteRow): WritebackRequest['approvals'][number] {
  return {
    actor: String(row.actor),
    decision: String(row.decision) as 'approved' | 'rejected',
    occurredAt: String(row.occurred_at),
    comment: nullableString(row.comment),
  };
}

function asWritebackRequest(row: SqliteRow, approvals: WritebackRequest['approvals']): PersistedWritebackRequest {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    sourceId: String(row.source_id),
    targetExternalId: String(row.target_external_id),
    operation: String(row.operation),
    payload: asObject(parseJson(row.payload_json)),
    risk: String(row.risk) as WritebackRisk,
    state: String(row.state) as WritebackRequest['state'],
    requestedBy: String(row.requested_by),
    requestedAt: String(row.requested_at),
    approvals,
    dryRunResult: asObject(parseJson(row.dry_run_json)),
    executedAt: nullableString(row.executed_at),
    blockedReasons: Array.isArray(parseJson(row.blocked_reasons_json))
      ? (parseJson(row.blocked_reasons_json) as unknown[]).map(String)
      : [],
    executionResult: row.execution_result_json === null ? null : asObject(parseJson(row.execution_result_json)),
    updatedAt: String(row.updated_at),
  };
}

function asProjectMember(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    userId: String(row.user_id),
    role: String(row.role),
    createdAt: String(row.created_at),
  };
}

export class AdvancedPlatformCatalog {
  private readonly policy: WritebackSafetyPolicy;

  constructor(
    private readonly database: DatabaseSync,
    options: AdvancedPlatformOptions = {},
  ) {
    this.policy = normalizePolicy(options.writebackPolicy);
    this.createSchema();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS platform_diagram_extractions (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL,
        document_external_id TEXT NOT NULL, text_sha256 TEXT NOT NULL CHECK(length(text_sha256)=64),
        tags_json TEXT NOT NULL CHECK(json_valid(tags_json)), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,id),
        FOREIGN KEY(tenant_id,project_id) REFERENCES platform_projects(tenant_id,id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_matching_evaluations (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, threshold REAL NOT NULL CHECK(threshold>=0 AND threshold<=1),
        input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64), prediction_count INTEGER NOT NULL CHECK(prediction_count>=0),
        truth_count INTEGER NOT NULL CHECK(truth_count>=0), evaluation_json TEXT NOT NULL CHECK(json_valid(evaluation_json)),
        proposals_json TEXT NOT NULL CHECK(json_valid(proposals_json)), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,id),
        FOREIGN KEY(tenant_id,project_id) REFERENCES platform_projects(tenant_id,id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_spatial_asset_links (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, asset_external_id TEXT NOT NULL,
        scene_external_id TEXT NOT NULL, node_external_id TEXT NOT NULL, transform_json TEXT NOT NULL CHECK(json_valid(transform_json)),
        confidence REAL NOT NULL CHECK(confidence>=0 AND confidence<=1),
        review_state TEXT NOT NULL CHECK(review_state IN ('proposed','accepted','rejected')),
        reviewed_by TEXT, review_comment TEXT, reviewed_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,id),
        FOREIGN KEY(tenant_id,project_id) REFERENCES platform_projects(tenant_id,id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_writeback_requests (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL,
        target_external_id TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
        state TEXT NOT NULL CHECK(state IN ('draft','pending_approval','approved','executing','succeeded','failed','cancelled')),
        dry_run_json TEXT NOT NULL CHECK(json_valid(dry_run_json)), blocked_reasons_json TEXT NOT NULL CHECK(json_valid(blocked_reasons_json)),
        requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, executed_at TEXT, execution_result_json TEXT CHECK(execution_result_json IS NULL OR json_valid(execution_result_json)),
        updated_at TEXT NOT NULL, PRIMARY KEY(tenant_id,project_id,id),
        FOREIGN KEY(tenant_id,project_id) REFERENCES platform_projects(tenant_id,id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,project_id,source_id) REFERENCES platform_sources(tenant_id,project_id,id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_writeback_approvals (
        approval_id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
        actor TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), comment TEXT, occurred_at TEXT NOT NULL,
        UNIQUE(tenant_id,project_id,request_id,actor),
        FOREIGN KEY(tenant_id,project_id,request_id) REFERENCES platform_writeback_requests(tenant_id,project_id,id) ON DELETE RESTRICT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS platform_writeback_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
        event_type TEXT NOT NULL, actor TEXT NOT NULL, details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        correlation_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
        FOREIGN KEY(tenant_id,project_id,request_id) REFERENCES platform_writeback_requests(tenant_id,project_id,id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS platform_writeback_requests_scope_idx
        ON platform_writeback_requests(tenant_id,project_id,id);
      CREATE INDEX IF NOT EXISTS platform_writeback_events_scope_idx
        ON platform_writeback_events(tenant_id,project_id,request_id,event_id);
      CREATE TRIGGER IF NOT EXISTS platform_writeback_approvals_immutable_update
        BEFORE UPDATE ON platform_writeback_approvals BEGIN SELECT RAISE(ABORT,'write-back approvals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS platform_writeback_approvals_immutable_delete
        BEFORE DELETE ON platform_writeback_approvals BEGIN SELECT RAISE(ABORT,'write-back approvals are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS platform_writeback_events_immutable_update
        BEFORE UPDATE ON platform_writeback_events BEGIN SELECT RAISE(ABORT,'write-back audit events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS platform_writeback_events_immutable_delete
        BEFORE DELETE ON platform_writeback_events BEGIN SELECT RAISE(ABORT,'write-back audit events are immutable'); END;
      INSERT INTO schema_metadata(key,value) VALUES ('platform_advanced_schema_version','1')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    `);
  }

  listDiagramExtractions(context: PlatformContext, query: CursorListQuery): Record<string, unknown> {
    return this.listByTextId('platform_diagram_extractions', context, query, asDiagramExtraction);
  }

  createDiagramExtraction(context: PlatformContext, input: DiagramExtractionCreate, actor: string, correlationId: string): Record<string, unknown> {
    const id = input.id ?? randomUUID();
    return this.transaction(() => {
      this.assertAvailable('platform_diagram_extractions', context, id, 'Diagram extraction');
      const tags = extractDiagramTags(input.text).map((tag) => ({ ...tag, page: input.page ?? tag.page }));
      const textSha256 = createHash('sha256').update(input.text).digest('hex');
      const createdAt = nowIso();
      this.database.prepare(`INSERT INTO platform_diagram_extractions(tenant_id,project_id,id,document_external_id,text_sha256,tags_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(context.tenantId, context.projectId, id, input.documentExternalId, textSha256, JSON.stringify(tags), actor, createdAt);
      this.audit(actor, 'platform.diagram_tags_extracted', 'diagramExtraction', `${context.tenantId}/${context.projectId}/${id}`, {
        documentExternalId: input.documentExternalId, textSha256, tagCount: tags.length,
      }, correlationId, createdAt);
      return asDiagramExtraction(this.rowById('platform_diagram_extractions', context, id));
    });
  }

  listMatchingEvaluations(context: PlatformContext, query: CursorListQuery): Record<string, unknown> {
    return this.listByTextId('platform_matching_evaluations', context, query, asMatchingEvaluation);
  }

  createMatchingEvaluation(context: PlatformContext, input: MatchingEvaluationCreate, actor: string, correlationId: string): Record<string, unknown> {
    const id = input.id ?? randomUUID();
    return this.transaction(() => {
      this.assertAvailable('platform_matching_evaluations', context, id, 'Matching evaluation');
      const evaluation = evaluateMatchingPredictions(input.predictions, input.truth, input.threshold);
      const proposals = rankProposedMatches(input.predictions);
      const inputSha256 = createHash('sha256').update(JSON.stringify({ predictions: input.predictions, truth: input.truth })).digest('hex');
      const createdAt = nowIso();
      this.database.prepare(`INSERT INTO platform_matching_evaluations(tenant_id,project_id,id,threshold,input_sha256,prediction_count,truth_count,evaluation_json,proposals_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(context.tenantId, context.projectId, id, input.threshold, inputSha256, input.predictions.length, input.truth.length, JSON.stringify(evaluation), JSON.stringify(proposals), actor, createdAt);
      this.audit(actor, 'platform.matching_evaluated', 'matchingEvaluation', `${context.tenantId}/${context.projectId}/${id}`, {
        inputSha256, evaluation, proposalCount: proposals.length, allProposalsRemainProposed: proposals.every((proposal) => proposal.state === 'proposed'),
      }, correlationId, createdAt);
      return asMatchingEvaluation(this.rowById('platform_matching_evaluations', context, id));
    });
  }

  listSpatialLinks(context: PlatformContext, query: CursorListQuery): Record<string, unknown> {
    return this.listByTextId('platform_spatial_asset_links', context, query, asSpatialLink);
  }

  createSpatialLink(context: PlatformContext, input: SpatialLinkCreate, actor: string, correlationId: string): Record<string, unknown> {
    const id = input.id ?? randomUUID();
    return this.transaction(() => {
      this.assertAvailable('platform_spatial_asset_links', context, id, 'Spatial asset link');
      const link = createProposedSpatialLink(input);
      const createdAt = nowIso();
      this.database.prepare(`INSERT INTO platform_spatial_asset_links(tenant_id,project_id,id,asset_external_id,scene_external_id,node_external_id,transform_json,confidence,review_state,reviewed_by,review_comment,reviewed_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,'proposed',NULL,NULL,NULL,?,?)`)
        .run(context.tenantId, context.projectId, id, link.assetExternalId, link.sceneExternalId, link.nodeExternalId, JSON.stringify(link.transform), link.confidence, actor, createdAt);
      this.audit(actor, 'platform.spatial_link_proposed', 'spatialAssetLink', `${context.tenantId}/${context.projectId}/${id}`, link, correlationId, createdAt);
      return asSpatialLink(this.rowById('platform_spatial_asset_links', context, id));
    });
  }

  reviewSpatialLink(context: PlatformContext, id: string, review: SpatialLinkReview, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.optionalRowById('platform_spatial_asset_links', context, id);
      if (!row) throw new NotFoundError(`Spatial asset link '${id}' was not found`);
      if (String(row.review_state) !== 'proposed') throw new ConflictError(`Spatial asset link '${id}' has already been ${String(row.review_state)}`);
      const reviewedAt = nowIso();
      this.database.prepare(`UPDATE platform_spatial_asset_links SET review_state=?,reviewed_by=?,review_comment=?,reviewed_at=? WHERE tenant_id=? AND project_id=? AND id=?`)
        .run(review.decision, actor, review.comment ?? null, reviewedAt, context.tenantId, context.projectId, id);
      this.audit(actor, `platform.spatial_link_${review.decision}`, 'spatialAssetLink', `${context.tenantId}/${context.projectId}/${id}`, review, correlationId, reviewedAt);
      return asSpatialLink(this.rowById('platform_spatial_asset_links', context, id));
    });
  }

  listProjectMembers(context: PlatformContext, query: CursorListQuery): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, 'userId');
    const rows = this.database.prepare(`SELECT * FROM platform_project_members WHERE tenant_id=? AND project_id=? AND user_id>? ORDER BY user_id LIMIT ?`)
      .all(context.tenantId, context.projectId, cursor, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, asProjectMember, (row) => ({ userId: String(row.user_id) }));
  }

  hasProjectMember(context: PlatformContext, userId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM platform_project_members WHERE tenant_id=? AND project_id=? AND user_id=?`)
      .get(context.tenantId, context.projectId, userId));
  }

  upsertProjectMember(context: PlatformContext, userId: string, input: ProjectMemberUpsert, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      const existing = this.database.prepare(`SELECT * FROM platform_project_members WHERE tenant_id=? AND project_id=? AND user_id=?`)
        .get(context.tenantId, context.projectId, userId) as SqliteRow | undefined;
      if (existing && String(existing.role) === 'owner' && input.role !== 'owner') this.assertAnotherOwner(context, userId);
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_project_members(tenant_id,project_id,user_id,role,created_at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,project_id,user_id) DO UPDATE SET role=excluded.role`)
        .run(context.tenantId, context.projectId, userId, input.role, timestamp);
      const action = existing ? 'platform.project_member_updated' : 'platform.project_member_added';
      this.audit(actor, action, 'projectMember', `${context.tenantId}/${context.projectId}/${userId}`, {
        previousRole: existing ? String(existing.role) : null, role: input.role,
      }, correlationId, timestamp);
      return asProjectMember(this.database.prepare(`SELECT * FROM platform_project_members WHERE tenant_id=? AND project_id=? AND user_id=?`)
        .get(context.tenantId, context.projectId, userId) as SqliteRow);
    });
  }

  removeProjectMember(context: PlatformContext, userId: string, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      const existing = this.database.prepare(`SELECT * FROM platform_project_members WHERE tenant_id=? AND project_id=? AND user_id=?`)
        .get(context.tenantId, context.projectId, userId) as SqliteRow | undefined;
      if (!existing) throw new NotFoundError(`Project member '${userId}' was not found`);
      if (String(existing.role) === 'owner') this.assertAnotherOwner(context, userId);
      this.database.prepare(`DELETE FROM platform_project_members WHERE tenant_id=? AND project_id=? AND user_id=?`)
        .run(context.tenantId, context.projectId, userId);
      const timestamp = nowIso();
      this.audit(actor, 'platform.project_member_removed', 'projectMember', `${context.tenantId}/${context.projectId}/${userId}`, {
        removedRole: String(existing.role),
      }, correlationId, timestamp);
      return asProjectMember(existing);
    });
  }

  listWritebackRequests(context: PlatformContext, query: CursorListQuery): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, 'id');
    const rows = this.database.prepare(`SELECT * FROM platform_writeback_requests WHERE tenant_id=? AND project_id=? AND id>? ORDER BY id LIMIT ?`)
      .all(context.tenantId, context.projectId, cursor, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, (row) => this.withSafety(context, row), (row) => ({ id: String(row.id) }));
  }

  createWritebackRequest(context: PlatformContext, input: WritebackRequestCreate, actor: string, correlationId: string): Record<string, unknown> {
    const id = input.id ?? randomUUID();
    return this.transaction(() => {
      this.assertAvailable('platform_writeback_requests', context, id, 'Write-back request');
      const source = this.database.prepare(`SELECT 1 FROM platform_sources WHERE tenant_id=? AND project_id=? AND id=?`)
        .get(context.tenantId, context.projectId, input.sourceId);
      if (!source) throw new NotFoundError(`Source '${input.sourceId}' was not found`);
      const requestedAt = nowIso();
      const candidate: WritebackRequest = {
        id, tenantId: context.tenantId, projectId: context.projectId, sourceId: input.sourceId,
        targetExternalId: input.targetExternalId, operation: input.operation, payload: input.payload, risk: input.risk,
        state: 'pending_approval', requestedBy: actor, requestedAt, approvals: [], dryRunResult: input.dryRunResult, executedAt: null,
      };
      const initialSafety = evaluateWritebackSafety(candidate, this.policy);
      const blockedReasons = nonApprovalReasons(initialSafety);
      const state: WritebackRequest['state'] = blockedReasons.length > 0 ? 'cancelled' : 'pending_approval';
      this.database.prepare(`INSERT INTO platform_writeback_requests(tenant_id,project_id,id,source_id,target_external_id,operation,payload_json,risk,state,dry_run_json,blocked_reasons_json,requested_by,requested_at,executed_at,execution_result_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`)
        .run(context.tenantId, context.projectId, id, input.sourceId, input.targetExternalId, input.operation, JSON.stringify(input.payload), input.risk, state, JSON.stringify(input.dryRunResult), JSON.stringify(blockedReasons), actor, requestedAt, requestedAt);
      const details = {
        operation: input.operation, risk: input.risk, targetExternalId: input.targetExternalId,
        payloadSha256: createHash('sha256').update(JSON.stringify(input.payload)).digest('hex'),
        state, safety: initialSafety,
      };
      this.writebackEvent(context, id, state === 'cancelled' ? 'request.blocked' : 'request.created', actor, details, correlationId, requestedAt);
      this.audit(actor, state === 'cancelled' ? 'platform.writeback_request_blocked' : 'platform.writeback_request_created', 'writebackRequest', `${context.tenantId}/${context.projectId}/${id}`, details, correlationId, requestedAt);
      return this.withSafety(context, this.rowById('platform_writeback_requests', context, id));
    });
  }

  approveWritebackRequest(context: PlatformContext, id: string, input: WritebackApprovalCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.optionalRowById('platform_writeback_requests', context, id);
      if (!row) throw new NotFoundError(`Write-back request '${id}' was not found`);
      if (String(row.state) !== 'pending_approval') throw new ConflictError(`Write-back request '${id}' is not pending approval`);
      if (String(row.requested_by) === actor) throw new ForbiddenError('The requester cannot approve or reject their own write-back request');
      const existing = this.database.prepare(`SELECT 1 FROM platform_writeback_approvals WHERE tenant_id=? AND project_id=? AND request_id=? AND actor=?`)
        .get(context.tenantId, context.projectId, id, actor);
      if (existing) throw new ConflictError(`Actor '${actor}' has already reviewed write-back request '${id}'`);
      const occurredAt = nowIso();
      this.database.prepare(`INSERT INTO platform_writeback_approvals(tenant_id,project_id,request_id,actor,decision,comment,occurred_at) VALUES (?,?,?,?,?,?,?)`)
        .run(context.tenantId, context.projectId, id, actor, input.decision, input.comment ?? null, occurredAt);
      let state: WritebackRequest['state'] = 'pending_approval';
      if (input.decision === 'rejected') {
        state = 'cancelled';
      } else {
        const request = this.requestFromRow(context, row);
        const decision = evaluateWritebackSafety({ ...request, approvals: this.approvals(context, id) }, this.policy);
        if (decision.allowed) state = 'approved';
        else if (nonApprovalReasons(decision).length > 0) state = 'cancelled';
      }
      this.database.prepare(`UPDATE platform_writeback_requests SET state=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=?`)
        .run(state, occurredAt, context.tenantId, context.projectId, id);
      const details = { decision: input.decision, comment: input.comment ?? null, resultingState: state };
      this.writebackEvent(context, id, `approval.${input.decision}`, actor, details, correlationId, occurredAt);
      this.audit(actor, `platform.writeback_${input.decision}`, 'writebackRequest', `${context.tenantId}/${context.projectId}/${id}`, details, correlationId, occurredAt);
      return this.withSafety(context, this.rowById('platform_writeback_requests', context, id));
    });
  }

  recordUnavailableExecutor(context: PlatformContext, id: string, actor: string, correlationId: string): void {
    this.transaction(() => {
      if (!this.optionalRowById('platform_writeback_requests', context, id)) throw new NotFoundError(`Write-back request '${id}' was not found`);
      const occurredAt = nowIso();
      const details = { reason: 'No industrial write-back executor is configured; request was not executed' };
      this.writebackEvent(context, id, 'execution.blocked', actor, details, correlationId, occurredAt);
      this.audit(actor, 'platform.writeback_execution_blocked', 'writebackRequest', `${context.tenantId}/${context.projectId}/${id}`, details, correlationId, occurredAt);
    });
  }

  assertWritebackExecutable(context: PlatformContext, id: string): void {
    const row = this.optionalRowById('platform_writeback_requests', context, id);
    if (!row) throw new NotFoundError(`Write-back request '${id}' was not found`);
    if (String(row.state) !== 'approved') throw new ConflictError(`Write-back request '${id}' is not approved for execution`);
    const safety = evaluateWritebackSafety(this.requestFromRow(context, row), this.policy);
    if (!safety.allowed) throw new ForbiddenError(`Write-back safety gates failed: ${safety.reasons.join('; ')}`);
  }

  beginWritebackExecution(context: PlatformContext, id: string, actor: string, correlationId: string): IndustrialWritebackExecution {
    return this.transaction(() => {
      const row = this.optionalRowById('platform_writeback_requests', context, id);
      if (!row) throw new NotFoundError(`Write-back request '${id}' was not found`);
      if (String(row.state) !== 'approved') throw new ConflictError(`Write-back request '${id}' is not approved for execution`);
      const request = this.requestFromRow(context, row);
      const safety = evaluateWritebackSafety(request, this.policy);
      if (!safety.allowed) throw new ForbiddenError(`Write-back safety gates failed: ${safety.reasons.join('; ')}`);
      const startedAt = nowIso();
      const updated = this.database.prepare(`UPDATE platform_writeback_requests SET state='executing',updated_at=? WHERE tenant_id=? AND project_id=? AND id=? AND state='approved'`)
        .run(startedAt, context.tenantId, context.projectId, id);
      if (updated.changes !== 1) throw new ConflictError(`Write-back request '${id}' is no longer approved for execution`);
      this.writebackEvent(context, id, 'execution.started', actor, { safety }, correlationId, startedAt);
      this.audit(actor, 'platform.writeback_execution_started', 'writebackRequest', `${context.tenantId}/${context.projectId}/${id}`, { safety }, correlationId, startedAt);
      return {
        tenantId: context.tenantId,
        projectId: context.projectId,
        requestId: id,
        sourceId: request.sourceId,
        targetExternalId: request.targetExternalId,
        operation: request.operation,
        payload: request.payload,
        risk: request.risk,
        requestedBy: request.requestedBy,
        approvedBy: request.approvals.filter((approval) => approval.decision === 'approved').map((approval) => approval.actor),
        executedBy: actor,
        correlationId,
      };
    });
  }

  completeWritebackExecution(
    context: PlatformContext,
    id: string,
    actor: string,
    correlationId: string,
    outcome: { succeeded: true; result: Record<string, unknown> } | { succeeded: false; error: string },
  ): Record<string, unknown> {
    return this.transaction(() => {
      const row = this.optionalRowById('platform_writeback_requests', context, id);
      if (!row) throw new NotFoundError(`Write-back request '${id}' was not found`);
      if (String(row.state) !== 'executing') throw new ConflictError(`Write-back request '${id}' is not executing`);
      const completedAt = nowIso();
      const state = outcome.succeeded ? 'succeeded' : 'failed';
      const result = outcome.succeeded ? outcome.result : { error: outcome.error };
      this.database.prepare(`UPDATE platform_writeback_requests SET state=?,executed_at=?,execution_result_json=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=?`)
        .run(state, completedAt, JSON.stringify(result), completedAt, context.tenantId, context.projectId, id);
      this.writebackEvent(context, id, `execution.${state}`, actor, result, correlationId, completedAt);
      this.audit(actor, `platform.writeback_execution_${state}`, 'writebackRequest', `${context.tenantId}/${context.projectId}/${id}`, result, correlationId, completedAt);
      return this.withSafety(context, this.rowById('platform_writeback_requests', context, id));
    });
  }

  listWritebackEvents(context: PlatformContext, id: string, query: CursorListQuery): Record<string, unknown> {
    if (!this.optionalRowById('platform_writeback_requests', context, id)) throw new NotFoundError(`Write-back request '${id}' was not found`);
    const cursor = decodeNumericCursor(query.cursor);
    const rows = this.database.prepare(`SELECT * FROM platform_writeback_events WHERE tenant_id=? AND project_id=? AND request_id=? AND event_id>? ORDER BY event_id LIMIT ?`)
      .all(context.tenantId, context.projectId, id, cursor, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, (row) => ({
      id: Number(row.event_id),
      tenantId: String(row.tenant_id),
      projectId: String(row.project_id),
      requestId: String(row.request_id),
      type: String(row.event_type),
      actor: String(row.actor),
      details: parseJson(row.details_json),
      correlationId: String(row.correlation_id),
      occurredAt: String(row.occurred_at),
    }), (row) => ({ eventId: Number(row.event_id) }));
  }

  private requestFromRow(context: PlatformContext, row: SqliteRow): PersistedWritebackRequest {
    return asWritebackRequest(row, this.approvals(context, String(row.id)));
  }

  private withSafety(context: PlatformContext, row: SqliteRow): Record<string, unknown> {
    const request = this.requestFromRow(context, row);
    return { ...request, safety: evaluateWritebackSafety(request, this.policy) };
  }

  private approvals(context: PlatformContext, id: string): WritebackRequest['approvals'] {
    return (this.database.prepare(`SELECT * FROM platform_writeback_approvals WHERE tenant_id=? AND project_id=? AND request_id=? ORDER BY approval_id`)
      .all(context.tenantId, context.projectId, id) as SqliteRow[]).map(asApproval);
  }

  private assertAnotherOwner(context: PlatformContext, excludedUserId: string): void {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM platform_project_members WHERE tenant_id=? AND project_id=? AND role='owner' AND user_id<>?`)
      .get(context.tenantId, context.projectId, excludedUserId) as SqliteRow;
    if (Number(row.count) < 1) throw new ConflictError('A project must retain at least one owner');
  }

  private assertAvailable(table: string, context: PlatformContext, id: string, label: string): void {
    if (this.optionalRowById(table, context, id)) throw new ConflictError(`${label} '${id}' already exists`);
  }

  private optionalRowById(table: string, context: PlatformContext, id: string): SqliteRow | undefined {
    return this.database.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND project_id=? AND id=?`)
      .get(context.tenantId, context.projectId, id) as SqliteRow | undefined;
  }

  private rowById(table: string, context: PlatformContext, id: string): SqliteRow {
    const row = this.optionalRowById(table, context, id);
    if (!row) throw new NotFoundError(`Resource '${id}' was not found`);
    return row;
  }

  private listByTextId(
    table: string,
    context: PlatformContext,
    query: CursorListQuery,
    mapper: (row: SqliteRow) => Record<string, unknown>,
  ): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, 'id');
    const rows = this.database.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND project_id=? AND id>? ORDER BY id LIMIT ?`)
      .all(context.tenantId, context.projectId, cursor, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, mapper, (row) => ({ id: String(row.id) }));
  }

  private page(
    rows: SqliteRow[],
    limit: number,
    mapper: (row: SqliteRow) => Record<string, unknown>,
    cursorFor: (row: SqliteRow) => unknown,
  ): Record<string, unknown> {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return { items: pageRows.map(mapper), nextCursor: hasMore && last ? encodeCursor(cursorFor(last)) : null };
  }

  private writebackEvent(
    context: PlatformContext,
    requestId: string,
    eventType: string,
    actor: string,
    details: unknown,
    correlationId: string,
    occurredAt: string,
  ): void {
    this.database.prepare(`INSERT INTO platform_writeback_events(tenant_id,project_id,request_id,event_type,actor,details_json,correlation_id,occurred_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(context.tenantId, context.projectId, requestId, eventType, actor, JSON.stringify(details), correlationId, occurredAt);
  }

  private audit(actor: string, action: string, entityType: string, entityId: string, details: unknown, correlationId: string, timestamp: string): void {
    this.database.prepare(`INSERT INTO audit_log(timestamp,actor,action,entity_type,entity_id,details_json,correlation_id) VALUES (?,?,?,?,?,?,?)`)
      .run(timestamp, actor, action, entityType, entityId, JSON.stringify(details), correlationId);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
