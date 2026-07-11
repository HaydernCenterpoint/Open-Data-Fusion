import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parsePreflightArguments,
  runSqliteCutoverPreflightCli,
  writeSqliteCutoverPreflightBundle,
} from '../src/cutover-preflight-cli.js';
import { createSqliteCutoverPreflightReport, SqliteCutoverPreflightError } from '../src/cutover-preflight.js';
import { FusionDatabase } from '../src/database.js';

function reverseJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseJsonObjectKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, nested]) => [key, reverseJsonObjectKeys(nested)]),
    );
  }
  return value;
}

function replaceSeededWorkspaceSnapshots(database: FusionDatabase, snapshotJson: string): void {
  database.database.prepare(`
    UPDATE workspaces SET snapshot_json = ? WHERE id = 'cooling-water-system'
  `).run(snapshotJson);
  database.database.prepare(`
    UPDATE workspace_revisions SET snapshot_json = ?
    WHERE workspace_id = 'cooling-water-system' AND version = 1
  `).run(snapshotJson);
}

describe('SQLite cutover preflight', () => {
  let database: FusionDatabase;
  let databasePath: string;
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), 'open-data-fusion-cutover-preflight-'));
    databasePath = join(tempDirectory, 'fixture.db');
    database = new FusionDatabase({ path: databasePath });
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('requires explicit database and output arguments for the preflight CLI', () => {
    expect(() => parsePreflightArguments([])).toThrow(
      'Usage: cutover-preflight --database <sqlite-path> --output <bundle.json>',
    );
    expect(parsePreflightArguments(['--database', 'fixture.db', '--output', 'bundle.json'])).toEqual({
      databasePath: 'fixture.db',
      outputPath: 'bundle.json',
    });
  });

  it('writes a serializable bundle after a successful read-only preflight', () => {
    const outputPath = join(tempDirectory, 'cutover-preflight.json');

    const report = writeSqliteCutoverPreflightBundle({ databasePath, outputPath });

    expect(existsSync(outputPath)).toBe(true);
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(report);
  });

  it('runs the CLI workflow from its command arguments', () => {
    const outputPath = join(tempDirectory, 'command-cutover-preflight.json');

    const report = runSqliteCutoverPreflightCli([
      '--database', databasePath,
      '--output', outputPath,
    ]);

    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(report);
  });

  it('does not write a bundle when the preflight detects invalid revision history', () => {
    const outputPath = join(tempDirectory, 'invalid-cutover-preflight.json');
    database.database.exec(`
      DELETE FROM workspace_revisions
      WHERE workspace_id = 'cooling-water-system' AND version = 1
    `);

    expect(() => writeSqliteCutoverPreflightBundle({ databasePath, outputPath })).toThrow(SqliteCutoverPreflightError);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects a missing SQLite input without creating an output path', () => {
    const outputPath = join(tempDirectory, 'missing-input', 'cutover-preflight.json');

    expect(() => writeSqliteCutoverPreflightBundle({
      databasePath: join(tempDirectory, 'does-not-exist.db'),
      outputPath,
    })).toThrow('SQLite database was not found');
    expect(existsSync(outputPath)).toBe(false);
  });

  it('rejects an output path that resolves to the SQLite input', () => {
    const outputPath = join(tempDirectory, '.', 'fixture.db');

    expect(() => writeSqliteCutoverPreflightBundle({ databasePath, outputPath })).toThrow(
      'Output path must not resolve to the supplied SQLite database',
    );
    expect(resolve(outputPath)).toBe(resolve(databasePath));
  });

  it('exports a deterministic, serializable report for the seeded SQLite bundle', () => {
    const report = createSqliteCutoverPreflightReport(database.database, databasePath);

    expect(report).toMatchObject({
      formatVersion: 'open-data-fusion.sqlite-cutover-preflight.v1',
      source: { databasePath, schemaVersion: '3' },
      counts: { workspaces: 1, revisions: 1, members: 4, auditEvents: 2 },
    });
    expect(report.workspaces).toHaveLength(1);
    expect(report.workspaces[0]).toMatchObject({ id: 'cooling-water-system', version: 1 });
    expect(report.revisions[0]).toMatchObject({ workspaceId: 'cooling-water-system', version: 1 });
    expect(report.members.map((member) => member.userId)).toEqual([
      'harper.dennis',
      'monica.reyes',
      'riley.chen',
      'samantha.lee',
    ]);
    expect(report.auditEvents.map((event) => event.id)).toEqual([1, 2]);
    expect(report.auditEvents[0]?.details).toEqual({
      assets: 8,
      timeSeries: 2,
      dataPoints: 50,
      documents: 2,
      relations: 3,
    });
    expect(Object.values(report.checksums)).toHaveLength(4);
    for (const checksum of Object.values(report.checksums)) {
      expect(checksum).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('rejects a workspace whose revision history no longer starts at version one', () => {
    database.database.exec(`
      DELETE FROM workspace_revisions
      WHERE workspace_id = 'cooling-water-system' AND version = 1
    `);

    expect(() => createSqliteCutoverPreflightReport(database.database, databasePath)).toThrow(SqliteCutoverPreflightError);
  });

  it('rejects a workspace with no owner member', () => {
    database.database.prepare(`
      UPDATE workspace_members
      SET role = 'editor'
      WHERE workspace_id = 'cooling-water-system' AND role = 'owner'
    `).run();

    expect(() => createSqliteCutoverPreflightReport(database.database, databasePath)).toThrow(SqliteCutoverPreflightError);
  });

  it('keeps checksums stable when source JSON object keys are reordered', () => {
    const before = createSqliteCutoverPreflightReport(database.database, databasePath);
    const workspace = database.database.prepare(`
      SELECT snapshot_json FROM workspaces WHERE id = 'cooling-water-system'
    `).get() as { snapshot_json: string };
    const auditEvent = database.database.prepare(`
      SELECT details_json FROM audit_log WHERE id = 1
    `).get() as { details_json: string };
    const snapshotJson = JSON.stringify(reverseJsonObjectKeys(JSON.parse(workspace.snapshot_json) as unknown));
    const detailsJson = JSON.stringify(reverseJsonObjectKeys(JSON.parse(auditEvent.details_json) as unknown));

    database.database.prepare(`
      UPDATE workspaces SET snapshot_json = ? WHERE id = 'cooling-water-system'
    `).run(snapshotJson);
    database.database.prepare(`
      UPDATE workspace_revisions SET snapshot_json = ?
      WHERE workspace_id = 'cooling-water-system' AND version = 1
    `).run(snapshotJson);
    database.database.prepare('UPDATE audit_log SET details_json = ? WHERE id = 1').run(detailsJson);

    const after = createSqliteCutoverPreflightReport(database.database, databasePath);

    expect(after.checksums.workspaces).toBe(before.checksums.workspaces);
    expect(after.checksums.revisions).toBe(before.checksums.revisions);
    expect(after.checksums.auditEvents).toBe(before.checksums.auditEvents);
  });

  it('rejects an unsafe integer before JSON parsing can round it', () => {
    replaceSeededWorkspaceSnapshots(
      database,
      '{"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[],"cutoverSequence":9007199254740993}',
    );

    expect(() => createSqliteCutoverPreflightReport(database.database, databasePath)).toThrow(SqliteCutoverPreflightError);
  });

  it('rejects a nonfinite exponent before JSON parsing can coerce it', () => {
    replaceSeededWorkspaceSnapshots(
      database,
      '{"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[],"cutoverMagnitude":1e400}',
    );

    expect(() => createSqliteCutoverPreflightReport(database.database, databasePath)).toThrow(SqliteCutoverPreflightError);
  });

  it('rejects an exponent that underflows during JSON number conversion', () => {
    replaceSeededWorkspaceSnapshots(
      database,
      '{"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[],"cutoverMagnitude":1e-400}',
    );

    expect(() => createSqliteCutoverPreflightReport(database.database, databasePath)).toThrow(SqliteCutoverPreflightError);
  });

  it('accepts semantically lossless decimal and exponent spellings', () => {
    replaceSeededWorkspaceSnapshots(
      database,
      '{"viewport":{"x":1.0,"y":1.50,"zoom":1e3},"nodes":[],"edges":[],"smallPosition":1e-3}',
    );

    const report = createSqliteCutoverPreflightReport(database.database, databasePath);

    expect(report.workspaces[0]?.snapshot).toMatchObject({
      viewport: { x: 1, y: 1.5, zoom: 1000 },
      smallPosition: 0.001,
    });
    expect(report.revisions[0]?.snapshot).toMatchObject({
      viewport: { x: 1, y: 1.5, zoom: 1000 },
      smallPosition: 0.001,
    });
  });
});
