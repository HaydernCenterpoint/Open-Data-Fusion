import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { ConflictError, DataIntegrityError, NotFoundError } from "./database.js";
import type { IngestBundle } from "./schemas.js";

export interface RawLandingContext {
  tenantId: string;
  projectId: string;
}

interface RawLandingRow {
  id: string;
  tenant_id: string;
  project_id: string;
  source_system: string;
  run_id: string;
  storage_key: string;
  sha256: string;
  byte_size: number;
  state: "received" | "accepted" | "failed" | "quarantined";
  actor: string;
  correlation_id: string;
  error_summary: string | null;
  created_at: string;
  completed_at: string | null;
  last_replayed_at: string | null;
  last_replay_run_id: string | null;
}

export interface RawLandingRecord {
  id: string;
  tenantId: string;
  projectId: string;
  sourceSystem: string;
  runId: string;
  rawObjectUri: string;
  sha256: string;
  byteSize: number;
  state: RawLandingRow["state"];
  actor: string;
  correlationId: string;
  errorSummary: string | null;
  createdAt: string;
  completedAt: string | null;
  lastReplayedAt: string | null;
  lastReplayRunId: string | null;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function recordFromRow(row: RawLandingRow): RawLandingRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    sourceSystem: row.source_system,
    runId: row.run_id,
    rawObjectUri: `raw://${row.tenant_id}/${row.project_id}/${row.id}`,
    sha256: row.sha256,
    byteSize: row.byte_size,
    state: row.state,
    actor: row.actor,
    correlationId: row.correlation_id,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    lastReplayedAt: row.last_replayed_at,
    lastReplayRunId: row.last_replay_run_id,
  };
}

function encodeCursor(row: Pick<RawLandingRow, "created_at" | "id">): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "string")) throw new Error();
    return [value[0] as string, value[1] as string];
  } catch {
    throw new ConflictError("Raw landing cursor is invalid");
  }
}

export class RawLandingStore {
  private readonly root: string;

  constructor(private readonly database: DatabaseSync, rootDirectory: string) {
    this.root = resolve(rootDirectory);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS platform_raw_ingest_objects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        run_id TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        state TEXT NOT NULL CHECK (state IN ('received', 'accepted', 'failed', 'quarantined')),
        actor TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        error_summary TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        last_replayed_at TEXT,
        last_replay_run_id TEXT,
        UNIQUE (tenant_id, project_id, run_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS platform_raw_ingest_context_created_idx
        ON platform_raw_ingest_objects (tenant_id, project_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS platform_raw_ingest_open_idx
        ON platform_raw_ingest_objects (tenant_id, project_id, state, created_at, id)
        WHERE state IN ('failed', 'quarantined');
    `);
  }

  async archive(context: RawLandingContext, bundle: IngestBundle, actor: string, correlationId: string): Promise<RawLandingRecord> {
    const bytes = Buffer.from(JSON.stringify(bundle), "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.database.prepare(`
      SELECT * FROM platform_raw_ingest_objects
      WHERE tenant_id = ? AND project_id = ? AND run_id = ?
    `).get(context.tenantId, context.projectId, bundle.source.runId ?? sha256) as RawLandingRow | undefined;
    if (existing) {
      if (existing.sha256 !== sha256) throw new ConflictError(`Ingestion run '${existing.run_id}' already has a different immutable raw payload`);
      return recordFromRow(existing);
    }

    const createdAt = new Date().toISOString();
    const runId = bundle.source.runId ?? sha256;
    const id = `raw-${sha256.slice(0, 16)}-${randomUUID()}`;
    const storageKey = `${safeSegment(context.tenantId)}/${safeSegment(context.projectId)}/${createdAt.slice(0, 10)}/${sha256}.json`;
    const path = this.resolveStorageKey(storageKey);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const existingBytes = await readFile(path);
      const existingHash = createHash("sha256").update(existingBytes).digest("hex");
      if (existingBytes.byteLength !== bytes.byteLength || existingHash !== sha256) {
        throw new DataIntegrityError("Existing raw object failed integrity verification");
      }
    }
    try {
      this.database.prepare(`
        INSERT INTO platform_raw_ingest_objects(
          id, tenant_id, project_id, source_system, run_id, storage_key, sha256,
          byte_size, state, actor, correlation_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)
      `).run(id, context.tenantId, context.projectId, bundle.source.system, runId, storageKey, sha256, bytes.byteLength, actor, correlationId, createdAt);
    } catch (error) {
      // Another request may have inserted the same run while this request was
      // awaiting filesystem I/O. Re-read the unique key and accept only the
      // exact immutable payload; never turn a valid idempotent race into 500.
      const raced = this.database.prepare(`
        SELECT * FROM platform_raw_ingest_objects
        WHERE tenant_id = ? AND project_id = ? AND run_id = ?
      `).get(context.tenantId, context.projectId, runId) as RawLandingRow | undefined;
      if (!raced) throw error;
      if (raced.sha256 !== sha256 || raced.byte_size !== bytes.byteLength) {
        throw new ConflictError(`Ingestion run '${runId}' already has a different immutable raw payload`);
      }
      return recordFromRow(raced);
    }
    return this.get(context, id);
  }

  complete(context: RawLandingContext, id: string, state: "accepted" | "failed" | "quarantined", error?: string): RawLandingRecord {
    const result = this.database.prepare(`
      UPDATE platform_raw_ingest_objects
      SET state = ?, error_summary = ?, completed_at = ?
      WHERE tenant_id = ? AND project_id = ? AND id = ?
    `).run(state, error?.replace(/[\r\n\t]+/g, " ").slice(0, 2_000) ?? null, new Date().toISOString(), context.tenantId, context.projectId, id);
    if (result.changes !== 1) throw new NotFoundError(`Raw ingest object '${id}' was not found`);
    return this.get(context, id);
  }

  list(context: RawLandingContext, limit: number, cursor?: string): { items: RawLandingRecord[]; nextCursor: string | null } {
    const decoded = decodeCursor(cursor);
    const rows = this.database.prepare(`
      SELECT * FROM platform_raw_ingest_objects
      WHERE tenant_id = ? AND project_id = ?
        AND (? IS NULL OR (created_at, id) < (?, ?))
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(context.tenantId, context.projectId, decoded?.[0] ?? null, decoded?.[0] ?? null, decoded?.[1] ?? null, limit + 1) as unknown as RawLandingRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { items: page.map(recordFromRow), nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!) : null };
  }

  async replayBundle(context: RawLandingContext, id: string): Promise<IngestBundle> {
    const row = this.row(context, id);
    const path = this.resolveStorageKey(row.storage_key);
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== row.byte_size || sha256 !== row.sha256) {
      throw new DataIntegrityError(`Raw ingest object '${id}' failed integrity verification`);
    }
    return JSON.parse(bytes.toString("utf8")) as IngestBundle;
  }

  markReplayed(context: RawLandingContext, id: string, replayRunId: string): RawLandingRecord {
    const result = this.database.prepare(`
      UPDATE platform_raw_ingest_objects SET last_replayed_at = ?, last_replay_run_id = ?
      WHERE tenant_id = ? AND project_id = ? AND id = ?
    `).run(new Date().toISOString(), replayRunId, context.tenantId, context.projectId, id);
    if (result.changes !== 1) throw new NotFoundError(`Raw ingest object '${id}' was not found`);
    return this.get(context, id);
  }

  get(context: RawLandingContext, id: string): RawLandingRecord {
    return recordFromRow(this.row(context, id));
  }

  private row(context: RawLandingContext, id: string): RawLandingRow {
    const row = this.database.prepare(`
      SELECT * FROM platform_raw_ingest_objects WHERE tenant_id = ? AND project_id = ? AND id = ?
    `).get(context.tenantId, context.projectId, id) as RawLandingRow | undefined;
    if (!row) throw new NotFoundError(`Raw ingest object '${id}' was not found`);
    return row;
  }

  private resolveStorageKey(storageKey: string): string {
    const path = resolve(this.root, storageKey);
    const relativePath = relative(this.root, path);
    if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) throw new Error("Raw object path escaped its storage root");
    return path;
  }
}
