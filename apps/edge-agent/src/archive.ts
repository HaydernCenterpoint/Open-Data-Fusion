import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ArchivedPayload } from "./types.js";

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

export async function archiveRawPayload(
  archiveDirectory: string,
  sourceSystem: string,
  observedAt: string,
  records: readonly Record<string, unknown>[],
): Promise<ArchivedPayload> {
  const payload = Buffer.from(JSON.stringify({ sourceSystem, observedAt, records }), "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const date = observedAt.slice(0, 10);
  const directory = resolve(archiveDirectory, safeSegment(sourceSystem), date);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${observedAt.replace(/[^0-9]/g, "").slice(0, 17)}-${sha256.slice(0, 16)}-${randomUUID()}.json`);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(payload);
    await file.sync();
  } finally {
    await file.close();
  }
  return { path, sha256, bytes: payload.byteLength };
}
