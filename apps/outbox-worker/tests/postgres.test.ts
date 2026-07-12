import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresOutboxRepository } from "../src/postgres.js";

describe("PostgresOutboxRepository", () => {
  it("builds a valid chained CTE when claiming leased events", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresOutboxRepository({ query } as unknown as Pool);

    await expect(repository.claim(25, "worker-1", 30_000)).resolves.toEqual([]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("FOR UPDATE SKIP LOCKED\n      ), claimed AS (");
    expect(sql).not.toContain("FOR UPDATE SKIP LOCKED\n      )\n      ), claimed AS (");
  });
});
