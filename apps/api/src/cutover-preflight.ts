import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type JsonObject = { [key: string]: JsonValue };
type JsonValue = boolean | null | number | string | JsonObject | JsonValue[];
type SqliteRow = Record<string, unknown>;

const JSON_NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_NUMBER_PARTS = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

export const SQLITE_CUTOVER_PREFLIGHT_FORMAT_VERSION = 'open-data-fusion.sqlite-cutover-preflight.v1';

export class SqliteCutoverPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteCutoverPreflightError';
  }
}

export interface WorkspaceCutoverExport {
  id: string;
  name: string;
  snapshot: JsonObject;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceRevisionCutoverExport {
  workspaceId: string;
  version: number;
  snapshot: JsonObject;
  changeSummary: string;
  actor: string;
  createdAt: string;
  correlationId: string;
}

export interface WorkspaceMemberCutoverExport {
  workspaceId: string;
  userId: string;
  displayName: string;
  role: string;
  createdAt: string;
}

export interface AuditEventCutoverExport {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: JsonObject;
  correlationId: string;
}

export interface SqliteCutoverPreflightReport {
  formatVersion: typeof SQLITE_CUTOVER_PREFLIGHT_FORMAT_VERSION;
  source: {
    databasePath: string;
    schemaVersion: string;
  };
  counts: {
    workspaces: number;
    revisions: number;
    members: number;
    auditEvents: number;
  };
  checksums: {
    workspaces: string;
    revisions: string;
    members: string;
    auditEvents: string;
  };
  workspaces: WorkspaceCutoverExport[];
  revisions: WorkspaceRevisionCutoverExport[];
  members: WorkspaceMemberCutoverExport[];
  auditEvents: AuditEventCutoverExport[];
}

interface NormalizedJsonNumber {
  sign: -1 | 0 | 1;
  significantDigits: bigint;
  decimalExponent: bigint;
}

function rejectNonLosslessJsonNumber(token: string, field: string): never {
  throw new SqliteCutoverPreflightError(`${field} contains non-lossless JSON number '${token}'`);
}

function normalizeJsonNumber(token: string): NormalizedJsonNumber {
  const match = JSON_NUMBER_PARTS.exec(token);
  const integerDigits = match?.[2];
  if (!match || !integerDigits) {
    throw new SqliteCutoverPreflightError(`Invalid JSON number '${token}'`);
  }

  const fractionalDigits = match[3] ?? '';
  const exponentText = match[4] ?? '0';
  const exponent = BigInt(exponentText.startsWith('+') ? exponentText.slice(1) : exponentText);
  const digitsWithoutLeadingZeros = `${integerDigits}${fractionalDigits}`.replace(/^0+/, '');
  if (digitsWithoutLeadingZeros.length === 0) {
    return { sign: 0, significantDigits: 0n, decimalExponent: 0n };
  }

  const significantDigitsText = digitsWithoutLeadingZeros.replace(/0+$/, '');
  const trailingZeroCount = digitsWithoutLeadingZeros.length - significantDigitsText.length;
  return {
    sign: match[1] === '-' ? -1 : 1,
    significantDigits: BigInt(significantDigitsText),
    decimalExponent: exponent - BigInt(fractionalDigits.length) + BigInt(trailingZeroCount),
  };
}

function jsonNumbersAreEqual(left: NormalizedJsonNumber, right: NormalizedJsonNumber): boolean {
  return left.sign === right.sign
    && left.significantDigits === right.significantDigits
    && left.decimalExponent === right.decimalExponent;
}

function validateJsonNumberToken(token: string, field: string): void {
  const numericValue = Number(token);
  if (!Number.isFinite(numericValue)) rejectNonLosslessJsonNumber(token, field);
  if (Object.is(numericValue, -0)) rejectNonLosslessJsonNumber(token, field);

  const serialized = JSON.stringify(numericValue);
  if (typeof serialized !== 'string' || !jsonNumbersAreEqual(normalizeJsonNumber(token), normalizeJsonNumber(serialized))) {
    rejectNonLosslessJsonNumber(token, field);
  }
}

function validateJsonNumberTokens(json: string, field: string): void {
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const character = json[index];
    if (!character) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== '-' && (character < '0' || character > '9')) continue;

    JSON_NUMBER_TOKEN.lastIndex = index;
    const match = JSON_NUMBER_TOKEN.exec(json);
    if (!match) continue;

    const token = match[0];
    validateJsonNumberToken(token, field);
    index += token.length - 1;
  }
}

function parseJsonObject(value: unknown, field: string): JsonObject {
  if (typeof value !== 'string') {
    throw new SqliteCutoverPreflightError(`${field} must contain JSON text`);
  }

  validateJsonNumberTokens(value, field);

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SqliteCutoverPreflightError(`${field} contains malformed JSON`);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new SqliteCutoverPreflightError(`${field} must contain a JSON object`);
  }

  return parsed as JsonObject;
}

function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  throw new SqliteCutoverPreflightError('SQLite cutover report contains a non-JSON value');
}

function validateInvariants(
  workspaces: WorkspaceCutoverExport[],
  revisions: WorkspaceRevisionCutoverExport[],
  members: WorkspaceMemberCutoverExport[],
): void {
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const revisionsByWorkspace = new Map<string, WorkspaceRevisionCutoverExport[]>();
  for (const workspace of workspaces) revisionsByWorkspace.set(workspace.id, []);

  for (const revision of revisions) {
    const history = revisionsByWorkspace.get(revision.workspaceId);
    if (!history) {
      throw new SqliteCutoverPreflightError(`Revision references missing workspace '${revision.workspaceId}'`);
    }
    history.push(revision);
  }

  for (const member of members) {
    if (!workspacesById.has(member.workspaceId)) {
      throw new SqliteCutoverPreflightError(`Member references missing workspace '${member.workspaceId}'`);
    }
  }

  for (const workspace of workspaces) {
    if (!members.some((member) => member.workspaceId === workspace.id && member.role === 'owner')) {
      throw new SqliteCutoverPreflightError(`Workspace '${workspace.id}' must have at least one owner member`);
    }

    const history = revisionsByWorkspace.get(workspace.id);
    if (!history || history.length === 0) {
      throw new SqliteCutoverPreflightError(`Workspace '${workspace.id}' revision history must start at version 1`);
    }

    for (let index = 0; index < history.length; index += 1) {
      const revision = history[index];
      const expectedVersion = index + 1;
      if (!revision || revision.version !== expectedVersion) {
        throw new SqliteCutoverPreflightError(
          `Workspace '${workspace.id}' revision history must contain version ${expectedVersion} without gaps`,
        );
      }
    }

    const currentRevision = history.at(-1);
    if (!currentRevision) {
      throw new SqliteCutoverPreflightError(`Workspace '${workspace.id}' has no current revision`);
    }
    if (currentRevision.version !== workspace.version) {
      throw new SqliteCutoverPreflightError(
        `Workspace '${workspace.id}' version ${workspace.version} does not match revision ${currentRevision.version}`,
      );
    }
    if (canonicalJson(workspace.snapshot) !== canonicalJson(currentRevision.snapshot)) {
      throw new SqliteCutoverPreflightError(`Workspace '${workspace.id}' snapshot does not match its current revision`);
    }
  }
}

function readSchemaVersion(database: DatabaseSync): string {
  const row = database.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get() as SqliteRow | undefined;
  if (!row) throw new SqliteCutoverPreflightError('SQLite cutover source has no schema version');
  return String(row.value);
}

/**
 * Reads a SQLite source without mutating it.
 *
 * Callers needing concurrent-writer consistency must execute this core reader
 * inside a consistent SQLite read snapshot.
 */
export function createSqliteCutoverPreflightReport(
  database: DatabaseSync,
  databasePath: string,
): SqliteCutoverPreflightReport {
  const workspaces = database.prepare(`
    SELECT id, name, snapshot_json, version, created_by, created_at, updated_by, updated_at
    FROM workspaces
    ORDER BY id
  `).all() as SqliteRow[];
  const revisions = database.prepare(`
    SELECT workspace_id, version, snapshot_json, change_summary, actor, created_at, correlation_id
    FROM workspace_revisions
    ORDER BY workspace_id, version
  `).all() as SqliteRow[];
  const members = database.prepare(`
    SELECT workspace_id, user_id, display_name, role, created_at
    FROM workspace_members
    ORDER BY workspace_id, user_id
  `).all() as SqliteRow[];
  const auditEvents = database.prepare(`
    SELECT id, timestamp, actor, action, entity_type, entity_id, details_json, correlation_id
    FROM audit_log
    ORDER BY id
  `).all() as SqliteRow[];

  const workspaceExports = workspaces.map((row): WorkspaceCutoverExport => ({
    id: String(row.id),
    name: String(row.name),
    snapshot: parseJsonObject(row.snapshot_json, `Workspace '${String(row.id)}' snapshot`),
    version: Number(row.version),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  }));
  const revisionExports = revisions.map((row): WorkspaceRevisionCutoverExport => ({
    workspaceId: String(row.workspace_id),
    version: Number(row.version),
    snapshot: parseJsonObject(
      row.snapshot_json,
      `Workspace '${String(row.workspace_id)}' revision ${String(row.version)} snapshot`,
    ),
    changeSummary: String(row.change_summary),
    actor: String(row.actor),
    createdAt: String(row.created_at),
    correlationId: String(row.correlation_id),
  }));
  const memberExports = members.map((row): WorkspaceMemberCutoverExport => ({
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    role: String(row.role),
    createdAt: String(row.created_at),
  }));
  const auditEventExports = auditEvents.map((row): AuditEventCutoverExport => ({
    id: Number(row.id),
    timestamp: String(row.timestamp),
    actor: String(row.actor),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: row.entity_id === null ? null : String(row.entity_id),
    details: parseJsonObject(row.details_json, `Audit event ${String(row.id)} details`),
    correlationId: String(row.correlation_id),
  }));

  validateInvariants(workspaceExports, revisionExports, memberExports);

  return {
    formatVersion: SQLITE_CUTOVER_PREFLIGHT_FORMAT_VERSION,
    source: { databasePath, schemaVersion: readSchemaVersion(database) },
    counts: {
      workspaces: workspaceExports.length,
      revisions: revisionExports.length,
      members: memberExports.length,
      auditEvents: auditEventExports.length,
    },
    checksums: {
      workspaces: checksum(workspaceExports),
      revisions: checksum(revisionExports),
      members: checksum(memberExports),
      auditEvents: checksum(auditEventExports),
    },
    workspaces: workspaceExports,
    revisions: revisionExports,
    members: memberExports,
    auditEvents: auditEventExports,
  };
}
