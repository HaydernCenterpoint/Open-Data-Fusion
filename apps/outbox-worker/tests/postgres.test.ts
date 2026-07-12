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

  it("moves poison events to an infinite durable delay and can explicitly requeue them", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const repository = new PostgresOutboxRepository({ query } as unknown as Pool);

    await repository.deadLetter("42", "worker-1", "broker unavailable");
    await expect(repository.requeueDeadLetter("42", "broker recovered")).resolves.toBe(true);

    expect(String(query.mock.calls[0]?.[0])).toContain("available_at = 'infinity'::timestamptz");
    expect(query.mock.calls[0]?.[1]).toEqual(["42", "worker-1", "dead-letter: broker unavailable"]);
    expect(String(query.mock.calls[1]?.[0])).toContain("attempt_count = 0");
    expect(String(query.mock.calls[1]?.[0])).toContain("available_at = 'infinity'::timestamptz");
  });

  it("maps durable backlog gauges from PostgreSQL", async () => {
    const query = vi.fn(async () => ({
      rows: [{ pending_events: "7", dead_lettered_events: "2", oldest_pending_age_seconds: "91.5" }],
      rowCount: 1,
    }));
    const repository = new PostgresOutboxRepository({ query } as unknown as Pool);

    await expect(repository.operationalSnapshot()).resolves.toEqual({
      pendingEvents: 7,
      deadLetteredEvents: 2,
      oldestPendingAgeSeconds: 91.5,
    });
  });
});
