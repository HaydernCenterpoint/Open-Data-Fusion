import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Request } from 'express';
import request, { type Test } from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IndustrialWritebackExecution } from '../src/advanced-platform.js';
import { createApp } from '../src/app.js';
import { DATA_PLANE_PERMISSIONS, type AuthenticatedIdentity, type IdentityProvider } from '../src/auth.js';
import { FusionDatabase } from '../src/database.js';
import type { PostgresPlatformCompatibilityPersistence } from '../src/postgres-platform-compatibility.js';
import type { PlatformDiscoveryPersistence } from '../src/platform-discovery.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const projectId = '22222222-2222-2222-2222-222222222222';
const actor = 'platform.owner@example.test';

class TestIdentityProvider implements IdentityProvider {
  readonly mode = 'oidc' as const;

  async authenticate(incoming: Request): Promise<AuthenticatedIdentity> {
    const userId = incoming.header('x-test-user') ?? actor;
    return { userId, displayName: userId, permissions: new Set(DATA_PLANE_PERMISSIONS) };
  }
}

function execution(): IndustrialWritebackExecution {
  return {
    tenantId,
    projectId,
    requestId: 'writeback-1',
    sourceId: 'erp',
    targetExternalId: 'asset-1',
    operation: 'update-status',
    payload: { status: 'ready' },
    risk: 'low',
    requestedBy: 'requester@example.test',
    approvedBy: ['approver@example.test'],
    executedBy: actor,
    correlationId: '11111111-1111-1111-1111-111111111111',
  };
}

function compatibility() {
  const store: PostgresPlatformCompatibilityPersistence = {
    mode: 'postgres',
    assertReady: async () => undefined,
    listDataModels: vi.fn(async () => ({ items: [{ id: 'postgres-model', version: 1 }], nextCursor: null })),
    createDataModelVersion: vi.fn(async () => ({ id: 'postgres-model', version: 1 })),
    listPipelines: vi.fn(async () => ({ items: [], nextCursor: null })),
    createPipeline: vi.fn(async () => ({ id: 'postgres-pipeline' })),
    triggerPipelineRun: vi.fn(async () => ({ id: 'run-1', replayed: true })),
    listPipelineRuns: vi.fn(async () => ({ items: [], nextCursor: null })),
    listQualityRules: vi.fn(async () => ({ items: [], nextCursor: null })),
    createQualityRule: vi.fn(async () => ({ id: 'postgres-rule' })),
    listQualityResults: vi.fn(async () => ({ items: [], nextCursor: null })),
    listCandidates: vi.fn(async () => ({ items: [], nextCursor: null })),
    createCandidate: vi.fn(async () => ({ id: 'postgres-candidate' })),
    reviewCandidate: vi.fn(async () => ({ id: 'postgres-candidate', status: 'accepted' })),
    listWritebackRequests: vi.fn(async () => ({ items: [], nextCursor: null })),
    createWritebackRequest: vi.fn(async () => ({ id: 'writeback-1', state: 'pending_approval' })),
    approveWritebackRequest: vi.fn(async () => ({ id: 'writeback-1', state: 'approved' })),
    assertWritebackExecutable: vi.fn(async () => undefined),
    beginWritebackExecution: vi.fn(async () => execution()),
    recordUnavailableExecutor: vi.fn(async () => undefined),
    completeWritebackExecution: vi.fn(async (_context, _userId, _requestId, _correlationId, outcome) => ({
      id: 'writeback-1',
      state: outcome.succeeded ? 'succeeded' : 'failed',
    })),
    listWritebackEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
  };
  return store;
}

function postgresDiscovery(): PlatformDiscoveryPersistence {
  return {
    mode: 'postgres',
    listTenants: async () => ({ items: [], nextCursor: null }),
    listProjects: async () => ({ items: [], nextCursor: null }),
  };
}

function scoped(test: Test): Test {
  return test
    .set('x-test-user', actor)
    .set('x-odf-tenant-id', tenantId)
    .set('x-odf-project-id', projectId);
}

describe('PostgreSQL legacy platform compatibility routes', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('routes legacy model and pipeline-run APIs to PostgreSQL compatibility persistence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-data-fusion-pg-compat-'));
    directories.push(directory);
    const database = new FusionDatabase({ path: join(directory, 'test.db'), seed: false });
    const store = compatibility();
    const app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      platformDiscovery: postgresDiscovery(),
      platformCompatibilityPersistence: store,
    });

    const models = await scoped(request(app).get('/api/v1/platform/data-models'));
    expect(models.status).toBe(200);
    expect(models.body.items).toEqual([{ id: 'postgres-model', version: 1 }]);
    expect(store.listDataModels).toHaveBeenCalledWith(
      { tenantId, projectId },
      actor,
      expect.objectContaining({ limit: 50 }),
    );

    const run = await scoped(request(app).post('/api/v1/platform/pipelines/postgres-pipeline/runs'))
      .send({ idempotencyKey: 'retry-1', input: { temperature: 42 } });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ id: 'run-1', replayed: true });
    expect(store.triggerPipelineRun).toHaveBeenCalledWith(
      { tenantId, projectId },
      actor,
      'postgres-pipeline',
      { idempotencyKey: 'retry-1', input: { temperature: 42 } },
      expect.any(String),
    );

    database.close();
  });

  it('keeps unavailable write-back execution fail-closed after PostgreSQL safety validation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-data-fusion-pg-compat-writeback-'));
    directories.push(directory);
    const database = new FusionDatabase({ path: join(directory, 'test.db'), seed: false });
    const store = compatibility();
    const app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      platformDiscovery: postgresDiscovery(),
      platformCompatibilityPersistence: store,
    });

    const response = await scoped(request(app).post('/api/v1/platform/writeback/requests/writeback-1/execute')).send({});
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: 'writeback_executor_unavailable' });
    expect(store.assertWritebackExecutable).toHaveBeenCalledWith({ tenantId, projectId }, actor, 'writeback-1');
    expect(store.recordUnavailableExecutor).toHaveBeenCalledWith(
      { tenantId, projectId },
      actor,
      'writeback-1',
      expect.any(String),
    );
    expect(store.beginWritebackExecution).not.toHaveBeenCalled();

    database.close();
  });

  it('executes through the PostgreSQL compatibility record and persists the executor outcome', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-data-fusion-pg-compat-executor-'));
    directories.push(directory);
    const database = new FusionDatabase({ path: join(directory, 'test.db'), seed: false });
    const store = compatibility();
    const execute = vi.fn(async () => ({ receipt: 'provider-receipt-1' }));
    const app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      platformDiscovery: postgresDiscovery(),
      platformCompatibilityPersistence: store,
      writebackExecutor: { execute },
    });

    const response = await scoped(request(app).post('/api/v1/platform/writeback/requests/writeback-1/execute')).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'writeback-1', state: 'succeeded' });
    expect(execute).toHaveBeenCalledWith(execution());
    expect(store.completeWritebackExecution).toHaveBeenCalledWith(
      { tenantId, projectId },
      actor,
      'writeback-1',
      expect.any(String),
      { succeeded: true, result: { receipt: 'provider-receipt-1' } },
    );

    database.close();
  });
});
