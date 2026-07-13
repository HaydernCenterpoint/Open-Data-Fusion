import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express, Request } from 'express';
import request, { type Test } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  DATA_PLANE_PERMISSIONS,
  type AuthenticatedIdentity,
  type DataPlanePermission,
  type IdentityProvider,
} from '../src/auth.js';
import { createApp } from '../src/app.js';
import { WorkspaceEventHub } from '../src/collaboration.js';
import { FusionDatabase } from '../src/database.js';

class TestIdentityProvider implements IdentityProvider {
  readonly mode = 'oidc' as const;

  async authenticate(incoming: Request): Promise<AuthenticatedIdentity> {
    const userId = incoming.header('x-test-user')?.trim();
    if (!userId) throw new AuthenticationError('Test identity is required');
    const requested = new Set((incoming.header('x-test-permissions') ?? '').split(/\s+/u).filter(Boolean));
    const permissions = new Set(DATA_PLANE_PERMISSIONS.filter((permission) => requested.has(permission)));
    return { userId, displayName: userId, permissions };
  }
}

const defaultContext = { tenantId: 'demo', projectId: 'north-plant' };

function authorize(test: Test, userId: string, permissions: DataPlanePermission[]): Test {
  return test
    .set('x-test-user', userId)
    .set('x-test-permissions', permissions.join(' '));
}

function scope(test: Test, context = defaultContext): Test {
  return test
    .set('x-odf-tenant-id', context.tenantId)
    .set('x-odf-project-id', context.projectId);
}

describe('platform catalog API', () => {
  let tempDirectory: string;
  let database: FusionDatabase;
  let eventHub: WorkspaceEventHub;
  let app: Express;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-platform-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    eventHub = new WorkspaceEventHub();
    app = createApp(database, eventHub, { identityProvider: new TestIdentityProvider() });
  });

  afterEach(async () => {
    await eventHub.close();
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('initializes and seeds the platform schema idempotently on the shared connection', async () => {
    const secondApp = createApp(database, undefined, { identityProvider: new TestIdentityProvider() });
    const tenants = await authorize(
      request(secondApp).get('/api/v1/platform/tenants'),
      'harper.dennis',
      ['data:read'],
    );
    expect(tenants.status).toBe(200);
    expect(tenants.body.items.map((tenant: { id: string }) => tenant.id)).toEqual(['demo']);

    const projects = await authorize(
      request(secondApp).get('/api/v1/platform/tenants/demo/projects'),
      'harper.dennis',
      ['data:read'],
    );
    expect(projects.body.items.map((project: { id: string }) => project.id)).toEqual(['north-plant']);
  });

  it('creates isolated tenants/projects and filters discovery by project membership', async () => {
    const tenant = await authorize(
      request(app).post('/api/v1/platform/tenants'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: 'tenant-b', name: 'Tenant B' });
    expect(tenant.status).toBe(201);

    const project = await authorize(
      request(app).post('/api/v1/platform/tenants/tenant-b/projects'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: 'project-b', name: 'Private Project' });
    expect(project.status).toBe(201);

    const harperProjects = await authorize(
      request(app).get('/api/v1/platform/tenants/tenant-b/projects'),
      'harper.dennis',
      ['data:read'],
    );
    expect(harperProjects.body.items.map((item: { id: string }) => item.id)).toEqual(['project-b']);

    const rileyProjects = await authorize(
      request(app).get('/api/v1/platform/tenants/tenant-b/projects'),
      'riley.chen',
      ['data:read'],
    );
    expect(rileyProjects.body.items).toEqual([]);

    const isolatedRead = await scope(authorize(
      request(app).get('/api/v1/platform/datasets'),
      'riley.chen',
      ['data:read'],
    ), { tenantId: 'tenant-b', projectId: 'project-b' });
    expect(isolatedRead.status).toBe(403);

    const harperCreate = await scope(authorize(
      request(app).post('/api/v1/platform/datasets'),
      'harper.dennis',
      ['data:ingest'],
    ), { tenantId: 'tenant-b', projectId: 'project-b' }).send({ id: 'private-data', name: 'Private Data' });
    expect(harperCreate.status).toBe(201);
  });

  it('bootstraps the first empty real workspace in a project and enforces its immutable scope', async () => {
    const realContext = { tenantId: 'real-tenant', projectId: 'real-project' };
    await authorize(
      request(app).post('/api/v1/platform/tenants'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: 'real-tenant', name: 'Real Tenant' });
    await authorize(
      request(app).post('/api/v1/platform/tenants/real-tenant/projects'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: 'real-project', name: 'Real Project' });

    const created = await scope(authorize(
      request(app).post('/api/v1/workspaces'),
      'harper.dennis',
      ['data:ingest'],
    ), realContext)
      .set('x-correlation-id', 'workspace-bootstrap-correlation')
      .send({ id: 'real-operations-canvas', name: 'Real operations canvas' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'real-operations-canvas',
      name: 'Real operations canvas',
      version: 1,
      snapshot: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
      createdBy: 'harper.dennis',
    });

    const audit = await scope(authorize(
      request(app).get('/api/v1/audit').query({ action: 'workspace.created' }),
      'harper.dennis',
      ['audit:read'],
    ), { tenantId: 'real-tenant', projectId: 'real-project' });
    expect(audit.status).toBe(200);
    expect(audit.body).toMatchObject({
      total: 1,
      items: [{
        action: 'workspace.created',
        entityType: 'workspace',
        entityId: 'real-operations-canvas',
        correlationId: 'workspace-bootstrap-correlation',
      }],
    });

    const read = await scope(authorize(
      request(app).get('/api/v1/workspaces/real-operations-canvas'),
      'harper.dennis',
      [],
    ), realContext);
    expect(read.status).toBe(200);

    const operation = await scope(authorize(
      request(app).post('/api/v1/workspaces/real-operations-canvas/operations'),
      'harper.dennis',
      [],
    ), realContext).send({
      baseVersion: 1,
      changeSummary: 'Add the first real asset node',
      operations: [{
        type: 'addNode',
        node: { id: 'P-101', type: 'asset', position: { x: 120, y: 80 }, data: { label: 'Pump P-101' } },
      }],
    });
    expect(operation.status).toBe(200);
    expect(operation.body).toMatchObject({ version: 2, snapshot: { nodes: [{ id: 'P-101' }] } });

    const memberUpsert = await scope(authorize(
      request(app).put('/api/v1/workspaces/real-operations-canvas/members/riley.chen'),
      'harper.dennis',
      [],
    ), realContext).send({ displayName: 'Riley Chen', role: 'viewer' });
    expect(memberUpsert.status).toBe(201);

    const memberWithoutProjectAccess = await scope(authorize(
      request(app).get('/api/v1/workspaces/real-operations-canvas'),
      'riley.chen',
      [],
    ), realContext);
    expect(memberWithoutProjectAccess.status).toBe(403);

    database.database.prepare(`
      INSERT INTO platform_project_members(tenant_id, project_id, user_id, role, created_at)
      VALUES (?, ?, ?, 'viewer', ?)
    `).run(realContext.tenantId, realContext.projectId, 'riley.chen', new Date().toISOString());
    const memberWithProjectAccess = await scope(authorize(
      request(app).get('/api/v1/workspaces/real-operations-canvas'),
      'riley.chen',
      [],
    ), realContext);
    expect(memberWithProjectAccess.status).toBe(200);

    const promotedWorkspaceOwner = await scope(authorize(
      request(app).put('/api/v1/workspaces/real-operations-canvas/members/riley.chen'),
      'harper.dennis',
      [],
    ), realContext).send({ displayName: 'Riley Chen', role: 'owner' });
    expect(promotedWorkspaceOwner.status).toBe(200);

    const projectViewerWrite = await scope(authorize(
      request(app).post('/api/v1/workspaces/real-operations-canvas/operations'),
      'riley.chen',
      [],
    ), realContext).send({
      baseVersion: 2,
      changeSummary: 'Project viewer must remain read-only',
      operations: [{ type: 'moveNode', nodeId: 'P-101', position: { x: 240, y: 160 } }],
    });
    expect(projectViewerWrite.status).toBe(403);

    database.database.prepare(`
      UPDATE platform_project_members SET role = 'editor'
      WHERE tenant_id = ? AND project_id = ? AND user_id = ?
    `).run(realContext.tenantId, realContext.projectId, 'riley.chen');
    const projectEditorWrite = await scope(authorize(
      request(app).post('/api/v1/workspaces/real-operations-canvas/operations'),
      'riley.chen',
      [],
    ), realContext).send({
      baseVersion: 2,
      changeSummary: 'Project editor moves the node',
      operations: [{ type: 'moveNode', nodeId: 'P-101', position: { x: 240, y: 160 } }],
    });
    expect(projectEditorWrite.status).toBe(200);
    expect(projectEditorWrite.body).toMatchObject({ version: 3 });

    const memberDelete = await scope(authorize(
      request(app).delete('/api/v1/workspaces/real-operations-canvas/members/riley.chen'),
      'harper.dennis',
      [],
    ), realContext);
    expect(memberDelete.status).toBe(204);

    const mutationAudit = await scope(authorize(
      request(app).get('/api/v1/audit'),
      'harper.dennis',
      ['audit:read'],
    ), realContext);
    expect(mutationAudit.status).toBe(200);
    expect(mutationAudit.body.total).toBe(6);
    expect(mutationAudit.body.items.map((item: { action: string }) => item.action)).toEqual([
      'workspace.member_removed',
      'workspace.operations_applied',
      'workspace.member_updated',
      'workspace.member_added',
      'workspace.operations_applied',
      'workspace.created',
    ]);

    const removedMemberRead = await scope(authorize(
      request(app).get('/api/v1/workspaces/real-operations-canvas'),
      'riley.chen',
      [],
    ), realContext);
    expect(removedMemberRead.status).toBe(403);

    const wrongScope = await scope(authorize(
      request(app).get('/api/v1/workspaces/real-operations-canvas'),
      'harper.dennis',
      [],
    ), defaultContext);
    expect(wrongScope.status).toBe(404);

    const duplicate = await scope(authorize(
      request(app).post('/api/v1/workspaces'),
      'harper.dennis',
      ['data:ingest'],
    ), realContext)
      .send({ id: 'real-operations-canvas', name: 'Duplicate' });
    expect(duplicate.status).toBe(409);

    database.database.prepare(`
      DELETE FROM platform_project_members
      WHERE tenant_id = ? AND project_id = ? AND user_id = ?
    `).run(realContext.tenantId, realContext.projectId, 'harper.dennis');
    const revokedProjectMember = await scope(authorize(
      request(app).get('/api/v1/workspaces/real-operations-canvas'),
      'harper.dennis',
      [],
    ), realContext);
    expect(revokedProjectMember.status).toBe(403);
  });

  it('stops a scoped SQLite workspace event stream after project membership is revoked', async () => {
    const context = { tenantId: 'stream-tenant', projectId: 'stream-project' };
    await authorize(
      request(app).post('/api/v1/platform/tenants'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: context.tenantId, name: 'Stream Tenant' });
    await authorize(
      request(app).post(`/api/v1/platform/tenants/${context.tenantId}/projects`),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: context.projectId, name: 'Stream Project' });
    const created = await scope(authorize(
      request(app).post('/api/v1/workspaces'),
      'harper.dennis',
      ['data:ingest'],
    ), context).send({ id: 'stream-workspace', name: 'Stream Workspace' });
    expect(created.status).toBe(201);

    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    let cancelStream: (() => Promise<void>) | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('SSE test server did not bind a TCP port');
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/stream-workspace/events`,
        {
          headers: {
            'x-test-user': 'harper.dennis',
            'x-odf-tenant-id': context.tenantId,
            'x-odf-project-id': context.projectId,
          },
        },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('SSE response did not include a body');
      cancelStream = () => reader.cancel().catch(() => undefined);
      const decoder = new TextDecoder();
      const readSseChunk = async (errorMessage: string) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error(errorMessage)), 2_000);
              timeout.unref();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      };
      let initialFrames = '';
      while (!initialFrames.includes('event: presence.updated')) {
        const initialChunk = await readSseChunk('Scoped SQLite SSE did not publish initial presence');
        if (initialChunk.done) throw new Error('Scoped SQLite SSE closed before initial presence');
        initialFrames += decoder.decode(initialChunk.value);
      }
      expect(initialFrames).toContain(': connected');

      database.database.prepare(`
        DELETE FROM platform_project_members
        WHERE tenant_id = ? AND project_id = ? AND user_id = ?
      `).run(context.tenantId, context.projectId, 'harper.dennis');
      eventHub.publishWorkspaceUpdated({
        workspaceId: 'stream-workspace',
        version: 2,
        actor: 'remote.editor',
        changeSummary: 'Remote update after revocation',
      });

      const closed = await readSseChunk('Scoped SQLite SSE did not close after revocation');
      expect(closed.done).toBe(true);
    } finally {
      await cancelStream?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('creates catalog resources, versions data models, and paginates with keyset cursors', async () => {
    for (const dataset of [
      { id: 'dataset-a', name: 'Dataset A' },
      { id: 'dataset-b', name: 'Dataset B' },
    ]) {
      const response = await scope(authorize(
        request(app).post('/api/v1/platform/datasets'),
        'riley.chen',
        ['data:ingest'],
      )).send(dataset);
      expect(response.status).toBe(201);
    }

    const firstPage = await scope(authorize(
      request(app).get('/api/v1/platform/datasets').query({ limit: 1 }),
      'riley.chen',
      ['data:read'],
    ));
    expect(firstPage.body.items.map((item: { id: string }) => item.id)).toEqual(['dataset-a']);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    const secondPage = await scope(authorize(
      request(app).get('/api/v1/platform/datasets').query({ limit: 1, cursor: firstPage.body.nextCursor }),
      'riley.chen',
      ['data:read'],
    ));
    expect(secondPage.body.items.map((item: { id: string }) => item.id)).toEqual(['dataset-b']);

    const source = await scope(authorize(
      request(app).post('/api/v1/platform/sources'),
      'riley.chen',
      ['data:ingest'],
    )).send({ id: 'opcua-north', name: 'North OPC-UA', type: 'opcua' });
    expect(source.status).toBe(201);
    const connector = await scope(authorize(
      request(app).post('/api/v1/platform/connectors'),
      'riley.chen',
      ['data:ingest'],
    )).send({
      id: 'opcua-reader', name: 'OPC-UA Reader', sourceId: 'opcua-north', type: 'opcua',
      configuration: { endpoint: 'opc.tcp://edge.local:4840', secretRef: 'vault://odf/opcua' },
    });
    expect(connector.status).toBe(201);

    const inlineSecret = await scope(authorize(
      request(app).post('/api/v1/platform/connectors'),
      'riley.chen',
      ['data:ingest'],
    )).send({
      id: 'unsafe', name: 'Unsafe', sourceId: 'opcua-north', type: 'opcua', configuration: { password: 'plaintext' },
    });
    expect(inlineSecret.status).toBe(400);

    const versionOne = await scope(authorize(
      request(app).post('/api/v1/platform/data-models/equipment/versions'),
      'riley.chen',
      ['data:ingest'],
    )).send({ name: 'Equipment', schema: { properties: { tag: { type: 'string' } } }, status: 'draft' });
    const versionTwo = await scope(authorize(
      request(app).post('/api/v1/platform/data-models/equipment/versions'),
      'riley.chen',
      ['data:ingest'],
    )).send({ name: 'Equipment', schema: { properties: { tag: { type: 'string' }, criticality: { type: 'string' } } }, status: 'published' });
    expect(versionOne.body.version).toBe(1);
    expect(versionTwo.body.version).toBe(2);

    const models = await scope(authorize(
      request(app).get('/api/v1/platform/data-models'),
      'samantha.lee',
      ['data:read'],
    ));
    expect(models.body.items.map((model: { version: number }) => model.version)).toEqual([1, 2]);
  });

  it('runs pipelines deterministically, records quality results, and enforces idempotency', async () => {
    const rule = await scope(authorize(
      request(app).post('/api/v1/platform/quality-rules'),
      'riley.chen',
      ['data:ingest'],
    )).send({
      id: 'temperature-minimum', name: 'Temperature minimum',
      check: { operator: 'gte', field: 'temperature', value: 60 }, severity: 'warning',
    });
    expect(rule.status).toBe(201);

    const pipeline = await scope(authorize(
      request(app).post('/api/v1/platform/pipelines'),
      'riley.chen',
      ['data:ingest'],
    )).send({ id: 'normalize-telemetry', name: 'Normalize telemetry', definition: { transform: 'identity' } });
    expect(pipeline.status).toBe(201);

    const firstRun = await scope(authorize(
      request(app).post('/api/v1/platform/pipelines/normalize-telemetry/runs'),
      'riley.chen',
      ['data:ingest'],
    )).set('x-correlation-id', 'pipeline-run-test').send({ idempotencyKey: 'hour-001', input: { temperature: 65 } });
    expect(firstRun.status).toBe(201);
    expect(firstRun.body).toMatchObject({
      status: 'completed', replayed: false,
      result: { quality: { total: 1, passed: 1, failed: 0 } },
    });

    const retry = await scope(authorize(
      request(app).post('/api/v1/platform/pipelines/normalize-telemetry/runs'),
      'riley.chen',
      ['data:ingest'],
    )).send({ idempotencyKey: 'hour-001', input: { temperature: 65 } });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ id: firstRun.body.id, replayed: true, status: 'completed' });

    const conflict = await scope(authorize(
      request(app).post('/api/v1/platform/pipelines/normalize-telemetry/runs'),
      'riley.chen',
      ['data:ingest'],
    )).send({ idempotencyKey: 'hour-001', input: { temperature: 20 } });
    expect(conflict.status).toBe(409);

    const results = await scope(authorize(
      request(app).get('/api/v1/platform/quality-results'),
      'samantha.lee',
      ['data:read'],
    ));
    expect(results.body.items).toHaveLength(1);
    expect(results.body.items[0]).toMatchObject({ ruleId: 'temperature-minimum', runId: firstRun.body.id, passed: true });

    const audit = database.listAudit({ action: 'platform.pipeline_run_completed', limit: 10, offset: 0 });
    expect((audit.items as Array<Record<string, unknown>>)[0]).toMatchObject({ actor: 'riley.chen', correlationId: 'pipeline-run-test' });
  });

  it('searches existing assets and newly projected platform entities', async () => {
    await scope(authorize(
      request(app).post('/api/v1/platform/datasets'),
      'riley.chen',
      ['data:ingest'],
    )).send({ id: 'maintenance-insights', name: 'Maintenance Insights', description: 'Pump maintenance analytics' });

    const assetSearch = await scope(authorize(
      request(app).get('/api/v1/platform/search').query({ q: 'Pump P-101' }),
      'samantha.lee',
      ['data:read'],
    ));
    expect(assetSearch.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'asset', entityId: 'P-101' }),
    ]));

    const catalogSearch = await scope(authorize(
      request(app).get('/api/v1/platform/search').query({ q: 'maintenance analytics' }),
      'samantha.lee',
      ['data:read'],
    ));
    expect(catalogSearch.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'dataset', entityId: 'maintenance-insights' }),
    ]));
  });

  it('reviews contextualization candidates with verified identity and project policy', async () => {
    const created = await scope(authorize(
      request(app).post('/api/v1/platform/contextualization/candidates'),
      'riley.chen',
      ['data:ingest'],
    )).send({
      id: 'candidate-1', source: { type: 'asset', id: 'P-101' }, target: { type: 'document', id: 'DOC-P101-MANUAL' },
      relationType: 'hasDocument', confidence: 0.94, evidence: { matchedTag: 'P-101' },
    });
    expect(created.status).toBe(201);

    const viewerDenied = await scope(authorize(
      request(app).post('/api/v1/platform/contextualization/candidates/candidate-1/review'),
      'samantha.lee',
      ['relations:review'],
    )).send({ decision: 'accepted' });
    expect(viewerDenied.status).toBe(403);

    const reviewed = await scope(authorize(
      request(app).post('/api/v1/platform/contextualization/candidates/candidate-1/review'),
      'monica.reyes',
      ['relations:review'],
    )).send({ decision: 'accepted', comment: 'Tag evidence verified' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({ status: 'accepted', reviewedBy: 'monica.reyes' });

    const secondReview = await scope(authorize(
      request(app).post('/api/v1/platform/contextualization/candidates/candidate-1/review'),
      'monica.reyes',
      ['relations:review'],
    )).send({ decision: 'rejected' });
    expect(secondReview.status).toBe(409);
  });

  it('requires both platform permissions and project roles', async () => {
    const missingPermission = await scope(authorize(
      request(app).post('/api/v1/platform/datasets'),
      'riley.chen',
      ['data:read'],
    )).send({ id: 'denied-a', name: 'Denied A' });
    expect(missingPermission.status).toBe(403);

    const viewerRole = await scope(authorize(
      request(app).post('/api/v1/platform/datasets'),
      'samantha.lee',
      ['data:ingest'],
    )).send({ id: 'denied-b', name: 'Denied B' });
    expect(viewerRole.status).toBe(403);

    const adminDenied = await authorize(
      request(app).post('/api/v1/platform/tenants'),
      'riley.chen',
      ['data:ingest'],
    ).send({ id: 'denied-tenant', name: 'Denied Tenant' });
    expect(adminDenied.status).toBe(403);

    const missingContext = await authorize(
      request(app).get('/api/v1/platform/datasets'),
      'riley.chen',
      ['data:read'],
    );
    expect(missingContext.status).toBe(400);
  });
});
