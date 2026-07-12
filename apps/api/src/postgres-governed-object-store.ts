import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  appendPlatformAuditAndOutbox,
  type PostgresRuntime,
  type ScopedTransaction,
} from '@open-data-fusion/postgres-runtime';

import { ConflictError, DataIntegrityError, ForbiddenError, NotFoundError } from './database.js';
import type { BlobReference, ImmutableBlobStore } from './object-storage.js';
import { openTemporaryObjectFile } from './object-storage.js';
import type { GovernedObjectListQuery, GovernedUploadMetadata } from './object-schemas.js';
import {
  ObjectTooLargeError,
  safeTextMimeTypes,
  type GovernedDownload,
  type GovernedObjectByteRange,
  type GovernedObjectContext,
  type GovernedObjectPersistence,
} from './object-store.js';

type Row = Record<string, unknown>;

export interface PostgresGovernedObjectStoreOptions {
  temporaryPath: string;
  maxObjectBytes?: number;
  maxExtractedTextCharacters?: number;
}

interface StoredUpload {
  versionId: string;
  blob: BlobReference;
  sizeBytes: number;
  sha256: string;
  extractedText: string | null;
  textTruncated: boolean;
}

interface ScopedContext {
  tenantId: string;
  projectId: string;
  userId: string;
}

const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DataIntegrityError(`PostgreSQL governed object returned an invalid ${label}`);
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DataIntegrityError(`PostgreSQL governed object returned an invalid ${label}`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 1) throw new DataIntegrityError(`PostgreSQL governed object returned an invalid ${label}`);
  return parsed;
}

function bool(value: unknown, label: string): boolean {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new DataIntegrityError(`PostgreSQL governed object returned an invalid ${label}`);
}

function timestamp(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new DataIntegrityError(`PostgreSQL governed object returned an invalid ${label}`);
  return parsed.toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function hashSegment(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, property: string, fallback: string | number): string | number {
  if (!cursor) return fallback;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !(property in parsed)) throw new Error();
    const value = (parsed as Record<string, unknown>)[property];
    if (typeof fallback === 'string') {
      if (typeof value !== 'string' || !value) throw new Error();
      return value;
    }
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error();
    return value as number;
  } catch {
    throw new ConflictError('Governed object cursor is invalid');
  }
}

function scopeFor(context: GovernedObjectContext, fallbackUserId?: string): ScopedContext {
  const tenantId = context.tenantId?.trim();
  const projectId = context.projectId?.trim();
  const userId = context.userId?.trim() || fallbackUserId?.trim();
  if (!tenantId || !projectId || !userId) {
    throw new ForbiddenError('Tenant, project, and user context are required for governed object storage');
  }
  return { tenantId, projectId, userId };
}

function asObject(row: Row): Record<string, unknown> {
  return {
    tenantId: requiredText(row.tenant_id, 'tenant ID'),
    projectId: requiredText(row.project_id, 'project ID'),
    id: requiredText(row.id, 'object ID'),
    title: requiredText(row.title, 'title'),
    fileName: requiredText(row.file_name, 'file name'),
    mimeType: requiredText(row.mime_type, 'MIME type'),
    currentVersion: positiveInteger(row.current_version, 'current version'),
    sizeBytes: integer(row.size_bytes, 'size'),
    sha256: requiredText(row.sha256, 'SHA-256'),
    etag: `"${requiredText(row.sha256, 'SHA-256')}"`,
    textIndexed: bool(row.text_indexed, 'text-indexed flag'),
    textTruncated: bool(row.text_truncated, 'text-truncated flag'),
    createdBy: requiredText(row.created_by, 'creator'),
    createdAt: timestamp(row.created_at, 'creation timestamp'),
    updatedBy: requiredText(row.updated_by, 'updater'),
    updatedAt: timestamp(row.updated_at, 'update timestamp'),
  };
}

function asVersion(row: Row): Record<string, unknown> {
  return {
    tenantId: requiredText(row.tenant_id, 'tenant ID'),
    projectId: requiredText(row.project_id, 'project ID'),
    objectId: requiredText(row.object_id, 'object ID'),
    version: positiveInteger(row.version, 'version'),
    versionId: requiredText(row.version_id, 'version ID'),
    title: requiredText(row.title, 'title'),
    fileName: requiredText(row.file_name, 'file name'),
    mimeType: requiredText(row.mime_type, 'MIME type'),
    sizeBytes: integer(row.size_bytes, 'size'),
    sha256: requiredText(row.sha256, 'SHA-256'),
    etag: `"${requiredText(row.sha256, 'SHA-256')}"`,
    textIndexed: bool(row.text_indexed, 'text-indexed flag'),
    textTruncated: bool(row.text_truncated, 'text-truncated flag'),
    createdBy: requiredText(row.created_by, 'creator'),
    createdAt: timestamp(row.created_at, 'creation timestamp'),
  };
}

function asEvent(row: Row): Record<string, unknown> {
  return {
    id: positiveInteger(row.event_id, 'event ID'),
    tenantId: requiredText(row.tenant_id, 'tenant ID'),
    projectId: requiredText(row.project_id, 'project ID'),
    objectId: requiredText(row.object_id, 'object ID'),
    version: row.version === null || row.version === undefined ? null : positiveInteger(row.version, 'event version'),
    type: requiredText(row.event_type, 'event type'),
    actor: requiredText(row.actor, 'actor'),
    details: parseJson(row.details),
    correlationId: requiredText(row.correlation_id, 'correlation ID'),
    occurredAt: timestamp(row.occurred_at, 'event timestamp'),
  };
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await file.write(buffer, offset, buffer.length - offset, null);
    if (result.bytesWritten <= 0) throw new Error('Governed object staging could not make progress writing the upload');
    offset += result.bytesWritten;
  }
}

const CURRENT_OBJECT_SELECT = [
  'SELECT object.tenant_id::text AS tenant_id, object.project_id::text AS project_id, object.object_id AS id,',
  '  object.current_version, object.created_by, object.created_at, object.updated_by, object.updated_at,',
  '  version.title, version.file_name, version.mime_type, version.size_bytes, version.sha256,',
  '  version.text_indexed, version.text_truncated',
  'FROM odf.governed_objects AS object',
  'JOIN odf.governed_object_versions AS version',
  '  ON version.tenant_id = object.tenant_id AND version.project_id = object.project_id',
  ' AND version.object_id = object.object_id AND version.version = object.current_version',
].join('\n');

const VERSION_SELECT = [
  'SELECT version.tenant_id::text AS tenant_id, version.project_id::text AS project_id, version.object_id, version.version,',
  '  version.version_id::text AS version_id, version.title, version.file_name, version.mime_type, version.storage_profile,',
  '  version.object_key, version.object_version_id, version.storage_etag, version.size_bytes, version.sha256,',
  '  version.extracted_text, version.text_indexed, version.text_truncated, version.created_by, version.created_at',
  'FROM odf.governed_object_versions AS version',
].join('\n');

/** PostgreSQL metadata adapter for shared, immutable S3-compatible governed objects. */
export class PostgresGovernedObjectStore implements GovernedObjectPersistence {
  readonly maxObjectBytes: number;
  private readonly temporaryPath: string;
  private readonly maxExtractedTextCharacters: number;

  constructor(
    private readonly runtime: PostgresRuntime,
    private readonly blobs: ImmutableBlobStore,
    options: PostgresGovernedObjectStoreOptions,
  ) {
    this.temporaryPath = resolve(options.temporaryPath);
    this.maxObjectBytes = options.maxObjectBytes ?? Math.min(blobs.maxObjectBytes, 50 * 1024 * 1024);
    this.maxExtractedTextCharacters = options.maxExtractedTextCharacters ?? 1_000_000;
    if (!Number.isSafeInteger(this.maxObjectBytes) || this.maxObjectBytes < 1 || this.maxObjectBytes > blobs.maxObjectBytes || this.maxObjectBytes > MAX_OBJECT_BYTES) {
      throw new Error('PostgreSQL governed object maxObjectBytes must be positive and no larger than the configured blob store limit');
    }
    if (!Number.isSafeInteger(this.maxExtractedTextCharacters) || this.maxExtractedTextCharacters < 1) {
      throw new Error('PostgreSQL governed object maxExtractedTextCharacters must be positive');
    }
  }

  async upload(
    context: GovernedObjectContext,
    objectId: string,
    metadata: GovernedUploadMetadata,
    source: Readable,
    actor: string,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const scope = scopeFor(context, actor);
    if (metadata.contentLength !== undefined && metadata.contentLength > this.maxObjectBytes) {
      throw new ObjectTooLargeError(`Object exceeds the ${this.maxObjectBytes}-byte upload limit`);
    }
    const staged = await this.stageAndStore(context, objectId, metadata, source);
    return this.runtime.withTransaction(scope, async (transaction) => {
      await transaction.query({
        text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        values: [`odf:governed-object:${scope.tenantId}:${scope.projectId}:${objectId}`],
      });
      const current = await transaction.query<Row>({
        text: [
          'SELECT current_version FROM odf.governed_objects',
          'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND object_id = $3',
          'FOR UPDATE',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, objectId],
      });
      const existing = current.rows[0];
      const version = existing ? positiveInteger(existing.current_version, 'current version') + 1 : 1;
      if (existing) {
        const update = await transaction.query({
          text: [
            'UPDATE odf.governed_objects',
            'SET current_version = $4, updated_by = $5, updated_at = now()',
            'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND object_id = $3 AND current_version = $6',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, objectId, version, actor, version - 1],
        });
        if (update.rowCount !== 1) throw new ConflictError(`Governed object '${objectId}' changed while a new version was uploaded`);
      } else {
        await transaction.query({
          text: [
            'INSERT INTO odf.governed_objects',
            '  (tenant_id, project_id, object_id, current_version, created_by, updated_by)',
            'VALUES ($1::uuid, $2::uuid, $3, 1, $4, $4)',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, objectId, actor],
        });
      }
      await transaction.query({
        text: [
          'INSERT INTO odf.governed_object_versions',
          '  (tenant_id, project_id, object_id, version, version_id, title, file_name, mime_type, storage_profile,',
          '   object_key, object_version_id, storage_etag, size_bytes, sha256, extracted_text, text_indexed, text_truncated, created_by)',
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13::bigint, $14, $15, $16, $17, $18)',
        ].join('\n'),
        values: [
          scope.tenantId, scope.projectId, objectId, version, staged.versionId, metadata.title, metadata.fileName, metadata.mimeType,
          staged.blob.storageProfile, staged.blob.objectKey, staged.blob.objectVersionId, staged.blob.etag,
          staged.sizeBytes, staged.sha256, staged.extractedText, staged.extractedText !== null, staged.textTruncated, actor,
        ],
      });
      const details = {
        version,
        versionId: staged.versionId,
        sha256: staged.sha256,
        sizeBytes: staged.sizeBytes,
        mimeType: metadata.mimeType,
        textIndexed: staged.extractedText !== null,
        textTruncated: staged.textTruncated,
      };
      await transaction.query({
        text: [
          'INSERT INTO odf.governed_object_events',
          "  (tenant_id, project_id, object_id, version, event_type, actor, details, correlation_id) VALUES ($1::uuid, $2::uuid, $3, $4, 'version.created', $5, $6::jsonb, $7::uuid)",
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, objectId, version, actor, JSON.stringify(details), correlationId],
      });
      await appendPlatformAuditAndOutbox(transaction, {
        actor,
        action: 'platform.governed_object_version_created',
        entityType: 'governedObject',
        entityId: `${objectId}@${version}`,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId,
        details,
      });
      const object = await this.currentObject(transaction, scope, objectId);
      const versionRow = await this.versionRow(transaction, scope, objectId, version);
      if (!object || !versionRow) throw new DataIntegrityError(`Governed object '${objectId}' was not readable after version creation`);
      return { object: asObject(object), version: asVersion(versionRow) };
    });
  }

  async listObjects(context: GovernedObjectContext, query: GovernedObjectListQuery): Promise<Record<string, unknown>> {
    const scope = scopeFor(context);
    const cursor = decodeCursor(query.cursor, 'id', '');
    return this.runtime.withTransaction(scope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: [
          CURRENT_OBJECT_SELECT,
          'WHERE object.tenant_id = $1::uuid AND object.project_id = $2::uuid AND object.object_id > $3',
          'ORDER BY object.object_id LIMIT $4',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, cursor, query.limit + 1],
      });
      return this.page(result.rows, query.limit, asObject, (row) => ({ id: requiredText(row.id, 'object ID') }));
    });
  }

  async getObject(context: GovernedObjectContext, objectId: string): Promise<Record<string, unknown>> {
    const scope = scopeFor(context);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const object = await this.currentObject(transaction, scope, objectId);
      if (!object) throw new NotFoundError(`Governed object '${objectId}' was not found`);
      return asObject(object);
    });
  }

  async listVersions(
    context: GovernedObjectContext,
    objectId: string,
    query: GovernedObjectListQuery,
  ): Promise<Record<string, unknown>> {
    const scope = scopeFor(context);
    const cursor = decodeCursor(query.cursor, 'version', 0);
    return this.runtime.withTransaction(scope, async (transaction) => {
      await this.requireObject(transaction, scope, objectId);
      const result = await transaction.query<Row>({
        text: [
          VERSION_SELECT,
          'WHERE version.tenant_id = $1::uuid AND version.project_id = $2::uuid AND version.object_id = $3 AND version.version > $4::integer',
          'ORDER BY version.version LIMIT $5',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, objectId, cursor, query.limit + 1],
      });
      return this.page(result.rows, query.limit, asVersion, (row) => ({ version: positiveInteger(row.version, 'version') }));
    });
  }

  async download(context: GovernedObjectContext, objectId: string, version?: number): Promise<GovernedDownload> {
    const scope = scopeFor(context);
    const download = await this.runtime.withTransaction(scope, async (transaction) => {
      const row = version === undefined
        ? await this.currentVersionRow(transaction, scope, objectId)
        : await this.versionRow(transaction, scope, objectId, version);
      if (!row) throw new NotFoundError(`Governed object '${objectId}'${version === undefined ? '' : ` version ${version}`} was not found`);
      const blobReference = this.blobReference(row);
      return {
        objectId,
        version: positiveInteger(row.version, 'version'),
        versionId: requiredText(row.version_id, 'version ID'),
        fileName: requiredText(row.file_name, 'file name'),
        title: requiredText(row.title, 'title'),
        mimeType: requiredText(row.mime_type, 'MIME type'),
        sha256: requiredText(row.sha256, 'SHA-256'),
        etag: `"${requiredText(row.sha256, 'SHA-256')}"`,
        sizeBytes: integer(row.size_bytes, 'size'),
        blobReference,
      } satisfies GovernedDownload;
    });
    await this.blobs.head(download.blobReference!);
    return download;
  }

  async openContent(download: GovernedDownload, range?: GovernedObjectByteRange): Promise<Readable> {
    if (!download.blobReference) throw new DataIntegrityError('Governed object has no shared blob locator');
    return this.blobs.open(download.blobReference, range);
  }

  async recordDownload(
    context: GovernedObjectContext,
    download: GovernedDownload,
    actor: string,
    correlationId: string,
    range: GovernedObjectByteRange | null,
  ): Promise<void> {
    const scope = scopeFor(context, actor);
    await this.runtime.withTransaction(scope, async (transaction) => {
      const details = {
        version: download.version,
        sha256: download.sha256,
        range: range ? { start: range.start, end: range.end } : null,
      };
      await transaction.query({
        text: [
          'INSERT INTO odf.governed_object_events',
          "  (tenant_id, project_id, object_id, version, event_type, actor, details, correlation_id) VALUES ($1::uuid, $2::uuid, $3, $4, 'content.downloaded', $5, $6::jsonb, $7::uuid)",
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, download.objectId, download.version, actor, JSON.stringify(details), correlationId],
      });
      await appendPlatformAuditAndOutbox(transaction, {
        actor,
        action: 'platform.governed_object_downloaded',
        entityType: 'governedObject',
        entityId: `${download.objectId}@${download.version}`,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId,
        details,
      });
    });
  }

  async listEvents(
    context: GovernedObjectContext,
    objectId: string,
    query: GovernedObjectListQuery,
  ): Promise<Record<string, unknown>> {
    const scope = scopeFor(context);
    const cursor = decodeCursor(query.cursor, 'eventId', 0);
    return this.runtime.withTransaction(scope, async (transaction) => {
      await this.requireObject(transaction, scope, objectId);
      const result = await transaction.query<Row>({
        text: [
          'SELECT event_id, tenant_id::text AS tenant_id, project_id::text AS project_id, object_id, version, event_type, actor, details, correlation_id::text AS correlation_id, occurred_at',
          'FROM odf.governed_object_events',
          'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND object_id = $3 AND event_id > $4::bigint',
          'ORDER BY event_id LIMIT $5',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, objectId, cursor, query.limit + 1],
      });
      return this.page(result.rows, query.limit, asEvent, (row) => ({ eventId: positiveInteger(row.event_id, 'event ID') }));
    });
  }

  private async stageAndStore(
    context: GovernedObjectContext,
    objectId: string,
    metadata: GovernedUploadMetadata,
    source: Readable,
  ): Promise<StoredUpload> {
    await mkdir(this.temporaryPath, { recursive: true, mode: 0o700 });
    const temporaryFile = resolve(this.temporaryPath, `${randomUUID()}.part`);
    const file = await open(temporaryFile, 'wx', 0o600);
    const hash = createHash('sha256');
    const canExtractText = safeTextMimeTypes.has(metadata.mimeType);
    let decoder: TextDecoder | null = canExtractText ? new TextDecoder('utf-8', { fatal: true }) : null;
    let extractedText = '';
    let textTruncated = false;
    let sizeBytes = 0;
    try {
      for await (const value of source) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        sizeBytes += bytes.byteLength;
        if (sizeBytes > this.maxObjectBytes) throw new ObjectTooLargeError(`Object exceeds the ${this.maxObjectBytes}-byte upload limit`);
        hash.update(bytes);
        await writeAll(file, bytes);
        if (decoder) {
          try {
            const decoded = decoder.decode(bytes, { stream: true });
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
      await file.close();
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporaryFile, { force: true }).catch(() => undefined);
      throw error;
    }

    const checksum = hash.digest('hex');
    const versionId = randomUUID();
    const blobKey = this.blobs.keyFor([
      'governed',
      hashSegment(context.tenantId),
      hashSegment(context.projectId),
      `${versionId}.blob`,
    ].join('/'));
    try {
      const blob = await this.blobs.putImmutable({
        objectKey: blobKey,
        body: openTemporaryObjectFile(temporaryFile),
        byteSize: sizeBytes,
        sha256: checksum,
        contentType: metadata.mimeType,
        allowMultipart: true,
      });
      return {
        versionId,
        blob,
        sizeBytes,
        sha256: checksum,
        extractedText: decoder ? extractedText : null,
        textTruncated,
      };
    } finally {
      await rm(temporaryFile, { force: true }).catch(() => undefined);
    }
  }

  private async currentObject(transaction: ScopedTransaction, scope: ScopedContext, objectId: string): Promise<Row | null> {
    const result = await transaction.query<Row>({
      text: [
        CURRENT_OBJECT_SELECT,
        'WHERE object.tenant_id = $1::uuid AND object.project_id = $2::uuid AND object.object_id = $3',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, objectId],
    });
    return result.rows[0] ?? null;
  }

  private async currentVersionRow(transaction: ScopedTransaction, scope: ScopedContext, objectId: string): Promise<Row | null> {
    const result = await transaction.query<Row>({
      text: [
        VERSION_SELECT,
        'JOIN odf.governed_objects AS object',
        '  ON object.tenant_id = version.tenant_id AND object.project_id = version.project_id',
        ' AND object.object_id = version.object_id AND object.current_version = version.version',
        'WHERE version.tenant_id = $1::uuid AND version.project_id = $2::uuid AND version.object_id = $3',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, objectId],
    });
    return result.rows[0] ?? null;
  }

  private async versionRow(
    transaction: ScopedTransaction,
    scope: ScopedContext,
    objectId: string,
    version: number,
  ): Promise<Row | null> {
    const result = await transaction.query<Row>({
      text: [
        VERSION_SELECT,
        'WHERE version.tenant_id = $1::uuid AND version.project_id = $2::uuid AND version.object_id = $3 AND version.version = $4::integer',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, objectId, version],
    });
    return result.rows[0] ?? null;
  }

  private async requireObject(transaction: ScopedTransaction, scope: ScopedContext, objectId: string): Promise<void> {
    const result = await transaction.query({
      text: [
        'SELECT 1 AS present FROM odf.governed_objects',
        'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND object_id = $3',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, objectId],
    });
    if (!result.rows[0]) throw new NotFoundError(`Governed object '${objectId}' was not found`);
  }

  private blobReference(row: Row): BlobReference {
    if (row.storage_profile !== 'primary') throw new DataIntegrityError('Governed object storage profile is invalid');
    return {
      storageProfile: 'primary',
      objectKey: requiredText(row.object_key, 'object key'),
      objectVersionId: requiredText(row.object_version_id, 'object version ID'),
      sha256: requiredText(row.sha256, 'SHA-256'),
      byteSize: integer(row.size_bytes, 'size'),
      contentType: requiredText(row.mime_type, 'MIME type'),
      etag: nullableText(row.storage_etag),
    };
  }

  private page(
    rows: readonly Row[],
    limit: number,
    mapper: (row: Row) => Record<string, unknown>,
    cursorFor: (row: Row) => unknown,
  ): Record<string, unknown> {
    const pageRows = rows.slice(0, limit);
    const tail = pageRows.at(-1);
    return {
      items: pageRows.map(mapper),
      nextCursor: rows.length > limit && tail ? encodeCursor(cursorFor(tail)) : null,
    };
  }
}
