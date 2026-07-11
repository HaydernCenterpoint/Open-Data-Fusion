import { mapPostgresError } from "./errors.js";
import {
  createPostgresPool,
  type PostgresPoolOptions,
  type RuntimePoolSettings,
} from "./pool.js";
import { PostgresIngestionRepository } from "./ingestion-repository.js";
import { PostgresQueueRepository } from "./queue-repository.js";
import { PostgresWorkspaceRepository } from "./workspace-repository.js";
import { PostgresCatalogRepository } from "./catalog-repository.js";
import { PostgresIndustrialRepository } from "./industrial-repository.js";
import { PostgresModelRepository } from "./model-repository.js";
import { PostgresPipelineQualityRepository } from "./pipeline-quality-repository.js";
import { PostgresSearchRepository } from "./search-repository.js";
import { PostgresWritebackRepository } from "./writeback-repository.js";
import { FailClosedProjectAccessResolver } from "./platform-support.js";
import type { ProjectAccessResolver } from "./platform-types.js";
import type {
  DatabaseHealth,
  DatabaseReadiness,
  RuntimeClient,
  RuntimePool,
  ScopedTransaction,
  SqlQuery,
  SqlQueryResult,
  TransactionContext,
  TransactionRunner,
} from "./types.js";

export interface PostgresRuntimeOptions extends PostgresPoolOptions {}

export interface PostgresRuntimeDependencies {
  /** Required for project-scoped repositories; defaults to fail-closed. */
  projectAccessResolver?: ProjectAccessResolver;
  /**
   * Builds a project resolver from this runtime's transaction runner. This is
   * useful for the database-backed resolver without creating a second pool.
   */
  projectAccessResolverFactory?: (runner: TransactionRunner) => ProjectAccessResolver;
}

const DEFAULT_TRANSACTION_SETTINGS: RuntimePoolSettings = {
  lockTimeoutMillis: 5_000,
  statementTimeoutMillis: 15_000,
  idleInTransactionTimeoutMillis: 30_000,
};

function duration(milliseconds: number): string {
  return String(milliseconds) + "ms";
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(label + " is required");
  return trimmed;
}

/**
 * Typed entry point for PostgreSQL access. It accepts an adapter-compatible
 * pool for recording tests and uses a short transaction for all tenant data.
 */
export class PostgresRuntime implements TransactionRunner {
  readonly workspaces: PostgresWorkspaceRepository;
  readonly ingestion: PostgresIngestionRepository;
  readonly queues: PostgresQueueRepository;
  readonly catalog: PostgresCatalogRepository;
  readonly industrial: PostgresIndustrialRepository;
  readonly models: PostgresModelRepository;
  readonly pipelines: PostgresPipelineQualityRepository;
  readonly search: PostgresSearchRepository;
  readonly writeback: PostgresWritebackRepository;

  constructor(
    private readonly pool: RuntimePool,
    private readonly settings: RuntimePoolSettings = DEFAULT_TRANSACTION_SETTINGS,
    dependencies: PostgresRuntimeDependencies = {},
  ) {
    const policy = dependencies.projectAccessResolver
      ?? dependencies.projectAccessResolverFactory?.(this)
      ?? new FailClosedProjectAccessResolver();
    this.workspaces = new PostgresWorkspaceRepository(this, policy);
    this.ingestion = new PostgresIngestionRepository(this);
    this.queues = new PostgresQueueRepository(this);
    this.catalog = new PostgresCatalogRepository(this, policy);
    this.industrial = new PostgresIndustrialRepository(this, policy);
    this.models = new PostgresModelRepository(this, policy);
    this.pipelines = new PostgresPipelineQualityRepository(this, policy);
    this.search = new PostgresSearchRepository(this, policy);
    this.writeback = new PostgresWritebackRepository(this, policy);
  }

  static connect(options: PostgresRuntimeOptions, dependencies: PostgresRuntimeDependencies = {}): PostgresRuntime {
    const created = createPostgresPool(options);
    return new PostgresRuntime(created.pool, created.settings, dependencies);
  }

  static fromPool(
    pool: RuntimePool,
    settings: Partial<RuntimePoolSettings> = {},
    dependencies: PostgresRuntimeDependencies = {},
  ): PostgresRuntime {
    return new PostgresRuntime(pool, {
      ...DEFAULT_TRANSACTION_SETTINGS,
      ...settings,
    }, dependencies);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async health(): Promise<DatabaseHealth> {
    try {
      const result = await this.pool.query<{ database: unknown }>({
        text: "SELECT current_database() AS database",
      });
      return {
        status: "ok",
        database: result.rows[0]?.database === undefined ? null : String(result.rows[0].database),
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: "degraded",
        database: null,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Uses PostgreSQL catalog visibility rather than tenant table reads so
   * readiness remains available before a request tenant is established. The
   * Canvas API also verifies the scope/membership migrations, its narrow
   * workspace grants, and the connected principal. This prevents a process
   * from reporting ready while connected as a migrator, cutover, bootstrap,
   * or outbox-publisher principal.
   */
  async readiness(): Promise<DatabaseReadiness> {
    try {
      const result = await this.pool.query<{
        schema_present: unknown;
        tenant_data_plane_present: unknown;
        workspace_scope_present: unknown;
        project_membership_present: unknown;
        workspace_grants_present: unknown;
        api_principal_attested: unknown;
      }>({
        text: [
          "SELECT",
          "  to_regclass('odf.schema_migrations') IS NOT NULL AS schema_present,",
          "  to_regclass('odf.raw_ingest_objects') IS NOT NULL AS tenant_data_plane_present,",
          "  to_regclass('odf.workspace_scopes') IS NOT NULL AS workspace_scope_present,",
          "  to_regclass('odf.project_members') IS NOT NULL AS project_membership_present,",
          "  (",
          "    has_table_privilege(current_user, 'odf.workspaces', 'SELECT')",
          "    AND has_table_privilege(current_user, 'odf.workspaces', 'UPDATE')",
          "    AND has_table_privilege(current_user, 'odf.workspace_revisions', 'SELECT')",
          "    AND has_table_privilege(current_user, 'odf.workspace_revisions', 'INSERT')",
          "    AND has_table_privilege(current_user, 'odf.workspace_members', 'SELECT')",
          "    AND has_table_privilege(current_user, 'odf.workspace_members', 'INSERT')",
          "    AND has_table_privilege(current_user, 'odf.workspace_members', 'UPDATE')",
          "    AND has_table_privilege(current_user, 'odf.workspace_members', 'DELETE')",
          "    AND has_table_privilege(current_user, 'odf.workspace_scopes', 'SELECT')",
          "    AND has_table_privilege(current_user, 'odf.project_members', 'SELECT')",
          "  ) AS workspace_grants_present,",
          "  (",
          "    NOT EXISTS (",
          "      SELECT 1 FROM pg_roles AS principal",
          "      WHERE principal.rolname IN (current_user, session_user)",
          "        AND (principal.rolsuper OR principal.rolcreatedb OR principal.rolcreaterole",
          "          OR principal.rolreplication OR principal.rolbypassrls)",
          "    )",
          "    AND pg_has_role(current_user, 'odf_app', 'member')",
          "    AND NOT pg_has_role(current_user, 'odf_outbox_publisher', 'member')",
          "    AND NOT pg_has_role(current_user, 'odf_cutover', 'member')",
          "    AND NOT pg_has_role(current_user, 'odf_tenant_provisioner', 'member')",
          "    AND NOT has_table_privilege(current_user, 'odf.workspace_scopes', 'INSERT, UPDATE, DELETE')",
          "    AND NOT has_table_privilege(current_user, 'odf.outbox_events', 'UPDATE, DELETE, TRUNCATE')",
          "  ) AS api_principal_attested",
        ].join("\n"),
      });
      const row = result.rows[0];
      const schemaPresent = row?.schema_present === true;
      const tenantDataPlanePresent = row?.tenant_data_plane_present === true;
      const workspaceScopePresent = row?.workspace_scope_present === true;
      const projectMembershipPresent = row?.project_membership_present === true;
      const workspaceGrantsPresent = row?.workspace_grants_present === true;
      const apiPrincipalAttested = row?.api_principal_attested === true;
      return {
        status: schemaPresent
          && tenantDataPlanePresent
          && workspaceScopePresent
          && projectMembershipPresent
          && workspaceGrantsPresent
          && apiPrincipalAttested
          ? "ready"
          : "not_ready",
        schemaPresent,
        tenantDataPlanePresent,
        workspaceScopePresent,
        projectMembershipPresent,
        workspaceGrantsPresent,
        apiPrincipalAttested,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: "not_ready",
        schemaPresent: false,
        tenantDataPlanePresent: false,
        workspaceScopePresent: false,
        projectMembershipPresent: false,
        workspaceGrantsPresent: false,
        apiPrincipalAttested: false,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async withTransaction<T>(
    context: TransactionContext,
    work: (transaction: ScopedTransaction) => Promise<T>,
  ): Promise<T> {
    const userId = nonEmpty(context.userId, "userId");
    const tenantId = context.tenantId === null ? "" : nonEmpty(context.tenantId, "tenantId");
    const platformAdmin = context.platformAdmin === true ? "true" : "false";
    let client: RuntimeClient | null = null;
    let began = false;
    let discardClient = false;

    try {
      const acquiredClient = await this.pool.connect();
      client = acquiredClient;
      await acquiredClient.query({ text: "BEGIN" });
      began = true;
      await this.configureTransaction(acquiredClient, tenantId, userId, platformAdmin);

      const transaction: ScopedTransaction = {
        kind: "database-transaction",
        query: <Row extends Record<string, unknown> = Record<string, unknown>>(query: SqlQuery): Promise<SqlQueryResult<Row>> => acquiredClient.query<Row>(query),
      };
      const result = await work(transaction);
      await acquiredClient.query({ text: "COMMIT" });
      return result;
    } catch (error) {
      if (began && client) {
        try {
          await client.query({ text: "ROLLBACK" });
        } catch {
          discardClient = true;
        }
      } else if (client) {
        // A connection that cannot even start a transaction may be unusable;
        // do not return it to the pool for another request.
        discardClient = true;
      }
      throw mapPostgresError(error);
    } finally {
      client?.release(discardClient);
    }
  }

  private async configureTransaction(
    client: RuntimeClient,
    tenantId: string,
    userId: string,
    platformAdmin: string,
  ): Promise<void> {
    // These use parameterized set_config calls rather than interpolated SET
    // statements. Passing true scopes every value to the current transaction.
    await client.query({
      text: "SELECT set_config('lock_timeout', $1, true)",
      values: [duration(this.settings.lockTimeoutMillis)],
    });
    await client.query({
      text: "SELECT set_config('statement_timeout', $1, true)",
      values: [duration(this.settings.statementTimeoutMillis)],
    });
    await client.query({
      text: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
      values: [duration(this.settings.idleInTransactionTimeoutMillis)],
    });
    await client.query({
      text: "SELECT set_config('odf.tenant_id', $1, true)",
      values: [tenantId],
    });
    await client.query({
      text: "SELECT set_config('odf.user_id', $1, true)",
      values: [userId],
    });
    await client.query({
      text: "SELECT set_config('odf.platform_admin', $1, true)",
      values: [platformAdmin],
    });
  }
}
