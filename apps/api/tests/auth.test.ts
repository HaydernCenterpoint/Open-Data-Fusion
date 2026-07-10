import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createIdentityProviderFromEnvironment, OidcIdentityProvider } from '../src/auth.js';
import { WorkspaceEventHub } from '../src/collaboration.js';
import { FusionDatabase } from '../src/database.js';

const issuer = 'https://identity.example.test/realms/open-data-fusion';
const audience = 'open-data-fusion-api';

describe('OIDC workspace authentication', () => {
  let tempDirectory: string;
  let database: FusionDatabase;
  let app: Express;
  let signToken: (userId: string, tokenAudience?: string) => Promise<string>;
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
    signToken = (userId, tokenAudience = audience) =>
      new SignJWT({ preferred_username: userId, name: `Test ${userId}` })
        .setProtectedHeader({ alg: 'RS256', kid: 'integration-test-key', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(tokenAudience)
        .setSubject(`subject:${userId}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-auth-'));
    database = new FusionDatabase({ path: join(tempDirectory, 'test.db') });
    app = createApp(database, new WorkspaceEventHub(), { identityProvider });
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
    const ownerToken = await signToken('harper.dennis');
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
    const token = await signToken('harper.dennis', 'another-api');
    const response = await request(app)
      .get('/api/v1/workspaces/cooling-water-system')
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
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
});
