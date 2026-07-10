import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { FusionDatabase } from "../src/database.js";

const databases: FusionDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("API operational endpoints", () => {
  it("reports readiness from the real database probe", async () => {
    const database = new FusionDatabase({ path: ":memory:", seed: true });
    databases.push(database);
    const response = await request(createApp(database)).get("/ready");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", readiness: "ready" });
  });

  it("protects Prometheus metrics when a scrape token is configured", async () => {
    const database = new FusionDatabase({ path: ":memory:", seed: true });
    databases.push(database);
    const app = createApp(database, undefined, { metricsToken: "local-metrics-secret" });
    await request(app).get("/health");

    const denied = await request(app).get("/metrics");
    expect(denied.status).toBe(401);

    const allowed = await request(app)
      .get("/metrics")
      .set("authorization", "Bearer local-metrics-secret");
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain("odf_api_http_requests_total");
    expect(allowed.text).toContain("odf_api_process_cpu_seconds_total");
  });
});
