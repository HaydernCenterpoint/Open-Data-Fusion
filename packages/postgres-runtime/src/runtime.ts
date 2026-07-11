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
    const policy = dependencies.projectAccessResolver ?? new FailClosedProjectAccessResolver();
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
   * Uses PostgreSQL catalog visibility rather than application-table reads so
   * readiness remains available to a least-privilege login before any tenant
   * context is established.
   */
  async readiness(): Promise<DatabaseReadiness> {
    try {
      const result = await this.pool.query<{ schema_present: unknown; tenant_data_plane_present: unknown }>({
        text: [
          "SELECT",
          "  to_regclass('odf.schema_migrations') IS NOT NULL AS schema_present,",
          "  to_regclass('odf.raw_ingest_objects') IS NOT NULL AS tenant_data_plane_present",
        ].join("\n"),
      });
      const row = result.rows[0];
      const schemaPresent = row?.schema_present === true;
      const tenantDataPlanePresent = row?.tenant_data_plane_present === true;
      return {
        status: schemaPresent && tenantDataPlanePresent ? "ready" : "not_ready",
        schemaPresent,
        tenantDataPlanePresent,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: "not_ready",
        schemaPresent: false,
        tenantDataPlanePresent: false,
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
