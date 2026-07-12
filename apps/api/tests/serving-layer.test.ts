import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

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
import { FusionDatabase } from '../src/database.js';
import { GovernedObjectStore, ObjectTooLargeError } from '../src/object-store.js';
import { PlatformCatalog } from '../src/platform.js';

class TestIdentityProvider implements IdentityProvider {
  readonly mode = 'oidc' as const;

  async authenticate(incoming: Request): Promise<AuthenticatedIdentity> {
    const userId = incoming.header('x-test-user')?.trim();
    if (!userId) throw new AuthenticationError('Test identity is required');
    const requested = new Set((incoming.header('x-test-permissions') ?? '').split(/\s+/u).filter(Boolean));
    return {
      userId,
      displayName: userId,
      permissions: new Set(DATA_PLANE_PERMISSIONS.filter((permission) => requested.has(permission))),
    };
  }
}

function authorize(test: Test, userId: string, permissions: DataPlanePermission[], projectId = 'north-plant'): Test {
  return test
    .set('x-test-user', userId)
    .set('x-test-permissions', permissions.join(' '))
    .set('x-odf-tenant-id', 'demo')
    .set('x-odf-project-id', projectId);
}

describe('governed object serving layer', () => {
  let tempDirectory: string;
  let objectDirectory: string;
  let database: FusionDatabase;
  let app: Express;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-objects-'));
    objectDirectory = join(tempDirectory, 'objects');
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      objectStorePath: objectDirectory,
      objectStoreMaxBytes: 2_048,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  async function upload(objectId: string, content: string | Buffer, options: {
    mimeType?: string;
    fileName?: string;
    title?: string;
    userId?: string;
    permissions?: DataPlanePermission[];
    projectId?: string;
  } = {}) {
    return authorize(
      request(app).post(`/api/v1/platform/objects/${encodeURIComponent(objectId)}/versions`),
      options.userId ?? 'riley.chen',
      options.permissions ?? ['data:ingest'],
      options.projectId,
    )
      .set('content-type', options.mimeType ?? 'text/plain; charset=utf-8')
      .set('x-odf-file-name', options.fileName ?? `${objectId}.txt`)
      .set('x-odf-title', options.title ?? objectId)
      .send(content);
  }

  it('streams immutable versions with hashes, ETags, safe ranges, keyset metadata, and immutable audit', async () => {
    const firstContent = 'Pump P-101 centrifugal seal inspection note.';
    const firstHash = createHash('sha256').update(firstContent).digest('hex');
    const first = await upload('maintenance-note', firstContent, {
      fileName: 'maintenance-note.txt',
      title: 'Maintenance note',
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      object: { id: 'maintenance-note', currentVersion: 1, sha256: firstHash, etag: `"${firstHash}"`, textIndexed: true },
      version: { version: 1, sha256: firstHash },
    });

    const full = await authorize(
      request(app).get('/api/v1/platform/objects/maintenance-note/content'),
      'samantha.lee',
      ['data:read'],
    );
    expect(full.status).toBe(200);
    expect(full.text).toBe(firstContent);
    expect(full.headers.etag).toBe(`"${firstHash}"`);
    expect(full.headers['accept-ranges']).toBe('bytes');

    const notModified = await authorize(
      request(app).get('/api/v1/platform/objects/maintenance-note/content').set('if-none-match', `"${firstHash}"`),
      'samantha.lee',
      ['data:read'],
    );
    expect(notModified.status).toBe(304);

    const range = await authorize(
      request(app).get('/api/v1/platform/objects/maintenance-note/content').set('range', 'bytes=5-9'),
      'samantha.lee',
      ['data:read'],
    );
    expect(range.status).toBe(206);
    expect(range.text).toBe(firstContent.slice(5, 10));
    expect(range.headers['content-range']).toBe(`bytes 5-9/${Buffer.byteLength(firstContent)}`);

    const invalidRange = await authorize(
      request(app).get('/api/v1/platform/objects/maintenance-note/content').set('range', 'bytes=999-1000'),
      'samantha.lee',
      ['data:read'],
    );
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers['content-range']).toBe(`bytes */${Buffer.byteLength(firstContent)}`);

    const secondContent = 'Pump P-101 replacement seal work order.';
    const second = await upload('maintenance-note', secondContent, {
      fileName: 'maintenance-note-v2.txt',
      title: 'Maintenance note revision',
    });
    expect(second.body.object.currentVersion).toBe(2);

    const original = await authorize(
      request(app).get('/api/v1/platform/objects/maintenance-note/versions/1/content'),
      'samantha.lee',
      ['data:read'],
    );
    expect(original.text).toBe(firstContent);
    expect(() => database.database.prepare(`UPDATE governed_object_versions SET sha256=? WHERE object_id=? AND version=1`)
      .run('0'.repeat(64), 'maintenance-note')).toThrow('governed object versions are immutable');

    await upload('z-second-object', 'second object', { fileName: 'second.txt' });
    const firstPage = await authorize(
      request(app).get('/api/v1/platform/objects').query({ limit: 1 }),
      'samantha.lee',
      ['data:read'],
    );
    expect(firstPage.body.items).toHaveLength(1);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    const secondPage = await authorize(
      request(app).get('/api/v1/platform/objects').query({ limit: 1, cursor: firstPage.body.nextCursor }),
      'samantha.lee',
      ['data:read'],
    );
    expect(secondPage.body.items).toHaveLength(1);

    const events = await authorize(
      request(app).get('/api/v1/platform/objects/maintenance-note/events'),
      'samantha.lee',
      ['audit:read'],
    );
    expect(events.body.items.map((event: { type: string }) => event.type)).toEqual([
      'version.created', 'content.downloaded', 'content.downloaded', 'version.created', 'content.downloaded',
    ]);
    expect(() => database.database.prepare(`DELETE FROM governed_object_events WHERE object_id=?`).run('maintenance-note'))
      .toThrow('governed object audit events are immutable');

    const head = await authorize(
      request(app).head('/api/v1/platform/objects/maintenance-note/content'),
      'samantha.lee',
      ['data:read'],
    );
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(Buffer.byteLength(secondContent)));
    expect(head.body).toEqual({});
  });

  it('indexes only safe UTF-8 text and falls back cleanly when FTS5 is unavailable', async () => {
    await upload('searchable-note', 'Centrifugal cavitation investigation evidence AXQZ-771.', {
      fileName: 'investigation.txt',
      title: 'Pump investigation',
    });
    const indexed = await authorize(
      request(app).get('/api/v1/platform/search').query({ q: 'cavitation AXQZ' }),
      'samantha.lee',
      ['data:read'],
    );
    expect(indexed.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'governedObject', entityId: 'searchable-note' }),
    ]));

    await upload('active-content', '<script>EXECUTEME-ACTIVE-9981</script>', {
      mimeType: 'text/html',
      fileName: 'page.html',
      title: 'Uploaded page',
    });
    const activeSearch = await authorize(
      request(app).get('/api/v1/platform/search').query({ q: 'EXECUTEME-ACTIVE-9981' }),
      'samantha.lee',
      ['data:read'],
    );
    expect(activeSearch.body.items.find((item: { entityId: string }) => item.entityId === 'active-content')).toBeUndefined();

    const invalidUtf8 = await upload('invalid-utf8', Buffer.from([0xff, 0xfe, 0x41]), {
      mimeType: 'text/plain',
      fileName: 'invalid-utf8.txt',
      title: 'Invalid UTF-8 sample',
    });
    expect(invalidUtf8.body.object.textIndexed).toBe(false);

    database.database.exec('DROP TABLE IF EXISTS platform_search_fts');
    const fallback = await authorize(
      request(app).get('/api/v1/platform/search').query({ q: 'AXQZ-771' }),
      'samantha.lee',
      ['data:read'],
    );
    expect(fallback.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'governedObject', entityId: 'searchable-note' }),
    ]));
  });

  it('rejects traversal-shaped identifiers and metadata without writing outside the store', async () => {
    const traversalId = await upload('..escape', 'blocked');
    expect(traversalId.status).toBe(400);
    const traversalName = await upload('safe-id', 'blocked', { fileName: '../escape.txt' });
    expect(traversalName.status).toBe(400);
    expect(readdirSync(join(objectDirectory, '.tmp'))).toEqual([]);
    expect(readdirSync(objectDirectory).filter((name) => name !== '.tmp')).toEqual([]);
  });

  it('aborts oversized streaming writes, removes temp files, and leaves no metadata', async () => {
    const httpRejected = await upload('oversized-http', Buffer.alloc(2_049, 1), {
      mimeType: 'application/octet-stream',
      fileName: 'oversized-http.bin',
    });
    expect(httpRejected.status).toBe(413);
    expect(readdirSync(join(objectDirectory, '.tmp'))).toEqual([]);

    const smallRoot = join(tempDirectory, 'small-object-store');
    const store = new GovernedObjectStore(database.database, new PlatformCatalog(database.database), {
      rootPath: smallRoot,
      maxObjectBytes: 8,
    });
    await expect(store.upload(
      { tenantId: 'demo', projectId: 'north-plant' },
      'oversized-stream',
      { fileName: 'oversized.bin', title: 'Oversized', mimeType: 'application/octet-stream' },
      Readable.from([Buffer.alloc(5, 1), Buffer.alloc(5, 2)]),
      'riley.chen',
      'oversized-test',
    )).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(readdirSync(join(smallRoot, '.tmp'))).toEqual([]);
    expect(store.listObjects({ tenantId: 'demo', projectId: 'north-plant' }, { limit: 50 }).items).toEqual([]);
  });

  it('enforces verified permissions, project roles, and tenant/project isolation', async () => {
    const unauthenticated = await request(app)
      .post('/api/v1/platform/objects/denied/versions')
      .set('content-type', 'text/plain')
      .send('denied');
    expect(unauthenticated.status).toBe(401);

    const viewerWrite = await upload('viewer-denied', 'denied', {
      userId: 'samantha.lee',
      permissions: ['data:ingest'],
    });
    expect(viewerWrite.status).toBe(403);

    const project = await authorize(
      request(app).post('/api/v1/platform/tenants/demo/projects'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: 'south-plant', name: 'South Plant' });
    expect(project.status).toBe(201);
    expect((await upload('shared-object', 'north bytes', { projectId: 'north-plant' })).status).toBe(201);
    expect((await upload('shared-object', 'south bytes', { projectId: 'south-plant', userId: 'harper.dennis' })).status).toBe(201);

    const north = await authorize(
      request(app).get('/api/v1/platform/objects/shared-object/content'),
      'samantha.lee',
      ['data:read'],
      'north-plant',
    );
    const south = await authorize(
      request(app).get('/api/v1/platform/objects/shared-object/content'),
      'harper.dennis',
      ['data:read'],
      'south-plant',
    );
    expect(north.text).toBe('north bytes');
    expect(south.text).toBe('south bytes');

    const outsider = await authorize(
      request(app).get('/api/v1/platform/objects'),
      'riley.chen',
      ['data:read'],
      'south-plant',
    );
    expect(outsider.status).toBe(403);
    const missingReadPermission = await authorize(
      request(app).get('/api/v1/platform/objects'),
      'samantha.lee',
      ['data:ingest'],
    );
    expect(missingReadPermission.status).toBe(403);
  });
});

describe('time-series serving queries', () => {
  let tempDirectory: string;
  let database: FusionDatabase;
  let app: Express;

  beforeEach(async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-telemetry-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    app = createApp(database, undefined, { identityProvider: new TestIdentityProvider() });
    const ingested = await authorize(
      request(app).post('/api/v1/ingest/bundle'),
      'riley.chen',
      ['data:ingest'],
    ).send({
      source: { system: 'aggregation-test', runId: 'aggregation-run' },
      assets: [{ externalId: 'AGG-1', name: 'Aggregation asset', type: 'test' }],
      timeSeries: [{ externalId: 'AGG-1-VALUE', assetExternalId: 'AGG-1', name: 'Value', unit: 'bar' }],
      dataPoints: [
        { timeSeriesExternalId: 'AGG-1-VALUE', timestamp: '2026-01-01T00:00:00.000Z', value: 10, quality: 'good' },
        { timeSeriesExternalId: 'AGG-1-VALUE', timestamp: '2026-01-01T00:00:30.000Z', value: 20, quality: 'uncertain' },
        { timeSeriesExternalId: 'AGG-1-VALUE', timestamp: '2026-01-01T00:01:00.000Z', value: 30, quality: 'good' },
        { timeSeriesExternalId: 'AGG-1-VALUE', timestamp: '2026-01-01T00:01:30.000Z', value: 40, quality: 'bad' },
      ],
    });
    expect(ingested.status).toBe(201);
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('returns latest/as-of points and bounded bucket downsampling without changing raw telemetry', async () => {
    const latest = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry/latest').query({ timeSeriesExternalId: 'AGG-1-VALUE' }),
      'samantha.lee',
      ['data:read'],
    );
    expect(latest.status).toBe(200);
    expect(latest.body.series[0].point).toMatchObject({ value: 40, quality: 'bad', timestamp: '2026-01-01T00:01:30.000Z' });

    const asOf = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry/latest').query({
        timeSeriesExternalId: 'AGG-1-VALUE', at: '2026-01-01T00:01:10.000Z',
      }),
      'samantha.lee',
      ['data:read'],
    );
    expect(asOf.body.series[0].point.value).toBe(30);

    const buckets = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry/aggregate').query({
        timeSeriesExternalId: 'AGG-1-VALUE',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:01:59.999Z',
        bucketMs: 60_000,
        aggregation: 'avg',
      }),
      'samantha.lee',
      ['data:read'],
    );
    expect(buckets.status).toBe(200);
    expect(buckets.body.series[0].buckets).toEqual([
      expect.objectContaining({ timestamp: '2026-01-01T00:00:00.000Z', value: 15, count: 2, min: 10, max: 20, quality: 'uncertain' }),
      expect.objectContaining({ timestamp: '2026-01-01T00:01:00.000Z', value: 35, count: 2, min: 30, max: 40, quality: 'bad' }),
    ]);

    const bounded = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry/buckets').query({
        from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:01:59.999Z',
        bucketMs: 60_000, aggregation: 'max', limit: 1,
      }),
      'samantha.lee',
      ['data:read'],
    );
    expect(bounded.body.series[0].buckets).toEqual([
      expect.objectContaining({ timestamp: '2026-01-01T00:01:00.000Z', value: 40 }),
    ]);

    const legacy = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry').query({
        timeSeriesExternalId: 'AGG-1-VALUE',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T00:01:59.999Z',
      }),
      'samantha.lee',
      ['data:read'],
    );
    expect(legacy.status).toBe(200);
    expect(legacy.body.series[0].points).toHaveLength(4);
  });

  it('requires both verified read permission and project membership for new serving queries', async () => {
    const missingContext = await request(app)
      .get('/api/v1/assets/AGG-1/telemetry/latest')
      .set('x-test-user', 'samantha.lee')
      .set('x-test-permissions', 'data:read');
    expect(missingContext.status).toBe(400);

    const missingPermission = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry/latest'),
      'samantha.lee',
      ['data:ingest'],
    );
    expect(missingPermission.status).toBe(403);

    const outsider = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry/aggregate').query({ bucketMs: 60_000 }),
      'outside.user',
      ['data:read'],
    );
    expect(outsider.status).toBe(403);

    const project = await authorize(
      request(app).post('/api/v1/platform/tenants/demo/projects'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: 'isolated-telemetry-project', name: 'Isolated telemetry project' });
    expect(project.status).toBe(201);
    const crossProject = await authorize(
      request(app).get('/api/v1/assets/AGG-1/telemetry/latest'),
      'harper.dennis',
      ['data:read'],
      'isolated-telemetry-project',
    );
    expect(crossProject.status).toBe(404);
  });
});
