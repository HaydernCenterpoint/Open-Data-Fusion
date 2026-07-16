import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export interface PipelineHeartbeat {
  lastSuccessAt: number;
}

export function isFreshPipelineHeartbeat(
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
 * The heartbeat is atomically replaced after a healthy polling cycle. It lets
 * a runtime distinguish a live event loop from a worker that can no longer
 * complete a pipeline cycle against PostgreSQL.
 */
export class PipelineHealthFile {
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

  async isFresh(maximumAgeMilliseconds: number): Promise<boolean> {
    try {
      return isFreshPipelineHeartbeat(JSON.parse(await readFile(this.path, "utf8")), maximumAgeMilliseconds, this.now());
    } catch {
      return false;
    }
  }
}
