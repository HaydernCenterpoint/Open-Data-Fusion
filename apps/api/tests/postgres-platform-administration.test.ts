import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ManagedProjectCreateInput,
  ManagedProjectUpdateInput,
  ManagedTenantUpdateInput,
} from '@open-data-fusion/postgres-runtime';
import type { Request } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { DATA_PLANE_PERMISSIONS, type AuthenticatedIdentity, type IdentityProvider } from '../src/auth.js';
import { FusionDatabase } from '../src/database.js';
import type {
  PlatformAdministrationPersistence,
  PlatformProjectMember,
  PlatformProjectAdministrationResult,
  PlatformTenantAdministrationResult,
  PlatformTenantMember,
} from '../src/platform-administration.js';
import type { PlatformDiscoveryPersistence } from '../src/platform-discovery.js';

const tenantId = '11111111-1111-1111-1111-111111111111';
const projectId = '22222222-2222-2222-2222-222222222222';
const newProjectId = '33333333-3333-3333-3333-333333333333';

class TestIdentityProvider implements IdentityProvider {
  readonly mode = 'oidc' as const;

  async authenticate(incoming: Request): Promise<AuthenticatedIdentity> {
    const userId = incoming.header('x-test-user') ?? 'tenant.owner@example.test';
    return {
      userId,
      displayName: userId,
      permissions: new Set(DATA_PLANE_PERMISSIONS),
    };
  }
}

function projectResult(id = projectId): PlatformProjectAdministrationResult {
  return {
    id,
    tenantId,
    slug: id,
    name: 'Operations',
    description: 'Live data',
    status: 'active',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    created: id === newProjectId,
    changed: true,
  };
}

function tenantResult(): PlatformTenantAdministrationResult {
  return {
    id: tenantId,
    slug: 'tenant-one',
    name: 'Tenant One',
    status: 'active',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    changed: true,
  };
}

function tenantMember(userId: string): PlatformTenantMember {
  return {
    tenantId,
    userId,
    role: 'viewer',
    createdBy: 'tenant.owner@example.test',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
}

function projectMember(userId: string): PlatformProjectMember {
  return {
    tenantId,
    projectId,
    userId,
    role: 'viewer',
    createdBy: 'tenant.owner@example.test',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  };
}

function administration() {
  const updateTenant = vi.fn(async (_tenant: string, _actor: string, _input: ManagedTenantUpdateInput) => tenantResult());
  const createProject = vi.fn(async (_tenant: string, _actor: string, input: ManagedProjectCreateInput) => projectResult(input.projectId));
  const updateProject = vi.fn(async (_tenant: string, project: string, _actor: string, _input: ManagedProjectUpdateInput) => projectResult(project));
  const listTenantMembers = vi.fn(async () => ({ items: [tenantMember('tenant.viewer@example.test')], nextCursor: null }));
  const upsertTenantMember = vi.fn(async (_tenant: string, _actor: string, userId: string) => ({
    member: tenantMember(userId), created: true, changed: true,
  }));
  const removeTenantMember = vi.fn(async () => undefined);
  const listProjectMembers = vi.fn(async () => ({ items: [projectMember('project.viewer@example.test')], nextCursor: null }));
  const upsertProjectMember = vi.fn(async (_tenant: string, _project: string, _actor: string, userId: string) => ({
    member: projectMember(userId), created: true, changed: true,
  }));
  const removeProjectMember = vi.fn(async () => undefined);
  const store: PlatformAdministrationPersistence = {
    mode: 'postgres',
    assertReady: async () => undefined,
    updateTenant,
    createProject,
    updateProject,
    listTenantMembers,
    upsertTenantMember,
    removeTenantMember,
    listProjectMembers,
    upsertProjectMember,
    removeProjectMember,
  };
  return { store, updateTenant, createProject, updateProject, listTenantMembers, upsertTenantMember, removeTenantMember, listProjectMembers, upsertProjectMember, removeProjectMember };
}

describe('PostgreSQL tenant/project administration routes', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('uses PostgreSQL administration for project and membership mutations without a shadow SQLite fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open-data-fusion-pg-admin-'));
    directories.push(directory);
    const database = new FusionDatabase({ path: join(directory, 'test.db'), seed: false });
    const pgDiscovery: PlatformDiscoveryPersistence = {
      mode: 'postgres',
      listTenants: async () => ({ items: [], nextCursor: null }),
      listProjects: async () => ({ items: [], nextCursor: null }),
    };
    const admin = administration();
    const app = createApp(database, undefined, {
      identityProvider: new TestIdentityProvider(),
      platformDiscovery: pgDiscovery,
      platformAdministration: admin.store,
    });

    const created = await request(app)
      .post(`/api/v1/platform/tenants/${tenantId}/projects`)
      .set('x-test-user', 'tenant.owner@example.test')
      .send({ id: newProjectId, name: 'Operations' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: newProjectId, tenantId, created: true });
    expect(admin.createProject).toHaveBeenCalledWith(tenantId, 'tenant.owner@example.test', expect.objectContaining({
      projectId: newProjectId,
      slug: newProjectId,
      correlationId: expect.any(String),
    }));

    const tenantUpdated = await request(app)
      .patch(`/api/v1/platform/tenants/${tenantId}`)
      .set('x-test-user', 'tenant.owner@example.test')
      .send({ status: 'suspended' });
    expect(tenantUpdated.status).toBe(200);
    expect(admin.updateTenant).toHaveBeenCalledWith(tenantId, 'tenant.owner@example.test', expect.objectContaining({ status: 'suspended' }));

    const updated = await request(app)
      .patch(`/api/v1/platform/tenants/${tenantId}/projects/${projectId}`)
      .set('x-test-user', 'tenant.owner@example.test')
      .send({ status: 'suspended' });
    expect(updated.status).toBe(200);
    expect(admin.updateProject).toHaveBeenCalledWith(tenantId, projectId, 'tenant.owner@example.test', expect.objectContaining({ status: 'suspended' }));

    const tenantMembers = await request(app)
      .get(`/api/v1/platform/tenants/${tenantId}/members`)
      .set('x-test-user', 'tenant.owner@example.test');
    expect(tenantMembers.status).toBe(200);
    expect(tenantMembers.body.items[0]).toMatchObject({ userId: 'tenant.viewer@example.test', role: 'viewer' });

    const createdTenantMember = await request(app)
      .put(`/api/v1/platform/tenants/${tenantId}/members/new.admin@example.test`)
      .set('x-test-user', 'tenant.owner@example.test')
      .send({ role: 'admin' });
    expect(createdTenantMember.status).toBe(201);
    expect(admin.upsertTenantMember).toHaveBeenCalledWith(
      tenantId,
      'tenant.owner@example.test',
      'new.admin@example.test',
      'admin',
      expect.any(String),
    );

    const members = await request(app)
      .get('/api/v1/platform/project/members')
      .set('x-test-user', 'tenant.owner@example.test')
      .set('x-odf-tenant-id', tenantId)
      .set('x-odf-project-id', projectId);
    expect(members.status).toBe(200);
    expect(members.body.items[0]).toMatchObject({ userId: 'project.viewer@example.test' });

    const added = await request(app)
      .put('/api/v1/platform/project/members/new.project@example.test')
      .set('x-test-user', 'tenant.owner@example.test')
      .set('x-odf-tenant-id', tenantId)
      .set('x-odf-project-id', projectId)
      .send({ role: 'viewer' });
    expect(added.status).toBe(201);
    expect(admin.upsertProjectMember).toHaveBeenCalledWith(
      tenantId,
      projectId,
      'tenant.owner@example.test',
      'new.project@example.test',
      'viewer',
      expect.any(String),
    );

    const removed = await request(app)
      .delete('/api/v1/platform/project/members/new.project@example.test')
      .set('x-test-user', 'tenant.owner@example.test')
      .set('x-odf-tenant-id', tenantId)
      .set('x-odf-project-id', projectId);
    expect(removed.status).toBe(204);
    expect(admin.removeProjectMember).toHaveBeenCalledWith(
      tenantId,
      projectId,
      'tenant.owner@example.test',
      'new.project@example.test',
      expect.any(String),
    );

    database.close();
  });
});
