import {
  ConflictError as RuntimeConflictError,
  DatabaseUnavailableError as RuntimeDatabaseUnavailableError,
  ForbiddenError as RuntimeForbiddenError,
  NotFoundError as RuntimeNotFoundError,
  type ManagedProjectCreateInput,
  type ManagedProjectUpdateInput,
  type ManagedTenantUpdateInput,
  type PostgresRuntime,
  type ProjectMemberRecord,
  type TenantMemberRecord,
} from '@open-data-fusion/postgres-runtime';
import { z } from 'zod';

import { ConflictError, ForbiddenError, NotFoundError } from './database.js';
import { cursorListQuerySchema, type CursorListQuery } from './platform-schemas.js';
import { workspaceUserIdSchema } from './schemas.js';

const uuidSchema = z.string().uuid();
const userCursorSchema = z.object({ id: workspaceUserIdSchema }).strict();

export interface PlatformAdministrationPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PlatformTenantMember {
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'viewer';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformProjectMember {
  tenantId: string;
  projectId: string;
  userId: string;
  role: 'owner' | 'editor' | 'reviewer' | 'viewer';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformProjectAdministrationResult {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'suspended' | 'archived';
  createdAt: string;
  updatedAt: string;
  created: boolean;
  changed: boolean;
}

export interface PlatformTenantAdministrationResult {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended' | 'retired';
  createdAt: string;
  updatedAt: string;
  changed: boolean;
}

export interface PlatformAdministrationPersistence {
  readonly mode: 'postgres';
  assertReady(): Promise<void>;
  updateTenant(
    tenantId: string,
    userId: string,
    input: ManagedTenantUpdateInput,
  ): Promise<PlatformTenantAdministrationResult>;
  createProject(
    tenantId: string,
    userId: string,
    input: ManagedProjectCreateInput,
  ): Promise<PlatformProjectAdministrationResult>;
  updateProject(
    tenantId: string,
    projectId: string,
    userId: string,
    input: ManagedProjectUpdateInput,
  ): Promise<PlatformProjectAdministrationResult>;
  listTenantMembers(
    tenantId: string,
    userId: string,
    query: CursorListQuery,
  ): Promise<PlatformAdministrationPage<PlatformTenantMember>>;
  upsertTenantMember(
    tenantId: string,
    userId: string,
    memberUserId: string,
    role: PlatformTenantMember['role'],
    correlationId: string,
  ): Promise<{ member: PlatformTenantMember; created: boolean; changed: boolean }>;
  removeTenantMember(tenantId: string, userId: string, memberUserId: string, correlationId: string): Promise<void>;
  listProjectMembers(
    tenantId: string,
    projectId: string,
    userId: string,
    query: CursorListQuery,
  ): Promise<PlatformAdministrationPage<PlatformProjectMember>>;
  upsertProjectMember(
    tenantId: string,
    projectId: string,
    userId: string,
    memberUserId: string,
    role: PlatformProjectMember['role'],
    correlationId: string,
  ): Promise<{ member: PlatformProjectMember; created: boolean; changed: boolean }>;
  removeProjectMember(tenantId: string, projectId: string, userId: string, memberUserId: string, correlationId: string): Promise<void>;
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  let value: unknown = null;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // Preserve the standard Zod validation failure for malformed cursors.
  }
  return userCursorSchema.parse(value).id;
}

function encodeCursor(value: string | null): string | null {
  return value ? Buffer.from(JSON.stringify({ id: value }), 'utf8').toString('base64url') : null;
}

function textCursor(value: string | undefined): { value: string } | undefined {
  return value ? { value } : undefined;
}

function tenantMember(record: TenantMemberRecord): PlatformTenantMember {
  return {
    tenantId: record.tenantId,
    userId: record.userId,
    role: record.role,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function projectMember(record: ProjectMemberRecord): PlatformProjectMember {
  return {
    tenantId: record.tenantId,
    projectId: record.projectId,
    userId: record.userId,
    role: record.role,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function projectResult(result: Awaited<ReturnType<PostgresRuntime['administration']['createProject']>>): PlatformProjectAdministrationResult {
  return {
    id: result.project.projectId,
    tenantId: result.project.tenantId,
    slug: result.project.slug,
    name: result.project.name,
    description: result.project.description,
    status: result.project.status,
    createdAt: result.project.createdAt,
    updatedAt: result.project.updatedAt,
    created: result.created === true,
    changed: result.changed,
  };
}

function tenantResult(result: Awaited<ReturnType<PostgresRuntime['administration']['updateTenant']>>): PlatformTenantAdministrationResult {
  return {
    id: result.tenant.tenantId,
    slug: result.tenant.slug,
    name: result.tenant.name,
    status: result.tenant.status,
    createdAt: result.tenant.createdAt,
    updatedAt: result.tenant.updatedAt,
    changed: result.changed,
  };
}

function translateRuntimeError(error: unknown): Error {
  if (error instanceof RuntimeForbiddenError) return new ForbiddenError(error.message);
  if (error instanceof RuntimeNotFoundError) return new NotFoundError(error.message);
  if (error instanceof RuntimeConflictError) return new ConflictError(error.message);
  if (error instanceof RuntimeDatabaseUnavailableError) return error;
  return error instanceof Error ? error : new Error('PostgreSQL platform administration failed');
}

/** PostgreSQL implementation of the user-facing tenant/project admin boundary. */
export class PostgresPlatformAdministrationPersistence implements PlatformAdministrationPersistence {
  readonly mode = 'postgres' as const;

  constructor(private readonly runtime: PostgresRuntime) {}

  async assertReady(): Promise<void> {
    try {
      const ready = await this.runtime.withTransaction({
        tenantId: null,
        userId: 'odf-api-administration-readiness',
        platformAdmin: false,
      }, async (transaction) => transaction.query<{ ready: unknown }>({
        text: [
          'SELECT (',
          "  to_regclass('odf.tenant_administration_events') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_update_tenant(text,text,uuid)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_create_project(uuid,text,text,text,uuid)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_update_project(uuid,text,text,boolean,text,uuid)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_list_tenant_members(text,integer)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_upsert_tenant_member(text,text,uuid)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_remove_tenant_member(text,uuid)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_list_project_members(text,integer)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_upsert_project_member(text,text,uuid)') IS NOT NULL",
          "  AND to_regprocedure('odf.admin_remove_project_member(text,uuid)') IS NOT NULL",
          "  AND has_function_privilege(current_user, 'odf.admin_create_project(uuid,text,text,text,uuid)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_update_tenant(text,text,uuid)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_update_project(uuid,text,text,boolean,text,uuid)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_list_tenant_members(text,integer)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_upsert_tenant_member(text,text,uuid)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_remove_tenant_member(text,uuid)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_list_project_members(text,integer)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_upsert_project_member(text,text,uuid)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.admin_remove_project_member(text,uuid)', 'EXECUTE')",
          ') AS ready',
        ].join('\n'),
      }));
      if (ready.rows[0]?.ready !== true) {
        throw new Error('PostgreSQL tenant/project administration is not ready');
      }
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async updateTenant(
    rawTenantId: string,
    userId: string,
    input: ManagedTenantUpdateInput,
  ): Promise<PlatformTenantAdministrationResult> {
    const tenantId = uuidSchema.parse(rawTenantId);
    try {
      return tenantResult(await this.runtime.administration.updateTenant({ tenantId, userId }, input));
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async createProject(
    rawTenantId: string,
    userId: string,
    input: ManagedProjectCreateInput,
  ): Promise<PlatformProjectAdministrationResult> {
    const tenantId = uuidSchema.parse(rawTenantId);
    const projectId = uuidSchema.parse(input.projectId);
    try {
      return projectResult(await this.runtime.administration.createProject({ tenantId, userId }, {
        ...input,
        projectId,
      }));
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async updateProject(
    rawTenantId: string,
    rawProjectId: string,
    userId: string,
    input: ManagedProjectUpdateInput,
  ): Promise<PlatformProjectAdministrationResult> {
    const tenantId = uuidSchema.parse(rawTenantId);
    const projectId = uuidSchema.parse(rawProjectId);
    try {
      const result = await this.runtime.administration.updateProject({ tenantId, projectId, userId }, input);
      return projectResult(result);
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async listTenantMembers(
    rawTenantId: string,
    userId: string,
    rawQuery: CursorListQuery,
  ): Promise<PlatformAdministrationPage<PlatformTenantMember>> {
    const tenantId = uuidSchema.parse(rawTenantId);
    const query = cursorListQuerySchema.parse(rawQuery);
    try {
      const page = await this.runtime.administration.listTenantMembers(
        { tenantId, userId },
        query.limit,
        textCursor(decodeCursor(query.cursor)),
      );
      return { items: page.items.map(tenantMember), nextCursor: encodeCursor(page.nextCursor?.value ?? null) };
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async upsertTenantMember(
    rawTenantId: string,
    userId: string,
    memberUserId: string,
    role: PlatformTenantMember['role'],
    correlationId: string,
  ): Promise<{ member: PlatformTenantMember; created: boolean; changed: boolean }> {
    const tenantId = uuidSchema.parse(rawTenantId);
    try {
      const result = await this.runtime.administration.upsertTenantMember({ tenantId, userId }, {
        userId: workspaceUserIdSchema.parse(memberUserId),
        role,
        correlationId,
      });
      return { member: tenantMember(result.member), created: result.created, changed: result.changed };
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async removeTenantMember(rawTenantId: string, userId: string, memberUserId: string, correlationId: string): Promise<void> {
    const tenantId = uuidSchema.parse(rawTenantId);
    try {
      await this.runtime.administration.removeTenantMember(
        { tenantId, userId },
        workspaceUserIdSchema.parse(memberUserId),
        correlationId,
      );
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async listProjectMembers(
    rawTenantId: string,
    rawProjectId: string,
    userId: string,
    rawQuery: CursorListQuery,
  ): Promise<PlatformAdministrationPage<PlatformProjectMember>> {
    const tenantId = uuidSchema.parse(rawTenantId);
    const projectId = uuidSchema.parse(rawProjectId);
    const query = cursorListQuerySchema.parse(rawQuery);
    try {
      const page = await this.runtime.administration.listProjectMembers(
        { tenantId, projectId, userId },
        query.limit,
        textCursor(decodeCursor(query.cursor)),
      );
      return { items: page.items.map(projectMember), nextCursor: encodeCursor(page.nextCursor?.value ?? null) };
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async upsertProjectMember(
    rawTenantId: string,
    rawProjectId: string,
    userId: string,
    memberUserId: string,
    role: PlatformProjectMember['role'],
    correlationId: string,
  ): Promise<{ member: PlatformProjectMember; created: boolean; changed: boolean }> {
    const tenantId = uuidSchema.parse(rawTenantId);
    const projectId = uuidSchema.parse(rawProjectId);
    try {
      const result = await this.runtime.administration.upsertProjectMember({ tenantId, projectId, userId }, {
        userId: workspaceUserIdSchema.parse(memberUserId),
        role,
        correlationId,
      });
      return { member: projectMember(result.member), created: result.created, changed: result.changed };
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async removeProjectMember(
    rawTenantId: string,
    rawProjectId: string,
    userId: string,
    memberUserId: string,
    correlationId: string,
  ): Promise<void> {
    const tenantId = uuidSchema.parse(rawTenantId);
    const projectId = uuidSchema.parse(rawProjectId);
    try {
      await this.runtime.administration.removeProjectMember(
        { tenantId, projectId, userId },
        workspaceUserIdSchema.parse(memberUserId),
        correlationId,
      );
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }
}
