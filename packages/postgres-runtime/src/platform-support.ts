import { ForbiddenError } from "./errors.js";
import type {
  KeysetPage,
} from "./types.js";
import type {
  ProjectAccessResolver,
  ProjectRole,
  ProjectScope,
  TenantScope,
} from "./platform-types.js";

export const READ_ROLES: readonly ProjectRole[] = ["owner", "editor", "reviewer", "viewer"];
export const WRITE_ROLES: readonly ProjectRole[] = ["owner", "editor"];
export const REVIEW_ROLES: readonly ProjectRole[] = ["owner", "reviewer"];

/** Missing identity integration must deny rather than silently allow access. */
export class FailClosedProjectAccessResolver implements ProjectAccessResolver {
  async resolve(_scope: ProjectScope): Promise<{ role: ProjectRole } | null> {
    return null;
  }
}

export function assertProjectScope(scope: ProjectScope): void {
  if (!scope.tenantId.trim() || !scope.projectId.trim() || !scope.userId.trim()) {
    throw new ForbiddenError("Tenant, project, and user context are required");
  }
}

export function assertTenantScope(scope: TenantScope): void {
  if (!scope.tenantId.trim() || !scope.userId.trim()) {
    throw new ForbiddenError("Tenant and user context are required");
  }
}

export async function authorizeTenantManagement(
  resolver: ProjectAccessResolver,
  scope: TenantScope,
): Promise<void> {
  assertTenantScope(scope);
  const decision = await resolver.resolveTenantManagement?.(scope);
  if (!decision?.canManageProjects) {
    throw new ForbiddenError("Tenant policy does not permit project management");
  }
}

export async function authorizeProject(
  resolver: ProjectAccessResolver,
  scope: ProjectScope,
  allowedRoles: readonly ProjectRole[],
): Promise<ProjectRole> {
  assertProjectScope(scope);
  // A resolver may be backed by an identity service. It is intentionally
  // called before a database transaction, keeping lock duration minimal.
  const decision = await resolver.resolve(scope);
  if (!decision || !allowedRoles.includes(decision.role)) {
    throw new ForbiddenError("Project policy does not permit this operation");
  }
  return decision.role;
}

export function boundedPageSize(limit: number, maximum = 200): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError("limit must be an integer between 1 and " + String(maximum));
  }
  return limit;
}

export function pageFromRows<Source, Output, Cursor>(
  rows: readonly Source[],
  limit: number,
  mapper: (row: Source) => Output,
  cursorFor: (row: Output) => Cursor,
): KeysetPage<Output, Cursor> {
  const page = rows.slice(0, limit).map(mapper);
  const tail = page.at(-1);
  return {
    items: page,
    nextCursor: rows.length > limit && tail ? cursorFor(tail) : null,
  };
}

export function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new RangeError(label + " is required");
  return text;
}

export function cleanOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  return text || null;
}
