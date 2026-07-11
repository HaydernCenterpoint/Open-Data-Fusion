import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createPostgresPool,
  type RuntimePool,
} from '@open-data-fusion/postgres-runtime';

import {
  importSqliteCutoverBundle,
  type SqliteCutoverImportReport,
} from './cutover-import.js';
import { readSqliteCutoverSource } from './cutover-preflight-cli.js';

const usage = 'Usage: cutover-import --bundle <preflight.json> [--database <sqlite-path>] [--apply]';

export interface CutoverImportArguments {
  bundlePath: string;
  databasePath?: string;
  apply: boolean;
}

export type CutoverImportPoolFactory = (connectionString: string) => RuntimePool;

export function parseCutoverImportArguments(args: readonly string[]): CutoverImportArguments {
  let bundlePath: string | undefined;
  let databasePath: string | undefined;
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--apply') {
      if (apply) throw new Error(usage);
      apply = true;
      continue;
    }
    if (argument === '--bundle' || argument === '--database') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(usage);
      if (argument === '--bundle') {
        if (bundlePath !== undefined) throw new Error(usage);
        bundlePath = value;
      } else {
        if (databasePath !== undefined) throw new Error(usage);
        databasePath = value;
      }
      index += 1;
      continue;
    }
    throw new Error(usage);
  }

  if (!bundlePath || (apply && !databasePath)) throw new Error(usage);
  return {
    bundlePath,
    ...(databasePath ? { databasePath } : {}),
    apply,
  };
}

export function readSqliteCutoverBundle(bundlePath: string): unknown {
  if (!existsSync(bundlePath)) throw new Error(`SQLite cutover bundle was not found: ${bundlePath}`);
  try {
    return JSON.parse(readFileSync(bundlePath, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`SQLite cutover bundle is not valid JSON: ${bundlePath}`);
    }
    throw error;
  }
}

function defaultPoolFactory(connectionString: string): RuntimePool {
  return createPostgresPool({
    connectionString,
    applicationName: 'open-data-fusion-sqlite-cutover',
    max: 1,
    statementTimeoutMillis: 120_000,
    lockTimeoutMillis: 10_000,
    idleInTransactionTimeoutMillis: 180_000,
  }).pool;
}

export async function runSqliteCutoverImportCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  poolFactory: CutoverImportPoolFactory = defaultPoolFactory,
): Promise<SqliteCutoverImportReport> {
  const parsed = parseCutoverImportArguments(args);
  const connectionString = environment.ODF_POSTGRES_URL?.trim();
  if (!connectionString) throw new Error('ODF_POSTGRES_URL is required for a PostgreSQL cutover rehearsal');

  const bundle = readSqliteCutoverBundle(parsed.bundlePath);
  const currentSource = parsed.databasePath
    ? readSqliteCutoverSource(parsed.databasePath)
    : undefined;
  const pool = poolFactory(connectionString);
  try {
    return await importSqliteCutoverBundle(pool, bundle, {
      apply: parsed.apply,
      ...(currentSource ? { currentSource } : {}),
    });
  } finally {
    await pool.end();
  }
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
}

if (isMainModule()) {
  try {
    const report = await runSqliteCutoverImportCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
