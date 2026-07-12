import { describe, expect, it } from 'vitest';
import {
  PostgresRuntime,
  type RuntimeClient,
  type RuntimePool,
  type SqlQuery,
  type SqlQueryResult,
} from '@open-data-fusion/postgres-runtime';

import { PostgresWorkspacePersistence, type WorkspaceRequestScope } from '../src/postgres-workspace-persistence.js';

type Row = Record<string, unknown>;
type QueryHandler = (query: SqlQuery) => SqlQueryResult<Row>;

class RecordingClient implements RuntimeClient {
  readonly queries: SqlQuery[] = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<TRow extends Record<string, unknown> = Row>(query: SqlQuery): Promise<SqlQueryResult<TRow>> {
    this.queries.push({ text: query.text, ...(query.values ? { values: [...query.values] } : {}) });
    return this.handler(query) as SqlQueryResult<TRow>;
  }

  release(): void {}
}

class RecordingPool implements RuntimePool {
  constructor(readonly client: RecordingClient) {}

  async connect(): Promise<RuntimeClient> {
    return this.client;
  }

  async query<TRow extends Record<string, unknown> = Row>(_query: SqlQuery): Promise<SqlQueryResult<TRow>> {
    return { rows: [], rowCount: 0 };
  }

  async end(): Promise<void> {}
}

function result(rows: Row[] = []): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

const scope: WorkspaceRequestScope = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  projectId: '22222222-2222-2222-2222-222222222222',
  userId: 'harper.dennis',
};

const correlationId = '33333333-3333-3333-3333-333333333333';

function workspaceRow(version = 2, snapshot: Row = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }): Row {
  return {
    id: 'cooling-water-system',
    name: 'Cooling Water System',
    snapshot,
    version,
    created_by: 'harper.dennis',
    created_at: '2026-07-12T00:00:00.000Z',
    updated_by: 'harper.dennis',
    updated_at: '2026-07-12T00:01:00.000Z',
  };
}

function persistence(handler: QueryHandler): { persistence: PostgresWorkspacePersistence; client: RecordingClient } {
  const client = new RecordingClient(handler);
  const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
    projectAccessResolver: {
      resolve: async () => ({ role: 'owner' }),
    },
  });
  return { persistence: new PostgresWorkspacePersistence(runtime), client };
}

describe('PostgresWorkspacePersistence', () => {
  it('creates the first project workspace through the governed database function', async () => {
    const { persistence: store, client } = persistence((query) => {
      if (query.text.includes('odf.create_project_workspace')) return result([workspaceRow(1)]);
      return result();
    });

    const workspace = await store.createWorkspace(scope, {
      id: 'cooling-water-system',
      name: 'Cooling Water System',
    }, correlationId);

    expect(workspace).toMatchObject({ id: 'cooling-water-system', version: 1 });
    const creation = client.queries.find((query) => query.text.includes('odf.create_project_workspace'));
    expect(creation?.values).toEqual([
      scope.projectId,
      'cooling-water-system',
      'Cooling Water System',
      correlationId,
    ]);
  });

  it('writes a workspace revision, audit entry, and outbox event in the PostgreSQL scope', async () => {
    const { persistence: store, client } = persistence((query) => {
      if (query.text.startsWith('UPDATE odf.workspaces')) return result([workspaceRow()]);
      return result();
    });

    const workspace = await store.updateWorkspace(scope, 'cooling-water-system', {
      expectedVersion: 1,
      actor: scope.userId,
      changeSummary: 'Saved layout',
      snapshot: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
    }, correlationId);

    expect(workspace).toMatchObject({ id: 'cooling-water-system', version: 2 });
    const update = client.queries.find((query) => query.text.startsWith('UPDATE odf.workspaces'));
    expect(update?.text).toContain('FROM odf.workspace_scopes');
    expect(update?.values).toEqual(expect.arrayContaining([scope.tenantId, scope.projectId]));

    const audit = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.audit_log'));
    expect(audit?.values?.[3]).toBe('workspace.saved');
    const outbox = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.outbox_events'));
    expect(outbox?.values?.[2]).toBe('workspace.updated');
  });

  it('applies operations to the requested version and retains the operation in audit and outbox JSON', async () => {
    const initialSnapshot = { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] };
    const nextSnapshot = {
      ...initialSnapshot,
      nodes: [{ id: 'P-101', type: 'asset', position: { x: 10, y: 20 }, data: { name: 'Pump P-101' } }],
    };
    const { persistence: store, client } = persistence((query) => {
      if (query.text.includes('FROM odf.workspaces AS workspace')) return result([workspaceRow(1, initialSnapshot)]);
      if (query.text.includes('FROM odf.workspace_members') && query.text.includes('display_name')) {
        return result([{
          workspace_id: 'cooling-water-system',
          user_id: scope.userId,
          display_name: 'Harper Dennis',
          role: 'owner',
          created_at: '2026-07-12T00:00:00.000Z',
        }]);
      }
      if (query.text.startsWith('UPDATE odf.workspaces')) return result([workspaceRow(2, nextSnapshot)]);
      return result();
    });

    const workspace = await store.applyWorkspaceOperations(scope, 'cooling-water-system', scope.userId, {
      baseVersion: 1,
      changeSummary: 'Added pump',
      operations: [{
        type: 'addNode',
        node: { id: 'P-101', type: 'asset', position: { x: 10, y: 20 }, data: { name: 'Pump P-101' } },
      }],
    }, correlationId);

    expect(workspace.snapshot.nodes).toHaveLength(1);
    const audit = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.audit_log'));
    expect(audit?.values?.[3]).toBe('workspace.operations_applied');
    expect(JSON.parse(String(audit?.values?.[6]))).toMatchObject({
      operations: [{ type: 'addNode', node: { id: 'P-101' } }],
    });
    const outbox = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.outbox_events'));
    expect(JSON.parse(String(outbox?.values?.[5]))).toMatchObject({
      operations: [{ type: 'addNode', node: { id: 'P-101' } }],
    });
  });

  it('returns the atomic created flag from membership upsert', async () => {
    const { persistence: store, client } = persistence((query) => {
      if (query.text.includes('SELECT role FROM odf.workspace_members')) return result([{ role: 'owner' }]);
      if (query.text.startsWith('INSERT INTO odf.workspace_members')) {
        return result([{
          workspace_id: 'cooling-water-system',
          user_id: 'riley.chen',
          display_name: 'Riley Chen',
          role: 'editor',
          created_at: '2026-07-12T00:00:00.000Z',
        }]);
      }
      return result();
    });

    const outcome = await store.upsertWorkspaceMember(
      scope,
      'cooling-water-system',
      scope.userId,
      'riley.chen',
      { displayName: 'Riley Chen', role: 'editor' },
      correlationId,
    );

    expect(outcome).toEqual({
      created: true,
      member: {
        workspaceId: 'cooling-water-system',
        userId: 'riley.chen',
        displayName: 'Riley Chen',
        role: 'editor',
      },
    });
    const outbox = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.outbox_events'));
    expect(outbox?.values?.[2]).toBe('members.updated');
    expect(JSON.parse(String(outbox?.values?.[5]))).toMatchObject({
      workspaceId: 'cooling-water-system',
      actor: scope.userId,
      change: 'added',
      member: {
        workspaceId: 'cooling-water-system',
        userId: 'riley.chen',
        displayName: 'Riley Chen',
        role: 'editor',
      },
    });
  });
});
