import { createServer } from 'node:http';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { WorkspaceEventHub } from '../src/collaboration.js';
import { FusionDatabase } from '../src/database.js';
import { PostgresWorkspacePersistence, type WorkspaceRequestScope } from '../src/postgres-workspace-persistence.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const projectId = '22222222-2222-2222-2222-222222222222';
const workspaceId = 'cooling-water-system';

function workspace(version = 1) {
  return {
    id: workspaceId,
    name: 'Cooling Water System',
    version,
    snapshot: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    createdBy: 'harper.dennis',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedBy: 'harper.dennis',
    updatedAt: '2026-07-12T00:01:00.000Z',
  };
}

class RecordingWorkspaceEventHub extends WorkspaceEventHub {
  readonly workspaceUpdates: Record<string, unknown>[] = [];

  override publishWorkspaceUpdated(data: Record<string, unknown>): void {
    this.workspaceUpdates.push(data);
  }
}

describe('PostgreSQL workspace routing', () => {
  const database = new FusionDatabase({ path: ':memory:' });

  afterEach(() => {
    // The production adapter must receive the UUID project scope from headers;
    // the legacy SQLite store is intentionally not queried by these tests.
  });

  it('routes workspace reads through PostgreSQL persistence with tenant/project scope', async () => {
    const calls: Array<{ scope: WorkspaceRequestScope; id: string }> = [];
    const persistence = {
      health: async () => ({ status: 'ok' as const, service: 'open-data-fusion-api', database: 'odf', timestamp: '2026-07-12T00:00:00.000Z' }),
      getWorkspaceMember: async () => ({ workspaceId, userId: 'harper.dennis', displayName: 'Harper Dennis', role: 'owner' as const }),
      getWorkspace: async (scope: WorkspaceRequestScope, id: string) => {
        calls.push({ scope, id });
        return workspace();
      },
    } as unknown as PostgresWorkspacePersistence;
    const app = createApp(database, undefined, { workspacePersistence: persistence });

    const response = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}`)
      .set('x-odf-user', 'harper.dennis')
      .set('x-odf-tenant-id', tenantId)
      .set('x-odf-project-id', projectId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: workspaceId, version: 1 });
    expect(calls).toEqual([{ scope: { tenantId, projectId, userId: 'harper.dennis' }, id: workspaceId }]);
  });

  it('routes workspace writes through PostgreSQL persistence and rejects missing scope headers', async () => {
    const updates: Array<{ scope: WorkspaceRequestScope; id: string; correlationId: string }> = [];
    const persistence = {
      health: async () => ({ status: 'ok' as const, service: 'open-data-fusion-api', database: 'odf', timestamp: '2026-07-12T00:00:00.000Z' }),
      getWorkspaceMember: async () => ({ workspaceId, userId: 'harper.dennis', displayName: 'Harper Dennis', role: 'owner' as const }),
      updateWorkspace: async (scope: WorkspaceRequestScope, id: string, _update: unknown, correlationId: string) => {
        updates.push({ scope, id, correlationId });
        return workspace(2);
      },
    } as unknown as PostgresWorkspacePersistence;
    const eventHub = new RecordingWorkspaceEventHub();
    const app = createApp(database, eventHub, { workspacePersistence: persistence });
    const body = {
      expectedVersion: 1,
      actor: 'untrusted-body-actor',
      changeSummary: 'Move asset',
      snapshot: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    };

    const missingScope = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}`)
      .set('x-odf-user', 'harper.dennis')
      .send(body);
    expect(missingScope.status).toBe(400);
    expect(updates).toEqual([]);

    const invalidCorrelation = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}`)
      .set('x-odf-user', 'harper.dennis')
      .set('x-odf-tenant-id', tenantId)
      .set('x-odf-project-id', projectId)
      .set('x-correlation-id', 'legacy-client-correlation')
      .send(body);
    expect(invalidCorrelation.status).toBe(400);
    expect(invalidCorrelation.body.error.code).toBe('invalid_correlation_id');
    expect(invalidCorrelation.headers['x-correlation-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(updates).toEqual([]);

    const response = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}`)
      .set('x-odf-user', 'harper.dennis')
      .set('x-odf-tenant-id', tenantId)
      .set('x-odf-project-id', projectId)
      .set('x-correlation-id', '33333333-3333-3333-3333-333333333333')
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.version).toBe(2);
    expect(updates).toEqual([{
      scope: { tenantId, projectId, userId: 'harper.dennis' },
      id: workspaceId,
      correlationId: '33333333-3333-3333-3333-333333333333',
    }]);
    expect(eventHub.workspaceUpdates).toEqual([]);
  });

  it('rechecks PostgreSQL membership before streaming a durable event after revocation', async () => {
    let memberPresent = true;
    const persistence = {
      health: async () => ({ status: 'ok' as const, service: 'open-data-fusion-api', database: 'odf', timestamp: '2026-07-12T00:00:00.000Z' }),
      getWorkspaceMember: async () => {
        if (!memberPresent) throw new Error('workspace membership was revoked');
        return { workspaceId, userId: 'harper.dennis', displayName: 'Harper Dennis', role: 'owner' as const };
      },
    } as unknown as PostgresWorkspacePersistence;
    const eventHub = new WorkspaceEventHub();
    const app = createApp(database, eventHub, { workspacePersistence: persistence });
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('SSE test server did not bind a TCP port');
      const scopeQuery = new URLSearchParams({ user: 'harper.dennis', tenantId, projectId });
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/${workspaceId}/events?${scopeQuery.toString()}`,
        { headers: { 'x-odf-user': 'harper.dennis' } },
      );
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('SSE response did not include a body');
      const decoder = new TextDecoder();
      let frames = decoder.decode((await reader.read()).value ?? new Uint8Array());

      memberPresent = false;
      eventHub.publishWorkspaceUpdated({ workspaceId, version: 2, actor: 'riley.chen', changeSummary: 'Remote update' });
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        frames += decoder.decode(chunk.value);
      }

      expect(frames).toContain(': connected');
      expect(frames).not.toContain('event: workspace.updated');
      await eventHub.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
