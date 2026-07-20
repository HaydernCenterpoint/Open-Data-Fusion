import { Pool, type PoolConfig } from "pg";

import type { PostgresConnectorConfig } from "../config.js";
import { mapTabularRecords } from "../mapping.js";
import type { ConnectorBatch, EdgeConnector } from "../types.js";

export interface PostgresQuerySource {
  query(text: string, values: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  close(): Promise<void>;
}

export interface PgPoolSourceOptions {
  connectionString: string;
  sourceSystem: string;
  statementTimeoutMs: number;
  ssl?: { rejectUnauthorized: boolean; ca?: string };
}

export class PgPoolSource implements PostgresQuerySource {
  private readonly pool: Pool;

  constructor(options: PgPoolSourceOptions) {
    const poolConfig: PoolConfig = {
      connectionString: options.connectionString,
      max: 1,
      application_name: `open-data-fusion-edge-${options.sourceSystem}`,
      statement_timeout: options.statementTimeoutMs,
      query_timeout: options.statementTimeoutMs,
      options: "-c default_transaction_read_only=on",
    };
    if (options.ssl) poolConfig.ssl = options.ssl;
    this.pool = new Pool(poolConfig);
  }

  async query(text: string, values: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    const result = await this.pool.query<Record<string, unknown>>(text, [...values]);
    return { rows: result.rows };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface PostgresConnectorDependencies {
  now?: () => Date;
}

function checkpointValue(value: unknown, column: string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`PostgreSQL checkpoint column '${column}' contains an invalid date`);
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`PostgreSQL checkpoint column '${column}' contains a non-finite number`);
    return String(value);
  }
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`PostgreSQL checkpoint column '${column}' must contain a non-empty string, finite number, or date`);
}

function compareCheckpointValues(left: unknown, right: unknown): number {
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    if (/^[+-]?\d+$/.test(left) && /^[+-]?\d+$/.test(right)) {
      const leftInteger = BigInt(left);
      const rightInteger = BigInt(right);
      return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
    }
    if (
      /^\d{4}-\d{2}-\d{2}T/.test(left) &&
      /^\d{4}-\d{2}-\d{2}T/.test(right) &&
      Number.isFinite(Date.parse(left)) &&
      Number.isFinite(Date.parse(right))
    ) {
      return Date.parse(left) - Date.parse(right);
    }
    return left.localeCompare(right);
  }
  return checkpointValue(left, "configured checkpoint").localeCompare(checkpointValue(right, "configured checkpoint"));
}

function jsonSafeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(record, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  if (encoded === undefined) throw new Error("PostgreSQL returned a record that cannot be archived as JSON");
  return JSON.parse(encoded) as Record<string, unknown>;
}

export class PostgresConnector implements EdgeConnector {
  private readonly now: () => Date;

  constructor(
    private readonly config: PostgresConnectorConfig,
    private readonly source: PostgresQuerySource,
    dependencies: PostgresConnectorDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async poll(checkpoint: string | null): Promise<ConnectorBatch | null> {
    const effectiveCheckpoint = checkpoint ?? this.config.initialCheckpoint;
    const result = await this.source.query(this.config.query, [effectiveCheckpoint, this.config.batchSize]);
    if (result.rows.length > this.config.batchSize) {
      throw new Error(
        `PostgreSQL query returned ${result.rows.length} rows, exceeding configured batchSize ${this.config.batchSize}; ensure $2 bounds the query`,
      );
    }
    if (result.rows.length === 0) return null;

    let previous: string | undefined;
    for (const [index, row] of result.rows.entries()) {
      if (!Object.hasOwn(row, this.config.checkpointColumn)) {
        throw new Error(`PostgreSQL row ${index + 1} does not contain checkpoint column '${this.config.checkpointColumn}'`);
      }
      const current = checkpointValue(row[this.config.checkpointColumn], this.config.checkpointColumn);
      if (index === 0 && compareCheckpointValues(current, effectiveCheckpoint) <= 0) {
        throw new Error(`PostgreSQL first checkpoint column '${this.config.checkpointColumn}' must be strictly greater than the stored checkpoint`);
      }
      if (previous !== undefined && compareCheckpointValues(previous, current) >= 0) {
        throw new Error(`PostgreSQL checkpoint column '${this.config.checkpointColumn}' must be strictly increasing`);
      }
      previous = current;
    }

    const checkpointAfter = previous!;
    if (compareCheckpointValues(checkpointAfter, effectiveCheckpoint) <= 0) {
      throw new Error(`PostgreSQL query did not advance checkpoint '${this.config.checkpointColumn}'`);
    }

    const records = result.rows.map(jsonSafeRecord);
    const mapped = mapTabularRecords(records, this.config.mapping);
    return {
      checkpointAfter,
      observedAt: this.now().toISOString(),
      ...mapped,
      documents: [],
      relations: [],
      rawRecords: records,
    };
  }

  async close(): Promise<void> {
    await this.source.close();
  }
}
