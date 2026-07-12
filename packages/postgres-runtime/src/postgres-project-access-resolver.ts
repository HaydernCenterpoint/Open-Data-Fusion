import { ForbiddenError } from "./errors.js";
import type {
  ProjectAccessResolver,
  ProjectRole,
  ProjectScope,
  TenantScope,
} from "./platform-types.js";
import type { TransactionRunner } from "./types.js";

const PROJECT_ROLES = new Set<ProjectRole>(["owner", "editor", "reviewer", "viewer"]);

/**
 * Durable, fail-closed project authorization backed by migration 005.
 *
 * The query runs through the same transaction runner as application data, so
 * `SET LOCAL odf.tenant_id` is always set before row-level security evaluates
 * a membership row.  A missing, malformed, or inaccessible row is denied.
 */
export class PostgresProjectAccessResolver implements ProjectAccessResolver {
  constructor(private readonly runner: TransactionRunner) {}

  async resolve(scope: ProjectScope): Promise<{ role: ProjectRole } | null> {
    if (!scope.tenantId.trim() || !scope.projectId.trim() || !scope.userId.trim()) {
      throw new ForbiddenError("Tenant, project, and user context are required");
    }
    return this.runner.withTransaction({ tenantId: scope.tenantId, userId: scope.userId }, async (transaction) => {
      const result = await transaction.query<{ role: unknown }>({
        text: [
          "SELECT member.role",
          "FROM odf.project_members AS member",
          "JOIN odf.projects AS project",
          "  ON project.tenant_id = member.tenant_id AND project.project_id = member.project_id",
          "JOIN odf.tenants AS tenant ON tenant.tenant_id = project.tenant_id",
          "WHERE member.tenant_id = $1::uuid",
          "  AND member.project_id = $2::uuid",
          "  AND member.user_id = $3",
          "  AND tenant.status = 'active'",
          "  AND project.status = 'active'",
          "LIMIT 1",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, scope.userId],
      });
      const role = result.rows[0]?.role;
      return typeof role === "string" && PROJECT_ROLES.has(role as ProjectRole)
        ? { role: role as ProjectRole }
        : null;
    });
  }

  async resolveTenantManagement(scope: TenantScope): Promise<{ canManageProjects: boolean } | null> {
    if (!scope.tenantId.trim() || !scope.userId.trim()) {
      throw new ForbiddenError("Tenant and user context are required");
    }
    return this.runner.withTransaction({ tenantId: scope.tenantId, userId: scope.userId }, async (transaction) => {
      const result = await transaction.query<{ role: unknown }>({
        text: [
          "SELECT role",
          "FROM odf.tenant_members",
          "WHERE tenant_id = $1::uuid",
          "  AND user_id = $2",
          "LIMIT 1",
        ].join("\n"),
        values: [scope.tenantId, scope.userId],
      });
      const role = result.rows[0]?.role;
      return { canManageProjects: role === "owner" || role === "admin" };
    });
  }
}
