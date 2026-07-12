import { NotFoundError } from "./errors.js";
import {
  projectFromRow,
  projectMemberFromRow,
  requiredRowBoolean,
  tenantMemberFromRow,
  tenantFromRow,
} from "./platform-mappers.js";
import {
  assertProjectScope,
  assertTenantScope,
  boundedPageSize,
  pageFromRows,
  requiredText,
} from "./platform-support.js";
import type {
  ManagedMemberMutation,
  ManagedProjectCreateInput,
  ManagedProjectMutation,
  ManagedProjectUpdateInput,
  ManagedTenantMutation,
  ManagedTenantUpdateInput,
  ProjectMemberRecord,
  ProjectMemberUpsertInput,
  ProjectScope,
  TenantMemberRecord,
  TenantMemberUpsertInput,
  TenantProjectAdministrationRepository,
  TenantScope,
  TextCursor,
} from "./platform-types.js";
import type { KeysetPage, TransactionContext, TransactionRunner } from "./types.js";

const PROJECT_COLUMNS = "project_id, tenant_id, slug, name, description, status, created_at, updated_at";

function firstRow(result: { rows: Record<string, unknown>[] }, label: string): Record<string, unknown> {
  const row = result.rows[0];
  if (!row) throw new Error("PostgreSQL tenant/project administration did not return " + label);
  return row;
}

function textCursor(value: string | undefined): TextCursor | undefined {
  return value ? { value } : undefined;
}

function tenantContext(scope: TenantScope): TransactionContext {
  return {
    tenantId: scope.tenantId,
    userId: scope.userId,
    ...(scope.platformAdmin !== undefined ? { platformAdmin: scope.platformAdmin } : {}),
  };
}

/**
 * Migration 012 administration routines form a narrow mutation boundary.
 * This repository never issues direct INSERT/UPDATE/DELETE statements against
 * tenant/project or membership relations, even though the caller uses an
 * application role that can read its own tenant scope for authorization.
 */
export class PostgresTenantProjectAdministrationRepository implements TenantProjectAdministrationRepository {
  constructor(private readonly runner: TransactionRunner) {}

  async updateTenant(scope: TenantScope, input: ManagedTenantUpdateInput): Promise<ManagedTenantMutation> {
    assertTenantScope(scope);
    requiredText(input.correlationId, "correlationId");
    if (input.name === undefined && input.status === undefined) {
      throw new RangeError("at least one tenant field is required");
    }
    return this.runner.withTransaction(tenantContext(scope), async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT tenant_id, slug, name, status, created_at, updated_at, changed",
          "FROM odf.admin_update_tenant($1, $2, $3::uuid)",
        ].join("\n"),
        values: [input.name ?? null, input.status ?? null, input.correlationId],
      });
      const row = firstRow(result, "a tenant");
      return { tenant: tenantFromRow(row), changed: requiredRowBoolean(row, "changed") };
    });
  }

  async createProject(scope: TenantScope, input: ManagedProjectCreateInput): Promise<ManagedProjectMutation> {
    assertTenantScope(scope);
    requiredText(input.projectId, "projectId");
    requiredText(input.slug, "slug");
    requiredText(input.name, "name");
    requiredText(input.correlationId, "correlationId");
    return this.runner.withTransaction(tenantContext(scope), async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + PROJECT_COLUMNS + ", created",
          "FROM odf.admin_create_project($1::uuid, $2, $3, $4, $5::uuid)",
        ].join("\n"),
        values: [
          input.projectId,
          input.slug,
          input.name,
          input.description ?? null,
          input.correlationId,
        ],
      });
      const row = firstRow(result, "a project");
      const created = requiredRowBoolean(row, "created");
      return { project: projectFromRow(row), created, changed: created };
    });
  }

  async updateProject(scope: ProjectScope, input: ManagedProjectUpdateInput): Promise<ManagedProjectMutation> {
    assertProjectScope(scope);
    requiredText(input.correlationId, "correlationId");
    if (input.name === undefined && input.description === undefined && input.status === undefined) {
      throw new RangeError("at least one project field is required");
    }
    return this.runner.withTransaction(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + PROJECT_COLUMNS + ", changed",
          "FROM odf.admin_update_project($1::uuid, $2, $3, $4::boolean, $5, $6::uuid)",
        ].join("\n"),
        values: [
          scope.projectId,
          input.name ?? null,
          input.description ?? null,
          input.description !== undefined,
          input.status ?? null,
          input.correlationId,
        ],
      });
      const row = firstRow(result, "a project");
      return { project: projectFromRow(row), changed: requiredRowBoolean(row, "changed") };
    });
  }

  async listTenantMembers(
    scope: TenantScope,
    limit: number,
    cursor?: TextCursor,
  ): Promise<KeysetPage<TenantMemberRecord, TextCursor>> {
    assertTenantScope(scope);
    const bounded = boundedPageSize(limit);
    return this.runner.withTransaction(tenantContext(scope), async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT tenant_id, user_id, role, created_by, created_at, updated_at",
          "FROM odf.admin_list_tenant_members($1, $2::integer)",
          "ORDER BY user_id",
        ].join("\n"),
        values: [cursor?.value ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, tenantMemberFromRow, (member) => ({ value: member.userId }));
    });
  }

  async upsertTenantMember(
    scope: TenantScope,
    input: TenantMemberUpsertInput,
  ): Promise<ManagedMemberMutation<TenantMemberRecord>> {
    assertTenantScope(scope);
    requiredText(input.userId, "userId");
    requiredText(input.correlationId, "correlationId");
    return this.runner.withTransaction(tenantContext(scope), async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT tenant_id, user_id, role, created_by, created_at, updated_at, created, changed",
          "FROM odf.admin_upsert_tenant_member($1, $2, $3::uuid)",
        ].join("\n"),
        values: [input.userId, input.role, input.correlationId],
      });
      const row = firstRow(result, "a tenant member");
      return {
        member: tenantMemberFromRow(row),
        created: requiredRowBoolean(row, "created"),
        changed: requiredRowBoolean(row, "changed"),
      };
    });
  }

  async removeTenantMember(scope: TenantScope, userId: string, correlationId: string): Promise<void> {
    assertTenantScope(scope);
    requiredText(userId, "userId");
    requiredText(correlationId, "correlationId");
    await this.runner.withTransaction(tenantContext(scope), async (transaction) => {
      const result = await transaction.query({
        text: "SELECT removed FROM odf.admin_remove_tenant_member($1, $2::uuid)",
        values: [userId, correlationId],
      });
      if (!requiredRowBoolean(firstRow(result, "a removal result"), "removed")) {
        throw new NotFoundError("Tenant member was not found");
      }
    });
  }

  async listProjectMembers(
    scope: ProjectScope,
    limit: number,
    cursor?: TextCursor,
  ): Promise<KeysetPage<ProjectMemberRecord, TextCursor>> {
    assertProjectScope(scope);
    const bounded = boundedPageSize(limit);
    return this.runner.withTransaction(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT tenant_id, project_id, user_id, role, created_by, created_at, updated_at",
          "FROM odf.admin_list_project_members($1, $2::integer)",
          "ORDER BY user_id",
        ].join("\n"),
        values: [cursor?.value ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, projectMemberFromRow, (member) => ({ value: member.userId }));
    });
  }

  async upsertProjectMember(
    scope: ProjectScope,
    input: ProjectMemberUpsertInput,
  ): Promise<ManagedMemberMutation<ProjectMemberRecord>> {
    assertProjectScope(scope);
    requiredText(input.userId, "userId");
    requiredText(input.correlationId, "correlationId");
    return this.runner.withTransaction(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT tenant_id, project_id, user_id, role, created_by, created_at, updated_at, created, changed",
          "FROM odf.admin_upsert_project_member($1, $2, $3::uuid)",
        ].join("\n"),
        values: [input.userId, input.role, input.correlationId],
      });
      const row = firstRow(result, "a project member");
      return {
        member: projectMemberFromRow(row),
        created: requiredRowBoolean(row, "created"),
        changed: requiredRowBoolean(row, "changed"),
      };
    });
  }

  async removeProjectMember(scope: ProjectScope, userId: string, correlationId: string): Promise<void> {
    assertProjectScope(scope);
    requiredText(userId, "userId");
    requiredText(correlationId, "correlationId");
    await this.runner.withTransaction(scope, async (transaction) => {
      const result = await transaction.query({
        text: "SELECT removed FROM odf.admin_remove_project_member($1, $2::uuid)",
        values: [userId, correlationId],
      });
      if (!requiredRowBoolean(firstRow(result, "a removal result"), "removed")) {
        throw new NotFoundError("Project member was not found");
      }
    });
  }
}

export { textCursor };
