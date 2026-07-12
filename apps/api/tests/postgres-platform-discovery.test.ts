import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ForbiddenError as RuntimeForbiddenError,
  PostgresRuntime,
  type RuntimeClient,
  type RuntimePool,
  type SqlQuery,
  type SqlQueryResult,
} from '@open-data-fusion/postgres-runtime';
import type { Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  DATA_PLANE_PERMISSIONS,
  type AuthenticatedIdentity,
  type IdentityProvider,
} from '../src/auth.js';
import { FusionDatabase } from '../src/database.js';
import type { IndustrialPersistence } from '../src/industrial-persistence.js';
import {
  PostgresPlatformDiscoveryPersistence,
  type PlatformDiscoveryPersistence,
} from '../src/platform-discovery.js';

type Row = Record<string, unknown>;
type QueryHandler = (query: SqlQuery) => SqlQueryResult<Row>;

class RecordingClient implements RuntimeClient {
  readonly queries: SqlQuery[] = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<TRow extends Row = Row>(query: SqlQuery): Promise<SqlQueryResult<TRow>> {
    const recorded = { text: query.text, ...(query.values ? { values: [...query.values] } : {}) };
    this.queries.push(recorded);
    return this.handler(recorded) as SqlQueryResult<TRow>;
  }

  release(): void {}
}

class RecordingPool implements RuntimePool {
  constructor(readonly client: RecordingClient) {}

  async connect(): Promise<RuntimeClient> {
    return this.client;
  }

  async query<TRow extends Row = Row>(_query: SqlQuery): Promise<SqlQueryResult<TRow>> {
    return { rows: [], rowCount: 0 };
  }

  async end(): Promise<void> {}
}

function result(rows: Row[] = []): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

function discovery(handler: QueryHandler) {
  const client = new RecordingClient(handler);
  const runtime = PostgresRuntime.fromPool(new RecordingPool(client));
  return { store: new PostgresPlatformDiscoveryPersistence(runtime), client };
}

const tenantOne = '11111111-1111-1111-1111-111111111111';
const tenantTwo = '22222222-2222-2222-2222-222222222222';
const tenantThree = '33333333-3333-3333-3333-333333333333';
const projectOne = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('PostgresPlatformDiscoveryPersistence', () => {
  it('discovers only through the transaction identity and keeps the current cursor contract', async () => {
    const rows = [tenantOne, tenantTwo, tenantThree].map((id, index) => ({
      id,
      name: `Tenant ${index + 1}`,
      created_by: 'provisioning-service',
      created_at: new Date(`2026-07-0${index + 1}T00:00:00.000Z`),
    }));
    const { store, client } = discovery((query) => (
      query.text.includes('discover_accessible_tenants') ? result(rows) : result()
    ));

    const page = await store.listTenants('real.user', true, { limit: 2 });

    expect(page.items).toEqual([
      { id: tenantOne, name: 'Tenant 1', createdBy: 'provisioning-service', createdAt: '2026-07-01T00:00:00.000Z' },
      { id: tenantTwo, name: 'Tenant 2', createdBy: 'provisioning-service', createdAt: '2026-07-02T00:00:00.000Z' },
    ]);
    expect(JSON.parse(Buffer.from(String(page.nextCursor), 'base64url').toString('utf8'))).toEqual({ id: tenantTwo });

    const identitySetting = client.queries.find((query) => query.text.includes("set_config('odf.user_id'"));
    expect(identitySetting?.values).toEqual(['real.user']);
    const adminSetting = client.queries.find((query) => query.text.includes("set_config('odf.platform_admin'"));
    expect(adminSetting?.values).toEqual(['false']);
    const discoveryQuery = client.queries.find((query) => query.text.includes('discover_accessible_tenants'));
    expect(discoveryQuery?.values).toEqual([null, 3]);
    expect(discoveryQuery?.values).not.toContain('real.user');
  });

  it('uses transaction-local tenant and user settings for project discovery', async () => {
    const { store, client } = discovery((query) => (
      query.text.includes('discover_accessible_projects')
        ? result([{
            tenant_id: tenantOne,
            id: projectOne,
            name: 'Production Plant',
            description: 'Live process data',
            created_by: 'provisioning-service',
            created_at: '2026-07-01T00:00:00.000Z',
          }])
        : result()
    ));

    await expect(store.listProjects(tenantOne, 'real.user', true, { limit: 1 })).resolves.toEqual({
      items: [{
        tenantId: tenantOne,
        id: projectOne,
        name: 'Production Plant',
        description: 'Live process data',
        createdBy: 'provisioning-service',
        createdAt: '2026-07-01T00:00:00.000Z',
      }],
      nextCursor: null,
    });

    expect(client.queries.find((query) => query.text.includes("set_config('odf.tenant_id'"))?.values).toEqual([tenantOne]);
    expect(client.queries.find((query) => query.text.includes("set_config('odf.user_id'"))?.values).toEqual(['real.user']);
    const discoveryQuery = client.queries.find((query) => query.text.includes('discover_accessible_projects'));
    expect(discoveryQuery?.values).toEqual([null, 2]);
    expect(discoveryQuery?.values).not.toEqual(expect.arrayContaining([tenantOne, 'real.user']));
  });

  it('rejects non-UUID PostgreSQL tenant ids before opening a transaction', async () => {
    const { store, client } = discovery(() => result());

    await expect(store.listProjects('tenant-slug', 'real.user', false, { limit: 50 })).rejects.toThrow();
    expect(client.queries).toEqual([]);
  });

  it('attests both discovery functions and their application grants', async () => {
    const { store, client } = discovery((query) => (
      query.text.includes("to_regprocedure('odf.discover_accessible_tenants") ? result([{ ready: true }]) : result()
    ));

    await expect(store.assertReady()).resolves.toBeUndefined();
    const readiness = client.queries.find((query) => query.text.includes("to_regprocedure('odf.discover_accessible_tenants"));
    expect(readiness?.text).toContain('has_function_privilege');
  });
});

class TestIdentityProvider implements IdentityProvider {
  readonly mode = 'oidc' as const;

  async authenticate(incoming: Request): Promise<AuthenticatedIdentity> {
    const userId = incoming.header('x-test-user') ?? 'real.user';
    return {
      userId,
      displayName: userId,
      permissions: new Set(DATA_PLANE_PERMISSIONS),
    };
  }
}

describe('PostgreSQL platform discovery routes', () => {
  const tempDirectories: string[] = [];

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('routes GET discovery to PostgreSQL and blocks shadow SQLite tenant/project writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-data-fusion-pg-discovery-'));
    tempDirectories.push(directory);
    const database = new FusionDatabase({ path: join(directory, 'test.db'), seed: false });
    const pgDiscovery: PlatformDiscoveryPersistence = {
      mode: 'postgres',
      listTenants: async () => ({
        items: [{ id: tenantOne, name: 'Tenant 1', createdBy: 'provisioner', createdAt: '2026-07-01T00:00:00.000Z' }],
        nextCursor: null,
      }),
      listProjects: async () => ({
        items: [{ tenantId: tenantOne, id: projectOne, name: 'Plant', description: null, createdBy: 'provisioner', createdAt: '2026-07-01T00:00:00.000Z' }],
        nextCursor: null,
      }),
    };
    const app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      platformDiscovery: pgDiscovery,
    });

    const tenants = await request(app).get('/api/v1/platform/tenants').set('x-test-user', 'real.user');
    expect(tenants.status).toBe(200);
    expect(tenants.body.items[0].id).toBe(tenantOne);

    const projects = await request(app).get(`/api/v1/platform/tenants/${tenantOne}/projects`).set('x-test-user', 'real.user');
    expect(projects.status).toBe(200);
    expect(projects.body.items[0].id).toBe(projectOne);

    const tenantWrite = await request(app)
      .post('/api/v1/platform/tenants')
      .set('x-test-user', 'real.user')
      .send({ id: 'shadow-tenant', name: 'Shadow Tenant' });
    expect(tenantWrite.status).toBe(403);

    const projectWrite = await request(app)
      .post(`/api/v1/platform/tenants/${tenantOne}/projects`)
      .set('x-test-user', 'real.user')
      .send({ id: 'shadow-project', name: 'Shadow Project' });
    expect(projectWrite.status).toBe(403);

    database.close();
  });

  it('maps PostgreSQL industrial authorization failures to a stable HTTP 403', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-data-fusion-pg-http-errors-'));
    tempDirectories.push(directory);
    const database = new FusionDatabase({ path: join(directory, 'test.db'), seed: false });
    const deniedPersistence = {
      mode: 'postgres',
      health: async () => ({ status: 'ok', mode: 'postgres', database: 'odf', timestamp: new Date().toISOString() }),
      authorize: async () => { throw new RuntimeForbiddenError('Project policy cannot be resolved'); },
    } as unknown as IndustrialPersistence;
    const app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      industrialPersistence: deniedPersistence,
    });

    const response = await request(app)
      .get('/api/v1/assets')
      .set('x-test-user', 'real.user')
      .set('x-odf-tenant-id', tenantOne)
      .set('x-odf-project-id', projectOne);
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'forbidden', message: 'Project policy cannot be resolved' });
    database.close();
  });
});
