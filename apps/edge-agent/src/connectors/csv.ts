import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "csv-parse";

import type { CsvConnectorConfig } from "../config.js";
import { mapTabularRecords } from "../mapping.js";
import type { ConnectorBatch, EdgeConnector } from "../types.js";

interface CsvCheckpoint {
  version: 1;
  fileIdentity: string;
  rows: number;
  prefixSha256: string;
}

export interface CsvConnectorDependencies {
  now?: () => Date;
}

function parseCheckpoint(value: string | null): CsvCheckpoint | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CsvCheckpoint>;
    if (
      parsed.version !== 1 ||
      typeof parsed.fileIdentity !== "string" ||
      !Number.isSafeInteger(parsed.rows) ||
      (parsed.rows ?? -1) < 0 ||
      typeof parsed.prefixSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.prefixSha256)
    ) {
      throw new Error("unexpected checkpoint shape");
    }
    return parsed as CsvCheckpoint;
  } catch (error) {
    throw new Error(`Invalid CSV checkpoint: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fileIdentity(path: string, stats: Awaited<ReturnType<typeof stat>>): string {
  return createHash("sha256")
    .update(`${resolve(path)}\0${stats.dev}\0${stats.ino}\0${stats.birthtimeMs}`)
    .digest("hex");
}

export class CsvConnector implements EdgeConnector {
  private readonly now: () => Date;

  constructor(
    private readonly config: CsvConnectorConfig,
    dependencies: CsvConnectorDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async poll(checkpointValue: string | null): Promise<ConnectorBatch | null> {
    const checkpoint = parseCheckpoint(checkpointValue);
    const statsBefore = await stat(this.config.filePath);
    if (!statsBefore.isFile()) throw new Error(`CSV source '${this.config.filePath}' is not a regular file`);
    const identity = fileIdentity(this.config.filePath, statsBefore);
    if (checkpoint && checkpoint.fileIdentity !== identity) {
      throw new Error(
        `CSV source '${this.config.filePath}' was replaced. Reset or migrate its checkpoint explicitly before backfilling the new file.`,
      );
    }

    const startRow = checkpoint?.rows ?? 0;
    const records: Array<Record<string, unknown>> = [];
    let rowsSeen = 0;
    let checkpointBoundaryVerified = startRow === 0;
    const prefixHash = createHash("sha256");
    const input = createReadStream(this.config.filePath);
    const parser = input.pipe(
      parse({
        bom: true,
        columns: true,
        delimiter: this.config.delimiter,
        skip_empty_lines: true,
        trim: this.config.trim,
      }),
    );

    try {
      for await (const value of parser) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(`CSV parser returned a non-object record at row ${rowsSeen + 1}`);
        }
        const record = value as Record<string, unknown>;
        rowsSeen += 1;
        prefixHash.update(JSON.stringify(record)).update("\n");

        if (rowsSeen === startRow && checkpoint) {
          if (prefixHash.copy().digest("hex") !== checkpoint.prefixSha256) {
            throw new Error(
              `CSV source '${this.config.filePath}' changed before its checkpoint boundary; refusing to skip rewritten rows`,
            );
          }
          checkpointBoundaryVerified = true;
          continue;
        }
        if (rowsSeen <= startRow) continue;

        records.push(record);
        if (records.length >= this.config.batchSize) break;
      }
    } finally {
      parser.destroy();
      input.destroy();
    }

    if (!checkpointBoundaryVerified) {
      throw new Error(
        `CSV source '${this.config.filePath}' has fewer rows than its checkpoint (${startRow}); refusing to lose the backfill position`,
      );
    }
    if (records.length === 0) return null;

    const statsAfter = await stat(this.config.filePath);
    if (fileIdentity(this.config.filePath, statsAfter) !== identity) {
      throw new Error(`CSV source '${this.config.filePath}' was replaced while it was being read`);
    }

    const mapped = mapTabularRecords(records, this.config.mapping);
    const checkpointAfter: CsvCheckpoint = {
      version: 1,
      fileIdentity: identity,
      rows: startRow + records.length,
      prefixSha256: prefixHash.digest("hex"),
    };
    return {
      checkpointAfter: JSON.stringify(checkpointAfter),
      observedAt: this.now().toISOString(),
      ...mapped,
      documents: [],
      relations: [],
      rawRecords: records,
    };
  }

  async close(): Promise<void> {
    // A CSV connector opens one bounded stream per poll and owns no long-lived handle.
  }
}
