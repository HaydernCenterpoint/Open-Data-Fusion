import type { ScopedTransaction, TransactionRunner } from "./types.js";
import {
  READ_ROLES,
  REVIEW_ROLES,
  WRITE_ROLES,
  authorizeProject,
} from "./platform-support.js";
import type {
  ProjectAccessResolver,
  ProjectRole,
  ProjectScope,
} from "./platform-types.js";

/** Shared policy boundary for migration-003 project data. */
export abstract class PolicyAwareRepository {
  protected constructor(
    protected readonly runner: TransactionRunner,
    protected readonly policy: ProjectAccessResolver,
  ) {}

  protected async read<T>(scope: ProjectScope, work: (transaction: ScopedTransaction) => Promise<T>): Promise<T> {
    await authorizeProject(this.policy, scope, READ_ROLES);
    return this.runner.withTransaction(scope, work);
  }

  protected async write<T>(scope: ProjectScope, work: (transaction: ScopedTransaction) => Promise<T>): Promise<T> {
    await authorizeProject(this.policy, scope, WRITE_ROLES);
    return this.runner.withTransaction(scope, work);
  }

  protected async review<T>(scope: ProjectScope, work: (transaction: ScopedTransaction) => Promise<T>): Promise<T> {
    await authorizeProject(this.policy, scope, REVIEW_ROLES);
    return this.runner.withTransaction(scope, work);
  }

  protected async resolveRole(scope: ProjectScope, allowedRoles: readonly ProjectRole[] = READ_ROLES): Promise<ProjectRole> {
    return authorizeProject(this.policy, scope, allowedRoles);
  }
}
