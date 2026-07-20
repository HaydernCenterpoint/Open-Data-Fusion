import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createIdentityProviderFromEnvironment, FactoryIdentityProvider, OidcIdentityProvider } from '../src/auth.js';
import { WorkspaceEventHub } from '../src/collaboration.js';
import { FusionDatabase } from '../src/database.js';
import { LegacySqliteIndustrialPersistence } from '../src/industrial-persistence.js';

const issuer = 'https://identity.example.test/realms/open-data-fusion';
const audience = 'open-data-fusion-api';
const factorySecret = 'test-fii-secret-that-is-at-least-32-bytes-long';

function signFactoryToken(
  userId: string,
  role: string,
  overrides: { issuer?: string; audience?: string; expiration?: string } = {},
): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(overrides.issuer ?? 'MKZ_PLC_Server')
    .setAudience(overrides.audience ?? 'MKZ_PLC_Client')
    .setIssuedAt()
    .setExpirationTime(overrides.expiration ?? '5m')
    .sign(new TextEncoder().encode(factorySecret));
}

interface TokenOptions {
  audience?: string;
  scope?: string;
  permissions?: string[];
}

describe('OIDC workspace authentication', () => {
  let tempDirectory: string;
  let database: FusionDatabase;
  let app: Express;
  let signToken: (userId: string, options?: TokenOptions) => Promise<string>;
  let identityProvider: OidcIdentityProvider;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = {
      ...(await exportJWK(publicKey)),
      kid: 'integration-test-key',
      alg: 'RS256',
      use: 'sig',
    };
    identityProvider = new OidcIdentityProvider(
      {
        issuer,
        audience,
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
        userClaim: 'preferred_username',
      },
      createLocalJWKSet({ keys: [publicJwk] }),
    );
    signToken = (userId, options = {}) =>
      new SignJWT({
        preferred_username: userId,
        name: `Test ${userId}`,
        ...(options.scope ? { scope: options.scope } : {}),
        ...(options.permissions ? { permissions: options.permissions } : {}),
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'integration-test-key', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(options.audience ?? audience)
        .setSubject(`subject:${userId}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-auth-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    app = createApp(database, new WorkspaceEventHub(), {
      identityProvider,
      defaultPlatformContext: { tenantId: 'demo', projectId: 'north-plant' },
      industrialPersistence: new LegacySqliteIndustrialPersistence(database),
    });
    const member = database.database.prepare(`
      INSERT OR IGNORE INTO platform_project_members(tenant_id, project_id, user_id, role, created_at)
      VALUES ('demo', 'north-plant', ?, ?, ?)
    `);
    const timestamp = new Date().toISOString();
    member.run('audit.reader', 'viewer', timestamp);
    member.run('connector.service', 'editor', timestamp);
    member.run('domain.expert', 'reviewer', timestamp);
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('requires a verified bearer token, including for the live event stream', async () => {
    const workspace = await request(app).get('/api/v1/workspaces/cooling-water-system');
    expect(workspace.status).toBe(401);
    expect(workspace.headers['www-authenticate']).toBe('Bearer');
    expect(workspace.body.error.code).toBe('unauthorized');

    const eventStream = await request(app)
      .get('/api/v1/workspaces/cooling-water-system/events')
      .query({ user: 'harper.dennis' });
    expect(eventStream.status).toBe(401);
  });

  it('keeps health public but requires a verified bearer token on every data-plane route', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200);

    const requests = [
      request(app).get('/api/v1/assets'),
      request(app).get('/api/v1/assets/P-101'),
      request(app).get('/api/v1/assets/P-101/telemetry'),
      request(app).get('/api/v1/relations'),
      request(app).get('/api/v1/audit'),
      request(app).post('/api/v1/ingest/bundle').send({}),
      request(app).post('/api/v1/relations/rel-p101-manual/review').send({ decision: 'accepted' }),
      request(app).post('/api/v1/platform/writeback/requests').send({}),
      request(app).post('/api/v1/platform/writeback/requests/request-1/approvals').send({}),
      request(app).post('/api/v1/platform/writeback/requests/request-1/execute').send({}),
      request(app).get('/api/v1/platform/objects'),
      request(app).post('/api/v1/platform/objects/object-1/versions').set('content-type', 'text/plain').send('data'),
      request(app).get('/api/v1/assets/P-101/telemetry/latest'),
    ];
    for (const pendingRequest of requests) {
      const response = await pendingRequest;
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('unauthorized');
    }
  });

  it('enforces independent read, ingest, review, and audit permissions', async () => {
    const readToken = await signToken('riley.chen', { scope: 'openid data:read' });
    const assets = await request(app)
      .get('/api/v1/assets')
      .set('authorization', `Bearer ${readToken}`);
    expect(assets.status).toBe(200);

    const deniedRequests = [
      request(app)
        .post('/api/v1/ingest/bundle')
        .set('authorization', `Bearer ${readToken}`)
        .send({ source: { system: 'scope-test' }, assets: [{ externalId: 'SCOPE-1', name: 'Scope test', type: 'Test' }] }),
      request(app)
        .post('/api/v1/relations/rel-p101-manual/review')
        .set('authorization', `Bearer ${readToken}`)
        .send({ decision: 'accepted' }),
      request(app).get('/api/v1/audit').set('authorization', `Bearer ${readToken}`),
    ];
    for (const pendingRequest of deniedRequests) {
      const response = await pendingRequest;
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    }

    const auditToken = await signToken('audit.reader', { permissions: ['audit:read'] });
    const audit = await request(app)
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${auditToken}`);
    expect(audit.status).toBe(200);
    const deniedAsset = await request(app)
      .get('/api/v1/assets')
      .set('authorization', `Bearer ${auditToken}`);
    expect(deniedAsset.status).toBe(403);
  });

  it('requires relation review permission before ingest can accept a relation', async () => {
    const connectorToken = await signToken('connector.service', { scope: 'data:ingest' });
    const response = await request(app)
      .post('/api/v1/ingest/bundle')
      .set('authorization', `Bearer ${connectorToken}`)
      .send({
        source: { system: 'connector', runId: 'accepted-relation-without-review' },
        relations: [{
          id: 'unauthorized-accepted-relation',
          sourceType: 'asset',
          sourceExternalId: 'P-101',
          targetType: 'document',
          targetExternalId: 'DOC-P101-MANUAL',
          relationType: 'documentedBy',
          status: 'accepted',
        }],
      });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'forbidden', message: "Permission 'relations:review' is required" });
  });

  it('derives ingestion and review audit actors from the verified token', async () => {
    const connectorToken = await signToken('connector.service', {
      scope: 'data:ingest audit:read',
    });
    const ingested = await request(app)
      .post('/api/v1/ingest/bundle')
      .set('authorization', `Bearer ${connectorToken}`)
      .set('x-odf-user', 'forged.header.actor')
      .set('x-correlation-id', 'verified-ingest-actor')
      .send({
        source: { system: 'verified-connector', runId: 'verified-run', actor: 'forged.connector' },
        assets: [{ externalId: 'VERIFIED-1', name: 'Verified asset', type: 'Test' }],
      });
    expect(ingested.status).toBe(201);
    const ingestAudit = await request(app)
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${connectorToken}`)
      .query({ action: 'ingestion.completed' });
    expect(ingestAudit.body.items[0]).toMatchObject({
      actor: 'connector.service',
      correlationId: 'verified-ingest-actor',
    });

    const reviewerToken = await signToken('domain.expert', {
      permissions: ['relations:review', 'audit:read'],
    });
    const reviewed = await request(app)
      .post('/api/v1/relations/rel-p101-manual/review')
      .set('authorization', `Bearer ${reviewerToken}`)
      .set('x-odf-user', 'forged.header.reviewer')
      .set('x-correlation-id', 'verified-review-actor')
      .send({ decision: 'accepted', reviewer: 'forged.reviewer' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.reviewer).toBe('domain.expert');
    const reviewAudit = await request(app)
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${reviewerToken}`)
      .query({ entityType: 'relation', entityId: 'rel-p101-manual' });
    expect(reviewAudit.body.items[0]).toMatchObject({
      actor: 'domain.expert',
      correlationId: 'verified-review-actor',
    });
  });

  it('honors the verified platform administrator permission', async () => {
    const token = await signToken('platform.operator', { permissions: ['platform:admin'] });
    const created = await request(app)
      .post('/api/v1/platform/tenants')
      .set('authorization', `Bearer ${token}`)
      .set('x-correlation-id', 'platform-admin-test')
      .send({ id: 'verified-tenant', name: 'Verified Tenant' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'verified-tenant', createdBy: 'platform.operator' });

    const audit = database.listAudit({ action: 'platform.tenant_created', limit: 10, offset: 0 });
    expect((audit.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      actor: 'platform.operator',
      correlationId: 'platform-admin-test',
    });
  });

  it('parses independent verified write-back request, approval, and execution permissions', async () => {
    app = createApp(database, new WorkspaceEventHub(), {
      identityProvider,
      writebackPolicy: {
        enabled: true,
        allowedOperations: ['reset.trip'],
        maximumRisk: 'high',
        requireDryRun: true,
      },
    });
    const contextHeaders = {
      'x-odf-tenant-id': 'demo',
      'x-odf-project-id': 'north-plant',
    };
    const ingestToken = await signToken('riley.chen', { permissions: ['data:ingest'] });
    const source = await request(app)
      .post('/api/v1/platform/sources')
      .set('authorization', `Bearer ${ingestToken}`)
      .set(contextHeaders)
      .send({ id: 'verified-control-system', name: 'Verified Control System', type: 'opcua' });
    expect(source.status).toBe(201);

    const requesterToken = await signToken('riley.chen', { permissions: ['writeback:request'] });
    const created = await request(app)
      .post('/api/v1/platform/writeback/requests')
      .set('authorization', `Bearer ${requesterToken}`)
      .set('x-odf-user', 'forged.requester')
      .set(contextHeaders)
      .send({
        id: 'verified-writeback', sourceId: 'verified-control-system', targetExternalId: 'P-101',
        operation: 'reset.trip', payload: {}, risk: 'low',
        dryRunResult: { safe: true, evidence: { simulator: 'passed' } },
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'pending_approval', requestedBy: 'riley.chen' });

    const approvalDenied = await request(app)
      .post('/api/v1/platform/writeback/requests/verified-writeback/approvals')
      .set('authorization', `Bearer ${requesterToken}`)
      .set(contextHeaders)
      .send({ decision: 'approved' });
    expect(approvalDenied.status).toBe(403);

    const approverToken = await signToken('monica.reyes', { permissions: ['writeback:approve'] });
    const approved = await request(app)
      .post('/api/v1/platform/writeback/requests/verified-writeback/approvals')
      .set('authorization', `Bearer ${approverToken}`)
      .set(contextHeaders)
      .send({ decision: 'approved' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: 'approved', approvals: [expect.objectContaining({ actor: 'monica.reyes' })] });

    const executorToken = await signToken('riley.chen', { permissions: ['writeback:execute'] });
    const unavailable = await request(app)
      .post('/api/v1/platform/writeback/requests/verified-writeback/execute')
      .set('authorization', `Bearer ${executorToken}`)
      .set(contextHeaders)
      .send({});
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe('writeback_executor_unavailable');
  });

  it('accepts a correctly signed token with the configured issuer and audience', async () => {
    const token = await signToken('riley.chen');
    const response = await request(app)
      .get('/api/v1/workspaces/cooling-water-system')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('cooling-water-system');
  });

  it('does not let a development identity header override the verified token subject', async () => {
    const viewerToken = await signToken('samantha.lee');
    const response = await request(app)
      .post('/api/v1/workspaces/cooling-water-system/operations')
      .set('authorization', `Bearer ${viewerToken}`)
      .set('x-odf-user', 'harper.dennis')
      .send({
        baseVersion: 1,
        changeSummary: 'Attempted identity override',
        operations: [{ type: 'moveNode', nodeId: 'canvas-p101', position: { x: 1, y: 1 } }],
      });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
    expect(database.getWorkspace('cooling-water-system').version).toBe(1);
  });

  it('uses the asynchronously verified owner identity for member administration and audit', async () => {
    const ownerToken = await signToken('harper.dennis', { scope: 'audit:read' });
    const added = await request(app)
      .put('/api/v1/workspaces/cooling-water-system/members/oidc.member')
      .set('authorization', `Bearer ${ownerToken}`)
      .set('x-odf-user', 'samantha.lee')
      .set('x-correlation-id', 'oidc-member-admin')
      .send({ displayName: 'OIDC Member', role: 'editor' });

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ userId: 'oidc.member', role: 'editor' });
    const audit = await request(app)
      .get('/api/v1/audit')
      .set('authorization', `Bearer ${ownerToken}`)
      .query({ entityType: 'workspaceMember', entityId: 'oidc.member' });
    expect(audit.body.items[0]).toMatchObject({
      action: 'workspace.member_added',
      actor: 'harper.dennis',
      correlationId: 'oidc-member-admin',
    });

    const editorToken = await signToken('riley.chen');
    const forbidden = await request(app)
      .put('/api/v1/workspaces/cooling-water-system/members/blocked.oidc.member')
      .set('authorization', `Bearer ${editorToken}`)
      .set('x-odf-user', 'harper.dennis')
      .send({ displayName: 'Blocked OIDC Member', role: 'viewer' });
    expect(forbidden.status).toBe(403);
  });

  it('rejects a correctly signed token for another audience', async () => {
    const token = await signToken('harper.dennis', { audience: 'another-api' });
    const response = await request(app)
      .get('/api/v1/workspaces/cooling-water-system')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });
});

describe('factory cookie authentication', () => {
  let tempDirectory: string;
  let database: FusionDatabase;
  let app: Express;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-factory-auth-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    app = createApp(database, new WorkspaceEventHub(), {
      identityProvider: new FactoryIdentityProvider({
        secret: factorySecret,
        issuer: 'MKZ_PLC_Server',
        audience: 'MKZ_PLC_Client',
      }),
      defaultPlatformContext: { tenantId: 'demo', projectId: 'north-plant' },
      industrialPersistence: new LegacySqliteIndustrialPersistence(database),
    });
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it.each([
    ['ADMIN', ['data:read', 'data:ingest', 'relations:review', 'audit:read', 'platform:admin', 'writeback:request', 'writeback:approve', 'writeback:execute']],
    ['ENGINEER', ['data:read', 'data:ingest', 'relations:review', 'writeback:request']],
    ['GUEST', ['data:read']],
  ] as const)('maps %s to explicit permissions', async (role, permissions) => {
    const token = await signFactoryToken('factory.user', role);
    const provider = new FactoryIdentityProvider({
      secret: factorySecret,
      issuer: 'MKZ_PLC_Server',
      audience: 'MKZ_PLC_Client',
    });
    const requestLike = { headers: { cookie: `fii_sso=${token}` } } as unknown as import('express').Request;

    const identity = await provider.authenticate(requestLike);

    expect(identity.userId).toBe('factory.user');
    expect(identity.role).toBe(role);
    expect([...identity.permissions]).toEqual(permissions);
  });

  it('returns verified session metadata without the token', async () => {
    const token = await signFactoryToken('factory.user', 'GUEST');
    const response = await request(app).get('/api/v1/auth/session').set('cookie', `fii_sso=${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      authenticated: true,
      identity: { userId: 'factory.user', displayName: 'factory.user', role: 'GUEST' },
    });
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('accepts a verified factory bearer token for service ingestion', async () => {
    const token = await signFactoryToken('service-account-open-data-fusion-connector', 'ENGINEER');
    const response = await request(app)
      .post('/api/v1/ingest/bundle')
      .set('authorization', `Bearer ${token}`)
      .send({
        source: { system: 'factory-adapter', runId: 'factory-service-token' },
        assets: [{ externalId: 'FACTORY-1', name: 'Factory asset', type: 'Test' }],
      });

    expect(response.status).toBe(201);
  });

  it('does not fall back to a cookie when an explicit bearer token is invalid', async () => {
    const cookieToken = await signFactoryToken('harper.dennis', 'ADMIN');
    const bearerToken = await signFactoryToken('harper.dennis', 'ADMIN', { issuer: 'wrong' });
    const response = await request(app)
      .get('/api/v1/assets')
      .set('authorization', `Bearer ${bearerToken}`)
      .set('cookie', `fii_sso=${cookieToken}`);

    expect(response.status).toBe(401);
  });

  it.each([
    () => signFactoryToken('factory.user', 'GUEST', { issuer: 'wrong' }),
    () => signFactoryToken('factory.user', 'GUEST', { audience: 'wrong' }),
    () => signFactoryToken('factory.user', 'GUEST', { expiration: '0s' }),
  ])('rejects an invalid shared token', async (makeToken) => {
    const token = await makeToken();
    const response = await request(app).get('/api/v1/auth/session').set('cookie', `fii_sso=${token}`);
    expect(response.status).toBe(401);
  });

  it('rejects missing, tampered, unsupported-role, and missing-subject cookies', async () => {
    const valid = await signFactoryToken('factory.user', 'GUEST');
    const [head, body, signature] = valid.split('.') as [string, string, string];
    const tamperedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    const tampered = `${head}.${body}.${tamperedSignature}`;
    const unsupportedRole = await signFactoryToken('factory.user', 'OWNER');
    const missingSubject = await new SignJWT({ role: 'GUEST' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('MKZ_PLC_Server')
      .setAudience('MKZ_PLC_Client')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(factorySecret));

    for (const cookieValue of [undefined, tampered, unsupportedRole, missingSubject]) {
      const pending = request(app).get('/api/v1/auth/session');
      const response = await (cookieValue ? pending.set('cookie', `fii_sso=${cookieValue}`) : pending);
      expect(response.status).toBe(401);
    }
  });

  it('keeps project membership enforcement after authentication', async () => {
    const token = await signFactoryToken('not-a-member', 'GUEST');
    const response = await request(app).get('/api/v1/assets').set('cookie', `fii_sso=${token}`);
    expect(response.status).toBe(403);
  });
});

describe('identity environment configuration', () => {
  it('fails closed when a production process has no OIDC configuration', () => {
    expect(() => createIdentityProviderFromEnvironment({ NODE_ENV: 'production' })).toThrow(
      'ODF_OIDC_ISSUER is required',
    );
  });

  it('only enables the development identity profile explicitly outside development', () => {
    const identityProvider = createIdentityProviderFromEnvironment({
      NODE_ENV: 'production',
      ODF_AUTH_MODE: 'development',
      ODF_DEV_USER: 'local.operator',
    });

    expect(identityProvider.mode).toBe('development');
  });

  it('requires an explicit secret for factory authentication', () => {
    expect(() => createIdentityProviderFromEnvironment({ ODF_AUTH_MODE: 'factory' })).toThrow(
      'FII_JWT_SECRET is required for the selected authentication mode',
    );
  });

  it('creates the factory provider only when explicitly selected', () => {
    const provider = createIdentityProviderFromEnvironment({
      ODF_AUTH_MODE: 'factory',
      FII_JWT_SECRET: factorySecret,
      FII_JWT_ISSUER: 'MKZ_PLC_Server',
      FII_JWT_AUDIENCE: 'MKZ_PLC_Client',
    });

    expect(provider.mode).toBe('factory');
  });
});
