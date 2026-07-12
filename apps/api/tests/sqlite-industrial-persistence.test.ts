import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConflictError, DataIntegrityError, FusionDatabase, NotFoundError } from '../src/database.js';
import type { IndustrialRequestScope } from '../src/industrial-persistence.js';
import type { IngestBundle } from '../src/schemas.js';
import { SqliteIndustrialPersistence } from '../src/sqlite-industrial-persistence.js';

const minute = 60_000;
const firstTimestamp = Date.UTC(2026, 6, 12, 0, 0, 10);

const alphaScope: IndustrialRequestScope = {
  tenantId: 'tenant-shared',
  projectId: 'project-alpha',
  userId: 'alpha.owner',
};

const betaScope: IndustrialRequestScope = {
  tenantId: 'tenant-shared',
  projectId: 'project-beta',
  userId: 'beta.owner',
};

function bundle(name: string, values: [number, number, number] = [10, 20, 30]): IngestBundle {
  return {
    source: { system: 'plant-connector', runId: 'shared-run', actor: 'ingest.user' },
    assets: [{
      externalId: 'SHARED-ASSET',
      name,
      type: 'Pump',
      description: `${name} description`,
      metadata: { site: name },
    }],
    timeSeries: [{
      externalId: 'SHARED-SERIES',
      assetExternalId: 'SHARED-ASSET',
      name: 'Pressure',
      unit: 'bar',
      description: 'Discharge pressure',
      metadata: { interval: '30s' },
    }],
    dataPoints: [
      { timeSeriesExternalId: 'SHARED-SERIES', timestamp: firstTimestamp, value: values[0], quality: 'good' },
      { timeSeriesExternalId: 'SHARED-SERIES', timestamp: firstTimestamp + 30_000, value: values[1], quality: 'uncertain' },
      { timeSeriesExternalId: 'SHARED-SERIES', timestamp: firstTimestamp + minute, value: values[2], quality: 'good' },
    ],
    documents: [{
      externalId: 'SHARED-DOCUMENT',
      assetExternalId: 'SHARED-ASSET',
      title: `${name} manual`,
      mimeType: 'application/pdf',
      uri: `s3://manuals/${name}.pdf`,
      metadata: { language: 'en' },
    }],
    relations: [{
      id: 'SHARED-RELATION',
      sourceType: 'asset',
      sourceExternalId: 'SHARED-ASSET',
      targetType: 'document',
      targetExternalId: 'SHARED-DOCUMENT',
      relationType: 'documented-by',
      status: 'proposed',
      confidence: 0.95,
      evidence: { rule: 'asset-manual' },
      ruleVersion: '1',
    }],
  };
}

describe('tenant/project-scoped SQLite industrial persistence', () => {
  let fusion: FusionDatabase;
  let persistence: SqliteIndustrialPersistence;

  beforeEach(() => {
    fusion = new FusionDatabase({ path: ':memory:', seed: false });
    persistence = new SqliteIndustrialPersistence(fusion.database);
  });

  afterEach(() => {
    fusion.close();
  });

  it('serves real scoped assets, telemetry, relations, provenance, raw metadata, and audit without touching legacy tables', async () => {
    await expect(persistence.authorize(alphaScope, ['owner'])).resolves.toBeUndefined();
    await expect(persistence.health()).resolves.toMatchObject({ status: 'ok', mode: 'sqlite' });

    await expect(persistence.ingest(alphaScope, bundle('Alpha'), 'alpha-ingest', {
      storageUri: 'file:///raw/alpha.json',
      sha256: 'a'.repeat(64),
      byteSize: 1_024,
      contentType: 'application/json',
    })).resolves.toMatchObject({
      runId: 'shared-run',
      status: 'completed',
      counts: { assets: 1, timeSeries: 1, dataPoints: 3, documents: 1, relations: 1 },
    });
    await persistence.ingest(betaScope, bundle('Beta', [100, 200, 300]), 'beta-ingest');

    const legacyAssets = fusion.database.prepare('SELECT COUNT(*) AS count FROM assets').get() as { count: number };
    expect(legacyAssets.count).toBe(0);

    await expect(persistence.listAssets(alphaScope, { limit: 50, offset: 0 })).resolves.toMatchObject({
      total: 1,
      items: [{ externalId: 'SHARED-ASSET', name: 'Alpha', metadata: { site: 'Alpha' } }],
    });
    await expect(persistence.listAssets(betaScope, { limit: 50, offset: 0 })).resolves.toMatchObject({
      total: 1,
      items: [{ externalId: 'SHARED-ASSET', name: 'Beta', metadata: { site: 'Beta' } }],
    });

    const detail = await persistence.getAsset(alphaScope, 'SHARED-ASSET');
    expect(detail).toMatchObject({
      asset: { externalId: 'SHARED-ASSET', name: 'Alpha' },
      parent: null,
      children: [],
      timeSeries: [{ externalId: 'SHARED-SERIES', unit: 'bar' }],
      documents: [{ externalId: 'SHARED-DOCUMENT', title: 'Alpha manual' }],
      relations: [{ id: 'SHARED-RELATION', status: 'proposed' }],
      provenance: [{ id: 1, ingestionRunId: 'shared-run', entityType: 'asset' }],
    });

    const raw = await persistence.getTelemetry(alphaScope, 'SHARED-ASSET', {
      from: firstTimestamp,
      to: firstTimestamp + 2 * minute,
      limit: 100,
    });
    expect(raw).toMatchObject({
      assetExternalId: 'SHARED-ASSET',
      series: [{
        externalId: 'SHARED-SERIES',
        points: [{ value: 10 }, { value: 20, quality: 'uncertain' }, { value: 30 }],
      }],
    });

    const latest = await persistence.getLatestTelemetry(alphaScope, 'SHARED-ASSET', {
      timeSeriesExternalId: 'SHARED-SERIES',
      at: firstTimestamp + 45_000,
    });
    expect(latest).toMatchObject({
      series: [{ point: { value: 20, quality: 'uncertain' }, points: [{ value: 20 }] }],
    });

    const aggregate = await persistence.getAggregatedTelemetry(alphaScope, 'SHARED-ASSET', {
      from: firstTimestamp - 10_000,
      to: firstTimestamp + 2 * minute,
      bucketMs: minute,
      aggregation: 'sum',
      limit: 100,
    });
    expect(aggregate).toMatchObject({
      bucketMs: minute,
      aggregation: 'sum',
      series: [{
        buckets: [
          { value: 30, count: 2, min: 10, max: 20, quality: 'uncertain' },
          { value: 30, count: 1, min: 30, max: 30, quality: 'good' },
        ],
      }],
    });

    const betaLatest = await persistence.getLatestTelemetry(betaScope, 'SHARED-ASSET', {});
    expect(betaLatest).toMatchObject({ series: [{ point: { value: 300 } }] });

    await expect(persistence.reviewRelation(alphaScope, 'SHARED-RELATION', {
      decision: 'accepted',
      reviewer: 'alpha.reviewer',
      comment: 'Verified against the manual',
    }, 'alpha-review')).resolves.toMatchObject({
      id: 'SHARED-RELATION',
      status: 'accepted',
      reviewer: 'alpha.reviewer',
    });
    await expect(persistence.listRelations(betaScope, undefined, 50)).resolves.toMatchObject({
      items: [{ id: 'SHARED-RELATION', status: 'proposed', reviewer: null }],
    });

    const alphaAudit = await persistence.listAudit(alphaScope, { limit: 50, offset: 0 });
    expect(alphaAudit).toMatchObject({ total: 2 });
    expect((alphaAudit.items as Array<Record<string, unknown>>).map((item) => item.action)).toEqual([
      'relation.accepted',
      'ingestion.completed',
    ]);
    await expect(persistence.listAudit(betaScope, { limit: 50, offset: 0 })).resolves.toMatchObject({
      total: 1,
      items: [{ id: 1, action: 'ingestion.completed', correlationId: 'beta-ingest' }],
    });

    const archive = fusion.database.prepare(`
      SELECT raw_storage_uri, raw_sha256, raw_byte_size, raw_content_type
      FROM industrial_ingestion_runs
      WHERE tenant_id = ? AND project_id = ? AND run_id = ?
    `).get(alphaScope.tenantId, alphaScope.projectId, 'shared-run');
    expect(archive).toEqual({
      raw_storage_uri: 'file:///raw/alpha.json',
      raw_sha256: 'a'.repeat(64),
      raw_byte_size: 1_024,
      raw_content_type: 'application/json',
    });
  });

  it('is idempotent per scope and rejects reuse of a completed run with a different payload', async () => {
    const original = bundle('Original');
    await persistence.ingest(alphaScope, original, 'first-correlation');

    await expect(persistence.ingest(alphaScope, original, 'retry-correlation')).resolves.toEqual({
      runId: 'shared-run',
      status: 'already_processed',
      counts: { assets: 1, timeSeries: 1, dataPoints: 3, documents: 1, relations: 1 },
    });
    await expect(persistence.ingest(alphaScope, bundle('Changed'), 'conflicting-correlation'))
      .rejects.toThrow(ConflictError);

    await expect(persistence.getAsset(alphaScope, 'SHARED-ASSET')).resolves.toMatchObject({
      asset: { name: 'Original' },
      provenance: [{ id: 1 }],
    });
    await expect(persistence.listAudit(alphaScope, { limit: 50, offset: 0 })).resolves.toMatchObject({
      total: 1,
      items: [{ correlationId: 'first-correlation' }],
    });
  });

  it('derives a stable content idempotency key when source.runId is omitted', async () => {
    const withoutRunId = bundle('No explicit run');
    delete withoutRunId.source.runId;

    const first = await persistence.ingest(alphaScope, withoutRunId, 'content-first');
    const retry = await persistence.ingest(alphaScope, structuredClone(withoutRunId), 'content-retry');

    expect(first).toMatchObject({ status: 'completed', runId: expect.stringMatching(/^content-[a-f0-9]{64}$/) });
    expect(retry).toMatchObject({ status: 'already_processed', runId: first.runId });
    await expect(persistence.listAudit(alphaScope, { limit: 10, offset: 0 })).resolves.toMatchObject({ total: 1 });
  });

  it('keeps telemetry observations immutable across distinct ingestion runs', async () => {
    const original = bundle('Original');
    await persistence.ingest(alphaScope, original, 'first-correlation');
    const correction = bundle('Original');
    correction.source.runId = 'correction-run';
    correction.dataPoints = [{
      ...correction.dataPoints[0]!,
      value: 999,
    }];

    await expect(persistence.ingest(alphaScope, correction, 'correction-correlation'))
      .rejects.toThrow('An immutable telemetry point already exists with a different value');
    await expect(persistence.getLatestTelemetry(alphaScope, 'SHARED-ASSET', {
      timeSeriesExternalId: 'SHARED-SERIES',
      at: firstTimestamp,
    })).resolves.toMatchObject({ series: [{ point: { value: 10 } }] });
  });

  it('freezes reviewed relation evidence against later connector ingests', async () => {
    const original = bundle('Original');
    await persistence.ingest(alphaScope, original, 'first-correlation');
    await persistence.reviewRelation(alphaScope, 'SHARED-RELATION', {
      decision: 'accepted',
      reviewer: 'alpha.reviewer',
      comment: 'Reviewed evidence',
    }, 'review-correlation');

    const rewrite = bundle('Original');
    rewrite.source.runId = 'relation-rewrite';
    rewrite.relations = [{
      ...rewrite.relations[0]!,
      confidence: 0.01,
      evidence: { forged: true },
    }];
    await expect(persistence.ingest(alphaScope, rewrite, 'rewrite-correlation'))
      .rejects.toThrow("cannot transition from accepted to proposed");
    await expect(persistence.listRelations(alphaScope, 'accepted', 10)).resolves.toMatchObject({
      items: [{
        id: 'SHARED-RELATION',
        confidence: 0.95,
        evidence: { rule: 'asset-manual' },
        reviewer: 'alpha.reviewer',
        reviewComment: 'Reviewed evidence',
      }],
    });
  });

  it('enforces the shared entity namespace for direct adapter callers', async () => {
    const original = bundle('Original');
    original.timeSeries = [];
    original.dataPoints = [];
    original.documents = [];
    original.relations = [];
    await persistence.ingest(alphaScope, original, 'namespace-first');

    const conflicting: IngestBundle = {
      source: { system: 'plant-connector', runId: 'namespace-conflict', actor: 'ingest.user' },
      assets: [], timeSeries: [], dataPoints: [], relations: [],
      documents: [{ externalId: 'SHARED-ASSET', title: 'Wrong type', metadata: {} }],
    };

    await expect(persistence.ingest(alphaScope, conflicting, 'namespace-second'))
      .rejects.toThrow('shared entity namespace');
  });

  it('rejects unsafe direct timestamps and self relations before persistence', async () => {
    const unsafeTimestamp = bundle('Unsafe timestamp');
    unsafeTimestamp.source.runId = 'unsafe-timestamp';
    unsafeTimestamp.dataPoints[0] = { ...unsafeTimestamp.dataPoints[0]!, timestamp: firstTimestamp + 0.5 };
    await expect(persistence.ingest(alphaScope, unsafeTimestamp, 'unsafe-timestamp-correlation'))
      .rejects.toThrow('integer epoch milliseconds');

    const selfRelation = bundle('Self relation');
    selfRelation.source.runId = 'self-relation';
    selfRelation.documents = [];
    selfRelation.relations = [{
      id: 'SELF', sourceType: 'asset', sourceExternalId: 'SHARED-ASSET',
      targetType: 'asset', targetExternalId: 'SHARED-ASSET', relationType: 'self',
      status: 'proposed', evidence: {},
    }];
    await expect(persistence.ingest(alphaScope, selfRelation, 'self-relation-correlation'))
      .rejects.toThrow('must be different entities');
  });

  it('does not silently rename an existing semantic relation and defaults confidence to zero', async () => {
    const first = bundle('Relation identity');
    first.source.runId = 'relation-identity-a';
    delete first.relations[0]!.confidence;
    await persistence.ingest(alphaScope, first, 'relation-identity-a-correlation');
    await expect(persistence.listRelations(alphaScope, 'proposed', 10)).resolves.toMatchObject({
      items: [{ id: 'SHARED-RELATION', confidence: 0 }],
    });

    const second = bundle('Relation identity');
    second.source.runId = 'relation-identity-b';
    second.relations[0] = { ...second.relations[0]!, id: 'DIFFERENT-RELATION-ID' };
    await expect(persistence.ingest(alphaScope, second, 'relation-identity-b-correlation'))
      .rejects.toThrow("conflicts with existing relation 'SHARED-RELATION'");
  });

  it('rolls back a failed bundle atomically and records only a scoped failure', async () => {
    const invalid: IngestBundle = {
      source: { system: 'plant-connector', runId: 'failed-run', actor: 'ingest.user' },
      assets: [{ externalId: 'ROLLED-BACK', name: 'Temporary', type: 'Pump', metadata: {} }],
      timeSeries: [{
        externalId: 'INVALID-SERIES',
        assetExternalId: 'MISSING-ASSET',
        name: 'Invalid',
        metadata: {},
      }],
      dataPoints: [],
      documents: [],
      relations: [],
    };

    await expect(persistence.ingest(alphaScope, invalid, 'failed-correlation')).rejects.toThrow(DataIntegrityError);
    await expect(persistence.getAsset(alphaScope, 'ROLLED-BACK')).rejects.toThrow(NotFoundError);
    await expect(persistence.listAssets(alphaScope, { limit: 50, offset: 0 })).resolves.toMatchObject({ total: 0 });
    await expect(persistence.listAudit(alphaScope, {
      action: 'ingestion.failed',
      limit: 50,
      offset: 0,
    })).resolves.toMatchObject({
      total: 1,
      items: [{
        action: 'ingestion.failed',
        entityId: 'failed-run',
        correlationId: 'failed-correlation',
      }],
    });
    await expect(persistence.listAudit(betaScope, { limit: 50, offset: 0 })).resolves.toMatchObject({ total: 0 });

    const run = fusion.database.prepare(`
      SELECT status, error_message FROM industrial_ingestion_runs
      WHERE tenant_id = ? AND project_id = ? AND run_id = ?
    `).get(alphaScope.tenantId, alphaScope.projectId, 'failed-run') as Record<string, unknown>;
    expect(run.status).toBe('failed');
    expect(run.error_message).toContain("asset 'MISSING-ASSET'");
  });

  it('declares composite scoped primary and foreign keys', () => {
    const primaryKey = fusion.database.prepare("PRAGMA table_info('industrial_assets')").all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(primaryKey.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name))
      .toEqual(['tenant_id', 'project_id', 'external_id']);

    const foreignKey = fusion.database.prepare("PRAGMA foreign_key_list('industrial_time_series')").all() as Array<{
      from: string;
      to: string;
    }>;
    expect(foreignKey.map((column) => [column.from, column.to])).toEqual(expect.arrayContaining([
      ['tenant_id', 'tenant_id'],
      ['project_id', 'project_id'],
      ['asset_external_id', 'external_id'],
    ]));
  });
});
