import { createHash } from 'node:crypto';

import type { RuntimeClient, RuntimePool } from '@open-data-fusion/postgres-runtime';

import {
  createCutoverChecksum,
  parseSqliteCutoverPreflightReport,
  SqliteCutoverPreflightError,
  type AuditEventCutoverExport,
  type JsonObject,
  type SqliteCutoverPreflightReport,
  type WorkspaceCutoverExport,
  type WorkspaceMemberCutoverExport,
  type WorkspaceRevisionCutoverExport,
} from './cutover-preflight.js';

const IMPORT_BATCH_SIZE = 500;
const POSTGRES_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const CORRELATION_ID_MAPPING_ALGORITHM = 'open-data-fusion.uuidv8.sha256.v1';
const LEGACY_CORRELATION_NAMESPACE = `${CORRELATION_ID_MAPPING_ALGORITHM}\0`;

export const REQUIRED_CUTOVER_MIGRATIONS = [
  '001_workspace_event_foundation',
  '002_workspace_owner_invariant',
  '003_tenant_industrial_data_plane',
  '004_sqlite_cutover_role',
] as const;

export interface SqliteCutoverImportOptions {
  apply?: boolean;
  /** Fresh report read from the frozen SQLite source immediately before apply. */
  currentSource?: unknown;
}

export interface SqliteCutoverImportReport {
  mode: 'applied' | 'dry-run';
  source: SqliteCutoverPreflightReport['source'];
  counts: SqliteCutoverPreflightReport['counts'];
  sourceChecksums: SqliteCutoverPreflightReport['checksums'];
  targetChecksums: SqliteCutoverPreflightReport['checksums'];
  correlationIds: {
    algorithm: typeof CORRELATION_ID_MAPPING_ALGORITHM;
    uniqueSourceValues: number;
    remappedValues: number;
    mappingChecksum: string;
  };
}

interface TargetData {
  workspaces: WorkspaceCutoverExport[];
  revisions: WorkspaceRevisionCutoverExport[];
  members: WorkspaceMemberCutoverExport[];
  auditEvents: AuditEventCutoverExport[];
}

interface CorrelationIdMapping {
  values: Map<string, string>;
  remappedValues: number;
  checksum: string;
}

type CutoverChecksums = SqliteCutoverPreflightReport['checksums'];
type CutoverCounts = SqliteCutoverPreflightReport['counts'];
type SqlRow = Record<string, unknown>;

function deterministicCorrelationUuid(value: string): string {
  if (POSTGRES_UUID_PATTERN.test(value)) return value.toLowerCase();

  const bytes = Buffer.from(
    createHash('sha256').update(LEGACY_CORRELATION_NAMESPACE).update(value).digest().subarray(0, 16),
  );
  // UUIDv8 marks this as an application-defined deterministic mapping rather
  // than claiming the SHA-1 namespace algorithm required by UUIDv5.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createCorrelationIdMapping(report: SqliteCutoverPreflightReport): CorrelationIdMapping {
  const sourceValues = [...new Set([
    ...report.revisions.map((revision) => revision.correlationId),
    ...report.auditEvents.map((event) => event.correlationId),
  ])].sort();
  const values = new Map<string, string>();
  const targets = new Map<string, string>();
  let remappedValues = 0;

  for (const source of sourceValues) {
    const target = deterministicCorrelationUuid(source);
    const priorSource = targets.get(target);
    if (priorSource !== undefined && priorSource !== source) {
      throw new SqliteCutoverPreflightError(
        `SQLite correlation IDs '${priorSource}' and '${source}' resolve to the same PostgreSQL UUID`,
      );
    }
    values.set(source, target);
    targets.set(target, source);
    if (target !== source.toLowerCase()) remappedValues += 1;
  }

  return {
    values,
    remappedValues,
    checksum: createCutoverChecksum(sourceValues.map((source) => ({ source, target: values.get(source) }))),
  };
}

function normalizedTimestamp(value: string | Date, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} is not a valid timestamp`);
  return date.toISOString();
}

function mappedCorrelationId(mapping: CorrelationIdMapping, source: string): string {
  const value = mapping.values.get(source);
  if (!value) throw new SqliteCutoverPreflightError(`SQLite correlation ID '${source}' has no PostgreSQL mapping`);
  return value;
}

function createExpectedTargetData(
  report: SqliteCutoverPreflightReport,
  mapping: CorrelationIdMapping,
): TargetData {
  return {
    workspaces: report.workspaces.map((workspace) => ({
      ...workspace,
      createdAt: normalizedTimestamp(workspace.createdAt, `Workspace '${workspace.id}' createdAt`),
      updatedAt: normalizedTimestamp(workspace.updatedAt, `Workspace '${workspace.id}' updatedAt`),
    })),
    revisions: report.revisions.map((revision) => ({
      ...revision,
      createdAt: normalizedTimestamp(
        revision.createdAt,
        `Workspace '${revision.workspaceId}' revision ${revision.version} createdAt`,
      ),
      correlationId: mappedCorrelationId(mapping, revision.correlationId),
    })),
    members: report.members.map((member) => ({
      ...member,
      createdAt: normalizedTimestamp(
        member.createdAt,
        `Workspace '${member.workspaceId}' member '${member.userId}' createdAt`,
      ),
    })),
    auditEvents: report.auditEvents.map((event) => ({
      ...event,
      timestamp: normalizedTimestamp(event.timestamp, `Audit event ${event.id} timestamp`),
      correlationId: mappedCorrelationId(mapping, event.correlationId),
    })),
  };
}

function assertCurrentSourceMatchesBundle(
  bundle: SqliteCutoverPreflightReport,
  currentSourceValue: unknown,
): void {
  const currentSource = parseSqliteCutoverPreflightReport(currentSourceValue);
  if (currentSource.source.schemaVersion !== bundle.source.schemaVersion) {
    throw new SqliteCutoverPreflightError(
      `Frozen SQLite schema version '${currentSource.source.schemaVersion}' does not match bundle version '${bundle.source.schemaVersion}'`,
    );
  }
  if (!countsAreEqual(currentSource.counts, bundle.counts)) {
    throw new SqliteCutoverPreflightError(
      `Frozen SQLite counts ${JSON.stringify(currentSource.counts)} do not match bundle counts ${JSON.stringify(bundle.counts)}`,
    );
  }
  for (const key of Object.keys(bundle.checksums) as Array<keyof CutoverChecksums>) {
    if (currentSource.checksums[key] !== bundle.checksums[key]) {
      throw new SqliteCutoverPreflightError(
        `Frozen SQLite checksum '${key}' no longer matches the rehearsed bundle; generate and rehearse a new bundle`,
      );
    }
  }
}

function checksums(data: TargetData): CutoverChecksums {
  return {
    workspaces: createCutoverChecksum(data.workspaces),
    revisions: createCutoverChecksum(data.revisions),
    members: createCutoverChecksum(data.members),
    auditEvents: createCutoverChecksum(data.auditEvents),
  };
}

function safeInteger(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${field} is not a safe integer`);
  return number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is not valid text`);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be text or null`);
  return value;
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${field} must be a JSON object`);
  }
  return value as JsonObject;
}

function mapTargetRows(
  workspaceRows: SqlRow[],
  revisionRows: SqlRow[],
  memberRows: SqlRow[],
  auditRows: SqlRow[],
): TargetData {
  return {
    workspaces: workspaceRows.map((row) => ({
      id: text(row.id, 'workspace.id'),
      name: text(row.name, 'workspace.name'),
      snapshot: jsonObject(row.snapshot, 'workspace.snapshot'),
      version: safeInteger(row.version, 'workspace.version'),
      createdBy: text(row.created_by, 'workspace.created_by'),
      createdAt: normalizedTimestamp(row.created_at as string | Date, 'workspace.created_at'),
      updatedBy: text(row.updated_by, 'workspace.updated_by'),
      updatedAt: normalizedTimestamp(row.updated_at as string | Date, 'workspace.updated_at'),
    })),
    revisions: revisionRows.map((row) => ({
      workspaceId: text(row.workspace_id, 'workspace_revision.workspace_id'),
      version: safeInteger(row.version, 'workspace_revision.version'),
      snapshot: jsonObject(row.snapshot, 'workspace_revision.snapshot'),
      changeSummary: text(row.change_summary, 'workspace_revision.change_summary'),
      actor: text(row.actor, 'workspace_revision.actor'),
      createdAt: normalizedTimestamp(row.created_at as string | Date, 'workspace_revision.created_at'),
      correlationId: text(row.correlation_id, 'workspace_revision.correlation_id').toLowerCase(),
    })),
    members: memberRows.map((row) => ({
      workspaceId: text(row.workspace_id, 'workspace_member.workspace_id'),
      userId: text(row.user_id, 'workspace_member.user_id'),
      displayName: text(row.display_name, 'workspace_member.display_name'),
      role: text(row.role, 'workspace_member.role'),
      createdAt: normalizedTimestamp(row.created_at as string | Date, 'workspace_member.created_at'),
    })),
    auditEvents: auditRows.map((row) => ({
      id: safeInteger(row.id, 'audit_event.id'),
      timestamp: normalizedTimestamp(row.occurred_at as string | Date, 'audit_event.occurred_at'),
      actor: text(row.actor, 'audit_event.actor'),
      action: text(row.action, 'audit_event.action'),
      entityType: text(row.entity_type, 'audit_event.entity_type'),
      entityId: nullableText(row.entity_id, 'audit_event.entity_id'),
      details: jsonObject(row.details, 'audit_event.details'),
      correlationId: text(row.correlation_id, 'audit_event.correlation_id').toLowerCase(),
    })),
  };
}

function parseCounts(row: SqlRow | undefined): CutoverCounts {
  if (!row) throw new Error('PostgreSQL did not return target table counts');
  return {
    workspaces: safeInteger(row.workspaces, 'workspaces count'),
    revisions: safeInteger(row.revisions, 'revisions count'),
    members: safeInteger(row.members, 'members count'),
    auditEvents: safeInteger(row.audit_events, 'audit events count'),
  };
}

async function readTargetCounts(client: RuntimeClient): Promise<CutoverCounts> {
  const result = await client.query({
    text: [
      'SELECT',
      '  (SELECT count(*) FROM odf.workspaces) AS workspaces,',
      '  (SELECT count(*) FROM odf.workspace_revisions) AS revisions,',
      '  (SELECT count(*) FROM odf.workspace_members) AS members,',
      '  (SELECT count(*) FROM odf.audit_log) AS audit_events',
    ].join('\n'),
  });
  return parseCounts(result.rows[0]);
}

function countsAreEqual(left: CutoverCounts, right: CutoverCounts): boolean {
  return left.workspaces === right.workspaces
    && left.revisions === right.revisions
    && left.members === right.members
    && left.auditEvents === right.auditEvents;
}

function emptyCounts(counts: CutoverCounts): boolean {
  return countsAreEqual(counts, { workspaces: 0, revisions: 0, members: 0, auditEvents: 0 });
}

async function insertBatches(
  client: RuntimeClient,
  queryText: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  for (let offset = 0; offset < records.length; offset += IMPORT_BATCH_SIZE) {
    const batch = records.slice(offset, offset + IMPORT_BATCH_SIZE);
    await client.query({ text: queryText, values: [JSON.stringify(batch)] });
  }
}

async function insertTargetData(client: RuntimeClient, data: TargetData): Promise<void> {
  await insertBatches(client, [
    'INSERT INTO odf.workspaces',
    '  (id, name, snapshot, version, created_by, created_at, updated_by, updated_at)',
    'SELECT item.id, item.name, item.snapshot, item.version, item.created_by, item.created_at, item.updated_by, item.updated_at',
    'FROM jsonb_to_recordset($1::jsonb) AS item(',
    '  id text, name text, snapshot jsonb, version bigint, created_by text, created_at timestamptz,',
    '  updated_by text, updated_at timestamptz',
    ')',
  ].join('\n'), data.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    snapshot: workspace.snapshot,
    version: workspace.version,
    created_by: workspace.createdBy,
    created_at: workspace.createdAt,
    updated_by: workspace.updatedBy,
    updated_at: workspace.updatedAt,
  })));

  await insertBatches(client, [
    'INSERT INTO odf.workspace_revisions',
    '  (workspace_id, version, snapshot, change_summary, actor, created_at, correlation_id)',
    'SELECT item.workspace_id, item.version, item.snapshot, item.change_summary, item.actor, item.created_at, item.correlation_id',
    'FROM jsonb_to_recordset($1::jsonb) AS item(',
    '  workspace_id text, version bigint, snapshot jsonb, change_summary text, actor text,',
    '  created_at timestamptz, correlation_id uuid',
    ')',
  ].join('\n'), data.revisions.map((revision) => ({
    workspace_id: revision.workspaceId,
    version: revision.version,
    snapshot: revision.snapshot,
    change_summary: revision.changeSummary,
    actor: revision.actor,
    created_at: revision.createdAt,
    correlation_id: revision.correlationId,
  })));

  await insertBatches(client, [
    'INSERT INTO odf.workspace_members',
    '  (workspace_id, user_id, display_name, role, created_at)',
    'SELECT item.workspace_id, item.user_id, item.display_name, item.role, item.created_at',
    'FROM jsonb_to_recordset($1::jsonb) AS item(',
    '  workspace_id text, user_id text, display_name text, role text, created_at timestamptz',
    ')',
  ].join('\n'), data.members.map((member) => ({
    workspace_id: member.workspaceId,
    user_id: member.userId,
    display_name: member.displayName,
    role: member.role,
    created_at: member.createdAt,
  })));

  await insertBatches(client, [
    'INSERT INTO odf.audit_log',
    '  (id, occurred_at, actor, action, entity_type, entity_id, details, correlation_id)',
    'OVERRIDING SYSTEM VALUE',
    'SELECT item.id, item.occurred_at, item.actor, item.action, item.entity_type, item.entity_id, item.details, item.correlation_id',
    'FROM jsonb_to_recordset($1::jsonb) AS item(',
    '  id bigint, occurred_at timestamptz, actor text, action text, entity_type text, entity_id text,',
    '  details jsonb, correlation_id uuid',
    ')',
  ].join('\n'), data.auditEvents.map((event) => ({
    id: event.id,
    occurred_at: event.timestamp,
    actor: event.actor,
    action: event.action,
    entity_type: event.entityType,
    entity_id: event.entityId,
    details: event.details,
    correlation_id: event.correlationId,
  })));

}

async function advanceAuditSequence(client: RuntimeClient): Promise<void> {
  await client.query({
    text: [
      'SELECT setval(',
      "  pg_get_serial_sequence('odf.audit_log', 'id')::regclass,",
      '  (SELECT max(id) FROM odf.audit_log),',
      '  true',
      ')',
    ].join('\n'),
  });
}

async function verifyTargetIntegrity(client: RuntimeClient): Promise<void> {
  const result = await client.query({
    text: [
      'SELECT',
      '  EXISTS (',
      '    SELECT 1',
      '    FROM odf.workspaces AS workspace',
      '    LEFT JOIN odf.workspace_revisions AS revision',
      '      ON revision.workspace_id = workspace.id AND revision.version = workspace.version',
      '    WHERE revision.workspace_id IS NULL OR revision.snapshot IS DISTINCT FROM workspace.snapshot',
      '  ) AS invalid_current_revision,',
      '  EXISTS (',
      '    SELECT 1',
      '    FROM odf.workspace_revisions',
      '    GROUP BY workspace_id',
      '    HAVING min(version) <> 1 OR max(version) <> count(*)',
      '  ) AS invalid_revision_history,',
      '  EXISTS (',
      '    SELECT 1',
      '    FROM odf.workspaces AS workspace',
      '    WHERE NOT EXISTS (',
      "      SELECT 1 FROM odf.workspace_members AS member WHERE member.workspace_id = workspace.id AND member.role = 'owner'",
      '    )',
      '  ) AS missing_owner',
    ].join('\n'),
  });
  const row = result.rows[0];
  if (!row) throw new Error('PostgreSQL did not return cutover integrity results');
  if (row.invalid_current_revision === true) throw new Error('PostgreSQL cutover target has an invalid current revision');
  if (row.invalid_revision_history === true) throw new Error('PostgreSQL cutover target has non-contiguous revision history');
  if (row.missing_owner === true) throw new Error('PostgreSQL cutover target has a workspace without an owner');
}

async function readTargetData(client: RuntimeClient): Promise<TargetData> {
  const workspaces = await client.query({
    text: [
      'SELECT id, name, snapshot, version, created_by, created_at, updated_by, updated_at',
      'FROM odf.workspaces ORDER BY id',
    ].join('\n'),
  });
  const revisions = await client.query({
    text: [
      'SELECT workspace_id, version, snapshot, change_summary, actor, created_at, correlation_id',
      'FROM odf.workspace_revisions ORDER BY workspace_id, version',
    ].join('\n'),
  });
  const members = await client.query({
    text: [
      'SELECT workspace_id, user_id, display_name, role, created_at',
      'FROM odf.workspace_members ORDER BY workspace_id, user_id',
    ].join('\n'),
  });
  const auditEvents = await client.query({
    text: [
      'SELECT id, occurred_at, actor, action, entity_type, entity_id, details, correlation_id',
      'FROM odf.audit_log ORDER BY id',
    ].join('\n'),
  });
  return mapTargetRows(workspaces.rows, revisions.rows, members.rows, auditEvents.rows);
}

function assertChecksums(actual: CutoverChecksums, expected: CutoverChecksums): void {
  for (const key of Object.keys(expected) as Array<keyof CutoverChecksums>) {
    if (actual[key] !== expected[key]) {
      throw new Error(`PostgreSQL cutover target checksum '${key}' does not match the imported bundle`);
    }
  }
}

async function verifyCutoverPrincipal(client: RuntimeClient): Promise<void> {
  const result = await client.query({
    text: [
      'SELECT',
      '  current_user AS role_name,',
      '  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,',
      '  (SELECT rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls',
      '   FROM pg_roles WHERE rolname = current_user) AS has_elevated_role_attributes,',
      "  pg_has_role(current_user, 'odf_cutover', 'USAGE') AS has_cutover_role,",
      "  has_schema_privilege(current_user, 'odf', 'CREATE') AS can_create_in_schema,",
      "  has_table_privilege(current_user, 'odf.workspaces', 'SELECT')",
      "    AND has_table_privilege(current_user, 'odf.workspaces', 'INSERT') AS can_import_workspaces,",
      "  has_table_privilege(current_user, 'odf.workspace_revisions', 'SELECT')",
      "    AND has_table_privilege(current_user, 'odf.workspace_revisions', 'INSERT') AS can_import_revisions,",
      "  has_table_privilege(current_user, 'odf.workspace_members', 'SELECT')",
      "    AND has_table_privilege(current_user, 'odf.workspace_members', 'INSERT') AS can_import_members,",
      "  has_table_privilege(current_user, 'odf.audit_log', 'SELECT')",
      "    AND has_table_privilege(current_user, 'odf.audit_log', 'INSERT') AS can_import_audit,",
      "  has_sequence_privilege(current_user, 'odf.audit_log_id_seq', 'UPDATE') AS can_advance_audit_sequence,",
      '  (',
      "    has_table_privilege(current_user, 'odf.workspaces', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') OR",
      "    has_table_privilege(current_user, 'odf.workspace_revisions', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') OR",
      "    has_table_privilege(current_user, 'odf.workspace_members', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') OR",
      "    has_table_privilege(current_user, 'odf.audit_log', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') OR",
      "    has_table_privilege(current_user, 'odf.schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')",
      '  ) AS has_forbidden_history_privileges,',
      '  EXISTS (',
      '    SELECT 1',
      '    FROM information_schema.tables AS candidate',
      "    WHERE candidate.table_schema = 'odf'",
      "      AND candidate.table_name NOT IN ('schema_migrations', 'workspaces', 'workspace_revisions', 'workspace_members', 'audit_log')",
      '      AND (',
      "        has_table_privilege(current_user, format('%I.%I', candidate.table_schema, candidate.table_name), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')",
      '      )',
      '  ) AS has_other_odf_table_privileges',
    ].join('\n'),
  });
  const row = result.rows[0];
  if (!row) throw new Error('PostgreSQL did not return cutover principal privileges');
  const roleName = typeof row.role_name === 'string' ? row.role_name : 'unknown';
  if (row.is_superuser === true) {
    throw new Error(`PostgreSQL cutover principal '${roleName}' must not be a superuser`);
  }
  if (row.has_cutover_role !== true) {
    throw new Error(`PostgreSQL cutover principal '${roleName}' must inherit the odf_cutover role`);
  }
  if (
    row.has_elevated_role_attributes === true
    || row.can_create_in_schema === true
    || row.has_forbidden_history_privileges === true
    || row.has_other_odf_table_privileges === true
  ) {
    throw new Error(`PostgreSQL cutover principal '${roleName}' has privileges outside odf_cutover`);
  }
  const requiredPrivileges = [
    ['workspace import', row.can_import_workspaces],
    ['revision import', row.can_import_revisions],
    ['membership import', row.can_import_members],
    ['audit import', row.can_import_audit],
    ['audit sequence advance', row.can_advance_audit_sequence],
  ] as const;
  const missing = requiredPrivileges.filter(([, granted]) => granted !== true).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `PostgreSQL cutover principal '${roleName}' is missing privileges: ${missing.join(', ')}`,
    );
  }
}

async function verifyRequiredMigrations(client: RuntimeClient): Promise<void> {
  const result = await client.query<{ version: unknown }>({
    text: 'SELECT version FROM odf.schema_migrations WHERE version = ANY($1::text[]) ORDER BY version',
    values: [[...REQUIRED_CUTOVER_MIGRATIONS]],
  });
  const applied = new Set(result.rows.map((row) => String(row.version)));
  const missing = REQUIRED_CUTOVER_MIGRATIONS.filter((version) => !applied.has(version));
  if (missing.length > 0) {
    throw new Error(`PostgreSQL cutover target is missing migrations: ${missing.join(', ')}`);
  }
}

/**
 * Rehearses or applies a one-way SQLite workspace-history import.
 *
 * Dry-run is the default: all inserts and verification execute inside the real
 * PostgreSQL transaction and are then rolled back. Applying requires an
 * explicit option and still refuses any non-empty target table.
 */
export async function importSqliteCutoverBundle(
  pool: RuntimePool,
  bundle: unknown,
  options: SqliteCutoverImportOptions = {},
): Promise<SqliteCutoverImportReport> {
  const report = parseSqliteCutoverPreflightReport(bundle);
  if (options.apply === true && options.currentSource === undefined) {
    throw new SqliteCutoverPreflightError(
      'Applying a cutover requires a fresh report from the frozen SQLite source',
    );
  }
  if (options.currentSource !== undefined) {
    assertCurrentSourceMatchesBundle(report, options.currentSource);
  }
  const correlationIds = createCorrelationIdMapping(report);
  const expectedTarget = createExpectedTargetData(report, correlationIds);
  const expectedTargetChecksums = checksums(expectedTarget);
  const client = await pool.connect();
  let began = false;
  let transactionClosed = false;
  let discardClient = false;

  try {
    await client.query({ text: 'BEGIN ISOLATION LEVEL SERIALIZABLE' });
    began = true;
    await client.query({ text: "SELECT set_config('lock_timeout', $1, true)", values: ['10s'] });
    await client.query({ text: "SELECT set_config('statement_timeout', $1, true)", values: ['120s'] });
    await client.query({ text: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)", values: ['180s'] });
    await client.query({
      text: "SELECT pg_advisory_xact_lock(hashtextextended('odf:sqlite-cutover-import', 0))",
    });

    await verifyRequiredMigrations(client);
    await verifyCutoverPrincipal(client);
    const initialCounts = await readTargetCounts(client);
    if (!emptyCounts(initialCounts)) {
      throw new Error(
        `PostgreSQL cutover target must be empty (found ${JSON.stringify(initialCounts)})`,
      );
    }

    await insertTargetData(client, expectedTarget);
    const importedCounts = await readTargetCounts(client);
    if (!countsAreEqual(importedCounts, report.counts)) {
      throw new Error(
        `PostgreSQL cutover target counts ${JSON.stringify(importedCounts)} do not match source ${JSON.stringify(report.counts)}`,
      );
    }
    await verifyTargetIntegrity(client);
    const actualTargetChecksums = checksums(await readTargetData(client));
    assertChecksums(actualTargetChecksums, expectedTargetChecksums);

    if (options.apply === true) {
      if (report.counts.auditEvents > 0) await advanceAuditSequence(client);
      await client.query({ text: 'COMMIT' });
    } else {
      await client.query({ text: 'ROLLBACK' });
    }
    transactionClosed = true;

    return {
      mode: options.apply === true ? 'applied' : 'dry-run',
      source: report.source,
      counts: report.counts,
      sourceChecksums: report.checksums,
      targetChecksums: expectedTargetChecksums,
      correlationIds: {
        algorithm: CORRELATION_ID_MAPPING_ALGORITHM,
        uniqueSourceValues: correlationIds.values.size,
        remappedValues: correlationIds.remappedValues,
        mappingChecksum: correlationIds.checksum,
      },
    };
  } catch (error) {
    if (began && !transactionClosed) {
      try {
        await client.query({ text: 'ROLLBACK' });
      } catch {
        discardClient = true;
      }
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}
