import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import { z } from 'zod';

import { ConflictError, DataIntegrityError, NotFoundError } from './database.js';
import type { GovernedObjectListQuery, GovernedUploadMetadata } from './object-schemas.js';
import type { PlatformContext } from './platform-schemas.js';
import type { PlatformCatalog } from './platform.js';

type SqliteRow = Record<string, unknown>;

const safeTextMimeTypes = new Set([
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
]);

const cursorSchema = z.object({ id: z.string().min(1) });
const versionCursorSchema = z.object({ version: z.number().int().positive() });
const eventCursorSchema = z.object({ eventId: z.number().int().positive() });

export class ObjectTooLargeError extends Error {}

export interface GovernedObjectStoreOptions {
  rootPath: string;
  maxObjectBytes?: number;
  maxExtractedTextCharacters?: number;
}

export interface GovernedDownload {
  objectId: string;
  version: number;
  versionId: string;
  fileName: string;
  title: string;
  mimeType: string;
  sha256: string;
  etag: string;
  sizeBytes: number;
  absolutePath: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>, fallback: T): T {
  if (!cursor) return fallback;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    decoded = null;
  }
  return schema.parse(decoded);
}

function asObject(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    id: String(row.id),
    title: String(row.title),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    currentVersion: Number(row.current_version),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    etag: `"${String(row.sha256)}"`,
    textIndexed: Number(row.text_indexed) === 1,
    textTruncated: Number(row.text_truncated) === 1,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  };
}

function asVersion(row: SqliteRow): Record<string, unknown> {
  return {
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    objectId: String(row.object_id),
    version: Number(row.version),
    versionId: String(row.version_id),
    title: String(row.title),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    etag: `"${String(row.sha256)}"`,
    textIndexed: Number(row.text_indexed) === 1,
    textTruncated: Number(row.text_truncated) === 1,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

function hashSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten <= 0) throw new Error('Object store could not make progress writing the upload');
    offset += bytesWritten;
  }
}

export class GovernedObjectStore {
  readonly maxObjectBytes: number;
  private readonly rootPath: string;
  private readonly temporaryPath: string;
  private readonly maxExtractedTextCharacters: number;

  constructor(
    private readonly database: DatabaseSync,
    private readonly searchCatalog: PlatformCatalog,
    options: GovernedObjectStoreOptions,
  ) {
    this.rootPath = resolve(options.rootPath);
    this.temporaryPath = resolve(this.rootPath, '.tmp');
    this.maxObjectBytes = options.maxObjectBytes ?? 50 * 1024 * 1024;
    this.maxExtractedTextCharacters = options.maxExtractedTextCharacters ?? 1_000_000;
    if (!Number.isSafeInteger(this.maxObjectBytes) || this.maxObjectBytes < 1 || this.maxObjectBytes > 5 * 1024 * 1024 * 1024) {
      throw new Error('Object-store maxObjectBytes must be between 1 byte and 5 GiB');
    }
    if (!Number.isSafeInteger(this.maxExtractedTextCharacters) || this.maxExtractedTextCharacters < 1) {
      throw new Error('Object-store maxExtractedTextCharacters must be a positive integer');
    }
    mkdirSync(this.temporaryPath, { recursive: true, mode: 0o700 });
    this.createSchema();
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS governed_objects (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK(current_version>0),
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,id),
        FOREIGN KEY(tenant_id,project_id) REFERENCES platform_projects(tenant_id,id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS governed_object_versions (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, object_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>0), version_id TEXT NOT NULL,
        title TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL,
        storage_path TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64), extracted_text TEXT,
        text_indexed INTEGER NOT NULL CHECK(text_indexed IN (0,1)), text_truncated INTEGER NOT NULL CHECK(text_truncated IN (0,1)),
        created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,project_id,object_id,version), UNIQUE(version_id),
        FOREIGN KEY(tenant_id,project_id,object_id) REFERENCES governed_objects(tenant_id,project_id,id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS governed_object_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        object_id TEXT NOT NULL, version INTEGER, event_type TEXT NOT NULL, actor TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)), correlation_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
        FOREIGN KEY(tenant_id,project_id,object_id) REFERENCES governed_objects(tenant_id,project_id,id) ON DELETE RESTRICT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS governed_objects_scope_idx ON governed_objects(tenant_id,project_id,id);
      CREATE INDEX IF NOT EXISTS governed_object_events_scope_idx ON governed_object_events(tenant_id,project_id,object_id,event_id);
      CREATE TRIGGER IF NOT EXISTS governed_object_versions_immutable_update
        BEFORE UPDATE ON governed_object_versions BEGIN SELECT RAISE(ABORT,'governed object versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS governed_object_versions_immutable_delete
        BEFORE DELETE ON governed_object_versions BEGIN SELECT RAISE(ABORT,'governed object versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS governed_object_events_immutable_update
        BEFORE UPDATE ON governed_object_events BEGIN SELECT RAISE(ABORT,'governed object audit events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS governed_object_events_immutable_delete
        BEFORE DELETE ON governed_object_events BEGIN SELECT RAISE(ABORT,'governed object audit events are immutable'); END;
      INSERT INTO schema_metadata(key,value) VALUES ('governed_object_schema_version','1')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    `);
  }

  async upload(
    context: PlatformContext,
    objectId: string,
    metadata: GovernedUploadMetadata,
    source: Readable,
    actor: string,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    if (metadata.contentLength !== undefined && metadata.contentLength > this.maxObjectBytes) {
      throw new ObjectTooLargeError(`Object exceeds the ${this.maxObjectBytes}-byte upload limit`);
    }

    const temporaryFile = resolve(this.temporaryPath, `${randomUUID()}.part`);
    this.assertContained(temporaryFile);
    const file = await open(temporaryFile, 'wx', 0o600);
    const hash = createHash('sha256');
    const canExtractText = safeTextMimeTypes.has(metadata.mimeType);
    let decoder: TextDecoder | null = canExtractText ? new TextDecoder('utf-8', { fatal: true }) : null;
    let extractedText = '';
    let textTruncated = false;
    let sizeBytes = 0;
    try {
      for await (const value of source) {
        const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        sizeBytes += buffer.byteLength;
        if (sizeBytes > this.maxObjectBytes) {
          throw new ObjectTooLargeError(`Object exceeds the ${this.maxObjectBytes}-byte upload limit`);
        }
        hash.update(buffer);
        await writeAll(file, buffer);
        if (decoder) {
          try {
            const decoded = decoder.decode(buffer, { stream: true });
            const remaining = this.maxExtractedTextCharacters - extractedText.length;
            if (remaining > 0) extractedText += decoded.slice(0, remaining);
            if (decoded.length > remaining) textTruncated = true;
          } catch {
            decoder = null;
            extractedText = '';
            textTruncated = false;
          }
        }
      }
      if (metadata.contentLength !== undefined && sizeBytes !== metadata.contentLength) {
        throw new DataIntegrityError(`Content-Length declared ${metadata.contentLength} bytes but ${sizeBytes} bytes were received`);
      }
      if (decoder) {
        try {
          const finalText = decoder.decode();
          const remaining = this.maxExtractedTextCharacters - extractedText.length;
          if (remaining > 0) extractedText += finalText.slice(0, remaining);
          if (finalText.length > remaining) textTruncated = true;
        } catch {
          decoder = null;
          extractedText = '';
          textTruncated = false;
        }
      }
      await file.sync();
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw error;
    }
    await file.close();

    const sha256 = hash.digest('hex');
    const versionId = randomUUID();
    const relativeStoragePath = [
      hashSegment(context.tenantId).slice(0, 24),
      hashSegment(context.projectId).slice(0, 24),
      hashSegment(objectId).slice(0, 32),
      `${versionId}.blob`,
    ].join('/');
    const finalPath = resolve(this.rootPath, relativeStoragePath);
    this.assertContained(finalPath);
    await mkdir(resolve(finalPath, '..'), { recursive: true, mode: 0o700 });
    try {
      await rename(temporaryFile, finalPath);
    } catch (error) {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw error;
    }

    try {
      return this.persistVersion(context, objectId, metadata, {
        versionId,
        relativeStoragePath,
        sizeBytes,
        sha256,
        extractedText: decoder ? extractedText : null,
        textTruncated,
      }, actor, correlationId);
    } catch (error) {
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  listObjects(context: PlatformContext, query: GovernedObjectListQuery): Record<string, unknown> {
    const cursor = decodeCursor(query.cursor, cursorSchema, { id: '' });
    const rows = this.database.prepare(`
      SELECT object.*,version.size_bytes,version.sha256,version.text_indexed,version.text_truncated
      FROM governed_objects AS object
      JOIN governed_object_versions AS version
        ON version.tenant_id=object.tenant_id AND version.project_id=object.project_id
       AND version.object_id=object.id AND version.version=object.current_version
      WHERE object.tenant_id=? AND object.project_id=? AND object.id>?
      ORDER BY object.id LIMIT ?
    `).all(context.tenantId, context.projectId, cursor.id, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, asObject, (row) => ({ id: String(row.id) }));
  }

  getObject(context: PlatformContext, objectId: string): Record<string, unknown> {
    const row = this.currentObjectRow(context, objectId);
    if (!row) throw new NotFoundError(`Governed object '${objectId}' was not found`);
    return asObject(row);
  }

  listVersions(context: PlatformContext, objectId: string, query: GovernedObjectListQuery): Record<string, unknown> {
    if (!this.objectExists(context, objectId)) throw new NotFoundError(`Governed object '${objectId}' was not found`);
    const cursor = decodeCursor(query.cursor, versionCursorSchema, { version: 0 });
    const rows = this.database.prepare(`SELECT * FROM governed_object_versions WHERE tenant_id=? AND project_id=? AND object_id=? AND version>? ORDER BY version LIMIT ?`)
      .all(context.tenantId, context.projectId, objectId, cursor.version, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, asVersion, (row) => ({ version: Number(row.version) }));
  }

  async download(context: PlatformContext, objectId: string, version?: number): Promise<GovernedDownload> {
    const row = version === undefined
      ? this.database.prepare(`
          SELECT version.* FROM governed_objects AS object
          JOIN governed_object_versions AS version
            ON version.tenant_id=object.tenant_id AND version.project_id=object.project_id
           AND version.object_id=object.id AND version.version=object.current_version
          WHERE object.tenant_id=? AND object.project_id=? AND object.id=?
        `).get(context.tenantId, context.projectId, objectId) as SqliteRow | undefined
      : this.database.prepare(`SELECT * FROM governed_object_versions WHERE tenant_id=? AND project_id=? AND object_id=? AND version=?`)
        .get(context.tenantId, context.projectId, objectId, version) as SqliteRow | undefined;
    if (!row) throw new NotFoundError(`Governed object '${objectId}'${version === undefined ? '' : ` version ${version}`} was not found`);
    const absolutePath = resolve(this.rootPath, String(row.storage_path));
    this.assertContained(absolutePath);
    if (isAbsolute(String(row.storage_path))) throw new DataIntegrityError('Governed object storage metadata contains an absolute path');
    const file = await stat(absolutePath).catch(() => null);
    if (!file?.isFile() || file.size !== Number(row.size_bytes)) {
      throw new DataIntegrityError(`Governed object '${objectId}' content is missing or does not match its immutable metadata`);
    }
    return {
      objectId,
      version: Number(row.version),
      versionId: String(row.version_id),
      fileName: String(row.file_name),
      title: String(row.title),
      mimeType: String(row.mime_type),
      sha256: String(row.sha256),
      etag: `"${String(row.sha256)}"`,
      sizeBytes: Number(row.size_bytes),
      absolutePath,
    };
  }

  recordDownload(
    context: PlatformContext,
    download: GovernedDownload,
    actor: string,
    correlationId: string,
    range: { start: number; end: number } | null,
  ): void {
    this.transaction(() => {
      const timestamp = nowIso();
      const details = {
        version: download.version,
        sha256: download.sha256,
        range,
      };
      this.event(context, download.objectId, download.version, 'content.downloaded', actor, details, correlationId, timestamp);
      this.audit(actor, 'platform.governed_object_downloaded', 'governedObject', `${context.tenantId}/${context.projectId}/${download.objectId}@${download.version}`, details, correlationId, timestamp);
    });
  }

  listEvents(context: PlatformContext, objectId: string, query: GovernedObjectListQuery): Record<string, unknown> {
    if (!this.objectExists(context, objectId)) throw new NotFoundError(`Governed object '${objectId}' was not found`);
    const cursor = decodeCursor(query.cursor, eventCursorSchema, { eventId: 0 });
    const rows = this.database.prepare(`SELECT * FROM governed_object_events WHERE tenant_id=? AND project_id=? AND object_id=? AND event_id>? ORDER BY event_id LIMIT ?`)
      .all(context.tenantId, context.projectId, objectId, cursor.eventId, query.limit + 1) as SqliteRow[];
    return this.page(rows, query.limit, (row) => ({
      id: Number(row.event_id),
      tenantId: String(row.tenant_id),
      projectId: String(row.project_id),
      objectId: String(row.object_id),
      version: row.version === null ? null : Number(row.version),
      type: String(row.event_type),
      actor: String(row.actor),
      details: parseJson(row.details_json),
      correlationId: String(row.correlation_id),
      occurredAt: String(row.occurred_at),
    }), (row) => ({ eventId: Number(row.event_id) }));
  }

  private persistVersion(
    context: PlatformContext,
    objectId: string,
    metadata: GovernedUploadMetadata,
    content: {
      versionId: string;
      relativeStoragePath: string;
      sizeBytes: number;
      sha256: string;
      extractedText: string | null;
      textTruncated: boolean;
    },
    actor: string,
    correlationId: string,
  ): Record<string, unknown> {
    return this.transaction(() => {
      const existing = this.database.prepare(`SELECT * FROM governed_objects WHERE tenant_id=? AND project_id=? AND id=?`)
        .get(context.tenantId, context.projectId, objectId) as SqliteRow | undefined;
      const version = Number(existing?.current_version ?? 0) + 1;
      const createdAt = nowIso();
      if (existing) {
        const updated = this.database.prepare(`UPDATE governed_objects SET title=?,file_name=?,mime_type=?,current_version=?,updated_by=?,updated_at=? WHERE tenant_id=? AND project_id=? AND id=? AND current_version=?`)
          .run(metadata.title, metadata.fileName, metadata.mimeType, version, actor, createdAt, context.tenantId, context.projectId, objectId, version - 1);
        if (updated.changes !== 1) throw new ConflictError(`Governed object '${objectId}' changed while a new version was uploaded`);
      } else {
        this.database.prepare(`INSERT INTO governed_objects(tenant_id,project_id,id,title,file_name,mime_type,current_version,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)`)
          .run(context.tenantId, context.projectId, objectId, metadata.title, metadata.fileName, metadata.mimeType, actor, createdAt, actor, createdAt);
      }
      this.database.prepare(`INSERT INTO governed_object_versions(tenant_id,project_id,object_id,version,version_id,title,file_name,mime_type,storage_path,size_bytes,sha256,extracted_text,text_indexed,text_truncated,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(context.tenantId, context.projectId, objectId, version, content.versionId, metadata.title, metadata.fileName, metadata.mimeType, content.relativeStoragePath, content.sizeBytes, content.sha256, content.extractedText, content.extractedText === null ? 0 : 1, content.textTruncated ? 1 : 0, actor, createdAt);
      this.searchCatalog.indexSearchDocument(
        context,
        'governedObject',
        objectId,
        metadata.title,
        `${objectId}\n${metadata.fileName}\n${content.extractedText ?? ''}`,
        createdAt,
      );
      const details = {
        version,
        versionId: content.versionId,
        sha256: content.sha256,
        sizeBytes: content.sizeBytes,
        mimeType: metadata.mimeType,
        textIndexed: content.extractedText !== null,
        textTruncated: content.textTruncated,
      };
      this.event(context, objectId, version, 'version.created', actor, details, correlationId, createdAt);
      this.audit(actor, 'platform.governed_object_version_created', 'governedObject', `${context.tenantId}/${context.projectId}/${objectId}@${version}`, details, correlationId, createdAt);
      return {
        object: asObject(this.currentObjectRow(context, objectId)!),
        version: asVersion(this.database.prepare(`SELECT * FROM governed_object_versions WHERE tenant_id=? AND project_id=? AND object_id=? AND version=?`)
          .get(context.tenantId, context.projectId, objectId, version) as SqliteRow),
      };
    });
  }

  private currentObjectRow(context: PlatformContext, objectId: string): SqliteRow | undefined {
    return this.database.prepare(`
      SELECT object.*,version.size_bytes,version.sha256,version.text_indexed,version.text_truncated
      FROM governed_objects AS object
      JOIN governed_object_versions AS version
        ON version.tenant_id=object.tenant_id AND version.project_id=object.project_id
       AND version.object_id=object.id AND version.version=object.current_version
      WHERE object.tenant_id=? AND object.project_id=? AND object.id=?
    `).get(context.tenantId, context.projectId, objectId) as SqliteRow | undefined;
  }

  private objectExists(context: PlatformContext, objectId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM governed_objects WHERE tenant_id=? AND project_id=? AND id=?`)
      .get(context.tenantId, context.projectId, objectId));
  }

  private event(
    context: PlatformContext,
    objectId: string,
    version: number | null,
    eventType: string,
    actor: string,
    details: unknown,
    correlationId: string,
    occurredAt: string,
  ): void {
    this.database.prepare(`INSERT INTO governed_object_events(tenant_id,project_id,object_id,version,event_type,actor,details_json,correlation_id,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(context.tenantId, context.projectId, objectId, version, eventType, actor, JSON.stringify(details), correlationId, occurredAt);
  }

  private audit(actor: string, action: string, entityType: string, entityId: string, details: unknown, correlationId: string, timestamp: string): void {
    this.database.prepare(`INSERT INTO audit_log(timestamp,actor,action,entity_type,entity_id,details_json,correlation_id) VALUES (?,?,?,?,?,?,?)`)
      .run(timestamp, actor, action, entityType, entityId, JSON.stringify(details), correlationId);
  }

  private assertContained(path: string): void {
    const relativePath = relative(this.rootPath, path);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new DataIntegrityError('Governed object storage path escaped the configured object-store root');
    }
  }

  private page(
    rows: SqliteRow[],
    limit: number,
    mapper: (row: SqliteRow) => Record<string, unknown>,
    cursorFor: (row: SqliteRow) => unknown,
  ): Record<string, unknown> {
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return { items: pageRows.map(mapper), nextCursor: hasMore && last ? encodeCursor(cursorFor(last)) : null };
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
