import {
  PostgresRuntime,
  type RuntimeClient,
  type RuntimePool,
  type SqlQuery,
  type SqlQueryResult,
} from '@open-data-fusion/postgres-runtime';
import { describe, expect, it, vi } from 'vitest';

import { PostgresPlatformCompatibilityStore } from '../src/postgres-platform-compatibility.js';

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

const scope = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  projectId: '22222222-2222-2222-2222-222222222222',
  userId: 'operator@example.test',
};
const correlationId = '33333333-3333-4333-8333-333333333333';

function compatibility(handler: QueryHandler) {
  const authorize = vi.fn(async () => ({ role: 'owner' as const }));
  const client = new RecordingClient(handler);
  const runtime = PostgresRuntime.fromPool(new RecordingPool(client), {}, {
    projectAccessResolver: { resolve: authorize },
  });
  return {
    store: new PostgresPlatformCompatibilityStore(runtime, {
      enabled: true,
      allowedOperations: ['setpoint.update'],
      maximumRisk: 'high',
      requireDryRun: true,
    }),
    client,
    authorize,
  };
}

describe('PostgresPlatformCompatibilityStore', () => {
  it('attests every compatibility table and write capability before the PostgreSQL server starts', async () => {
    const { store, client } = compatibility((query) => (
      query.text.includes("to_regclass('odf.platform_legacy_model_versions')")
        ? result([{ ready: true }])
        : result()
    ));

    await expect(store.assertReady()).resolves.toBeUndefined();
    const readiness = client.queries.find((query) => query.text.includes("to_regclass('odf.platform_legacy_model_versions')"));
    expect(readiness?.text).toContain("odf.platform_legacy_writeback_events");
    expect(readiness?.text).toContain("odf.platform_legacy_quality_results', 'INSERT'");
    expect(readiness?.text).toContain("odf.platform_legacy_context_candidates', 'UPDATE'");
    expect(readiness?.text).toContain("odf.model_spaces', 'SELECT'");
    expect(readiness?.text).toContain("odf.data_models', 'INSERT'");
  });

  it('uses a scoped PostgreSQL transaction for model versions and preserves the legacy cursor shape', async () => {
    const modelRow = {
      tenant_id: scope.tenantId,
      project_id: scope.projectId,
      model_id: 'pump-model',
      version: 2,
      name: 'Pump model',
      schema_json: { type: 'object' },
      status: 'published',
      created_by: 'modeler@example.test',
      created_at: '2026-07-12T00:00:00.000Z',
    };
    const { store, client, authorize } = compatibility((query) => (
      query.text.includes('FROM odf.platform_legacy_model_versions') ? result([modelRow]) : result()
    ));

    await expect(store.listDataModels(scope, scope.userId, { limit: 50 })).resolves.toEqual({
      items: [{
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        id: 'pump-model',
        version: 2,
        name: 'Pump model',
        schema: { type: 'object' },
        status: 'published',
        createdBy: 'modeler@example.test',
        createdAt: '2026-07-12T00:00:00.000Z',
      }],
      nextCursor: null,
    });
    expect(authorize).toHaveBeenCalledWith(scope);
    const modelQuery = client.queries.find((query) => query.text.includes('FROM odf.platform_legacy_model_versions'));
    expect(modelQuery?.values).toEqual([scope.tenantId, scope.projectId, '', 0, 51]);
    expect(modelQuery?.text).toContain('tenant_id = $1::uuid AND project_id = $2::uuid');
    expect(modelQuery?.text).not.toContain(scope.tenantId);
  });

  it('writes new compatibility model versions into the normalized model graph in the same transaction', async () => {
    const createdAt = '2026-07-12T00:00:00.000Z';
    const spaceId = '44444444-4444-4444-8444-444444444444';
    const modelRow = {
      tenant_id: scope.tenantId,
      project_id: scope.projectId,
      model_id: 'pump-model',
      version: 2,
      name: 'Pump model',
      schema_json: { type: 'object' },
      status: 'published',
      created_by: scope.userId,
      created_at: createdAt,
    };
    const { store, client } = compatibility((query) => {
      if (query.text.includes('FROM odf.model_spaces')) return result([{ space_id: spaceId }]);
      if (query.text.includes('SELECT COALESCE(max(version), 0) + 1')) return result([{ version: 2 }]);
      if (query.text.includes('INSERT INTO odf.platform_legacy_model_versions')) return result([modelRow]);
      if (query.text.includes('INSERT INTO odf.data_models')) return result([{ data_model_id: '55555555-5555-4555-8555-555555555555' }]);
      return result();
    });

    await expect(store.createDataModelVersion(
      scope,
      scope.userId,
      'pump-model',
      { name: 'Pump model', schema: { type: 'object' }, status: 'published' },
      correlationId,
    )).resolves.toMatchObject({
      id: 'pump-model',
      version: 2,
      status: 'published',
    });

    const legacyIndex = client.queries.findIndex((query) => query.text.includes('INSERT INTO odf.platform_legacy_model_versions'));
    const normalizedIndex = client.queries.findIndex((query) => query.text.includes('INSERT INTO odf.data_models'));
    expect(legacyIndex).toBeGreaterThan(-1);
    expect(normalizedIndex).toBeGreaterThan(legacyIndex);
    expect(client.queries[normalizedIndex]?.values).toEqual([
      scope.tenantId,
      scope.projectId,
      spaceId,
      'pump-model',
      '2',
      'Pump model',
      '{"type":"object"}',
      'published',
      scope.userId,
      createdAt,
    ]);
    expect(client.queries.map((query) => query.text)).toContain('COMMIT');
  });

  it('records a pipeline run as processing before atomically completing it with quality results', async () => {
    const startedAt = '2026-07-12T01:00:00.000Z';
    const completedAt = '2026-07-12T01:01:00.000Z';
    const { store, client } = compatibility((query) => {
      if (query.text.includes('SELECT pipeline_id, version, enabled')) {
        return result([{ pipeline_id: 'normalize-telemetry', version: 1, enabled: true }]);
      }
      if (query.text.includes('FROM odf.platform_legacy_pipeline_runs') && query.text.includes('idempotency_key = $4')) return result();
      if (query.text.includes('INSERT INTO odf.platform_legacy_pipeline_runs')) {
        return result([{
          tenant_id: scope.tenantId,
          project_id: scope.projectId,
          run_id: 'run-1',
          pipeline_id: 'normalize-telemetry',
          idempotency_key: 'retry-1',
          input_hash: 'a'.repeat(64),
          input_json: { process: { temperature: 65 } },
          status: 'processing',
          result_json: {},
          triggered_by: scope.userId,
          started_at: startedAt,
          completed_at: null,
        }]);
      }
      if (query.text.includes('FROM odf.platform_legacy_quality_rules')) {
        return result([{
          rule_id: 'nested-temperature-minimum',
          check_json: { operator: 'gte', field: 'process.temperature', value: 60 },
        }]);
      }
      if (query.text.includes('INSERT INTO odf.platform_legacy_quality_results')) {
        return result([{ result_id: 1, evaluated_at: completedAt }]);
      }
      if (query.text.includes("UPDATE odf.platform_legacy_pipeline_runs\n          SET status = 'completed'")) {
        return result([{
          tenant_id: scope.tenantId,
          project_id: scope.projectId,
          run_id: 'run-1',
          pipeline_id: 'normalize-telemetry',
          idempotency_key: 'retry-1',
          input_hash: 'a'.repeat(64),
          input_json: { process: { temperature: 65 } },
          status: 'completed',
          result_json: { fingerprint: 'a'.repeat(64), quality: { total: 1, passed: 1, failed: 0 } },
          triggered_by: scope.userId,
          started_at: startedAt,
          completed_at: completedAt,
        }]);
      }
      return result();
    });

    const run = await store.triggerPipelineRun(scope, scope.userId, 'normalize-telemetry', {
      idempotencyKey: 'retry-1',
      input: { process: { temperature: 65 } },
    }, correlationId);

    expect(run).toMatchObject({
      id: 'run-1',
      pipelineId: 'normalize-telemetry',
      idempotencyKey: 'retry-1',
      status: 'completed',
      replayed: false,
      result: { quality: { total: 1, passed: 1, failed: 0 } },
    });
    const inserted = client.queries.find((query) => query.text.includes('INSERT INTO odf.platform_legacy_pipeline_runs'));
    expect(inserted?.text).toContain("'processing'");
    expect(inserted?.values?.at(-1)).toBe(scope.userId);
    const completed = client.queries.find((query) => query.text.includes("SET status = 'completed'"));
    expect(completed?.values?.slice(0, 3)).toEqual([scope.tenantId, scope.projectId, expect.any(String)]);
    const qualityResult = client.queries.find((query) => query.text.includes('INSERT INTO odf.platform_legacy_quality_results'));
    expect(JSON.parse(String(qualityResult?.values?.[5]))).toEqual({ actual: 65 });
  });
});
