import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  createSqliteCutoverPreflightReport,
  type SqliteCutoverPreflightReport,
} from './cutover-preflight.js';

const usage = 'Usage: cutover-preflight --database <sqlite-path> --output <bundle.json>';

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function parsePreflightArguments(args: readonly string[]): { databasePath: string; outputPath: string } {
  const databasePath = valueAfter(args, '--database');
  const outputPath = valueAfter(args, '--output');
  if (!databasePath || !outputPath) throw new Error(usage);
  return { databasePath, outputPath };
}

export function readSqliteCutoverSource(databasePath: string): SqliteCutoverPreflightReport {
  if (!existsSync(databasePath)) throw new Error(`SQLite database was not found: ${databasePath}`);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('BEGIN');
    try {
      return createSqliteCutoverPreflightReport(database, databasePath);
    } finally {
      database.exec('ROLLBACK');
    }
  } finally {
    database.close();
  }
}

export function writeSqliteCutoverPreflightBundle({
  databasePath,
  outputPath,
}: {
  databasePath: string;
  outputPath: string;
}): SqliteCutoverPreflightReport {
  if (resolve(databasePath) === resolve(outputPath)) {
    throw new Error('Output path must not resolve to the supplied SQLite database');
  }

  const report = readSqliteCutoverSource(databasePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function runSqliteCutoverPreflightCli(args: readonly string[]): SqliteCutoverPreflightReport {
  return writeSqliteCutoverPreflightBundle(parsePreflightArguments(args));
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
}

if (isMainModule()) {
  try {
    const report = runSqliteCutoverPreflightCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({ source: report.source, counts: report.counts, checksums: report.checksums }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
