import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { FusionDatabase } from "../src/database.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function rawLandingApp() {
  const directory = await mkdtemp(join(tmpdir(), "odf-raw-"));
  const database = new FusionDatabase({ path: ":memory:", seed: true });
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  cleanup.push(() => database.close());
  return createApp(database, undefined, { rawLandingDirectory: directory });
}

const contextHeaders = {
  "x-odf-user": "harper.dennis",
  "x-odf-tenant-id": "demo",
  "x-odf-project-id": "north-plant",
};

describe("immutable raw landing and replay", () => {
  it("archives accepted payloads and replays them as a new audited run", async () => {
    const app = await rawLandingApp();
    const ingest = await request(app)
      .post("/api/v1/ingest/bundle")
      .set(contextHeaders)
      .send({
        source: { system: "csv-pilot", runId: "raw-run-1", actor: "forged" },
        assets: [{ externalId: "RAW-P-1", name: "Raw Pump 1", type: "Pump" }],
      });
    expect(ingest.status).toBe(201);
    expect(ingest.body).toMatchObject({ rawObjectId: expect.stringMatching(/^raw-/), rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const listed = await request(app)
      .get("/api/v1/platform/ingestion/raw")
      .set(contextHeaders);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ runId: "raw-run-1", state: "accepted", actor: "harper.dennis" });
    expect(listed.body.items[0].rawObjectUri).toMatch(/^raw:\/\/demo\/north-plant\//);
    expect(listed.body.items[0]).not.toHaveProperty("storageKey");

    const replay = await request(app)
      .post(`/api/v1/platform/ingestion/raw/${listed.body.items[0].id}/replay`)
      .set(contextHeaders);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ status: "completed", replayedFromRawObjectId: listed.body.items[0].id });
    expect(replay.body.runId).toMatch(/^replay-/);
  });

  it("retains invalid but well-formed payloads as failed raw evidence", async () => {
    const app = await rawLandingApp();
    const ingest = await request(app)
      .post("/api/v1/ingest/bundle")
      .set(contextHeaders)
      .send({
        source: { system: "csv-pilot", runId: "raw-run-failed" },
        dataPoints: [{ timeSeriesExternalId: "MISSING-SERIES", timestamp: "2026-07-11T00:00:00.000Z", value: 1 }],
      });
    expect(ingest.status).toBe(422);

    const listed = await request(app)
      .get("/api/v1/platform/ingestion/raw")
      .set(contextHeaders);
    expect(listed.body.items[0]).toMatchObject({ runId: "raw-run-failed", state: "failed" });
    expect(listed.body.items[0].errorSummary).toContain("does not exist");
  });
});
