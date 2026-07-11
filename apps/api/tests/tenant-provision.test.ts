import type {
  RuntimeClient,
  RuntimePool,
  SqlQuery,
  SqlQueryResult,
} from '@open-data-fusion/postgres-runtime';
import { describe, expect, it } from 'vitest';

import {
  parseTenantProvisionArguments,
  runTenantProvisionCli,
} from '../src/tenant-provision-cli.js';
import {
  provisionTenantProject,
  REQUIRED_TENANT_PROVISION_MIGRATIONS,
  type TenantProjectProvisionInput,
} from '../src/tenant-provision.js';

type Row = Record<string, unknown>;

interface ProvisionFunctionResponse extends Row {
  tenant_created: boolean;
  project_created: boolean;
  tenant_owner_created: boolean;
  project_owner_created: boolean;
  model_space_created: boolean;
  audit_recorded: boolean;
}

function result<T extends Row>(rows: T[], rowCount: number | null = rows.length): SqlQueryResult<T> {
  return { rows, rowCount };
}

function stringValue(values: readonly unknown[] | undefined, index: number): string {
  const value = values?.[index];
  if (typeof value !== 'string') throw new Error(`Expected a string SQL value at index ${String(index)}`);
  return value;
}

function createdResponse(): ProvisionFunctionResponse {
  return {
    tenant_created: true,
    project_created: true,
    tenant_owner_created: true,
    project_owner_created: true,
    model_space_created: true,
    audit_recorded: true,
  };
}

function unchangedResponse(): ProvisionFunctionResponse {
  return {
    tenant_created: false,
    project_created: false,
    tenant_owner_created: false,
    project_owner_created: false,
    model_space_created: false,
    audit_recorded: false,
  };
}

class RecordingTenantProvisionClient implements RuntimeClient {
  readonly commands: SqlQuery[] = [];
  releasedWith: boolean | undefined;
  migrations: readonly string[] = REQUIRED_TENANT_PROVISION_MIGRATIONS;
  principal: Row = {
    role_name: 'odf_tenant_provision_login',
    is_superuser: false,
    has_elevated_role_attributes: false,
    has_tenant_provisioner_role: true,
    can_use_odf_schema: true,
    can_create_in_odf_schema: false,
    can_read_schema_migrations: true,
    can_execute_bootstrap_function: true,
    has_forbidden_odf_relation_privileges: false,
    has_forbidden_odf_sequence_privileges: false,
    has_other_odf_function_privileges: false,
  };
  target: 'empty' | 'complete' = 'empty';
  targetOwnerUserId: string | undefined;
  auditEvents = 0;
  functionResponseOverride: ProvisionFunctionResponse | undefined;
  private transactionStart: {
    target: 'empty' | 'complete';
    targetOwnerUserId: string | undefined;
    auditEvents: number;
  } = { target: 'empty', targetOwnerUserId: undefined, auditEvents: 0 };

  async query<T extends Row = Row>(query: SqlQuery): Promise<SqlQueryResult<T>> {
    this.commands.push(query);
    const sql = query.text;

    if (sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE') {
      this.transactionStart = {
        target: this.target,
        targetOwnerUserId: this.targetOwnerUserId,
        auditEvents: this.auditEvents,
      };
      return result([]) as SqlQueryResult<T>;
    }
    if (sql === 'COMMIT') return result([]) as SqlQueryResult<T>;
    if (sql === 'ROLLBACK') {
      this.target = this.transactionStart.target;
      this.targetOwnerUserId = this.transactionStart.targetOwnerUserId;
      this.auditEvents = this.transactionStart.auditEvents;
      return result([]) as SqlQueryResult<T>;
    }
    if (sql.includes("set_config('")) return result([{}]) as SqlQueryResult<T>;
    if (sql.includes('AS can_execute_bootstrap_function')) {
      return result([this.principal]) as SqlQueryResult<T>;
    }
    if (sql.startsWith('SELECT version FROM odf.schema_migrations')) {
      return result(this.migrations.map((version) => ({ version }))) as unknown as SqlQueryResult<T>;
    }
    if (sql.includes('FROM odf.provision_tenant_project(')) {
      if (this.functionResponseOverride) {
        return result([this.functionResponseOverride]) as unknown as SqlQueryResult<T>;
      }

      const ownerUserId = stringValue(query.values, 6);
      if (this.target === 'empty') {
        this.target = 'complete';
        this.targetOwnerUserId = ownerUserId;
        this.auditEvents += 1;
        return result([createdResponse()]) as unknown as SqlQueryResult<T>;
      }
      if (ownerUserId !== this.targetOwnerUserId) {
        throw new Error('tenant/project bootstrap target already exists but is not an exact completed bootstrap');
      }
      return result([unchangedResponse()]) as unknown as SqlQueryResult<T>;
    }

    throw new Error(`Unexpected tenant provisioning SQL: ${sql}`);
  }

  release(error?: boolean): void {
    this.releasedWith = error;
  }
}

class RecordingTenantProvisionPool implements RuntimePool {
  readonly client = new RecordingTenantProvisionClient();
  connectCount = 0;
  ended = false;

  async connect(): Promise<RuntimeClient> {
    this.connectCount += 1;
    return this.client;
  }

  async query<T extends Row = Row>(_query: SqlQuery): Promise<SqlQueryResult<T>> {
    throw new Error('Tenant provisioning must use a dedicated transaction client');
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

const input: TenantProjectProvisionInput = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  tenantSlug: 'north-energy',
  tenantName: 'North Energy',
  projectId: '22222222-2222-2222-2222-222222222222',
  projectSlug: 'north-plant',
  projectName: 'North Plant',
  ownerUserId: 'owner@example.test',
  modelSpaceId: '33333333-3333-3333-3333-333333333333',
  modelSpaceSlug: 'default',
  modelSpaceName: 'Default model space',
  provisionedBy: 'bootstrap.operator@example.test',
};

function cliArgs(): string[] {
  return [
    '--tenant-id', input.tenantId,
    '--tenant-slug', input.tenantSlug,
    '--tenant-name', input.tenantName,
    '--project-id', input.projectId,
    '--project-slug', input.projectSlug,
    '--project-name', input.projectName,
    '--owner-user-id', input.ownerUserId,
    '--model-space-id', input.modelSpaceId,
    '--model-space-slug', input.modelSpaceSlug,
    '--model-space-name', input.modelSpaceName,
    '--provisioned-by', input.provisionedBy,
  ];
}

describe('tenant/project provisioning', () => {
  it('parses every identity explicitly and defaults to a rollback-only rehearsal', () => {
    expect(parseTenantProvisionArguments(cliArgs())).toEqual({ input, apply: false });
    expect(parseTenantProvisionArguments([...cliArgs(), '--apply'])).toEqual({ input, apply: true });
    expect(() => parseTenantProvisionArguments([...cliArgs(), '--postgres-url', 'postgresql://secret.example.test/odf'])).toThrow(
      'Usage: tenant-provision',
    );
    expect(() => parseTenantProvisionArguments([...cliArgs(), '--apply', '--apply'])).toThrow('Usage: tenant-provision');
    expect(() => parseTenantProvisionArguments(cliArgs().slice(0, -2))).toThrow('Usage: tenant-provision');
  });

  it('calls the database-owned bootstrap function in one rollback-only transaction by default', async () => {
    const pool = new RecordingTenantProvisionPool();

    const report = await provisionTenantProject(pool, input);

    expect(report).toEqual({
      mode: 'dry-run',
      tenant: { id: input.tenantId, slug: input.tenantSlug, created: true },
      project: { id: input.projectId, slug: input.projectSlug, created: true },
      memberships: {
        tenantOwnerCreated: true,
        projectOwnerCreated: true,
        ownerUserId: input.ownerUserId,
      },
      modelSpace: { id: input.modelSpaceId, slug: input.modelSpaceSlug, created: true },
      auditRecorded: false,
    });
    expect(pool.client.commands.map((query) => query.text)).toContain('ROLLBACK');
    expect(pool.client.commands.map((query) => query.text)).not.toContain('COMMIT');
    expect(pool.client.commands.some((query) => query.text.includes('FROM odf.provision_tenant_project('))).toBe(true);
    expect(pool.client.commands.some((query) => query.text.startsWith('INSERT INTO odf.'))).toBe(false);
    expect(pool.client.commands.some((query) => query.text.includes('FROM odf.tenants'))).toBe(false);
    expect(pool.client.target).toBe('empty');
    expect(pool.client.auditEvents).toBe(0);
    expect(pool.client.releasedWith).toBe(false);
  });

  it('commits one complete bootstrap and accepts only the exact completed identity as a no-op', async () => {
    const pool = new RecordingTenantProvisionPool();

    const first = await provisionTenantProject(pool, input, { apply: true });
    const second = await provisionTenantProject(pool, input, { apply: true });

    expect(first).toMatchObject({
      mode: 'applied',
      tenant: { created: true },
      project: { created: true },
      memberships: { tenantOwnerCreated: true, projectOwnerCreated: true },
      modelSpace: { created: true },
      auditRecorded: true,
    });
    expect(second).toMatchObject({
      mode: 'applied',
      tenant: { created: false },
      project: { created: false },
      memberships: { tenantOwnerCreated: false, projectOwnerCreated: false },
      modelSpace: { created: false },
      auditRecorded: false,
    });
    expect(pool.client.target).toBe('complete');
    expect(pool.client.auditEvents).toBe(1);
  });

  it('rejects an existing tenant plus a requested new owner without changing the completed target', async () => {
    const pool = new RecordingTenantProvisionPool();
    await provisionTenantProject(pool, input, { apply: true });

    await expect(provisionTenantProject(pool, {
      ...input,
      ownerUserId: 'new-owner@example.test',
    }, { apply: true })).rejects.toThrow(
      'tenant/project bootstrap target already exists but is not an exact completed bootstrap',
    );

    expect(pool.client.commands.map((query) => query.text)).toContain('ROLLBACK');
    expect(pool.client.target).toBe('complete');
    expect(pool.client.targetOwnerUserId).toBe(input.ownerUserId);
    expect(pool.client.auditEvents).toBe(1);
  });

  it('fails before a database connection for malformed or unbounded bootstrap input', async () => {
    const pool = new RecordingTenantProvisionPool();

    await expect(provisionTenantProject(pool, { ...input, tenantId: 'not-a-uuid' })).rejects.toThrow('tenantId must be a UUID');
    await expect(provisionTenantProject(pool, { ...input, tenantName: ' North Energy' })).rejects.toThrow('tenantName must be a non-empty');

    expect(pool.connectCount).toBe(0);
  });

  it('fails closed on a partial result from the security-definer function', async () => {
    const pool = new RecordingTenantProvisionPool();
    pool.client.functionResponseOverride = {
      ...createdResponse(),
      project_created: false,
    };

    await expect(provisionTenantProject(pool, input, { apply: true })).rejects.toThrow(
      'PostgreSQL tenant provisioning function returned a partial bootstrap result',
    );
    expect(pool.client.commands.map((query) => query.text)).toContain('ROLLBACK');
  });

  it('rejects a broad provisioning principal before executing the bootstrap function', async () => {
    const pool = new RecordingTenantProvisionPool();
    pool.client.principal = { ...pool.client.principal, has_forbidden_odf_relation_privileges: true };

    await expect(provisionTenantProject(pool, input, { apply: true })).rejects.toThrow(
      "PostgreSQL tenant provisioning principal 'odf_tenant_provision_login' has privileges outside odf_tenant_provisioner",
    );

    expect(pool.client.commands.some((query) => query.text.includes('FROM odf.provision_tenant_project('))).toBe(false);
  });

  it('requires every prerequisite migration before executing the bootstrap function', async () => {
    const pool = new RecordingTenantProvisionPool();
    pool.client.migrations = REQUIRED_TENANT_PROVISION_MIGRATIONS.slice(0, -1);

    await expect(provisionTenantProject(pool, input)).rejects.toThrow(
      'PostgreSQL tenant provisioning target is missing migrations: 007_tenant_project_provisioning_role',
    );
    expect(pool.client.commands.some((query) => query.text.includes('FROM odf.provision_tenant_project('))).toBe(false);
  });

  it('uses only ODF_TENANT_PROVISION_POSTGRES_URL and always closes the dedicated pool', async () => {
    const pool = new RecordingTenantProvisionPool();
    let suppliedConnectionString: string | undefined;

    const report = await runTenantProvisionCli(
      cliArgs(),
      {
        ODF_POSTGRES_URL: 'postgresql://wrong-purpose.example.test/odf',
        ODF_TENANT_PROVISION_POSTGRES_URL: 'postgresql://tenant-provision.example.test/odf',
      },
      (connectionString) => {
        suppliedConnectionString = connectionString;
        return pool;
      },
    );

    expect(report.mode).toBe('dry-run');
    expect(suppliedConnectionString).toBe('postgresql://tenant-provision.example.test/odf');
    expect(pool.ended).toBe(true);
    await expect(runTenantProvisionCli(cliArgs(), { ODF_POSTGRES_URL: 'postgresql://wrong-purpose.example.test/odf' })).rejects.toThrow(
      'ODF_TENANT_PROVISION_POSTGRES_URL is required for tenant/project provisioning',
    );
  });
});
