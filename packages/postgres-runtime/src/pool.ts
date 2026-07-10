import { Pool, type PoolClient, type PoolConfig, type QueryConfig } from "pg";

import type {
  RuntimeClient,
  RuntimePool,
  SqlQuery,
  SqlQueryResult,
} from "./types.js";

const DEFAULT_POOL_MAX = 10;
const MAX_POOL_MAX = 50;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

export interface PostgresPoolOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
  idleInTransactionTimeoutMillis?: number;
  applicationName?: string;
  ssl?: PoolConfig["ssl"];
}

export interface RuntimePoolSettings {
  lockTimeoutMillis: number;
  statementTimeoutMillis: number;
  idleInTransactionTimeoutMillis: number;
}

export interface CreatedPostgresPool {
  pool: RuntimePool;
  settings: RuntimePoolSettings;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(label + " must be an integer between " + String(minimum) + " and " + String(maximum));
  }
  return resolved;
}

class NodePgClient implements RuntimeClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(query: SqlQuery): Promise<SqlQueryResult<Row>> {
    const config: QueryConfig<unknown[]> = {
      text: query.text,
      ...(query.values ? { values: [...query.values] } : {}),
    };
    const result = await this.client.query(config);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount,
    };
  }

  release(error?: boolean): void {
    this.client.release(error);
  }
}

class NodePgPool implements RuntimePool {
  constructor(private readonly pool: Pool) {}

  async connect(): Promise<RuntimeClient> {
    return new NodePgClient(await this.pool.connect());
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(query: SqlQuery): Promise<SqlQueryResult<Row>> {
    const config: QueryConfig<unknown[]> = {
      text: query.text,
      ...(query.values ? { values: [...query.values] } : {}),
    };
    const result = await this.pool.query(config);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount,
    };
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

/**
 * Creates a deliberately small pool. Production clusters should put a
 * transaction pooler in front of PostgreSQL rather than increasing max.
 */
export function createPostgresPool(options: PostgresPoolOptions): CreatedPostgresPool {
  if (!options.connectionString.trim()) throw new Error("connectionString is required");

  const max = boundedInteger(options.max, DEFAULT_POOL_MAX, 1, MAX_POOL_MAX, "max");
  const idleTimeoutMillis = boundedInteger(options.idleTimeoutMillis, DEFAULT_IDLE_TIMEOUT_MS, 1_000, 600_000, "idleTimeoutMillis");
  const connectionTimeoutMillis = boundedInteger(options.connectionTimeoutMillis, DEFAULT_CONNECTION_TIMEOUT_MS, 100, 120_000, "connectionTimeoutMillis");
  const statementTimeoutMillis = boundedInteger(options.statementTimeoutMillis, DEFAULT_STATEMENT_TIMEOUT_MS, 100, 120_000, "statementTimeoutMillis");
  const lockTimeoutMillis = boundedInteger(
    options.lockTimeoutMillis,
    Math.min(DEFAULT_LOCK_TIMEOUT_MS, statementTimeoutMillis),
    100,
    statementTimeoutMillis,
    "lockTimeoutMillis",
  );
  const idleInTransactionTimeoutMillis = boundedInteger(
    options.idleInTransactionTimeoutMillis,
    DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    1_000,
    300_000,
    "idleInTransactionTimeoutMillis",
  );

  const pool = new Pool({
    connectionString: options.connectionString,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    statement_timeout: statementTimeoutMillis,
    lock_timeout: lockTimeoutMillis,
    idle_in_transaction_session_timeout: idleInTransactionTimeoutMillis,
    application_name: options.applicationName ?? "open-data-fusion-runtime",
    ...(options.ssl ? { ssl: options.ssl } : {}),
  });
  return {
    pool: new NodePgPool(pool),
    settings: {
      lockTimeoutMillis,
      statementTimeoutMillis,
      idleInTransactionTimeoutMillis,
    },
  };
}
