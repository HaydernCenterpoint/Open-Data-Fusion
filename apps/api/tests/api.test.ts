import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { DevelopmentIdentityProvider } from '../src/auth.js';
import { WorkspaceEventHub } from '../src/collaboration.js';
import { FusionDatabase } from '../src/database.js';
import { LegacySqliteIndustrialPersistence } from '../src/industrial-persistence.js';
import { InMemorySharedEventDelivery } from '../src/shared-event-delivery.js';

class DegradedRedisDelivery extends InMemorySharedEventDelivery {
  override readonly mode = 'redis' as const;

  override health() {
    return { status: 'degraded' as const, mode: 'redis' as const };
  }
}

describe('Open Data Fusion API vertical slice', () => {
  let tempDirectory: string;
  let database: FusionDatabase;
  let app: Express;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-api-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    app = createApp(database, undefined, {
      identityProvider: new DevelopmentIdentityProvider('harper.dennis'),
      defaultPlatformContext: { tenantId: 'demo', projectId: 'north-plant' },
      industrialPersistence: new LegacySqliteIndustrialPersistence(database),
    });
    const member = database.database.prepare(`
      INSERT OR IGNORE INTO platform_project_members(tenant_id, project_id, user_id, role, created_at)
      VALUES ('demo', 'north-plant', ?, 'reviewer', ?)
    `);
    member.run('domain.expert@example.com', new Date().toISOString());
    member.run('another.reviewer@example.com', new Date().toISOString());
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('reports health with a correlation id', async () => {
    const response = await request(app).get('/health').set('x-correlation-id', 'health-test');

    expect(response.status).toBe(200);
    expect(response.headers['x-correlation-id']).toBe('health-test');
    expect(response.body).toMatchObject({ status: 'ok', service: 'open-data-fusion-api', schemaVersion: '3' });
  });

  it('fails readiness when a required shared event transport degrades', async () => {
    const requiredApp = createApp(
      database,
      new WorkspaceEventHub(new DegradedRedisDelivery()),
      { sharedEventsRequired: true },
    );

    const health = await request(requiredApp).get('/health');
    const ready = await request(requiredApp).get('/ready');

    expect(health.status).toBe(200);
    expect(health.body.sharedEventDelivery).toEqual({ status: 'degraded', mode: 'redis' });
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({
      readiness: 'not_ready',
      sharedEventDelivery: { status: 'degraded', mode: 'redis' },
    });
  });

  it('lists and searches the seeded asset hierarchy', async () => {
    const response = await request(app).get('/api/v1/assets').query({ q: 'P-101', limit: 10 });

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({ externalId: 'P-101', parentExternalId: 'AREA-A', type: 'Pump' });
  });

  it('returns an asset with context, documents, relations, and provenance', async () => {
    const response = await request(app).get('/api/v1/assets/P-101');

    expect(response.status).toBe(200);
    expect(response.body.asset.externalId).toBe('P-101');
    expect(response.body.parent.externalId).toBe('AREA-A');
    expect(response.body.timeSeries).toHaveLength(2);
    expect(response.body.documents[0].externalId).toBe('DOC-P101-MANUAL');
    expect(response.body.relations.some((relation: { id: string }) => relation.id === 'rel-p101-manual')).toBe(true);
    expect(response.body.provenance[0]).toMatchObject({ entityType: 'asset', entityId: 'P-101' });
  });

  it('returns time-ordered telemetry for an asset', async () => {
    const response = await request(app)
      .get('/api/v1/assets/P-101/telemetry')
      .query({ timeSeriesExternalId: 'P-101-PRESSURE', limit: 5 });

    expect(response.status).toBe(200);
    expect(response.body.series).toHaveLength(1);
    expect(response.body.series[0]).toMatchObject({ externalId: 'P-101-PRESSURE', unit: 'psi' });
    expect(response.body.series[0].points).toHaveLength(5);
    const timestamps = response.body.series[0].points.map((point: { timestamp: string }) => Date.parse(point.timestamp));
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
  });

  it('ingests a contextualized bundle atomically and makes retries idempotent', async () => {
    const timestamp = Date.now();
    const bundle = {
      source: { system: 'test-opcua', runId: 'test-run-001', actor: 'integration-test' },
      assets: [
        {
          externalId: 'M-201',
          name: 'Motor M-201',
          type: 'Motor',
          parentExternalId: 'AREA-A',
          metadata: { voltage: 400 },
        },
      ],
      timeSeries: [
        {
          externalId: 'M-201-SPEED',
          assetExternalId: 'M-201',
          name: 'M-201 speed',
          unit: 'rpm',
        },
      ],
      dataPoints: [
        {
          timeSeriesExternalId: 'M-201-SPEED',
          timestamp,
          value: 1_487.5,
          quality: 'good',
        },
      ],
      documents: [
        {
          externalId: 'DOC-M201-DATASHEET',
          assetExternalId: 'M-201',
          title: 'M-201 Data Sheet',
          mimeType: 'application/pdf',
        },
      ],
      relations: [
        {
          id: 'rel-m201-datasheet',
          sourceType: 'asset',
          sourceExternalId: 'M-201',
          targetType: 'document',
          targetExternalId: 'DOC-M201-DATASHEET',
          relationType: 'hasDocument',
          confidence: 0.91,
          evidence: { matchedTag: 'M-201' },
        },
      ],
    };

    const first = await request(app).post('/api/v1/ingest/bundle').send(bundle);
    const retry = await request(app).post('/api/v1/ingest/bundle').send(bundle);

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ runId: 'test-run-001', status: 'completed' });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('already_processed');

    const asset = await request(app).get('/api/v1/assets/M-201');
    expect(asset.status).toBe(200);
    expect(asset.body.asset.metadata.voltage).toBe(400);
    expect(asset.body.provenance[0].ingestionRunId).toBe('test-run-001');

    const telemetry = await request(app)
      .get('/api/v1/assets/M-201/telemetry')
      .query({ from: new Date(timestamp - 1_000).toISOString(), to: new Date(timestamp + 1_000).toISOString() });
    expect(telemetry.body.series[0].points[0].value).toBe(1_487.5);
  });

  it('rolls back an invalid relational bundle and records the failed run', async () => {
    const response = await request(app)
      .post('/api/v1/ingest/bundle')
      .set('x-correlation-id', 'failed-ingest-test')
      .send({
        source: { system: 'test-context-engine', runId: 'test-run-invalid', actor: 'integration-test' },
        relations: [
          {
            sourceType: 'asset',
            sourceExternalId: 'P-101',
            targetType: 'document',
            targetExternalId: 'DOES-NOT-EXIST',
            relationType: 'hasDocument',
          },
        ],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('data_integrity_error');

    const audit = await request(app).get('/api/v1/audit').query({ action: 'ingestion.failed' });
    expect(audit.body.total).toBe(1);
    expect(audit.body.items[0]).toMatchObject({ entityId: 'test-run-invalid', correlationId: 'failed-ingest-test' });
  });

  it('reviews a proposed relation once and exposes the audit event', async () => {
    const response = await request(app)
      .post('/api/v1/relations/rel-p101-manual/review')
      .set('x-odf-user', 'domain.expert@example.com')
      .set('x-correlation-id', 'review-test')
      .send({ decision: 'accepted', reviewer: 'forged.reviewer@example.com', comment: 'Tag and drawing agree' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'rel-p101-manual', status: 'accepted', reviewer: 'domain.expert@example.com' });

    const secondReview = await request(app)
      .post('/api/v1/relations/rel-p101-manual/review')
      .set('x-odf-user', 'another.reviewer@example.com')
      .send({ decision: 'rejected', reviewer: 'another.reviewer@example.com' });
    expect(secondReview.status).toBe(409);

    const audit = await request(app).get('/api/v1/audit').query({ entityType: 'relation', entityId: 'rel-p101-manual' });
    expect(audit.status).toBe(200);
    expect(audit.body.items[0]).toMatchObject({
      action: 'relation.accepted',
      actor: 'domain.expert@example.com',
      correlationId: 'review-test',
    });
  });

  it('keeps immutable workspace revisions, rejects stale writes, and rolls back by appending a revision', async () => {
    const initial = await request(app).get('/api/v1/workspaces/cooling-water-system');
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ id: 'cooling-water-system', version: 1 });
    const initialNodeCount = initial.body.snapshot.nodes.length;
    const editedSnapshot = structuredClone(initial.body.snapshot);
    editedSnapshot.nodes.push({
      id: 'canvas-note-001',
      type: 'note',
      position: { x: 760, y: 580 },
      data: { text: 'Inspect discharge pressure before handover' },
    });

    const saved = await request(app)
      .put('/api/v1/workspaces/cooling-water-system')
      .set('x-correlation-id', 'workspace-save-test')
      .send({
        expectedVersion: 1,
        actor: 'harper.dennis',
        changeSummary: 'Added handover inspection note',
        snapshot: editedSnapshot,
      });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 2, updatedBy: 'harper.dennis' });
    expect(saved.body.snapshot.nodes).toHaveLength(initialNodeCount + 1);

    const staleWrite = await request(app)
      .put('/api/v1/workspaces/cooling-water-system')
      .send({ expectedVersion: 1, actor: 'riley.chen', changeSummary: 'Stale edit', snapshot: editedSnapshot });
    expect(staleWrite.status).toBe(409);
    expect(staleWrite.body.error.message).toContain('version 2');

    const revisionsBeforeRollback = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisionsBeforeRollback.status).toBe(200);
    expect(revisionsBeforeRollback.body.items.map((revision: { version: number }) => revision.version)).toEqual([2, 1]);
    expect(revisionsBeforeRollback.body.items[0]).toMatchObject({
      actor: 'harper.dennis',
      changeSummary: 'Added handover inspection note',
      correlationId: 'workspace-save-test',
    });

    const rolledBack = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/rollback')
      .set('x-correlation-id', 'workspace-rollback-test')
      .set('x-odf-user', 'riley.chen')
      .send({ expectedVersion: 2, targetVersion: 1, actor: 'riley.chen' });
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body).toMatchObject({ version: 3, updatedBy: 'riley.chen' });
    expect(rolledBack.body.snapshot.nodes).toHaveLength(initialNodeCount);

    const revisionsAfterRollback = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisionsAfterRollback.body.items.map((revision: { version: number }) => revision.version)).toEqual([3, 2, 1]);
    expect(revisionsAfterRollback.body.items[0]).toMatchObject({
      actor: 'riley.chen',
      changeSummary: 'Rolled back to revision 1',
      correlationId: 'workspace-rollback-test',
    });
  });

  it('lists seeded workspace members for members only', async () => {
    const response = await request(app)
      .get('/api/v1/workspaces/cooling-water-system/members')
      .set('x-odf-user', 'riley.chen');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [
        { workspaceId: 'cooling-water-system', userId: 'harper.dennis', displayName: 'Harper Dennis', role: 'owner' },
        { workspaceId: 'cooling-water-system', userId: 'riley.chen', displayName: 'Riley Chen', role: 'editor' },
        { workspaceId: 'cooling-water-system', userId: 'monica.reyes', displayName: 'Monica Reyes', role: 'reviewer' },
        { workspaceId: 'cooling-water-system', userId: 'samantha.lee', displayName: 'Samantha Lee', role: 'viewer' },
      ],
      total: 4,
    });

    const outsider = await request(app)
      .get('/api/v1/workspaces/cooling-water-system/members')
      .set('x-odf-user', 'outsider.user');
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.code).toBe('forbidden');
  });

  it('lets an owner add, update, and remove workspace members with immutable audit events', async () => {
    const added = await request(app)
      .put('/api/v1/workspaces/cooling-water-system/members/jordan.kim')
      .set('x-odf-user', 'harper.dennis')
      .set('x-correlation-id', 'member-add-test')
      .send({ displayName: 'Jordan Kim', role: 'editor' });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({
      workspaceId: 'cooling-water-system',
      userId: 'jordan.kim',
      displayName: 'Jordan Kim',
      role: 'editor',
    });

    const updated = await request(app)
      .put('/api/v1/workspaces/cooling-water-system/members/jordan.kim')
      .set('x-odf-user', 'harper.dennis')
      .set('x-correlation-id', 'member-update-test')
      .send({ displayName: 'Jordan K. Kim', role: 'reviewer' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ userId: 'jordan.kim', displayName: 'Jordan K. Kim', role: 'reviewer' });

    const removed = await request(app)
      .delete('/api/v1/workspaces/cooling-water-system/members/jordan.kim')
      .set('x-odf-user', 'harper.dennis')
      .set('x-correlation-id', 'member-remove-test');
    expect(removed.status).toBe(204);

    const members = await request(app).get('/api/v1/workspaces/cooling-water-system/members');
    expect(members.body.total).toBe(4);
    expect(members.body.items.some((member: { userId: string }) => member.userId === 'jordan.kim')).toBe(false);

    const audit = await request(app).get('/api/v1/audit').query({ entityType: 'workspaceMember', entityId: 'jordan.kim' });
    expect(audit.body.items.map((item: { action: string }) => item.action)).toEqual([
      'workspace.member_removed',
      'workspace.member_updated',
      'workspace.member_added',
    ]);
    expect(audit.body.items.map((item: { actor: string }) => item.actor)).toEqual([
      'harper.dennis',
      'harper.dennis',
      'harper.dennis',
    ]);
    expect(audit.body.items.map((item: { correlationId: string }) => item.correlationId)).toEqual([
      'member-remove-test',
      'member-update-test',
      'member-add-test',
    ]);
  });

  it('forbids editors, reviewers, and viewers from managing members', async () => {
    for (const userId of ['riley.chen', 'monica.reyes', 'samantha.lee']) {
      const upsert = await request(app)
        .put('/api/v1/workspaces/cooling-water-system/members/blocked.user')
        .set('x-odf-user', userId)
        .send({ displayName: 'Blocked User', role: 'viewer' });
      expect(upsert.status).toBe(403);
      expect(upsert.body.error.code).toBe('forbidden');

      const remove = await request(app)
        .delete('/api/v1/workspaces/cooling-water-system/members/samantha.lee')
        .set('x-odf-user', userId);
      expect(remove.status).toBe(403);
      expect(remove.body.error.code).toBe('forbidden');
    }

    const members = await request(app).get('/api/v1/workspaces/cooling-water-system/members');
    expect(members.body.total).toBe(4);
  });

  it('does not allow the final workspace owner to be demoted or removed', async () => {
    const demotion = await request(app)
      .put('/api/v1/workspaces/cooling-water-system/members/harper.dennis')
      .set('x-odf-user', 'harper.dennis')
      .send({ displayName: 'Harper Dennis', role: 'editor' });
    expect(demotion.status).toBe(409);
    expect(demotion.body.error.message).toContain('retain at least one owner');

    const removal = await request(app)
      .delete('/api/v1/workspaces/cooling-water-system/members/harper.dennis')
      .set('x-odf-user', 'harper.dennis');
    expect(removal.status).toBe(409);
    expect(removal.body.error.message).toContain('retain at least one owner');

    const members = await request(app).get('/api/v1/workspaces/cooling-water-system/members');
    expect(members.body.items.find((member: { userId: string }) => member.userId === 'harper.dennis').role).toBe('owner');
    const audit = await request(app).get('/api/v1/audit').query({ entityType: 'workspaceMember', entityId: 'harper.dennis' });
    expect(audit.body.total).toBe(0);
  });

  it('validates member identity, display name, role, and body fields', async () => {
    const invalidRequests = [
      request(app)
        .put('/api/v1/workspaces/cooling-water-system/members/bad%20user')
        .set('x-odf-user', 'harper.dennis')
        .send({ displayName: 'Bad User', role: 'viewer' }),
      request(app)
        .put('/api/v1/workspaces/cooling-water-system/members/new.user')
        .set('x-odf-user', 'harper.dennis')
        .send({ displayName: '   ', role: 'viewer' }),
      request(app)
        .put('/api/v1/workspaces/cooling-water-system/members/new.user')
        .set('x-odf-user', 'harper.dennis')
        .send({ displayName: 'New User', role: 'administrator' }),
      request(app)
        .put('/api/v1/workspaces/cooling-water-system/members/new.user')
        .set('x-odf-user', 'harper.dennis')
        .send({ userId: 'forged.user', displayName: 'New User', role: 'viewer' }),
      request(app)
        .put('/api/v1/workspaces/cooling-water-system/members/new.user')
        .set('x-odf-user', 'harper.dennis')
        .send({ actor: 'forged.owner', displayName: 'New User', role: 'viewer' }),
    ];
    for (const pendingRequest of invalidRequests) {
      const response = await pendingRequest;
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('validation_error');
    }

    const missing = await request(app)
      .delete('/api/v1/workspaces/cooling-water-system/members/missing.user')
      .set('x-odf-user', 'harper.dennis');
    expect(missing.status).toBe(404);
  });

  it('applies owner and editor canvas operations atomically and records the authenticated actor', async () => {
    const ownerUpdate = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'harper.dennis')
      .set('x-correlation-id', 'owner-operations')
      .send({
        baseVersion: 1,
        changeSummary: 'Move pump and add investigation note',
        operations: [
          { type: 'moveNode', nodeId: 'canvas-p101', position: { x: 610, y: 180 } },
          {
            type: 'addNode',
            node: { id: 'canvas-investigation', type: 'note', position: { x: 800, y: 180 }, data: { text: 'Check vibration' } },
          },
          {
            type: 'addEdge',
            edge: { id: 'canvas-investigation-link', source: 'canvas-p101', target: 'canvas-investigation', type: 'annotatedBy', data: {} },
          },
        ],
      });
    expect(ownerUpdate.status).toBe(200);
    expect(ownerUpdate.body).toMatchObject({ version: 2, updatedBy: 'harper.dennis' });
    expect(ownerUpdate.body.snapshot.nodes.find((node: { id: string }) => node.id === 'canvas-p101').position).toEqual({ x: 610, y: 180 });

    const editorUpdate = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'riley.chen')
      .set('x-correlation-id', 'editor-operations')
      .send({
        baseVersion: 2,
        changeSummary: 'Remove investigation note',
        operations: [
          { type: 'removeEdge', edgeId: 'canvas-investigation-link' },
          { type: 'removeNode', nodeId: 'canvas-investigation' },
        ],
      });
    expect(editorUpdate.status).toBe(200);
    expect(editorUpdate.body).toMatchObject({ version: 3, updatedBy: 'riley.chen' });
    expect(editorUpdate.body.snapshot.nodes.some((node: { id: string }) => node.id === 'canvas-investigation')).toBe(false);

    const revisions = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisions.body.items.map((revision: { version: number }) => revision.version)).toEqual([3, 2, 1]);
    expect(revisions.body.items[0]).toMatchObject({ actor: 'riley.chen', correlationId: 'editor-operations' });
    expect(revisions.body.items[1]).toMatchObject({ actor: 'harper.dennis', correlationId: 'owner-operations' });

    const audit = await request(app).get('/api/v1/audit').query({ action: 'workspace.operations_applied' });
    expect(audit.body.total).toBe(2);
    expect(audit.body.items[0]).toMatchObject({ actor: 'riley.chen', correlationId: 'editor-operations' });
    expect(audit.body.items[0].details.operations).toHaveLength(2);
  });

  it('updates node and edge fields with controlled shallow data patches', async () => {
    const response = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'riley.chen')
      .set('x-correlation-id', 'semantic-update-operations')
      .send({
        baseVersion: 1,
        changeSummary: 'Refine pump card and pressure relation',
        operations: [
          {
            type: 'updateNode',
            nodeId: 'canvas-p101',
            patch: {
              type: 'assetCard',
              position: { x: 640, y: 160 },
              data: { label: 'Primary Pump P-101', width: 320, height: 180 },
            },
          },
          {
            type: 'updateEdge',
            edgeId: 'canvas-p101-pressure',
            patch: { type: 'observes', data: { label: 'discharge pressure' } },
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ version: 2, updatedBy: 'riley.chen' });
    const node = response.body.snapshot.nodes.find((candidate: { id: string }) => candidate.id === 'canvas-p101');
    expect(node).toMatchObject({
      type: 'assetCard',
      position: { x: 640, y: 160 },
      data: { externalId: 'P-101', label: 'Primary Pump P-101', width: 320, height: 180 },
    });
    const edge = response.body.snapshot.edges.find((candidate: { id: string }) => candidate.id === 'canvas-p101-pressure');
    expect(edge).toMatchObject({
      source: 'canvas-p101',
      target: 'canvas-pressure',
      type: 'observes',
      data: { label: 'discharge pressure' },
    });

    const revisions = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisions.body.total).toBe(2);
    expect(revisions.body.items[0]).toMatchObject({
      version: 2,
      actor: 'riley.chen',
      changeSummary: 'Refine pump card and pressure relation',
      correlationId: 'semantic-update-operations',
    });
    const audit = await request(app).get('/api/v1/audit').query({ action: 'workspace.operations_applied' });
    expect(audit.body.items[0].details.operations.map((operation: { type: string }) => operation.type)).toEqual(['updateNode', 'updateEdge']);
  });

  it('rejects empty, unknown, and malformed semantic patches without a revision', async () => {
    const invalidOperations = [
      { type: 'updateNode', nodeId: 'canvas-p101', patch: {} },
      { type: 'updateEdge', edgeId: 'canvas-p101-pressure', patch: {} },
      { type: 'updateNode', nodeId: 'canvas-p101', patch: { id: 'replacement-id' } },
      { type: 'updateEdge', edgeId: 'canvas-p101-pressure', patch: { source: 'canvas-system' } },
      { type: 'updateNode', nodeId: 'canvas-p101', patch: { position: { x: 'invalid', y: 10 } } },
      { type: 'updateEdge', edgeId: 'canvas-p101-pressure', patch: { type: '   ' } },
    ];

    for (const operation of invalidOperations) {
      const response = await request(app)
        .post('/api/v1/workspaces/cooling-water-system/operations')
        .set('x-odf-user', 'harper.dennis')
        .send({ baseVersion: 1, changeSummary: 'Invalid semantic patch', operations: [operation] });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('validation_error');
    }

    const workspace = await request(app).get('/api/v1/workspaces/cooling-water-system');
    expect(workspace.body).toMatchObject({ version: 1, updatedBy: 'system' });
    const revisions = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisions.body.total).toBe(1);
  });

  it('rolls back a semantic update batch when a target node or edge does not exist', async () => {
    const response = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'harper.dennis')
      .send({
        baseVersion: 1,
        changeSummary: 'Partially invalid semantic update',
        operations: [
          { type: 'updateNode', nodeId: 'canvas-p101', patch: { data: { label: 'Must not persist' } } },
          { type: 'updateEdge', edgeId: 'missing-edge', patch: { type: 'relation' } },
        ],
      });

    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain("Canvas edge 'missing-edge' was not found");
    const workspace = await request(app).get('/api/v1/workspaces/cooling-water-system');
    expect(workspace.body.version).toBe(1);
    expect(workspace.body.snapshot.nodes.find((node: { id: string }) => node.id === 'canvas-p101').data.label).toBe('Pump P-101');
  });

  it('enforces reviewer and viewer read-only access without creating a revision', async () => {
    for (const userId of ['monica.reyes', 'samantha.lee']) {
      const response = await request(app)
        .post('/api/v1/workspaces/cooling-water-system/operations')
        .set('x-odf-user', userId)
        .send({
          baseVersion: 1,
          changeSummary: 'Read-only edit attempt',
          operations: [{ type: 'updateNode', nodeId: 'canvas-p101', patch: { data: { attemptedBy: userId } } }],
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: 'forbidden' });
    }
    const workspace = await request(app).get('/api/v1/workspaces/cooling-water-system');
    expect(workspace.body.version).toBe(1);
    const revisions = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisions.body.total).toBe(1);
  });

  it('rejects stale operation batches with the current version and preserves revision history', async () => {
    const first = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'riley.chen')
      .send({
        baseVersion: 1,
        changeSummary: 'First concurrent move',
        operations: [{ type: 'updateNode', nodeId: 'canvas-p101', patch: { position: { x: 510, y: 110 } } }],
      });
    expect(first.status).toBe(200);

    const stale = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'harper.dennis')
      .send({
        baseVersion: 1,
        changeSummary: 'Stale concurrent move',
        operations: [{ type: 'updateNode', nodeId: 'canvas-p101', patch: { position: { x: 999, y: 999 } } }],
      });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toContain('at version 2');

    const workspace = await request(app).get('/api/v1/workspaces/cooling-water-system');
    expect(workspace.body.version).toBe(2);
    expect(workspace.body.snapshot.nodes.find((node: { id: string }) => node.id === 'canvas-p101').position).toEqual({ x: 510, y: 110 });
    const revisions = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisions.body.total).toBe(2);
  });

  it('rejects broken edge references and rolls back the entire operation batch', async () => {
    const missingTarget = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'harper.dennis')
      .send({
        baseVersion: 1,
        changeSummary: 'Invalid edge',
        operations: [
          { type: 'moveNode', nodeId: 'canvas-p101', position: { x: 700, y: 700 } },
          { type: 'addEdge', edge: { id: 'broken-edge', source: 'canvas-p101', target: 'missing-node', type: 'relation', data: {} } },
        ],
      });
    expect(missingTarget.status).toBe(422);
    expect(missingTarget.body.error.message).toContain("missing target node 'missing-node'");

    const danglingEdges = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('x-odf-user', 'riley.chen')
      .send({
        baseVersion: 1,
        changeSummary: 'Invalid node removal',
        operations: [{ type: 'removeNode', nodeId: 'canvas-p101' }],
      });
    expect(danglingEdges.status).toBe(422);
    expect(danglingEdges.body.error.message).toContain("references missing");

    const workspace = await request(app).get('/api/v1/workspaces/cooling-water-system');
    expect(workspace.body.version).toBe(1);
    expect(workspace.body.snapshot.nodes.find((node: { id: string }) => node.id === 'canvas-p101').position).toEqual({ x: 500, y: 105 });
    const revisions = await request(app).get('/api/v1/workspaces/cooling-water-system/revisions');
    expect(revisions.body.total).toBe(1);
  });

  it('returns structured validation errors', async () => {
    const response = await request(app).post('/api/v1/ingest/bundle').send({ source: { system: '' } });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_error');
    expect(response.body.error.issues.length).toBeGreaterThan(0);
  });
});
