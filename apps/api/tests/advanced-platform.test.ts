import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express, Request } from 'express';
import request, { type Test } from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  writebackPolicyFromEnvironment,
  type IndustrialWritebackExecutor,
} from '../src/advanced-platform.js';
import {
  AuthenticationError,
  DATA_PLANE_PERMISSIONS,
  type AuthenticatedIdentity,
  type DataPlanePermission,
  type IdentityProvider,
} from '../src/auth.js';
import { createApp } from '../src/app.js';
import { FusionDatabase } from '../src/database.js';

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

function authorize(test: Test, userId: string, permissions: DataPlanePermission[]): Test {
  return test
    .set('x-test-user', userId)
    .set('x-test-permissions', permissions.join(' '))
    .set('x-odf-tenant-id', 'demo')
    .set('x-odf-project-id', 'north-plant');
}

const policy = {
  enabled: true,
  allowedOperations: ['set.control_mode', 'reset.trip'],
  maximumRisk: 'high' as const,
  requireDryRun: true,
  approvalRequirements: { low: 1, medium: 1, high: 2, critical: 2 },
};

const identityMatrix = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

describe('advanced project platform API', () => {
  let tempDirectory: string;
  let database: FusionDatabase;
  let app: Express;
  let execute: ReturnType<typeof vi.fn<IndustrialWritebackExecutor['execute']>>;

  beforeEach(async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-advanced-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    execute = vi.fn<IndustrialWritebackExecutor['execute']>(async (execution) => ({
      externalWriteId: `write-${execution.requestId}`,
      applied: true,
    }));
    app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      writebackPolicy: policy,
      writebackExecutor: { execute },
    });
    const source = await authorize(
      request(app).post('/api/v1/platform/sources'),
      'riley.chen',
      ['data:ingest'],
    ).send({ id: 'control-system', name: 'Control System', type: 'opcua' });
    expect(source.status).toBe(201);
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('loads a fail-closed server policy and refuses to disable dry-run enforcement', () => {
    expect(writebackPolicyFromEnvironment({
      ODF_WRITEBACK_ENABLED: 'true',
      ODF_WRITEBACK_ALLOWED_OPERATIONS: 'reset.trip,set.control_mode',
      ODF_WRITEBACK_MAXIMUM_RISK: 'high',
      ODF_WRITEBACK_APPROVALS_HIGH: '2',
    })).toMatchObject({
      enabled: true,
      allowedOperations: ['reset.trip', 'set.control_mode'],
      maximumRisk: 'high',
      requireDryRun: true,
      approvalRequirements: { high: 2 },
    });
    expect(() => writebackPolicyFromEnvironment({ ODF_WRITEBACK_REQUIRE_DRY_RUN: 'false' })).toThrow(
      'must require a safe dry-run',
    );
    expect(() => writebackPolicyFromEnvironment({ ODF_WRITEBACK_APPROVALS_HIGH: '1' })).toThrow(
      "approval requirement for 'high' must be between 2 and 20",
    );
  });

  it('persists P&ID tag extraction and ranked matching proposals without auto-acceptance', async () => {
    const extracted = await authorize(
      request(app).post('/api/v1/platform/diagrams/tag-extractions'),
      'riley.chen',
      ['data:ingest'],
    ).send({
      id: 'pid-001-extraction',
      documentExternalId: 'PID-001',
      page: 2,
      text: 'Pump P-101 discharge is measured by PT-1001 on line 6"-CW-101.',
    });
    expect(extracted.status).toBe(201);
    expect(extracted.body.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'P-101', kind: 'equipment', page: 2 }),
      expect.objectContaining({ tag: 'PT-1001', kind: 'instrument', page: 2 }),
    ]));
    expect(extracted.body).not.toHaveProperty('text');
    expect(extracted.body.textSha256).toMatch(/^[a-f0-9]{64}$/);

    const evaluated = await authorize(
      request(app).post('/api/v1/platform/matching/evaluations'),
      'riley.chen',
      ['data:ingest'],
    ).send({
      id: 'matching-001',
      threshold: 0.8,
      predictions: [
        { sourceExternalId: 'PT-1001', targetExternalId: 'P-101-PRESSURE', score: 0.91 },
        { sourceExternalId: 'PT-1001', targetExternalId: 'P-102-PRESSURE', score: 0.4 },
      ],
      truth: [
        { sourceExternalId: 'PT-1001', targetExternalId: 'P-101-PRESSURE', accepted: true },
        { sourceExternalId: 'PT-1001', targetExternalId: 'P-102-PRESSURE', accepted: false },
      ],
    });
    expect(evaluated.status).toBe(201);
    expect(evaluated.body.evaluation).toMatchObject({ truePositives: 1, falsePositives: 0, precision: 1, recall: 1 });
    expect(evaluated.body.proposals.map((proposal: { state: string }) => proposal.state)).toEqual(['proposed', 'proposed']);
    expect(evaluated.body.proposals.map((proposal: { score: number }) => proposal.score)).toEqual([0.91, 0.4]);

    const restarted = createApp(database, undefined, { identityProvider: new TestIdentityProvider() });
    const persisted = await authorize(
      request(restarted).get('/api/v1/platform/matching/evaluations'),
      'samantha.lee',
      ['data:read'],
    );
    expect(persisted.body.items).toEqual([expect.objectContaining({ id: 'matching-001' })]);
  });

  it('scopes persisted advanced resources by both tenant and project', async () => {
    const project = await authorize(
      request(app).post('/api/v1/platform/tenants/demo/projects'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ id: 'south-plant', name: 'South Plant' });
    expect(project.status).toBe(201);

    const createIn = async (projectId: string, text: string) => request(app)
      .post('/api/v1/platform/diagrams/tag-extractions')
      .set('x-test-user', 'harper.dennis')
      .set('x-test-permissions', 'data:ingest')
      .set('x-odf-tenant-id', 'demo')
      .set('x-odf-project-id', projectId)
      .send({ id: 'shared-extraction-id', documentExternalId: 'PID-SHARED', text });
    expect((await createIn('north-plant', 'Pump P-101')).status).toBe(201);
    expect((await createIn('south-plant', 'Pump P-202')).status).toBe(201);

    const listIn = async (projectId: string) => request(app)
      .get('/api/v1/platform/diagrams/tag-extractions')
      .set('x-test-user', 'harper.dennis')
      .set('x-test-permissions', 'data:read')
      .set('x-odf-tenant-id', 'demo')
      .set('x-odf-project-id', projectId);
    const north = await listIn('north-plant');
    const south = await listIn('south-plant');
    expect(north.body.items[0].tags).toEqual([expect.objectContaining({ tag: 'P-101' })]);
    expect(south.body.items[0].tags).toEqual([expect.objectContaining({ tag: 'P-202' })]);
  });

  it('validates 4x4 spatial transforms and permits exactly one reviewer transition', async () => {
    const invalid = await authorize(
      request(app).post('/api/v1/platform/spatial/asset-links'),
      'riley.chen',
      ['data:ingest'],
    ).send({
      id: 'spatial-invalid', assetExternalId: 'P-101', sceneExternalId: 'north-plant-3d',
      nodeExternalId: 'node-p101', transform: [1, 0, 0], confidence: 0.9,
    });
    expect(invalid.status).toBe(400);

    const proposed = await authorize(
      request(app).post('/api/v1/platform/spatial/asset-links'),
      'riley.chen',
      ['data:ingest'],
    ).send({
      id: 'spatial-p101', assetExternalId: 'P-101', sceneExternalId: 'north-plant-3d',
      nodeExternalId: 'node-p101', transform: identityMatrix, confidence: 0.96,
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ reviewState: 'proposed', transform: identityMatrix });

    const reviewed = await authorize(
      request(app).post('/api/v1/platform/spatial/asset-links/spatial-p101/review'),
      'monica.reyes',
      ['relations:review'],
    ).send({ decision: 'accepted', comment: 'Aligned against survey control points' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({ reviewState: 'accepted', reviewedBy: 'monica.reyes' });

    const secondReview = await authorize(
      request(app).post('/api/v1/platform/spatial/asset-links/spatial-p101/review'),
      'harper.dennis',
      ['relations:review'],
    ).send({ decision: 'rejected' });
    expect(secondReview.status).toBe(409);
  });

  it('requires distinct high-risk approvals and never calls the executor before every safety gate passes', async () => {
    const created = await authorize(
      request(app).post('/api/v1/platform/writeback/requests'),
      'riley.chen',
      ['writeback:request'],
    ).set('x-correlation-id', 'writeback-high-risk').send({
      id: 'wb-high-001', sourceId: 'control-system', targetExternalId: 'P-101',
      operation: 'set.control_mode', payload: { mode: 'manual' }, risk: 'high',
      dryRunResult: { safe: true, evidence: { interlocks: 'passed', simulator: 'passed' } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'pending_approval', safety: { requiredApprovals: 2, validApprovals: 0 } });

    const premature = await authorize(
      request(app).post('/api/v1/platform/writeback/requests/wb-high-001/execute'),
      'riley.chen',
      ['writeback:execute'],
    ).send({});
    expect(premature.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();

    const firstApproval = await authorize(
      request(app).post('/api/v1/platform/writeback/requests/wb-high-001/approvals'),
      'monica.reyes',
      ['writeback:approve'],
    ).send({ decision: 'approved', comment: 'Process conditions verified' });
    expect(firstApproval.body).toMatchObject({ state: 'pending_approval', safety: { validApprovals: 1 } });

    const stillPremature = await authorize(
      request(app).post('/api/v1/platform/writeback/requests/wb-high-001/execute'),
      'riley.chen',
      ['writeback:execute'],
    ).send({});
    expect(stillPremature.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();

    const secondApproval = await authorize(
      request(app).post('/api/v1/platform/writeback/requests/wb-high-001/approvals'),
      'harper.dennis',
      ['writeback:approve'],
    ).send({ decision: 'approved', comment: 'Operations approval' });
    expect(secondApproval.body).toMatchObject({ state: 'approved', safety: { allowed: true, validApprovals: 2 } });

    const executed = await authorize(
      request(app).post('/api/v1/platform/writeback/requests/wb-high-001/execute'),
      'riley.chen',
      ['writeback:execute'],
    ).send({});
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({ state: 'succeeded', executionResult: { applied: true } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      requestId: 'wb-high-001', requestedBy: 'riley.chen',
      approvedBy: ['monica.reyes', 'harper.dennis'], executedBy: 'riley.chen',
    });

    const events = await authorize(
      request(app).get('/api/v1/platform/writeback/requests/wb-high-001/events'),
      'samantha.lee',
      ['audit:read'],
    );
    expect(events.body.items.map((event: { type: string }) => event.type)).toEqual([
      'request.created', 'approval.approved', 'approval.approved', 'execution.started', 'execution.succeeded',
    ]);
    expect(() => database.database.prepare('UPDATE platform_writeback_events SET actor=? WHERE request_id=?').run('tampered', 'wb-high-001')).toThrow(
      'write-back audit events are immutable',
    );
    expect(() => database.database.prepare('DELETE FROM platform_writeback_approvals WHERE request_id=?').run('wb-high-001')).toThrow(
      'write-back approvals are immutable',
    );
  });

  it('blocks requester self-approval, unsafe/non-allowlisted requests, and all critical write-back', async () => {
    const ownRequest = await authorize(
      request(app).post('/api/v1/platform/writeback/requests'),
      'harper.dennis',
      ['writeback:request'],
    ).send({
      id: 'wb-own', sourceId: 'control-system', targetExternalId: 'P-101', operation: 'reset.trip',
      payload: {}, risk: 'low', dryRunResult: { safe: true, evidence: { simulator: 'passed' } },
    });
    expect(ownRequest.body.state).toBe('pending_approval');
    const selfApproval = await authorize(
      request(app).post('/api/v1/platform/writeback/requests/wb-own/approvals'),
      'harper.dennis',
      ['writeback:approve'],
    ).send({ decision: 'approved' });
    expect(selfApproval.status).toBe(403);

    const unsafe = await authorize(
      request(app).post('/api/v1/platform/writeback/requests'),
      'riley.chen',
      ['writeback:request'],
    ).send({
      id: 'wb-unsafe', sourceId: 'control-system', targetExternalId: 'P-101', operation: 'reset.trip',
      payload: {}, risk: 'low', dryRunResult: { safe: false, evidence: { interlock: 'failed' } },
    });
    expect(unsafe.body).toMatchObject({ state: 'cancelled', blockedReasons: ['A successful safe dry-run is required'] });

    const notAllowlisted = await authorize(
      request(app).post('/api/v1/platform/writeback/requests'),
      'riley.chen',
      ['writeback:request'],
    ).send({
      id: 'wb-not-allowlisted', sourceId: 'control-system', targetExternalId: 'P-101', operation: 'disable.safety_system',
      payload: {}, risk: 'low', dryRunResult: { safe: true, evidence: { simulator: 'passed' } },
    });
    expect(notAllowlisted.body.state).toBe('cancelled');
    expect(notAllowlisted.body.blockedReasons).toContain("Operation 'disable.safety_system' is not allowlisted");

    const critical = await authorize(
      request(app).post('/api/v1/platform/writeback/requests'),
      'riley.chen',
      ['writeback:request'],
    ).send({
      id: 'wb-critical', sourceId: 'control-system', targetExternalId: 'P-101', operation: 'reset.trip',
      payload: {}, risk: 'critical', dryRunResult: { safe: true, evidence: { simulator: 'passed' } },
    });
    expect(critical.body.state).toBe('cancelled');
    expect(critical.body.blockedReasons).toContain('Critical write-back requires an external safety case and cannot be approved automatically');
    const criticalExecute = await authorize(
      request(app).post('/api/v1/platform/writeback/requests/wb-critical/execute'),
      'riley.chen',
      ['writeback:execute'],
    ).send({});
    expect(criticalExecute.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails closed without an injected executor and keeps an approved request retryable', async () => {
    const withoutExecutor = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      writebackPolicy: policy,
    });
    await authorize(
      request(withoutExecutor).post('/api/v1/platform/writeback/requests'),
      'riley.chen',
      ['writeback:request'],
    ).send({
      id: 'wb-no-executor', sourceId: 'control-system', targetExternalId: 'P-101', operation: 'reset.trip',
      payload: {}, risk: 'low', dryRunResult: { safe: true, evidence: { simulator: 'passed' } },
    });
    const approval = await authorize(
      request(withoutExecutor).post('/api/v1/platform/writeback/requests/wb-no-executor/approvals'),
      'monica.reyes',
      ['writeback:approve'],
    ).send({ decision: 'approved' });
    expect(approval.body.state).toBe('approved');

    const blocked = await authorize(
      request(withoutExecutor).post('/api/v1/platform/writeback/requests/wb-no-executor/execute'),
      'riley.chen',
      ['writeback:execute'],
    ).send({});
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('writeback_executor_unavailable');
    expect(execute).not.toHaveBeenCalled();

    const requests = await authorize(
      request(withoutExecutor).get('/api/v1/platform/writeback/requests'),
      'samantha.lee',
      ['data:read'],
    );
    expect(requests.body.items.find((item: { id: string }) => item.id === 'wb-no-executor')).toMatchObject({ state: 'approved' });
  });

  it('requires explicit write-back permissions and supports owner-controlled project membership', async () => {
    const missingPermission = await authorize(
      request(app).post('/api/v1/platform/writeback/requests'),
      'riley.chen',
      ['data:ingest'],
    ).send({
      id: 'wb-denied', sourceId: 'control-system', targetExternalId: 'P-101', operation: 'reset.trip',
      payload: {}, risk: 'low', dryRunResult: { safe: true, evidence: { simulator: 'passed' } },
    });
    expect(missingPermission.status).toBe(403);

    const added = await authorize(
      request(app).put('/api/v1/platform/project/members/new.reviewer'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ role: 'reviewer' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ userId: 'new.reviewer', role: 'reviewer' });

    const editorDenied = await authorize(
      request(app).put('/api/v1/platform/project/members/blocked.member'),
      'riley.chen',
      ['platform:admin'],
    ).send({ role: 'viewer' });
    expect(editorDenied.status).toBe(403);

    const lastOwner = await authorize(
      request(app).put('/api/v1/platform/project/members/harper.dennis'),
      'harper.dennis',
      ['platform:admin'],
    ).send({ role: 'viewer' });
    expect(lastOwner.status).toBe(409);

    const listed = await authorize(
      request(app).get('/api/v1/platform/project/members'),
      'samantha.lee',
      ['data:read'],
    );
    expect(listed.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ userId: 'new.reviewer', role: 'reviewer' })]));

    const removed = await authorize(
      request(app).delete('/api/v1/platform/project/members/new.reviewer'),
      'harper.dennis',
      ['platform:admin'],
    );
    expect(removed.status).toBe(204);

    const developmentApp = createApp(database, undefined, { writebackPolicy: policy });
    const developmentExtraction = await request(developmentApp)
      .post('/api/v1/platform/diagrams/tag-extractions')
      .set('x-odf-tenant-id', 'demo')
      .set('x-odf-project-id', 'north-plant')
      .send({ id: 'development-extraction', documentExternalId: 'PID-DEV', text: 'Pump P-101' });
    expect(developmentExtraction.status).toBe(201);
    expect(developmentExtraction.body.createdBy).toBe('harper.dennis');
  });
});
