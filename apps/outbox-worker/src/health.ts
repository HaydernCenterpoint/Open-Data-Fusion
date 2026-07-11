import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface OutboxHeartbeat {
  lastSuccessAt: number;
}

export function isFreshOutboxHeartbeat(
  value: unknown,
  maximumAgeMilliseconds: number,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(maximumAgeMilliseconds) || maximumAgeMilliseconds <= 0) return false;
  if (!value || typeof value !== "object" || !("lastSuccessAt" in value)) return false;
  const lastSuccessAt = value.lastSuccessAt;
  return typeof lastSuccessAt === "number"
    && Number.isFinite(lastSuccessAt)
    && lastSuccessAt <= now
    && now - lastSuccessAt <= maximumAgeMilliseconds;
}

/**
 * A file heartbeat lets the container runtime distinguish a live event loop
 * from a worker that can no longer reach PostgreSQL or Redis. The write is
 * replace-atomic so a concurrent Docker healthcheck never reads partial JSON.
 */
export class OutboxHealthFile {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  async reset(): Promise<void> {
    await rm(this.path, { force: true });
  }

  async markSuccess(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify({ lastSuccessAt: this.now() }), { mode: 0o600 });
      await rename(temporaryPath, this.path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
