import { describe, expect, it } from 'vitest';

import { ingestBundleSchema, workspaceCreateSchema } from '../src/schemas.js';

function minimalBundle(): Record<string, unknown> {
  return {
    source: { system: 'schema-test', actor: 'connector' },
    assets: [{ externalId: 'A-1', name: 'Asset', type: 'pump' }],
    timeSeries: [{ externalId: 'TS-1', assetExternalId: 'A-1', name: 'Pressure' }],
    dataPoints: [{ timeSeriesExternalId: 'TS-1', timestamp: 1_784_000_000_000, value: 10 }],
    documents: [],
    relations: [],
  };
}

describe('industrial ingest contract validation', () => {
  it('normalizes ISO timestamps and accepts an omitted relation confidence', () => {
    const input = minimalBundle();
    input.dataPoints = [{ timeSeriesExternalId: 'TS-1', timestamp: '2026-07-12T00:00:00.000Z', value: 10 }];
    input.relations = [{
      sourceType: 'asset', sourceExternalId: 'A-1', targetType: 'timeSeries',
      targetExternalId: 'TS-1', relationType: 'measures', evidence: {},
    }];

    const parsed = ingestBundleSchema.parse(input);

    expect(parsed.dataPoints[0]?.timestamp).toBe(Date.parse('2026-07-12T00:00:00.000Z'));
    expect(parsed.relations[0]?.confidence).toBeUndefined();
  });

  it.each([
    ['fractional timestamp', (input: Record<string, unknown>) => {
      input.dataPoints = [{ timeSeriesExternalId: 'TS-1', timestamp: 1_784_000_000_000.5, value: 10 }];
    }],
    ['shared external ID used by two entity types', (input: Record<string, unknown>) => {
      input.documents = [{ externalId: 'A-1', title: 'Conflicting document' }];
    }],
    ['duplicate telemetry observation', (input: Record<string, unknown>) => {
      const point = { timeSeriesExternalId: 'TS-1', timestamp: 1_784_000_000_000, value: 10 };
      input.dataPoints = [point, { ...point }];
    }],
    ['self relation', (input: Record<string, unknown>) => {
      input.relations = [{
        sourceType: 'asset', sourceExternalId: 'A-1', targetType: 'asset',
        targetExternalId: 'A-1', relationType: 'self', evidence: {},
      }];
    }],
    ['duplicate semantic relation', (input: Record<string, unknown>) => {
      const relation = {
        sourceType: 'asset', sourceExternalId: 'A-1', targetType: 'timeSeries',
        targetExternalId: 'TS-1', relationType: 'measures', evidence: {},
      };
      input.relations = [relation, { ...relation, id: 'another-id' }];
    }],
  ])('rejects %s', (_label, mutate) => {
    const input = minimalBundle();
    mutate(input);
    expect(ingestBundleSchema.safeParse(input).success).toBe(false);
  });
});

describe('workspace bootstrap contract validation', () => {
  it('rejects control characters consistently before either database adapter runs', () => {
    expect(workspaceCreateSchema.safeParse({ id: 'valid-id', name: 'Line one\nLine two' }).success).toBe(false);
    expect(workspaceCreateSchema.safeParse({ id: 'valid-id', name: 'Operations Canvas' }).success).toBe(true);
  });
});
