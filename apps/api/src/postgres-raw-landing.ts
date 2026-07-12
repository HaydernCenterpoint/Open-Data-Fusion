import { createHash, randomUUID } from 'node:crypto';

import {
  appendPlatformAuditAndOutbox,
  type PostgresRuntime,
  type ScopedTransaction,
} from '@open-data-fusion/postgres-runtime';

import { ConflictError, DataIntegrityError, ForbiddenError, NotFoundError } from './database.js';
import type { ImmutableBlobStore } from './object-storage.js';
import type { IngestBundle } from './schemas.js';
import type {
  RawLandingContext,
  RawLandingPersistence,
  RawLandingRecord,
  RawLandingState,
} from './raw-landing.js';

type Row = Record<string, unknown>;

const RAW_STATES = new Set<RawLandingState>(['received', 'accepted', 'failed', 'quarantined']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashSegment(value: string, length = 24): string {
  return sha256(value).slice(0, length);
}

function timestamp(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new DataIntegrityError(`PostgreSQL raw landing returned an invalid ${label}`);
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : timestamp(value, label);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DataIntegrityError(`PostgreSQL raw landing returned an invalid ${label}`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new DataIntegrityError(`PostgreSQL raw landing returned an invalid ${label}`);
  return result;
}

function errorSummary(value: string | undefined): string {
  const sanitized = value?.replace(/[\r\n\t]+/gu, ' ').trim().slice(0, 2_000);
  return sanitized || 'Unknown ingestion failure';
}

function encodeCursor(record: RawLandingRecord): string {
  return Buffer.from(JSON.stringify([record.createdAt, record.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some((part) => typeof part !== 'string')) throw new Error();
    const createdAt = new Date(parsed[0] as string);
    if (Number.isNaN(createdAt.getTime()) || !UUID_PATTERN.test(parsed[1] as string)) throw new Error();
    return [createdAt.toISOString(), parsed[1] as string];
  } catch {
    throw new ConflictError('Raw landing cursor is invalid');
  }
}

function asState(value: unknown): RawLandingState {
  if (typeof value !== 'string' || !RAW_STATES.has(value as RawLandingState)) {
    throw new DataIntegrityError('PostgreSQL raw landing returned an invalid lifecycle state');
  }
  return value as RawLandingState;
}

function recordFromRow(row: Row): RawLandingRecord {
  const id = requiredText(row.id, 'landing ID');
  const tenantId = requiredText(row.tenant_id, 'tenant ID');
  const projectId = requiredText(row.project_id, 'project ID');
  return {
    id,
    tenantId,
    projectId,
    sourceSystem: requiredText(row.source_system, 'source system'),
    runId: requiredText(row.run_id, 'run ID'),
    // Keep physical S3 locators private. Existing clients keep the stable
    // logical URI regardless of bucket/provider migration.
    rawObjectUri: `raw://${tenantId}/${projectId}/${id}`,
    sha256: requiredText(row.content_sha256, 'content checksum'),
    byteSize: numberValue(row.byte_size, 'byte size'),
    state: asState(row.state),
    actor: requiredText(row.actor, 'actor'),
    correlationId: requiredText(row.correlation_id, 'correlation ID'),
    errorSummary: nullableText(row.error_summary),
    createdAt: timestamp(row.created_at, 'creation timestamp'),
    completedAt: nullableTimestamp(row.completed_at, 'completion timestamp'),
    lastReplayedAt: nullableTimestamp(row.last_replayed_at, 'replay timestamp'),
    lastReplayRunId: nullableText(row.last_replay_run_id),
  };
}

function scopeFor(context: RawLandingContext, fallbackUserId?: string): { tenantId: string; projectId: string; userId: string } {
  const tenantId = context.tenantId?.trim();
  const projectId = context.projectId?.trim();
  const userId = context.userId?.trim() || fallbackUserId?.trim();
  if (!tenantId || !projectId || !userId) throw new ForbiddenError('Tenant, project, and user context are required for raw landing');
  return { tenantId, projectId, userId };
}

function rawLocatorKey(context: RawLandingContext, runId: string, checksum: string): string {
  return [
    'raw',
    hashSegment(context.tenantId),
    hashSegment(context.projectId),
    hashSegment(runId),
    `${checksum}.json`,
  ].join('/');
}

const RECORD_SELECT = [
  'SELECT landing.landing_id::text AS id, landing.tenant_id::text AS tenant_id, landing.project_id::text AS project_id,',
  '  landing.source_system, landing.run_id, landing.storage_profile, landing.object_key, landing.object_version_id,',
  '  landing.content_sha256, landing.content_type, landing.byte_size, landing.actor, landing.correlation_id::text AS correlation_id,',
  '  landing.created_at, lifecycle.event_type AS state, lifecycle.error_summary,',
  "  CASE WHEN lifecycle.event_type = 'received' THEN NULL ELSE lifecycle.occurred_at END AS completed_at,",
  '  replay.occurred_at AS last_replayed_at, replay.replay_run_id AS last_replay_run_id',
  'FROM odf.raw_landing_objects AS landing',
  'JOIN LATERAL (',
  '  SELECT event_type, error_summary, occurred_at',
  '  FROM odf.raw_landing_events',
  "  WHERE tenant_id = landing.tenant_id AND project_id = landing.project_id AND landing_id = landing.landing_id AND event_type <> 'replayed'",
  '  ORDER BY event_id DESC LIMIT 1',
  ') AS lifecycle ON true',
  'LEFT JOIN LATERAL (',
  '  SELECT occurred_at, replay_run_id',
  '  FROM odf.raw_landing_events',
  "  WHERE tenant_id = landing.tenant_id AND project_id = landing.project_id AND landing_id = landing.landing_id AND event_type = 'replayed'",
  '  ORDER BY event_id DESC LIMIT 1',
  ') AS replay ON true',
].join('\n');

/** PostgreSQL raw landing with immutable shared blob bytes and scoped metadata. */
export class PostgresRawLandingStore implements RawLandingPersistence {
  constructor(
    private readonly runtime: PostgresRuntime,
    private readonly blobs: ImmutableBlobStore,
  ) {}

  async archive(context: RawLandingContext, bundle: IngestBundle, actor: string, correlationId: string): Promise<RawLandingRecord> {
    const scope = scopeFor(context, actor);
    const bytes = Buffer.from(JSON.stringify(bundle), 'utf8');
    const checksum = sha256(bytes);
    const runId = bundle.source.runId ?? checksum;
    const existing = await this.runtime.withTransaction(scope, async (transaction) => this.findByRun(transaction, scope, runId));
    if (existing) {
      this.assertExactRun(existing, checksum, bytes.byteLength);
      await this.verifyBlob(context, existing.id, actor);
      return existing;
    }

    // Blob I/O intentionally happens outside the PostgreSQL transaction. A
    // deterministic immutable key makes an idempotent race safe; a rare DB
    // failure can leave only an unreachable orphan for a maintenance sweeper.
    const blob = await this.blobs.putImmutable({
      objectKey: this.blobKey(context, runId, checksum),
      body: bytes,
      byteSize: bytes.byteLength,
      sha256: checksum,
      contentType: 'application/json',
    });
    const landingId = randomUUID();

    const archived = await this.runtime.withTransaction(scope, async (transaction) => {
      await transaction.query({
        text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        values: [`odf:raw-landing:${scope.tenantId}:${scope.projectId}:${runId}`],
      });
      const raced = await this.findByRun(transaction, scope, runId, true);
      if (raced) {
        this.assertExactRun(raced, checksum, bytes.byteLength);
        return raced;
      }
      await transaction.query({
        text: [
          'INSERT INTO odf.raw_landing_objects',
          '  (landing_id, tenant_id, project_id, source_system, run_id, storage_profile, object_key, object_version_id,',
          '   content_sha256, content_type, byte_size, actor, correlation_id)',
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::bigint, $12, $13::uuid)',
          'ON CONFLICT (tenant_id, project_id, run_id) DO NOTHING',
        ].join('\n'),
        values: [
          landingId, scope.tenantId, scope.projectId, bundle.source.system, runId, blob.storageProfile,
          blob.objectKey, blob.objectVersionId, checksum, blob.contentType, bytes.byteLength, actor, correlationId,
        ],
      });
      const persisted = await this.findByRun(transaction, scope, runId, true);
      const resolvedLandingId = persisted?.id ?? landingId;
      if (persisted) {
        this.assertExactRun(persisted, checksum, bytes.byteLength);
        // A conflict can only be an exact idempotent run because the lock is
        // held, but ensure the lifecycle event exists before returning.
        const event = await transaction.query({
          text: [
            'SELECT 1 AS present FROM odf.raw_landing_events',
            "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND landing_id::text = $3 AND event_type = 'received'",
            'LIMIT 1',
          ].join('\n'),
          values: [scope.tenantId, scope.projectId, persisted.id],
        });
        if (event.rows[0]) return persisted;
      }
      await transaction.query({
        text: [
          'INSERT INTO odf.raw_landing_events',
          "  (tenant_id, project_id, landing_id, event_type, actor, correlation_id) VALUES ($1::uuid, $2::uuid, $3::uuid, 'received', $4, $5::uuid)",
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, resolvedLandingId, actor, correlationId],
      });
      await appendPlatformAuditAndOutbox(transaction, {
        actor,
        action: 'raw_landing.received',
        entityType: 'rawLanding',
        entityId: resolvedLandingId,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId,
        details: { runId, sourceSystem: bundle.source.system, sha256: checksum, byteSize: bytes.byteLength },
      });
      const created = await this.findById(transaction, scope, resolvedLandingId);
      if (!created) throw new DataIntegrityError('Raw landing metadata was not readable after creation');
      return created;
    });
    // A race may return metadata committed by another replica. Verify its
    // immutable locator after the short database transaction, so idempotent
    // retries never report success for deleted or corrupted raw evidence.
    await this.verifyBlob(context, archived.id, actor);
    return archived;
  }

  async complete(
    context: RawLandingContext,
    id: string,
    state: Exclude<RawLandingState, 'received'>,
    failure?: string,
  ): Promise<RawLandingRecord> {
    const scope = scopeFor(context);
    return this.runtime.withTransaction(scope, async (transaction) => {
      await this.lockLanding(transaction, scope, id);
      const current = await this.findById(transaction, scope, id);
      if (!current) throw new NotFoundError(`Raw ingest object '${id}' was not found`);
      const normalizedError = state === 'accepted' ? null : errorSummary(failure);
      if (current.state === state && current.errorSummary === normalizedError) return current;
      await transaction.query({
        text: [
          'INSERT INTO odf.raw_landing_events',
          '  (tenant_id, project_id, landing_id, event_type, error_summary, actor, correlation_id)',
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid)',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, id, state, normalizedError, scope.userId, current.correlationId],
      });
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: `raw_landing.${state}`,
        entityType: 'rawLanding',
        entityId: id,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId: current.correlationId,
        details: { runId: current.runId, sourceSystem: current.sourceSystem, ...(normalizedError ? { errorSummary: normalizedError } : {}) },
      });
      const completed = await this.findById(transaction, scope, id);
      if (!completed) throw new DataIntegrityError(`Raw ingest object '${id}' disappeared after lifecycle update`);
      return completed;
    });
  }

  async list(context: RawLandingContext, limit: number, cursor?: string): Promise<{ items: RawLandingRecord[]; nextCursor: string | null }> {
    const scope = scopeFor(context);
    const decoded = decodeCursor(cursor);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: [
          RECORD_SELECT,
          'WHERE landing.tenant_id = $1::uuid AND landing.project_id = $2::uuid',
          '  AND ($3::timestamptz IS NULL OR landing.created_at < $3::timestamptz',
          '       OR (landing.created_at = $3::timestamptz AND landing.landing_id < $4::uuid))',
          'ORDER BY landing.created_at DESC, landing.landing_id DESC',
          'LIMIT $5',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, decoded?.[0] ?? null, decoded?.[1] ?? null, limit + 1],
      });
      const records = result.rows.map(recordFromRow);
      const items = records.slice(0, limit);
      const tail = items.at(-1);
      return { items, nextCursor: records.length > limit && tail ? encodeCursor(tail) : null };
    });
  }

  async replayBundle(context: RawLandingContext, id: string): Promise<IngestBundle> {
    const record = await this.get(context, id);
    const locator = await this.locator(context, id);
    const stream = await this.blobs.open(locator);
    const chunks: Buffer[] = [];
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > record.byteSize) throw new DataIntegrityError(`Raw ingest object '${id}' exceeds its immutable metadata size`);
      hash.update(bytes);
      chunks.push(bytes);
    }
    const checksum = hash.digest('hex');
    if (size !== record.byteSize || checksum !== record.sha256) {
      throw new DataIntegrityError(`Raw ingest object '${id}' failed integrity verification`);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as IngestBundle;
    } catch {
      throw new DataIntegrityError(`Raw ingest object '${id}' does not contain a valid JSON bundle`);
    }
  }

  async markReplayed(context: RawLandingContext, id: string, replayRunId: string): Promise<RawLandingRecord> {
    const scope = scopeFor(context);
    if (!replayRunId.trim()) throw new ConflictError('Raw replay run ID is required');
    return this.runtime.withTransaction(scope, async (transaction) => {
      await this.lockLanding(transaction, scope, id);
      const current = await this.findById(transaction, scope, id);
      if (!current) throw new NotFoundError(`Raw ingest object '${id}' was not found`);
      await transaction.query({
        text: [
          'INSERT INTO odf.raw_landing_events',
          "  (tenant_id, project_id, landing_id, event_type, replay_run_id, actor, correlation_id) VALUES ($1::uuid, $2::uuid, $3::uuid, 'replayed', $4, $5, $6::uuid)",
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, id, replayRunId, scope.userId, current.correlationId],
      });
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId,
        action: 'raw_landing.replayed',
        entityType: 'rawLanding',
        entityId: id,
        tenantId: scope.tenantId,
        projectId: scope.projectId,
        correlationId: current.correlationId,
        details: { runId: current.runId, replayRunId },
      });
      const replayed = await this.findById(transaction, scope, id);
      if (!replayed) throw new DataIntegrityError(`Raw ingest object '${id}' disappeared after replay evidence`);
      return replayed;
    });
  }

  async get(context: RawLandingContext, id: string): Promise<RawLandingRecord> {
    const scope = scopeFor(context);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const record = await this.findById(transaction, scope, id);
      if (!record) throw new NotFoundError(`Raw ingest object '${id}' was not found`);
      return record;
    });
  }

  private blobKey(context: RawLandingContext, runId: string, checksum: string): string {
    return this.blobs.keyFor(rawLocatorKey(context, runId, checksum));
  }

  private async locator(context: RawLandingContext, id: string, fallbackUserId?: string) {
    const scope = scopeFor(context, fallbackUserId);
    return this.runtime.withTransaction(scope, async (transaction) => {
      const result = await transaction.query<Row>({
        text: [
          'SELECT storage_profile, object_key, object_version_id, content_sha256, byte_size, content_type',
          'FROM odf.raw_landing_objects',
          'WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND landing_id::text = $3',
        ].join('\n'),
        values: [scope.tenantId, scope.projectId, id],
      });
      const row = result.rows[0];
      if (!row) throw new NotFoundError(`Raw ingest object '${id}' was not found`);
      if (row.storage_profile !== 'primary') throw new DataIntegrityError('Raw landing storage profile is invalid');
      return {
        storageProfile: 'primary' as const,
        objectKey: requiredText(row.object_key, 'object key'),
        objectVersionId: requiredText(row.object_version_id, 'object version ID'),
        sha256: requiredText(row.content_sha256, 'content checksum'),
        byteSize: numberValue(row.byte_size, 'byte size'),
        contentType: requiredText(row.content_type, 'content type'),
        etag: null,
      };
    });
  }

  private async verifyBlob(context: RawLandingContext, id: string, fallbackUserId?: string): Promise<void> {
    await this.blobs.head(await this.locator(context, id, fallbackUserId));
  }

  private async lockLanding(transaction: ScopedTransaction, scope: { tenantId: string; projectId: string }, id: string): Promise<void> {
    await transaction.query({
      text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      values: [`odf:raw-landing:${scope.tenantId}:${scope.projectId}:${id}`],
    });
  }

  private async findByRun(
    transaction: ScopedTransaction,
    scope: { tenantId: string; projectId: string },
    runId: string,
    lock = false,
  ): Promise<RawLandingRecord | null> {
    const result = await transaction.query<Row>({
      text: [
        RECORD_SELECT,
        'WHERE landing.tenant_id = $1::uuid AND landing.project_id = $2::uuid AND landing.run_id = $3',
        ...(lock ? ['FOR UPDATE OF landing'] : []),
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, runId],
    });
    return result.rows[0] ? recordFromRow(result.rows[0]) : null;
  }

  private async findById(
    transaction: ScopedTransaction,
    scope: { tenantId: string; projectId: string },
    id: string,
  ): Promise<RawLandingRecord | null> {
    const result = await transaction.query<Row>({
      text: [
        RECORD_SELECT,
        'WHERE landing.tenant_id = $1::uuid AND landing.project_id = $2::uuid AND landing.landing_id::text = $3',
      ].join('\n'),
      values: [scope.tenantId, scope.projectId, id],
    });
    return result.rows[0] ? recordFromRow(result.rows[0]) : null;
  }

  private assertExactRun(record: RawLandingRecord, checksum: string, byteSize: number): void {
    if (record.sha256 !== checksum || record.byteSize !== byteSize) {
      throw new ConflictError(`Ingestion run '${record.runId}' already has a different immutable raw payload`);
    }
  }
}
