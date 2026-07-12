import { describe, expect, it, vi } from 'vitest';
import {
  PostgresRuntime,
  type RuntimeClient,
  type RuntimePool,
  type SqlQuery,
  type SqlQueryResult,
} from '@open-data-fusion/postgres-runtime';

import { PostgresIndustrialPersistence } from '../src/postgres-industrial-persistence.js';
import type { IndustrialRequestScope } from '../src/industrial-persistence.js';
import type { IngestBundle } from '../src/schemas.js';

type Row = Record<string, unknown>;
type QueryHandler = (query: SqlQuery) => SqlQueryResult<Row>;

class RecordingClient implements RuntimeClient {
  readonly queries: SqlQuery[] = [];

  constructor(private readonly handler: QueryHandler) {}

  async query<TRow extends Row = Row>(query: SqlQuery): Promise<SqlQueryResult<TRow>> {
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

  async query<TRow extends Row = Row>(_query: SqlQuery): Promise<SqlQueryResult<TRow>> {
    return { rows: [], rowCount: 0 };
  }

  async end(): Promise<void> {}
}

function result(rows: Row[] = []): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

const scope: IndustrialRequestScope = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  projectId: '22222222-2222-2222-2222-222222222222',
  userId: 'operator@example.com',
};

const correlationId = '33333333-3333-4333-8333-333333333333';
const modelSpaceId = '44444444-4444-4444-8444-444444444444';
const sourceConnectionId = '55555555-5555-4555-8555-555555555555';
const otherProjectId = '66666666-6666-4666-8666-666666666666';

function createPersistence(handler: QueryHandler) {
  const authorize = vi.fn(async () => ({ role: 'owner' as const }));
  const client = new RecordingClient(handler);
  const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
    projectAccessResolver: { resolve: authorize },
  });
  return { persistence: new PostgresIndustrialPersistence(runtime), client, authorize };
}

function bundle(): IngestBundle {
  return {
    source: { system: 'plant-opcua', runId: 'shift-2026-07-12', actor: 'connector@plant' },
    assets: [{ externalId: 'P-101', name: 'Pump P-101', type: 'pump', metadata: { area: 'utilities' } }],
    timeSeries: [{
      externalId: 'P-101.temperature', assetExternalId: 'P-101', name: 'Temperature', unit: 'C',
      description: 'Bearing temperature', metadata: {},
    }],
    dataPoints: [
      { timeSeriesExternalId: 'P-101.temperature', timestamp: 1_784_000_000_000, value: 72.1, quality: 'good' },
      { timeSeriesExternalId: 'P-101.temperature', timestamp: 1_784_000_060_000, value: 72.4, quality: 'uncertain' },
    ],
    documents: [{ externalId: 'P-101.manual', assetExternalId: 'P-101', title: 'Pump manual', mimeType: 'application/pdf', uri: 's3://manuals/p-101.pdf', metadata: {} }],
    relations: [{
      id: 'P-101-has-manual', sourceType: 'asset', sourceExternalId: 'P-101', targetType: 'document',
      targetExternalId: 'P-101.manual', relationType: 'hasDocument', status: 'proposed', confidence: 0.98,
      evidence: { rule: 'asset-document-name' }, ruleVersion: '1',
    }],
  };
}

function persistedGraphRows(query: SqlQuery): SqlQueryResult<Row> {
  const rows = JSON.parse(String(query.values?.[3])) as Array<{
    id: string;
    external_id: string;
    kind: string;
  }>;
  return result(rows.map((row) => ({
    instance_id: row.id,
    tenant_id: query.values?.[0],
    project_id: query.values?.[1],
    space_id: query.values?.[2],
    external_id: row.external_id,
    instance_kind: row.kind,
  })));
}

function successfulIngestHandler(query: SqlQuery): SqlQueryResult<Row> {
  if (query.text.startsWith('SELECT space.space_id')) {
    return result([{ space_id: modelSpaceId, source_connection_id: sourceConnectionId }]);
  }
  if (query.text.startsWith('SELECT ingestion_run_id')) return result();
  if (query.text.startsWith('INSERT INTO odf.graph_instances')) return persistedGraphRows(query);
  if (query.text.startsWith('UPDATE odf.ingestion_runs') && query.text.includes("state = 'succeeded'")) {
    return result([{ completed_at: '2026-07-12T02:00:00.000Z' }]);
  }
  return result();
}

describe('PostgresIndustrialPersistence', () => {
  it('enforces membership and returns a tenant/project-scoped asset page with the SQLite response shape', async () => {
    const { persistence, client, authorize } = createPersistence((query) => {
      if (query.text.startsWith('SELECT count(*)::bigint')) return result([{ total: '1' }]);
      if (query.text.includes('FROM odf.assets AS asset') && query.text.includes('ORDER BY lower(asset.name)')) {
        return result([{
          external_id: 'P-101', name: 'Pump P-101', description: 'Cooling water pump', asset_type: 'pump',
          parent_external_id: null, metadata: { area: 'utilities' }, source_system: 'plant-opcua',
          created_at: '2026-07-12T01:00:00.000Z', updated_at: '2026-07-12T01:05:00.000Z',
          total: '1',
        }]);
      }
      return result();
    });

    const page = await persistence.listAssets(scope, { q: 'pump', type: 'pump', limit: 25, offset: 0 });

    expect(authorize).toHaveBeenCalledWith(scope);
    expect(page).toEqual({
      items: [{
        externalId: 'P-101', name: 'Pump P-101', description: 'Cooling water pump', type: 'pump',
        parentExternalId: null, metadata: { area: 'utilities' }, sourceSystem: 'plant-opcua',
        createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:05:00.000Z',
      }],
      total: 1,
      limit: 25,
      offset: 0,
    });
    const pageQuery = client.queries.find((query) => query.text.includes('ORDER BY lower(asset.name)'));
    expect(pageQuery?.values).toEqual([scope.tenantId, scope.projectId, 'pump', 'pump', 25, 0]);
    expect(pageQuery?.text).toContain("space.external_id = 'default'");
  });

  it('reuses existing default-model-space entity UUIDs instead of creating parallel identities', async () => {
    const existingAssetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const existingSeriesId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const existingDocumentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const { persistence, client } = createPersistence((query) => {
      if (query.text.startsWith('SELECT space.space_id')) {
        return result([{ space_id: modelSpaceId, source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('SELECT ingestion_run_id')) return result();
      if (query.text.startsWith('SELECT graph.instance_id, graph.external_id')) {
        return result([
          { instance_id: existingAssetId, external_id: 'P-101', instance_kind: 'node', entity_type: 'asset' },
          { instance_id: existingSeriesId, external_id: 'P-101.temperature', instance_kind: 'node', entity_type: 'timeSeries' },
          { instance_id: existingDocumentId, external_id: 'P-101.manual', instance_kind: 'node', entity_type: 'document' },
        ]);
      }
      if (query.text.startsWith('INSERT INTO odf.graph_instances')) return persistedGraphRows(query);
      if (query.text.startsWith('WITH incoming_points AS MATERIALIZED')) {
        return result([{ expected_count: '2', accepted_count: '2' }]);
      }
      if (query.text.startsWith('UPDATE odf.ingestion_runs') && query.text.includes("state = 'succeeded'")) {
        return result([{ completed_at: '2026-07-12T02:00:00.000Z' }]);
      }
      return result();
    });

    await persistence.ingest(scope, bundle(), correlationId);

    const graphInsert = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.graph_instances'));
    const graphRows = JSON.parse(String(graphInsert?.values?.[3])) as Row[];
    expect(graphInsert?.text).toContain(
      'properties = odf.graph_instances.properties || EXCLUDED.properties',
    );
    expect(graphRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: existingAssetId, external_id: 'P-101' }),
      expect.objectContaining({ id: existingSeriesId, external_id: 'P-101.temperature' }),
      expect.objectContaining({ id: existingDocumentId, external_id: 'P-101.manual' }),
    ]));
  });

  it('atomically ingests a bundle, batches numeric points, and short-circuits an identical completed run', async () => {
    let completedRun: Row | undefined;
    const { persistence, client, authorize } = createPersistence((query) => {
      if (query.text.startsWith('SELECT space.space_id')) {
        return result([{ space_id: modelSpaceId, source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('SELECT ingestion_run_id')) {
        return completedRun ? result([completedRun]) : result();
      }
      if (query.text.startsWith('INSERT INTO odf.graph_instances')) return persistedGraphRows(query);
      if (query.text.startsWith('WITH incoming_points AS MATERIALIZED')) {
        return result([{ expected_count: '2', accepted_count: '2' }]);
      }
      if (query.text.startsWith('UPDATE odf.ingestion_runs') && query.text.includes("state = 'succeeded'")) {
        const initial = client.queries.find((item) => item.text.startsWith('INSERT INTO odf.ingestion_runs'));
        const checkpointBefore = JSON.parse(String(initial?.values?.[6])) as { payloadHash: string };
        completedRun = {
          ingestion_run_id: query.values?.[2],
          state: 'succeeded',
          checkpoint_before: checkpointBefore,
          checkpoint_after: JSON.parse(String(query.values?.[4])),
          completed_at: '2026-07-12T02:00:00.000Z',
        };
        return result([{ completed_at: completedRun.completed_at }]);
      }
      return result();
    });

    const first = await persistence.ingest(scope, bundle(), correlationId);
    const second = await persistence.ingest(scope, bundle(), correlationId);

    expect(authorize).toHaveBeenNthCalledWith(1, scope);
    expect(first).toMatchObject({ status: 'completed', runId: 'shift-2026-07-12' });
    expect(second).toEqual({
      runId: 'shift-2026-07-12',
      status: 'already_processed',
      counts: { assets: 1, timeSeries: 1, dataPoints: 2, documents: 1, relations: 1 },
    });
    const runInsert = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.ingestion_runs'));
    expect(String(runInsert?.values?.[0])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(runInsert?.values?.[0]).not.toBe(first.runId);

    const lockIndex = client.queries.findIndex((query) => query.text.includes('pg_advisory_xact_lock'));
    const priorRunIndex = client.queries.findIndex((query) => query.text.startsWith('SELECT ingestion_run_id'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(priorRunIndex);

    const pointInserts = client.queries.filter((query) => query.text.startsWith('INSERT INTO odf.time_series_points'));
    expect(pointInserts).toHaveLength(1);
    expect(pointInserts[0]?.text).toContain('jsonb_to_recordset');
    expect(pointInserts[0]?.text).toContain('DO NOTHING');
    const pointVerification = client.queries.find((query) => query.text.startsWith('WITH incoming_points AS MATERIALIZED'));
    expect(pointVerification?.text).toContain('IS NOT DISTINCT FROM incoming.numeric_value');
    const pointPayload = JSON.parse(String(pointInserts[0]?.values?.[4])) as Row[];
    expect(pointPayload).toHaveLength(2);
    expect(pointPayload[0]).toMatchObject({ timestamp_ms: 1_784_000_000_000, numeric_value: 72.1, quality: 'good' });

    const graphInsert = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.graph_instances'));
    const graphPayload = JSON.parse(String(graphInsert?.values?.[3])) as Row[];
    expect(graphPayload).toHaveLength(4);
    expect(graphPayload.every((item) => /^[0-9a-f-]{14}8[0-9a-f-]+$/.test(String(item.id)))).toBe(true);
    expect(client.queries.filter((query) => query.text.startsWith('INSERT INTO odf.graph_instances'))).toHaveLength(1);
    expect(client.queries.some((query) => query.text.startsWith('INSERT INTO odf.provenance_records'))).toBe(true);
    expect(client.queries.some((query) => query.text.startsWith('INSERT INTO odf.audit_log'))).toBe(true);
    expect(client.queries.some((query) => query.text.startsWith('INSERT INTO odf.outbox_events'))).toBe(true);
  });

  it('fails the whole run when the atomic point upsert detects a conflicting immutable observation', async () => {
    const { persistence, client } = createPersistence((query) => {
      if (query.text.startsWith('SELECT space.space_id')) {
        return result([{ space_id: modelSpaceId, source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('SELECT ingestion_run_id')) return result();
      if (query.text.startsWith('INSERT INTO odf.graph_instances')) return persistedGraphRows(query);
      if (query.text.startsWith('WITH incoming_points AS MATERIALIZED')) {
        return result([{ expected_count: '2', accepted_count: '1' }]);
      }
      if (query.text.startsWith('SELECT source_connection_id FROM odf.source_connections')) {
        return result([{ source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('INSERT INTO odf.ingestion_runs') && query.text.includes("'failed'")) {
        return result([{ ingestion_run_id: query.values?.[0] }]);
      }
      return result();
    });

    await expect(persistence.ingest(scope, bundle(), correlationId)).rejects.toThrow(
      'An immutable telemetry point already exists with a different value',
    );
    expect(client.queries.some((query) => query.text.startsWith('WITH incoming_points AS MATERIALIZED'))).toBe(true);
  });

  it('keeps caller relation IDs and derives bounded deterministic collision-safe IDs for composite relations', async () => {
    const { persistence, client } = createPersistence(successfulIngestHandler);
    const longSourceId = `A${'x'.repeat(254)}`;
    const longTargetId = `D${'y'.repeat(254)}`;
    const relations: IngestBundle['relations'] = [
      {
        id: 'caller:provided-relation', sourceType: 'asset', sourceExternalId: 'A', targetType: 'document',
        targetExternalId: 'D', relationType: 'documents', status: 'proposed', evidence: {},
      },
      {
        sourceType: 'asset', sourceExternalId: 'A:B', targetType: 'document', targetExternalId: 'D',
        relationType: 'uses', status: 'proposed', evidence: {},
      },
      {
        sourceType: 'asset', sourceExternalId: 'A', targetType: 'document', targetExternalId: 'D',
        relationType: 'B:uses', status: 'proposed', evidence: {},
      },
      {
        sourceType: 'asset', sourceExternalId: longSourceId, targetType: 'document', targetExternalId: longTargetId,
        relationType: 'documents', status: 'proposed', evidence: {},
      },
    ];
    const compositeBundle: IngestBundle = {
      source: { system: 'plant-opcua', runId: 'relation-id-run-1', actor: 'connector@plant' },
      assets: [], timeSeries: [], dataPoints: [], documents: [], relations,
    };

    await persistence.ingest(scope, compositeBundle, correlationId);
    await persistence.ingest(scope, {
      ...compositeBundle,
      source: { ...compositeBundle.source, runId: 'relation-id-run-2' },
    }, correlationId);

    const graphInserts = client.queries.filter((query) => query.text.startsWith('INSERT INTO odf.graph_instances'));
    expect(graphInserts).toHaveLength(2);
    const firstEdges = (JSON.parse(String(graphInserts[0]?.values?.[3])) as Row[])
      .filter((item) => item.kind === 'edge');
    const secondEdges = (JSON.parse(String(graphInserts[1]?.values?.[3])) as Row[])
      .filter((item) => item.kind === 'edge');
    const firstIds = firstEdges.map((item) => String(item.external_id));
    const secondIds = secondEdges.map((item) => String(item.external_id));

    expect(firstIds[0]).toBe('caller:provided-relation');
    expect(firstIds.slice(1).every((id) => id.length <= 255)).toBe(true);
    expect(new Set(firstIds.slice(1)).size).toBe(3);
    expect(secondIds).toEqual(firstIds);
  });

  it('rejects a predictable relation graph UUID preempted by another project and scopes relation graph reads', async () => {
    const existingAssetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const existingDocumentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const { persistence, client } = createPersistence((query) => {
      if (query.text.startsWith('SELECT space.space_id')) {
        return result([{ space_id: modelSpaceId, source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('SELECT ingestion_run_id')) return result();
      if (query.text.startsWith('SELECT graph.instance_id, graph.external_id')) {
        return result([
          { instance_id: existingAssetId, external_id: 'P-101', instance_kind: 'node', entity_type: 'asset' },
          { instance_id: existingDocumentId, external_id: 'P-101.manual', instance_kind: 'node', entity_type: 'document' },
        ]);
      }
      if (query.text.startsWith('INSERT INTO odf.graph_instances')) {
        const edge = (JSON.parse(String(query.values?.[3])) as Row[])[0]!;
        return result([{
          instance_id: edge.id,
          tenant_id: scope.tenantId,
          project_id: otherProjectId,
          space_id: modelSpaceId,
          external_id: edge.external_id,
          instance_kind: edge.kind,
        }]);
      }
      if (query.text.startsWith('SELECT source_connection_id FROM odf.source_connections')) {
        return result([{ source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('INSERT INTO odf.ingestion_runs') && query.text.includes("'failed'")) {
        return result([{ ingestion_run_id: query.values?.[0] }]);
      }
      return result();
    });
    const relationOnly = bundle();
    relationOnly.source.runId = 'cross-project-edge-preemption';
    relationOnly.assets = [];
    relationOnly.timeSeries = [];
    relationOnly.dataPoints = [];
    relationOnly.documents = [];

    await expect(persistence.ingest(scope, relationOnly, correlationId)).rejects.toThrow(
      "Graph instance 'P-101-has-manual' is already bound to a different project or identity",
    );
    await persistence.listRelations(scope, undefined, 50);

    const graphInsert = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.graph_instances'));
    expect(graphInsert?.text).toContain('odf.graph_instances.project_id = EXCLUDED.project_id');
    expect(graphInsert?.text).toContain('odf.graph_instances.external_id = EXCLUDED.external_id');
    expect(graphInsert?.text).toContain('RETURNING instance_id, tenant_id, project_id');
    const relationRead = client.queries.find((query) => query.text.startsWith('WITH combined AS'));
    expect(relationRead?.text).toContain('relation_graph.tenant_id = candidate.tenant_id');
    expect(relationRead?.text).toContain('relation_graph.project_id = candidate.project_id');
    expect(relationRead?.text).toContain('relation_graph.tenant_id = relation.tenant_id');
    expect(relationRead?.text).toContain('relation_graph.project_id = relation.project_id');
  });

  it('reconciles proposed and accepted relation representations without split-brain state', async () => {
    const { persistence, client } = createPersistence(successfulIngestHandler);
    const relation: IngestBundle['relations'][number] = {
      id: 'stateful-relation', sourceType: 'asset', sourceExternalId: 'P-101', targetType: 'document',
      targetExternalId: 'P-101.manual', relationType: 'hasDocument', status: 'proposed', confidence: 0.9,
      evidence: {},
    };
    const stateBundle: IngestBundle = {
      source: { system: 'plant-opcua', runId: 'relation-state-proposed', actor: 'connector@plant' },
      assets: [], timeSeries: [], dataPoints: [], documents: [], relations: [relation],
    };

    await persistence.ingest(scope, stateBundle, correlationId);
    await persistence.ingest(scope, {
      ...stateBundle,
      source: { ...stateBundle.source, runId: 'relation-state-accepted' },
      relations: [{ ...relation, status: 'accepted' }],
    }, correlationId);

    const conflictCheck = client.queries.find((query) => query.text.includes('terminal_candidates AS'));
    expect(conflictCheck?.text).toContain('terminal_candidates');
    expect(conflictCheck?.text).toContain('terminal_relations');
    expect(conflictCheck?.text).toContain("candidate.state <> 'proposed'");
    expect(conflictCheck?.text).toContain("relation.state IN ('accepted', 'superseded')");

    const candidateInsert = client.queries.find((query) => query.text.startsWith('INSERT INTO odf.relation_candidates'));
    expect(candidateInsert?.text).toContain('item.status');
    expect(candidateInsert?.text).toContain('accepted_relation_id');
    expect(candidateInsert?.text).toContain("WHERE odf.relation_candidates.state = 'proposed'");
  });

  it('detaches an existing document link when the next document payload has no asset', async () => {
    const { persistence, client } = createPersistence(successfulIngestHandler);
    const detached = bundle();
    detached.source.runId = 'document-detach';
    detached.assets = [];
    detached.timeSeries = [];
    detached.dataPoints = [];
    detached.relations = [];
    detached.documents = [{
      externalId: 'P-101.manual', assetExternalId: null, title: 'Pump manual', mimeType: 'application/pdf',
      uri: 's3://manuals/p-101.pdf', metadata: {},
    }];

    await persistence.ingest(scope, detached, correlationId);

    const detach = client.queries.find((query) => query.text.startsWith('DELETE FROM odf.document_asset_links'));
    expect(detach?.text).toContain('link.document_id = item.id::uuid');
    expect(detach?.values?.slice(0, 2)).toEqual([scope.tenantId, scope.projectId]);
    const detachRows = JSON.parse(String(detach?.values?.[2])) as Row[];
    expect(detachRows).toEqual([expect.objectContaining({ asset_id: null })]);
  });

  it('persists the raw-object link on the failed ingestion run', async () => {
    let rawObjectId: string | undefined;
    const { persistence, client } = createPersistence((query) => {
      if (query.text.startsWith('SELECT space.space_id')) {
        return result([{ space_id: modelSpaceId, source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('SELECT ingestion_run_id')) return result();
      if (query.text.includes('odf.raw_ingest_objects')) {
        rawObjectId ??= String(query.values?.[0]);
        return result([{ raw_object_id: rawObjectId }]);
      }
      if (query.text.startsWith('INSERT INTO odf.graph_instances')) throw new Error('synthetic graph failure');
      if (query.text.startsWith('SELECT source_connection_id FROM odf.source_connections')) {
        return result([{ source_connection_id: sourceConnectionId }]);
      }
      if (query.text.startsWith('INSERT INTO odf.ingestion_runs') && query.text.includes("'failed'")) {
        return result([{ ingestion_run_id: query.values?.[0] }]);
      }
      return result();
    });
    const archive = {
      storageUri: 'file:///archive/plant-opcua/run.ndjson',
      sha256: 'a'.repeat(64),
      byteSize: 4_096,
      contentType: 'application/x-ndjson',
    };

    await expect(persistence.ingest(scope, bundle(), correlationId, archive)).rejects.toThrow();

    const failedRun = client.queries.find((query) => (
      query.text.startsWith('INSERT INTO odf.ingestion_runs') && query.text.includes("'failed'")
    ));
    expect(rawObjectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(failedRun?.text).toContain('raw_object_id');
    expect(failedRun?.values).toContain(rawObjectId);
  });
});
