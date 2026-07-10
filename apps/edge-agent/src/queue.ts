import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ArchivedPayload, IngestBundle, QueuedBatch } from "./types.js";

interface QueueRow {
  id: string;
  source_system: string;
  idempotency_key: string;
  bundle_json: string;
  archive_path: string;
  archive_sha256: string;
  checkpoint_after: string;
  attempt_count: number;
}

export class EdgeQueue {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS source_checkpoints (
        source_system TEXT PRIMARY KEY,
        checkpoint TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS queued_batches (
        id TEXT PRIMARY KEY,
        source_system TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        bundle_json TEXT NOT NULL CHECK (json_valid(bundle_json)),
        archive_path TEXT NOT NULL,
        archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
        checkpoint_after TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        available_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS queued_batches_ready_idx
        ON queued_batches (available_at, created_at, id)
        WHERE state IN ('pending', 'failed');
    `);
  }

  checkpoint(sourceSystem: string): string | null {
    const row = this.database.prepare("SELECT checkpoint FROM source_checkpoints WHERE source_system = ?").get(sourceSystem) as { checkpoint: string } | undefined;
    return row?.checkpoint ?? null;
  }

  enqueue(id: string, sourceSystem: string, bundle: IngestBundle, checkpointAfter: string, archive: ArchivedPayload): boolean {
    const now = new Date().toISOString();
    const transaction = this.database.prepare(`
      INSERT INTO queued_batches(
        id, source_system, idempotency_key, bundle_json, archive_path, archive_sha256,
        checkpoint_after, state, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = transaction.run(id, sourceSystem, bundle.source.runId, JSON.stringify(bundle), archive.path, archive.sha256, checkpointAfter, Date.now(), now);
      if (result.changes === 1) {
        this.database.prepare(`
          INSERT INTO source_checkpoints(source_system, checkpoint, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(source_system) DO UPDATE SET checkpoint = excluded.checkpoint, updated_at = excluded.updated_at
        `).run(sourceSystem, checkpointAfter, now);
      }
      this.database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claim(leaseMilliseconds = 30_000): QueuedBatch | null {
    const now = Date.now();
    this.database.prepare(`
      UPDATE queued_batches
      SET state = 'failed', lease_expires_at = NULL, available_at = ?
      WHERE state = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).run(now, now);
    const row = this.database.prepare(`
      UPDATE queued_batches
      SET state = 'sending', attempt_count = attempt_count + 1, lease_expires_at = ?, last_error = NULL
      WHERE id = (
        SELECT id FROM queued_batches
        WHERE state IN ('pending', 'failed') AND available_at <= ?
        ORDER BY available_at, created_at, id
        LIMIT 1
      )
      RETURNING id, source_system, idempotency_key, bundle_json, archive_path,
        archive_sha256, checkpoint_after, attempt_count
    `).get(now + leaseMilliseconds, now) as QueueRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      sourceSystem: row.source_system,
      idempotencyKey: row.idempotency_key,
      bundle: JSON.parse(row.bundle_json) as IngestBundle,
      archivePath: row.archive_path,
      archiveSha256: row.archive_sha256,
      checkpointAfter: row.checkpoint_after,
      attemptCount: row.attempt_count,
    };
  }

  markSent(id: string): void {
    const result = this.database.prepare(`
      UPDATE queued_batches SET state = 'sent', lease_expires_at = NULL, sent_at = ?
      WHERE id = ? AND state = 'sending'
    `).run(new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`Queued batch '${id}' is not leased for sending`);
  }

  release(id: string, error: string, delayMilliseconds: number): void {
    const result = this.database.prepare(`
      UPDATE queued_batches
      SET state = 'failed', lease_expires_at = NULL, available_at = ?, last_error = ?
      WHERE id = ? AND state = 'sending'
    `).run(Date.now() + delayMilliseconds, error.replace(/[\r\n\t]+/g, " ").slice(0, 2_000), id);
    if (result.changes !== 1) throw new Error(`Queued batch '${id}' is not leased for sending`);
  }

  pendingCount(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM queued_batches WHERE state <> 'sent'").get() as { count: number };
    return row.count;
  }

  close(): void {
    this.database.close();
  }
}
