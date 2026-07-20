import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";

import { createApp } from "../src/app.js";
import { FusionDatabase } from "../src/database.js";
import { createApiLogger } from "../src/observability.js";

const databases: FusionDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("API operational endpoints", () => {
  it("loads Pino through CommonJS so the OTLP log stream is attached", () => {
    const source = readFileSync(new URL("../src/observability.ts", import.meta.url), "utf8");

    expect(source).toContain('import { createRequire } from "node:module";');
    expect(source).toContain('const pino: PinoFactory = require("pino");');
    expect(source).not.toContain('import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";');
  });

  it("redacts Pino fields before serialized request logs can reach OTLP", () => {
    const lines: string[] = [];
    const secret = "unexportable-log-secret";
    const logger = createApiLogger({
      write(line: string): void {
        lines.push(line);
      },
    }, { NODE_ENV: "development" });

    logger.child({ childCredentials: { token: secret } }).info({
      correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      method: "GET",
      route: "/health",
      statusCode: 200,
      durationMs: 4,
      request: {
        headers: { authorization: `Bearer ${secret}` },
        cookie: `session=${secret}`,
      },
      endpoint: `postgresql://api:${secret}@db.internal/odf`,
      err: new Error(`delivery failed password=${secret}`),
    }, "request completed");

    expect(lines).toHaveLength(1);
    const serialized = lines[0]!;
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");

    const record = JSON.parse(serialized) as Record<string, unknown>;
    expect(record).toMatchObject({
      correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      method: "GET",
      route: "/health",
      statusCode: 200,
      durationMs: 4,
      childCredentials: "[REDACTED]",
      request: {
        headers: { authorization: "[REDACTED]" },
        cookie: "[REDACTED]",
      },
    });
    expect(JSON.stringify(record.err)).not.toContain(secret);
  });

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
