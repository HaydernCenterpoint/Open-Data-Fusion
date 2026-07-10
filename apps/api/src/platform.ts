import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { ConflictError, ForbiddenError, NotFoundError } from './database.js';
import type {
  CandidateCreate,
  CandidateReview,
  ConnectorCreate,
  CursorListQuery,
  DataModelVersionCreate,
  DatasetCreate,
  PipelineCreate,
  PipelineRunTrigger,
  PlatformContext,
  PlatformSearchQuery,
  ProjectCreate,
  QualityRuleCreate,
  SourceCreate,
  TenantCreate,
} from './platform-schemas.js';

type SqliteRow = Record<string, unknown>;
export type PlatformProjectRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

const idCursorSchema = z.object({ id: z.string().min(1) });
const modelCursorSchema = z.object({ id: z.string().min(1), version: z.number().int().positive() });
const numericCursorSchema = z.object({ id: z.number().int().nonnegative() });
const searchCursorSchema = z.object({ type: z.string().min(1), id: z.string().min(1) });

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

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (!cursor) return fallback;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    decoded = null;
  }
  return schema.parse(decoded);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asTenant(row: SqliteRow): Record<string, unknown> {
  return { id: String(row.id), name: String(row.name), createdBy: String(row.created_by), createdAt: String(row.created_at) };
}

function asProject(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), id: String(row.id), name: String(row.name),
    description: nullableString(row.description), createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asDataset(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.id), name: String(row.name),
    description: nullableString(row.description), createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asSource(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.id), name: String(row.name),
    type: String(row.type), description: nullableString(row.description), createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asConnector(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.id), name: String(row.name),
    sourceId: String(row.source_id), type: String(row.type), configuration: parseJson(row.configuration_json),
    enabled: Number(row.enabled) === 1, createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asDataModel(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.model_id), version: Number(row.version),
    name: String(row.name), schema: parseJson(row.schema_json), status: String(row.status),
    createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asPipeline(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.id), name: String(row.name),
    sourceId: nullableString(row.source_id), datasetId: nullableString(row.dataset_id), definition: parseJson(row.definition_json),
    version: Number(row.version), enabled: Number(row.enabled) === 1, createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asPipelineRun(row: SqliteRow, replayed = false): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.run_id), pipelineId: String(row.pipeline_id),
    idempotencyKey: String(row.idempotency_key), status: String(row.status), inputHash: String(row.input_hash),
    result: parseJson(row.result_json), triggeredBy: String(row.triggered_by), startedAt: String(row.started_at),
    completedAt: nullableString(row.completed_at), replayed,
  };
}

function asQualityRule(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.id), name: String(row.name),
    targetType: String(row.target_type), check: parseJson(row.check_json), severity: String(row.severity),
    enabled: Number(row.enabled) === 1, createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asQualityResult(row: SqliteRow): Record<string, unknown> {
  return {
    id: Number(row.result_id), tenantId: String(row.tenant_id), projectId: String(row.project_id),
    ruleId: String(row.rule_id), runId: String(row.run_id), passed: Number(row.passed) === 1,
    observed: parseJson(row.observed_json), evaluatedAt: String(row.evaluated_at),
  };
}

function asCandidate(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), id: String(row.id),
    source: { type: String(row.source_type), id: String(row.source_id) },
    target: { type: String(row.target_type), id: String(row.target_id) },
    relationType: String(row.relation_type), confidence: Number(row.confidence), evidence: parseJson(row.evidence_json),
    status: String(row.status), reviewedBy: nullableString(row.reviewed_by), reviewComment: nullableString(row.review_comment),
    reviewedAt: nullableString(row.reviewed_at), createdBy: String(row.created_by), createdAt: String(row.created_at),
  };
}

function asSearchResult(row: SqliteRow): Record<string, unknown> {
  const body = String(row.body);
  return {
    tenantId: String(row.tenant_id), projectId: String(row.project_id), entityType: String(row.entity_type),
    entityId: String(row.entity_id), title: String(row.title), summary: body.slice(0, 1_000), updatedAt: String(row.updated_at),
  };
}

export class PlatformCatalog {
  private searchFtsAvailable = false;

  constructor(private readonly database: DatabaseSync) {
    this.createSchema();
    this.initializeSearchFts();
    this.seedDefaultsIfWorkspaceSeeded();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS platform_tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS platform_projects (
        tenant_id TEXT NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
        id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, id)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_project_members (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner','editor','reviewer','viewer')), created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, user_id),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS platform_project_members_user_idx ON platform_project_members(user_id, tenant_id, project_id);
      CREATE TABLE IF NOT EXISTS platform_datasets (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, project_id, id),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_sources (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        description TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, project_id, id),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_connectors (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, source_id TEXT NOT NULL,
        type TEXT NOT NULL, configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, project_id, id),
        FOREIGN KEY(tenant_id, project_id, source_id) REFERENCES platform_sources(tenant_id, project_id, id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_data_models (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, model_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
        name TEXT NOT NULL, schema_json TEXT NOT NULL CHECK(json_valid(schema_json)), status TEXT NOT NULL CHECK(status IN ('draft','published')),
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, project_id, model_id, version),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_pipelines (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, source_id TEXT, dataset_id TEXT,
        definition_json TEXT NOT NULL CHECK(json_valid(definition_json)), version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, id),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id, project_id, source_id) REFERENCES platform_sources(tenant_id, project_id, id) ON DELETE RESTRICT,
        FOREIGN KEY(tenant_id, project_id, dataset_id) REFERENCES platform_datasets(tenant_id, project_id, id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_pipeline_runs (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
        status TEXT NOT NULL CHECK(status IN ('processing','completed','failed')), result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        triggered_by TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
        PRIMARY KEY(tenant_id, project_id, run_id), UNIQUE(tenant_id, project_id, pipeline_id, idempotency_key),
        FOREIGN KEY(tenant_id, project_id, pipeline_id) REFERENCES platform_pipelines(tenant_id, project_id, id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS platform_pipeline_runs_list_idx ON platform_pipeline_runs(tenant_id, project_id, run_id);
      CREATE TABLE IF NOT EXISTS platform_quality_rules (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, target_type TEXT NOT NULL,
        check_json TEXT NOT NULL CHECK(json_valid(check_json)), severity TEXT NOT NULL CHECK(severity IN ('info','warning','error')),
        enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, id),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_quality_results (
        result_id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        rule_id TEXT NOT NULL, run_id TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)),
        observed_json TEXT NOT NULL CHECK(json_valid(observed_json)), evaluated_at TEXT NOT NULL,
        FOREIGN KEY(tenant_id, project_id, rule_id) REFERENCES platform_quality_rules(tenant_id, project_id, id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id, project_id, run_id) REFERENCES platform_pipeline_runs(tenant_id, project_id, run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS platform_quality_results_scope_idx ON platform_quality_results(tenant_id, project_id, result_id);
      CREATE TABLE IF NOT EXISTS platform_context_candidates (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
        target_type TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1), evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected')), reviewed_by TEXT, review_comment TEXT, reviewed_at TEXT,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, project_id, id),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS platform_search_index (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, project_id, entity_type, entity_id),
        FOREIGN KEY(tenant_id, project_id) REFERENCES platform_projects(tenant_id, id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS platform_search_scope_idx ON platform_search_index(tenant_id, project_id, entity_type, entity_id);
      INSERT INTO schema_metadata(key, value) VALUES ('platform_schema_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
  }

  private seedDefaultsIfWorkspaceSeeded(): void {
    const seededWorkspace = this.database.prepare('SELECT 1 AS found FROM workspaces WHERE id = ?').get('cooling-water-system');
    if (!seededWorkspace) return;
    const timestamp = nowIso();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT OR IGNORE INTO platform_tenants(id,name,created_by,created_at) VALUES ('demo','Demo Industrial Tenant','system',?)`).run(timestamp);
      this.database.prepare(`INSERT OR IGNORE INTO platform_projects(tenant_id,id,name,description,created_by,created_at) VALUES ('demo','north-plant','North Plant','Seeded industrial project','system',?)`).run(timestamp);
      const member = this.database.prepare(`INSERT OR IGNORE INTO platform_project_members(tenant_id,project_id,user_id,role,created_at) VALUES ('demo','north-plant',?,?,?)`);
      member.run('harper.dennis', 'owner', timestamp);
      member.run('riley.chen', 'editor', timestamp);
      member.run('monica.reyes', 'reviewer', timestamp);
      member.run('alex.morgan', 'reviewer', timestamp);
      member.run('samantha.lee', 'viewer', timestamp);
      member.run('service-account-open-data-fusion-connector', 'editor', timestamp);
      this.refreshAssetSearchProjection({ tenantId: 'demo', projectId: 'north-plant' }, timestamp);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  assertProjectAccess(context: PlatformContext, userId: string, allowedRoles?: readonly PlatformProjectRole[]): PlatformProjectRole {
    const row = this.database.prepare(`
      SELECT role FROM platform_project_members WHERE tenant_id = ? AND project_id = ? AND user_id = ?
    `).get(context.tenantId, context.projectId, userId) as SqliteRow | undefined;
    if (!row) throw new ForbiddenError(`User '${userId}' cannot access project '${context.tenantId}/${context.projectId}'`);
    const role = String(row.role) as PlatformProjectRole;
    if (allowedRoles && !allowedRoles.includes(role)) {
      throw new ForbiddenError(`Role '${role}' cannot perform this project operation`);
    }
    return role;
  }

  assertAssetVisible(context: PlatformContext, assetExternalId: string): void {
    const statement = this.database.prepare(`
      SELECT 1 FROM platform_search_index
      WHERE tenant_id=? AND project_id=? AND entity_type='asset' AND entity_id=?
    `);
    let visible = statement.get(context.tenantId, context.projectId, assetExternalId);
    if (!visible && context.tenantId === 'demo' && context.projectId === 'north-plant') {
      this.refreshAssetSearchProjection(context, nowIso());
      visible = statement.get(context.tenantId, context.projectId, assetExternalId);
    }
    if (!visible) throw new NotFoundError(`Asset '${assetExternalId}' was not found in project '${context.tenantId}/${context.projectId}'`);
  }

  listTenants(userId: string, includeAll: boolean, query: CursorListQuery): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, idCursorSchema, { id: '' });
    const rows = includeAll
      ? this.database.prepare(`SELECT * FROM platform_tenants WHERE id > ? ORDER BY id LIMIT ?`).all(cursor.id, query.limit + 1) as SqliteRow[]
      : this.database.prepare(`
          SELECT DISTINCT tenant.* FROM platform_tenants AS tenant
          JOIN platform_project_members AS member ON member.tenant_id = tenant.id
          WHERE member.user_id = ? AND tenant.id > ? ORDER BY tenant.id LIMIT ?
        `).all(userId, cursor.id, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, asTenant, (row) => ({ id: String(row.id) }));
  }

  createTenant(input: TenantCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      if (this.database.prepare('SELECT 1 FROM platform_tenants WHERE id = ?').get(input.id)) throw new ConflictError(`Tenant '${input.id}' already exists`);
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_tenants(id,name,created_by,created_at) VALUES (?,?,?,?)`).run(input.id, input.name, actor, timestamp);
      this.audit(actor, 'platform.tenant_created', 'tenant', input.id, input, correlationId, timestamp);
      return asTenant(this.database.prepare('SELECT * FROM platform_tenants WHERE id = ?').get(input.id) as SqliteRow);
    });
  }

  listProjects(tenantId: string, userId: string, includeAll: boolean, query: CursorListQuery): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, idCursorSchema, { id: '' });
    const rows = includeAll
      ? this.database.prepare(`SELECT * FROM platform_projects WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?`).all(tenantId, cursor.id, query.limit + 1) as SqliteRow[]
      : this.database.prepare(`
          SELECT project.* FROM platform_projects AS project
          JOIN platform_project_members AS member ON member.tenant_id=project.tenant_id AND member.project_id=project.id
          WHERE project.tenant_id=? AND member.user_id=? AND project.id>? ORDER BY project.id LIMIT ?
        `).all(tenantId, userId, cursor.id, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, asProject, (row) => ({ id: String(row.id) }));
  }

  createProject(tenantId: string, input: ProjectCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      if (!this.database.prepare('SELECT 1 FROM platform_tenants WHERE id=?').get(tenantId)) throw new NotFoundError(`Tenant '${tenantId}' was not found`);
      if (this.database.prepare('SELECT 1 FROM platform_projects WHERE tenant_id=? AND id=?').get(tenantId, input.id)) throw new ConflictError(`Project '${tenantId}/${input.id}' already exists`);
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_projects(tenant_id,id,name,description,created_by,created_at) VALUES (?,?,?,?,?,?)`).run(tenantId, input.id, input.name, input.description ?? null, actor, timestamp);
      this.database.prepare(`INSERT INTO platform_project_members(tenant_id,project_id,user_id,role,created_at) VALUES (?,?,?,'owner',?)`).run(tenantId, input.id, actor, timestamp);
      this.upsertSearch({ tenantId, projectId: input.id }, 'project', input.id, input.name, input.description ?? '', timestamp);
      this.audit(actor, 'platform.project_created', 'project', `${tenantId}/${input.id}`, input, correlationId, timestamp);
      return asProject(this.database.prepare('SELECT * FROM platform_projects WHERE tenant_id=? AND id=?').get(tenantId, input.id) as SqliteRow);
    });
  }

  listDatasets(context: PlatformContext, query: CursorListQuery): Record<string, unknown> { return this.listScoped('platform_datasets', context, query, asDataset); }
  listSources(context: PlatformContext, query: CursorListQuery): Record<string, unknown> { return this.listScoped('platform_sources', context, query, asSource); }
  listConnectors(context: PlatformContext, query: CursorListQuery): Record<string, unknown> { return this.listScoped('platform_connectors', context, query, asConnector); }
  listPipelines(context: PlatformContext, query: CursorListQuery): Record<string, unknown> { return this.listScoped('platform_pipelines', context, query, asPipeline); }
  listQualityRules(context: PlatformContext, query: CursorListQuery): Record<string, unknown> { return this.listScoped('platform_quality_rules', context, query, asQualityRule); }
  listCandidates(context: PlatformContext, query: CursorListQuery): Record<string, unknown> { return this.listScoped('platform_context_candidates', context, query, asCandidate); }

  createDataset(context: PlatformContext, input: DatasetCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.createScoped('platform_datasets', 'dataset', context, input.id, actor, correlationId, () => {
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_datasets(tenant_id,project_id,id,name,description,created_by,created_at) VALUES (?,?,?,?,?,?,?)`).run(context.tenantId, context.projectId, input.id, input.name, input.description ?? null, actor, timestamp);
      this.upsertSearch(context, 'dataset', input.id, input.name, input.description ?? '', timestamp);
      return asDataset(this.database.prepare(`SELECT * FROM platform_datasets WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.id) as SqliteRow);
    }, input);
  }

  createSource(context: PlatformContext, input: SourceCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.createScoped('platform_sources', 'source', context, input.id, actor, correlationId, () => {
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_sources(tenant_id,project_id,id,name,type,description,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(context.tenantId, context.projectId, input.id, input.name, input.type, input.description ?? null, actor, timestamp);
      this.upsertSearch(context, 'source', input.id, input.name, `${input.type} ${input.description ?? ''}`, timestamp);
      return asSource(this.database.prepare(`SELECT * FROM platform_sources WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.id) as SqliteRow);
    }, input);
  }

  createConnector(context: PlatformContext, input: ConnectorCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.createScoped('platform_connectors', 'connector', context, input.id, actor, correlationId, () => {
      if (!this.database.prepare(`SELECT 1 FROM platform_sources WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.sourceId)) throw new NotFoundError(`Source '${input.sourceId}' was not found`);
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_connectors(tenant_id,project_id,id,name,source_id,type,configuration_json,enabled,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(context.tenantId, context.projectId, input.id, input.name, input.sourceId, input.type, JSON.stringify(input.configuration), input.enabled ? 1 : 0, actor, timestamp);
      this.upsertSearch(context, 'connector', input.id, input.name, `${input.type} ${input.sourceId}`, timestamp);
      return asConnector(this.database.prepare(`SELECT * FROM platform_connectors WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.id) as SqliteRow);
    }, { ...input, configuration: '[redacted configuration]' });
  }

  listDataModels(context: PlatformContext, query: CursorListQuery): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, modelCursorSchema, { id: '', version: 0 });
    const rows = this.database.prepare(`
      SELECT * FROM platform_data_models WHERE tenant_id=? AND project_id=?
        AND (model_id > ? OR (model_id = ? AND version > ?))
      ORDER BY model_id, version LIMIT ?
    `).all(context.tenantId, context.projectId, cursor.id, cursor.id, cursor.version, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, asDataModel, (row) => ({ id: String(row.model_id), version: Number(row.version) }));
  }

  createDataModelVersion(context: PlatformContext, modelId: string, input: DataModelVersionCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      const latest = this.database.prepare(`SELECT MAX(version) AS version FROM platform_data_models WHERE tenant_id=? AND project_id=? AND model_id=?`).get(context.tenantId, context.projectId, modelId) as SqliteRow;
      const version = Number(latest.version ?? 0) + 1;
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_data_models(tenant_id,project_id,model_id,version,name,schema_json,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(context.tenantId, context.projectId, modelId, version, input.name, JSON.stringify(input.schema), input.status, actor, timestamp);
      this.upsertSearch(context, 'dataModel', `${modelId}@${version}`, input.name, `${input.status} model ${modelId}`, timestamp);
      this.audit(actor, 'platform.data_model_version_created', 'dataModel', `${context.tenantId}/${context.projectId}/${modelId}@${version}`, { modelId, version, name: input.name, status: input.status }, correlationId, timestamp);
      return asDataModel(this.database.prepare(`SELECT * FROM platform_data_models WHERE tenant_id=? AND project_id=? AND model_id=? AND version=?`).get(context.tenantId, context.projectId, modelId, version) as SqliteRow);
    });
  }

  createPipeline(context: PlatformContext, input: PipelineCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.createScoped('platform_pipelines', 'pipeline', context, input.id, actor, correlationId, () => {
      if (input.sourceId && !this.database.prepare(`SELECT 1 FROM platform_sources WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.sourceId)) throw new NotFoundError(`Source '${input.sourceId}' was not found`);
      if (input.datasetId && !this.database.prepare(`SELECT 1 FROM platform_datasets WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.datasetId)) throw new NotFoundError(`Dataset '${input.datasetId}' was not found`);
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_pipelines(tenant_id,project_id,id,name,source_id,dataset_id,definition_json,version,enabled,created_by,created_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)`).run(context.tenantId, context.projectId, input.id, input.name, input.sourceId ?? null, input.datasetId ?? null, JSON.stringify(input.definition), input.enabled ? 1 : 0, actor, timestamp);
      this.upsertSearch(context, 'pipeline', input.id, input.name, `${input.sourceId ?? ''} ${input.datasetId ?? ''}`, timestamp);
      return asPipeline(this.database.prepare(`SELECT * FROM platform_pipelines WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.id) as SqliteRow);
    }, input);
  }

  triggerPipelineRun(context: PlatformContext, pipelineId: string, input: PipelineRunTrigger, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      const pipeline = this.database.prepare(`SELECT * FROM platform_pipelines WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, pipelineId) as SqliteRow | undefined;
      if (!pipeline) throw new NotFoundError(`Pipeline '${pipelineId}' was not found`);
      if (Number(pipeline.enabled) !== 1) throw new ConflictError(`Pipeline '${pipelineId}' is disabled`);
      const inputHash = createHash('sha256').update(canonicalJson({ pipelineVersion: Number(pipeline.version), input: input.input })).digest('hex');
      const prior = this.database.prepare(`SELECT * FROM platform_pipeline_runs WHERE tenant_id=? AND project_id=? AND pipeline_id=? AND idempotency_key=?`).get(context.tenantId, context.projectId, pipelineId, input.idempotencyKey) as SqliteRow | undefined;
      if (prior) {
        if (String(prior.input_hash) !== inputHash) throw new ConflictError(`Pipeline run key '${input.idempotencyKey}' was already used with different input`);
        return asPipelineRun(prior, true);
      }

      const runId = `run-${createHash('sha256').update(`${context.tenantId}:${context.projectId}:${pipelineId}:${input.idempotencyKey}`).digest('hex').slice(0, 32)}`;
      const startedAt = nowIso();
      this.database.prepare(`INSERT INTO platform_pipeline_runs(tenant_id,project_id,run_id,pipeline_id,idempotency_key,input_hash,input_json,status,result_json,triggered_by,started_at,completed_at) VALUES (?,?,?,?,?,?,?,'processing','{}',?,?,NULL)`).run(context.tenantId, context.projectId, runId, pipelineId, input.idempotencyKey, inputHash, JSON.stringify(input.input), actor, startedAt);
      const quality = this.evaluateQualityRules(context, runId, input.input, startedAt);
      const result = { fingerprint: inputHash, quality };
      const completedAt = nowIso();
      this.database.prepare(`UPDATE platform_pipeline_runs SET status='completed', result_json=?, completed_at=? WHERE tenant_id=? AND project_id=? AND run_id=?`).run(JSON.stringify(result), completedAt, context.tenantId, context.projectId, runId);
      this.audit(actor, 'platform.pipeline_run_completed', 'pipelineRun', `${context.tenantId}/${context.projectId}/${runId}`, { pipelineId, runId, idempotencyKey: input.idempotencyKey, inputHash, quality }, correlationId, completedAt);
      const row = this.database.prepare(`SELECT * FROM platform_pipeline_runs WHERE tenant_id=? AND project_id=? AND run_id=?`).get(context.tenantId, context.projectId, runId) as SqliteRow;
      return asPipelineRun(row);
    });
  }

  listPipelineRuns(context: PlatformContext, query: CursorListQuery): Record<string, unknown> { return this.listScoped('platform_pipeline_runs', context, query, asPipelineRun, 'run_id'); }

  createQualityRule(context: PlatformContext, input: QualityRuleCreate, actor: string, correlationId: string): Record<string, unknown> {
    return this.createScoped('platform_quality_rules', 'qualityRule', context, input.id, actor, correlationId, () => {
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_quality_rules(tenant_id,project_id,id,name,target_type,check_json,severity,enabled,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(context.tenantId, context.projectId, input.id, input.name, input.targetType, JSON.stringify(input.check), input.severity, input.enabled ? 1 : 0, actor, timestamp);
      this.upsertSearch(context, 'qualityRule', input.id, input.name, `${input.targetType} ${input.severity}`, timestamp);
      return asQualityRule(this.database.prepare(`SELECT * FROM platform_quality_rules WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, input.id) as SqliteRow);
    }, input);
  }

  listQualityResults(context: PlatformContext, query: CursorListQuery): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, numericCursorSchema, { id: 0 });
    const rows = this.database.prepare(`SELECT * FROM platform_quality_results WHERE tenant_id=? AND project_id=? AND result_id>? ORDER BY result_id LIMIT ?`).all(context.tenantId, context.projectId, cursor.id, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, asQualityResult, (row) => ({ id: Number(row.result_id) }));
  }

  createCandidate(context: PlatformContext, input: CandidateCreate, actor: string, correlationId: string): Record<string, unknown> {
    const candidateId = input.id ?? randomUUID();
    return this.createScoped('platform_context_candidates', 'contextCandidate', context, candidateId, actor, correlationId, () => {
      const timestamp = nowIso();
      this.database.prepare(`INSERT INTO platform_context_candidates(tenant_id,project_id,id,source_type,source_id,target_type,target_id,relation_type,confidence,evidence_json,status,reviewed_by,review_comment,reviewed_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'proposed',NULL,NULL,NULL,?,?)`).run(context.tenantId, context.projectId, candidateId, input.source.type, input.source.id, input.target.type, input.target.id, input.relationType, input.confidence, JSON.stringify(input.evidence), actor, timestamp);
      this.upsertSearch(context, 'contextCandidate', candidateId, `${input.relationType}: ${input.source.id} → ${input.target.id}`, JSON.stringify(input.evidence), timestamp);
      return asCandidate(this.database.prepare(`SELECT * FROM platform_context_candidates WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, candidateId) as SqliteRow);
    }, { ...input, id: candidateId });
  }

  reviewCandidate(context: PlatformContext, candidateId: string, review: CandidateReview, actor: string, correlationId: string): Record<string, unknown> {
    return this.transaction(() => {
      const current = this.database.prepare(`SELECT * FROM platform_context_candidates WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, candidateId) as SqliteRow | undefined;
      if (!current) throw new NotFoundError(`Contextualization candidate '${candidateId}' was not found`);
      if (String(current.status) !== 'proposed') throw new ConflictError(`Contextualization candidate '${candidateId}' has already been ${String(current.status)}`);
      const reviewedAt = nowIso();
      this.database.prepare(`UPDATE platform_context_candidates SET status=?,reviewed_by=?,review_comment=?,reviewed_at=? WHERE tenant_id=? AND project_id=? AND id=?`).run(review.decision, actor, review.comment ?? null, reviewedAt, context.tenantId, context.projectId, candidateId);
      this.audit(actor, `platform.context_candidate_${review.decision}`, 'contextCandidate', `${context.tenantId}/${context.projectId}/${candidateId}`, { previousStatus: 'proposed', decision: review.decision, comment: review.comment ?? null }, correlationId, reviewedAt);
      return asCandidate(this.database.prepare(`SELECT * FROM platform_context_candidates WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, candidateId) as SqliteRow);
    });
  }

  search(context: PlatformContext, query: PlatformSearchQuery): Record<string, unknown> {
    if (context.tenantId === 'demo' && context.projectId === 'north-plant') this.refreshAssetSearchProjection(context, nowIso());
    const cursor = decodeCursor(query.cursor, searchCursorSchema, { type: '', id: '' });
    if (this.searchFtsAvailable) {
      const terms = query.q.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (terms.length > 0) {
        const match = terms.map((term) => `"${term}"*`).join(' AND ');
        const typeCondition = query.entityType ? 'AND search.entity_type = ?' : '';
        const parameters: Array<string | number> = [match, context.tenantId, context.projectId];
        if (query.entityType) parameters.push(query.entityType);
        parameters.push(cursor.type, cursor.type, cursor.id, query.limit + 1);
        try {
          const rows = this.database.prepare(`
            SELECT search.* FROM platform_search_fts AS fts
            JOIN platform_search_index AS search
              ON search.tenant_id=fts.tenant_id AND search.project_id=fts.project_id
             AND search.entity_type=fts.entity_type AND search.entity_id=fts.entity_id
            WHERE platform_search_fts MATCH ? AND fts.tenant_id=? AND fts.project_id=?
              ${typeCondition} AND (search.entity_type > ? OR (search.entity_type = ? AND search.entity_id > ?))
            ORDER BY search.entity_type,search.entity_id LIMIT ?
          `).all(...parameters) as SqliteRow[];
          if (rows.length > 0) {
            return this.page(rows, query.limit, asSearchResult, (row) => ({ type: String(row.entity_type), id: String(row.entity_id) }));
          }
        } catch {
          this.searchFtsAvailable = false;
        }
      }
    }
    const search = `%${query.q}%`;
    const typeCondition = query.entityType ? 'AND entity_type = ?' : '';
    const parameters: Array<string | number> = [context.tenantId, context.projectId, search, search];
    if (query.entityType) parameters.push(query.entityType);
    parameters.push(cursor.type, cursor.type, cursor.id, query.limit + 1);
    const rows = this.database.prepare(`
      SELECT * FROM platform_search_index
      WHERE tenant_id=? AND project_id=? AND (title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE)
        ${typeCondition} AND (entity_type > ? OR (entity_type = ? AND entity_id > ?))
      ORDER BY entity_type, entity_id LIMIT ?
    `).all(...parameters) as SqliteRow[];
    return this.page(rows, query.limit, asSearchResult, (row) => ({ type: String(row.entity_type), id: String(row.entity_id) }));
  }

  indexSearchDocument(
    context: PlatformContext,
    entityType: string,
    entityId: string,
    title: string,
    body: string,
    timestamp = nowIso(),
  ): void {
    this.upsertSearch(context, entityType, entityId, title, body, timestamp);
  }

  private listScoped(
    table: string,
    context: PlatformContext,
    query: CursorListQuery,
    mapper: (row: SqliteRow) => Record<string, unknown>,
    idColumn = 'id',
  ): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, idCursorSchema, { id: '' });
    const rows = this.database.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND project_id=? AND ${idColumn}>? ORDER BY ${idColumn} LIMIT ?`).all(context.tenantId, context.projectId, cursor.id, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, mapper, (row) => ({ id: String(row[idColumn]) }));
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

  private createScoped<TInput extends object>(
    table: string,
    entityType: string,
    context: PlatformContext,
    id: string,
    actor: string,
    correlationId: string,
    create: () => Record<string, unknown>,
    auditInput: TInput,
  ): Record<string, unknown> {
    return this.transaction(() => {
      if (this.database.prepare(`SELECT 1 FROM ${table} WHERE tenant_id=? AND project_id=? AND id=?`).get(context.tenantId, context.projectId, id)) throw new ConflictError(`${entityType} '${id}' already exists`);
      const result = create();
      this.audit(actor, `platform.${entityType}_created`, entityType, `${context.tenantId}/${context.projectId}/${id}`, auditInput, correlationId);
      return result;
    });
  }

  private evaluateQualityRules(context: PlatformContext, runId: string, input: Record<string, unknown>, evaluatedAt: string): Record<string, number> {
    const rules = this.database.prepare(`SELECT * FROM platform_quality_rules WHERE tenant_id=? AND project_id=? AND enabled=1 ORDER BY id`).all(context.tenantId, context.projectId) as SqliteRow[];
    let passed = 0;
    for (const rule of rules) {
      const check = parseJson(rule.check_json) as { operator?: string; field?: string; value?: unknown };
      const actual = this.valueAtPath(input, check.field ?? '');
      const ok = check.operator === 'required'
        ? actual !== undefined && actual !== null && actual !== ''
        : check.operator === 'equals'
          ? canonicalJson(actual) === canonicalJson(check.value)
          : check.operator === 'gte'
            ? typeof actual === 'number' && typeof check.value === 'number' && actual >= check.value
            : check.operator === 'lte'
              ? typeof actual === 'number' && typeof check.value === 'number' && actual <= check.value
              : false;
      if (ok) passed += 1;
      this.database.prepare(`INSERT INTO platform_quality_results(tenant_id,project_id,rule_id,run_id,passed,observed_json,evaluated_at) VALUES (?,?,?,?,?,?,?)`).run(context.tenantId, context.projectId, String(rule.id), runId, ok ? 1 : 0, JSON.stringify({ actual: actual ?? null }), evaluatedAt);
    }
    return { total: rules.length, passed, failed: rules.length - passed };
  }

  private valueAtPath(input: Record<string, unknown>, path: string): unknown {
    let current: unknown = input;
    for (const segment of path.split('.').filter(Boolean)) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  private refreshAssetSearchProjection(context: PlatformContext, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO platform_search_index(tenant_id,project_id,entity_type,entity_id,title,body,updated_at)
      SELECT ?,?,'asset',external_id,name,COALESCE(description,'') || ' ' || type,? FROM assets WHERE 1
      ON CONFLICT(tenant_id,project_id,entity_type,entity_id) DO UPDATE SET
        title=excluded.title,body=excluded.body,updated_at=excluded.updated_at
    `).run(context.tenantId, context.projectId, timestamp);
    if (this.searchFtsAvailable) {
      try {
        this.database.prepare(`DELETE FROM platform_search_fts WHERE tenant_id=? AND project_id=? AND entity_type='asset'`)
          .run(context.tenantId, context.projectId);
        this.database.prepare(`
          INSERT INTO platform_search_fts(tenant_id,project_id,entity_type,entity_id,title,body)
          SELECT tenant_id,project_id,entity_type,entity_id,title,body FROM platform_search_index
          WHERE tenant_id=? AND project_id=? AND entity_type='asset'
        `).run(context.tenantId, context.projectId);
      } catch {
        this.searchFtsAvailable = false;
      }
    }
  }

  private upsertSearch(context: PlatformContext, entityType: string, entityId: string, title: string, body: string, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO platform_search_index(tenant_id,project_id,entity_type,entity_id,title,body,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,project_id,entity_type,entity_id) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at
    `).run(context.tenantId, context.projectId, entityType, entityId, title, body, timestamp);
    if (this.searchFtsAvailable) {
      try {
        this.database.prepare(`DELETE FROM platform_search_fts WHERE tenant_id=? AND project_id=? AND entity_type=? AND entity_id=?`)
          .run(context.tenantId, context.projectId, entityType, entityId);
        this.database.prepare(`INSERT INTO platform_search_fts(tenant_id,project_id,entity_type,entity_id,title,body) VALUES (?,?,?,?,?,?)`)
          .run(context.tenantId, context.projectId, entityType, entityId, title, body);
      } catch {
        this.searchFtsAvailable = false;
      }
    }
  }

  private initializeSearchFts(): void {
    try {
      this.database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS platform_search_fts USING fts5(
          tenant_id UNINDEXED, project_id UNINDEXED, entity_type UNINDEXED, entity_id UNINDEXED,
          title, body, tokenize='unicode61'
        );
        DELETE FROM platform_search_fts;
        INSERT INTO platform_search_fts(tenant_id,project_id,entity_type,entity_id,title,body)
        SELECT tenant_id,project_id,entity_type,entity_id,title,body FROM platform_search_index;
      `);
      this.searchFtsAvailable = true;
    } catch {
      this.searchFtsAvailable = false;
    }
  }

  private audit(actor: string, action: string, entityType: string, entityId: string, details: unknown, correlationId: string, timestamp = nowIso()): void {
    this.database.prepare(`INSERT INTO audit_log(timestamp,actor,action,entity_type,entity_id,details_json,correlation_id) VALUES (?,?,?,?,?,?,?)`).run(timestamp, actor, action, entityType, entityId, JSON.stringify(details), correlationId);
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
