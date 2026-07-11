import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  RuntimeClient,
  RuntimePool,
  SqlQuery,
  SqlQueryResult,
} from '@open-data-fusion/postgres-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseCutoverImportArguments,
  runSqliteCutoverImportCli,
} from '../src/cutover-import-cli.js';
import {
  importSqliteCutoverBundle,
  REQUIRED_CUTOVER_MIGRATIONS,
} from '../src/cutover-import.js';
import {
  createCutoverChecksum,
  createSqliteCutoverPreflightReport,
  type SqliteCutoverPreflightReport,
} from '../src/cutover-preflight.js';
import { FusionDatabase } from '../src/database.js';

type Row = Record<string, unknown>;

interface StoredTarget {
  workspaces: Row[];
  workspaceScopes: Row[];
  revisions: Row[];
  members: Row[];
  auditEvents: Row[];
}

function emptyTarget(): StoredTarget {
  return { workspaces: [], workspaceScopes: [], revisions: [], members: [], auditEvents: [] };
}

function cloneTarget(target: StoredTarget): StoredTarget {
  return structuredClone(target);
}

function queryResult<T extends Row>(rows: T[], rowCount: number | null = rows.length): SqlQueryResult<T> {
  return { rows, rowCount };
}

class RecordingCutoverClient implements RuntimeClient {
  readonly commands: SqlQuery[] = [];
  releasedWith: boolean | undefined;
  target = emptyTarget();
  principal: Row = {
    role_name: 'odf_cutover_login',
    is_superuser: false,
    has_elevated_role_attributes: false,
    has_cutover_role: true,
    can_create_in_schema: false,
    has_forbidden_history_privileges: false,
    has_other_odf_table_privileges: false,
    can_import_workspaces: true,
    can_import_revisions: true,
    can_import_members: true,
    can_import_workspace_scopes: true,
    can_import_audit: true,
    can_advance_audit_sequence: true,
  };
  private transactionStart = emptyTarget();

  constructor(
    private readonly migrations: readonly string[] = REQUIRED_CUTOVER_MIGRATIONS,
    private readonly failInsert?: 'workspaces' | 'revisions' | 'members' | 'auditEvents',
  ) {}

  async query<T extends Row = Row>(query: SqlQuery): Promise<SqlQueryResult<T>> {
    this.commands.push(query);
    const sql = query.text;

    if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') {
      this.transactionStart = cloneTarget(this.target);
      return queryResult([]) as SqlQueryResult<T>;
    }
    if (sql === 'COMMIT') return queryResult([]) as SqlQueryResult<T>;
    if (sql === 'ROLLBACK') {
      this.target = cloneTarget(this.transactionStart);
      return queryResult([]) as SqlQueryResult<T>;
    }
    if (sql.includes("set_config('") || sql.includes('pg_advisory_xact_lock')) {
      return queryResult([{}]) as SqlQueryResult<T>;
    }
    if (sql.startsWith('SELECT version FROM odf.schema_migrations')) {
      return queryResult(this.migrations.map((version) => ({ version }))) as unknown as SqlQueryResult<T>;
    }
    if (sql.includes('AS can_import_workspaces')) {
      return queryResult([this.principal]) as SqlQueryResult<T>;
    }
    if (sql.includes('(SELECT count(*) FROM odf.workspaces) AS workspaces')) {
      return queryResult([{
        workspaces: String(this.target.workspaces.length),
        revisions: String(this.target.revisions.length),
        members: String(this.target.members.length),
        audit_events: String(this.target.auditEvents.length),
      }]) as unknown as SqlQueryResult<T>;
    }
    if (sql === 'SELECT count(*) AS workspace_scopes FROM odf.workspace_scopes') {
      return queryResult([{ workspace_scopes: String(this.target.workspaceScopes.length) }]) as unknown as SqlQueryResult<T>;
    }
    if (sql.startsWith('INSERT INTO odf.workspaces')) {
      this.insert('workspaces', query);
      return queryResult([], this.lastBatchLength(query)) as SqlQueryResult<T>;
    }
    if (sql.startsWith('INSERT INTO odf.workspace_revisions')) {
      this.insert('revisions', query);
      return queryResult([], this.lastBatchLength(query)) as SqlQueryResult<T>;
    }
    if (sql.startsWith('INSERT INTO odf.workspace_scopes')) {
      this.insert('workspaceScopes', query);
      return queryResult([], this.lastBatchLength(query)) as SqlQueryResult<T>;
    }
    if (sql.startsWith('INSERT INTO odf.workspace_members')) {
      this.insert('members', query);
      return queryResult([], this.lastBatchLength(query)) as SqlQueryResult<T>;
    }
    if (sql.startsWith('INSERT INTO odf.audit_log')) {
      this.insert('auditEvents', query);
      return queryResult([], this.lastBatchLength(query)) as SqlQueryResult<T>;
    }
    if (sql.startsWith('SELECT setval(')) return queryResult([{ setval: 1 }]) as unknown as SqlQueryResult<T>;
    if (sql.includes('AS invalid_current_revision')) {
      return queryResult([{
        invalid_current_revision: false,
        invalid_revision_history: false,
        missing_owner: false,
        invalid_workspace_scope: false,
      }]) as unknown as SqlQueryResult<T>;
    }
    if (sql.includes('FROM odf.workspaces ORDER BY id')) {
      return queryResult(this.target.workspaces) as SqlQueryResult<T>;
    }
    if (sql.includes('FROM odf.workspace_revisions ORDER BY workspace_id, version')) {
      return queryResult(this.target.revisions) as SqlQueryResult<T>;
    }
    if (sql.includes('FROM odf.workspace_members ORDER BY workspace_id, user_id')) {
      return queryResult(this.target.members) as SqlQueryResult<T>;
    }
    if (sql.includes('FROM odf.audit_log ORDER BY id')) {
      return queryResult(this.target.auditEvents) as SqlQueryResult<T>;
    }

    throw new Error(`Unexpected cutover SQL: ${sql}`);
  }

  release(error?: boolean): void {
    this.releasedWith = error;
  }

  private insert(table: keyof StoredTarget, query: SqlQuery): void {
    if (this.failInsert === table) throw new Error(`simulated ${table} insert failure`);
    this.target[table].push(...this.batch(query));
  }

  private batch(query: SqlQuery): Row[] {
    const serialized = query.values?.[0];
    if (typeof serialized !== 'string') throw new Error('Cutover insert batch must be serialized JSON');
    return JSON.parse(serialized) as Row[];
  }

  private lastBatchLength(query: SqlQuery): number {
    return this.batch(query).length;
  }
}

class RecordingCutoverPool implements RuntimePool {
  readonly client: RecordingCutoverClient;
  connectCount = 0;
  ended = false;

  constructor(
    migrations: readonly string[] = REQUIRED_CUTOVER_MIGRATIONS,
    failInsert?: 'workspaces' | 'revisions' | 'members' | 'auditEvents',
  ) {
    this.client = new RecordingCutoverClient(migrations, failInsert);
  }

  async connect(): Promise<RuntimeClient> {
    this.connectCount += 1;
    return this.client;
  }

  async query<T extends Row = Row>(_query: SqlQuery): Promise<SqlQueryResult<T>> {
    throw new Error('Cutover imports must use a dedicated transaction client');
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

const targetScope = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  projectId: '22222222-2222-2222-2222-222222222222',
  assignedBy: 'cutover.operator@example.test',
} as const;

function dryRunOptions() {
  return { targetScope } as const;
}

function applyOptions(report: SqliteCutoverPreflightReport) {
  return { apply: true, currentSource: structuredClone(report), targetScope } as const;
}

function refreshChecksums(report: SqliteCutoverPreflightReport): void {
  report.checksums = {
    workspaces: createCutoverChecksum(report.workspaces),
    revisions: createCutoverChecksum(report.revisions),
    members: createCutoverChecksum(report.members),
    auditEvents: createCutoverChecksum(report.auditEvents),
  };
}

describe('SQLite to PostgreSQL cutover import', () => {
  let database: FusionDatabase;
  let report: SqliteCutoverPreflightReport;
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-cutover-import-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'source.db') });
    report = createSqliteCutoverPreflightReport(database.database, join(tempDirectory, 'source.db'));
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('runs the complete import and verification transaction before rolling back by default', async () => {
    const pool = new RecordingCutoverPool();

    const result = await importSqliteCutoverBundle(pool, report, dryRunOptions());

    expect(result).toMatchObject({
      mode: 'dry-run',
      counts: report.counts,
      correlationIds: {
        algorithm: 'open-data-fusion.uuidv8.sha256.v1',
        uniqueSourceValues: 2,
        remappedValues: 2,
      },
    });
    expect(result.correlationIds.mappingChecksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(pool.client.commands.map((query) => query.text)).toContain('ROLLBACK');
    expect(pool.client.commands.map((query) => query.text)).not.toContain('COMMIT');
    expect(pool.client.commands.some((query) => query.text.startsWith('SELECT setval('))).toBe(false);
    expect(pool.client.target).toEqual(emptyTarget());
    expect(pool.client.releasedWith).toBe(false);
  });

  it('commits only when apply is explicitly enabled', async () => {
    const pool = new RecordingCutoverPool();

    const result = await importSqliteCutoverBundle(pool, report, applyOptions(report));

    expect(result.mode).toBe('applied');
    expect(pool.client.commands.map((query) => query.text)).toContain('COMMIT');
    expect(pool.client.commands.map((query) => query.text)).not.toContain('ROLLBACK');
    expect(pool.client.commands.some((query) => query.text.startsWith('SELECT setval('))).toBe(true);
    expect(pool.client.target.workspaces).toHaveLength(report.counts.workspaces);
    expect(pool.client.target.workspaceScopes).toHaveLength(report.counts.workspaces);
    expect(pool.client.target.revisions).toHaveLength(report.counts.revisions);
    expect(pool.client.target.members).toHaveLength(report.counts.members);
    expect(pool.client.target.auditEvents).toHaveLength(report.counts.auditEvents);
  });

  it('preserves PostgreSQL-compatible correlation UUIDs without remapping', async () => {
    const correlationId = 'f7ca67c2-36db-4d79-92ea-eccdf507f2fc';
    for (const revision of report.revisions) revision.correlationId = correlationId;
    for (const auditEvent of report.auditEvents) auditEvent.correlationId = correlationId;
    refreshChecksums(report);

    const result = await importSqliteCutoverBundle(new RecordingCutoverPool(), report, dryRunOptions());

    expect(result.correlationIds).toMatchObject({ uniqueSourceValues: 1, remappedValues: 0 });
  });

  it('refuses a target containing existing cutover data', async () => {
    const pool = new RecordingCutoverPool();
    pool.client.target.workspaces.push({ id: 'existing' });

    await expect(importSqliteCutoverBundle(pool, report, applyOptions(report))).rejects.toThrow(
      'PostgreSQL cutover target must be empty',
    );

    expect(pool.client.commands.map((query) => query.text)).toContain('ROLLBACK');
    expect(pool.client.commands.some((query) => query.text.startsWith('INSERT INTO'))).toBe(false);
  });

  it('requires every migration including the least-privilege cutover role', async () => {
    const pool = new RecordingCutoverPool(REQUIRED_CUTOVER_MIGRATIONS.slice(0, -1));

    await expect(importSqliteCutoverBundle(pool, report, dryRunOptions())).rejects.toThrow(
      'PostgreSQL cutover target is missing migrations: 005_tenant_membership_and_workspace_scope',
    );
    expect(pool.client.commands.map((query) => query.text)).toContain('ROLLBACK');
  });

  it('rejects a superuser instead of accepting an over-privileged migration URL', async () => {
    const pool = new RecordingCutoverPool();
    pool.client.principal.is_superuser = true;
    pool.client.principal.role_name = 'postgres';

    await expect(importSqliteCutoverBundle(pool, report, dryRunOptions())).rejects.toThrow(
      "PostgreSQL cutover principal 'postgres' must not be a superuser",
    );
    expect(pool.client.commands.map((query) => query.text)).toContain('ROLLBACK');
  });

  it('requires the principal to inherit only the narrow cutover role', async () => {
    const missingRole = new RecordingCutoverPool();
    missingRole.client.principal.has_cutover_role = false;
    await expect(importSqliteCutoverBundle(missingRole, report, dryRunOptions())).rejects.toThrow(
      "PostgreSQL cutover principal 'odf_cutover_login' must inherit the odf_cutover role",
    );

    const overprivileged = new RecordingCutoverPool();
    overprivileged.client.principal.has_other_odf_table_privileges = true;
    await expect(importSqliteCutoverBundle(overprivileged, report, dryRunOptions())).rejects.toThrow(
      "PostgreSQL cutover principal 'odf_cutover_login' has privileges outside odf_cutover",
    );
  });

  it('verifies apply-only sequence privileges during a non-mutating dry-run', async () => {
    const pool = new RecordingCutoverPool();
    pool.client.principal.can_advance_audit_sequence = false;

    await expect(importSqliteCutoverBundle(pool, report, dryRunOptions())).rejects.toThrow(
      "PostgreSQL cutover principal 'odf_cutover_login' is missing privileges: audit sequence advance",
    );
    expect(pool.client.commands.some((query) => query.text.startsWith('INSERT INTO'))).toBe(false);
  });

  it('rolls back a partially inserted target when PostgreSQL rejects a batch', async () => {
    const pool = new RecordingCutoverPool(REQUIRED_CUTOVER_MIGRATIONS, 'revisions');

    await expect(importSqliteCutoverBundle(pool, report, applyOptions(report))).rejects.toThrow(
      'simulated revisions insert failure',
    );

    expect(pool.client.target).toEqual(emptyTarget());
    expect(pool.client.commands.map((query) => query.text).at(-1)).toBe('ROLLBACK');
  });

  it('requires a fresh frozen-source report before apply and rejects a stale bundle', async () => {
    const missingSourcePool = new RecordingCutoverPool();
    await expect(importSqliteCutoverBundle(missingSourcePool, report, { apply: true, targetScope })).rejects.toThrow(
      'Applying a cutover requires a fresh report from the frozen SQLite source',
    );
    expect(missingSourcePool.connectCount).toBe(0);

    const staleSource = structuredClone(report);
    staleSource.workspaces[0]!.name = 'Changed after rehearsal';
    refreshChecksums(staleSource);
    const staleSourcePool = new RecordingCutoverPool();
    await expect(importSqliteCutoverBundle(staleSourcePool, report, {
      apply: true,
      currentSource: staleSource,
      targetScope,
    })).rejects.toThrow(
      "Frozen SQLite checksum 'workspaces' no longer matches the rehearsed bundle",
    );
    expect(staleSourcePool.connectCount).toBe(0);
  });

  it('rejects a modified bundle before acquiring a PostgreSQL connection', async () => {
    const pool = new RecordingCutoverPool();
    report.workspaces[0]!.name = 'Tampered workspace';

    await expect(importSqliteCutoverBundle(pool, report, dryRunOptions())).rejects.toThrow(
      "SQLite cutover bundle checksum 'workspaces' does not match its records",
    );
    expect(pool.connectCount).toBe(0);
  });

  it('requires a UUID tenant/project scope before acquiring a PostgreSQL connection', async () => {
    const pool = new RecordingCutoverPool();

    await expect(importSqliteCutoverBundle(pool, report)).rejects.toThrow(
      'SQLite cutover requires an explicit tenant, project, and assigning actor for workspace scope',
    );
    await expect(importSqliteCutoverBundle(pool, report, {
      targetScope: { ...targetScope, tenantId: 'not-a-uuid' },
    })).rejects.toThrow('SQLite cutover target tenantId must be a UUID');
    expect(pool.connectCount).toBe(0);
  });

  it('parses an explicit bundle and apply flag while defaulting to dry-run', () => {
    expect(parseCutoverImportArguments([
      '--bundle', 'bundle.json',
      '--tenant-id', targetScope.tenantId,
      '--project-id', targetScope.projectId,
      '--assigned-by', targetScope.assignedBy,
    ])).toEqual({
      bundlePath: 'bundle.json',
      tenantId: targetScope.tenantId,
      projectId: targetScope.projectId,
      assignedBy: targetScope.assignedBy,
      apply: false,
    });
    expect(parseCutoverImportArguments([
      '--apply',
      '--bundle', 'bundle.json',
      '--database', 'source.db',
      '--tenant-id', targetScope.tenantId,
      '--project-id', targetScope.projectId,
      '--assigned-by', targetScope.assignedBy,
    ])).toEqual({
      bundlePath: 'bundle.json',
      databasePath: 'source.db',
      tenantId: targetScope.tenantId,
      projectId: targetScope.projectId,
      assignedBy: targetScope.assignedBy,
      apply: true,
    });
    expect(() => parseCutoverImportArguments(['--apply', '--bundle', 'bundle.json'])).toThrow(
      'Usage: cutover-import --bundle <preflight.json> --tenant-id <uuid> --project-id <uuid> --assigned-by <user> [--database <sqlite-path>] [--apply]',
    );
    expect(() => parseCutoverImportArguments(['--bundle', 'bundle.json', '--unknown'])).toThrow(
      'Usage: cutover-import --bundle <preflight.json> --tenant-id <uuid> --project-id <uuid> --assigned-by <user> [--database <sqlite-path>] [--apply]',
    );
  });

  it('runs the CLI with an environment-only PostgreSQL URL and closes its pool', async () => {
    const bundlePath = join(tempDirectory, 'bundle.json');
    writeFileSync(bundlePath, JSON.stringify(report), 'utf8');
    const pool = new RecordingCutoverPool();
    let suppliedConnectionString: string | undefined;

    const result = await runSqliteCutoverImportCli(
      [
        '--bundle', bundlePath,
        '--tenant-id', targetScope.tenantId,
        '--project-id', targetScope.projectId,
        '--assigned-by', targetScope.assignedBy,
      ],
      { ODF_POSTGRES_URL: 'postgresql://cutover.example.test/odf' },
      (connectionString) => {
        suppliedConnectionString = connectionString;
        return pool;
      },
    );

    expect(result.mode).toBe('dry-run');
    expect(suppliedConnectionString).toBe('postgresql://cutover.example.test/odf');
    expect(pool.ended).toBe(true);
  });

  it('fails closed when the PostgreSQL URL is absent', async () => {
    await expect(runSqliteCutoverImportCli([
      '--bundle', 'bundle.json',
      '--tenant-id', targetScope.tenantId,
      '--project-id', targetScope.projectId,
      '--assigned-by', targetScope.assignedBy,
    ], {})).rejects.toThrow(
      'ODF_POSTGRES_URL is required for a PostgreSQL cutover rehearsal',
    );
  });
});
