import { once } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { OtlpLogEmitter, resolveOtlpLogsEndpoint } from "../src/otlp-logs.js";

describe("outbox OTLP log emitter", () => {
  it("normalizes only safe HTTP OTLP log endpoints", () => {
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318/",
    })).toBe("http://collector.example:4318/v1/logs");
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.example/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
    })).toBe("https://collector.example/v1/logs");
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example",
    })).toBeNull();
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "grpc",
    })).toBeNull();
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
      OTEL_LOGS_EXPORTER: "none",
    })).toBeNull();
  });

  it("exports a bounded redacted JSON record over OTLP without a global provider", async () => {
    const marker = "outbox-otlp-log-marker";
    let requestBody = Buffer.alloc(0);
    const server = createServer((request, response) => {
      request.on("data", (chunk: Buffer) => { requestBody = Buffer.concat([requestBody, chunk]); });
      request.on("end", () => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/logs");
        response.statusCode = 200;
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

    const emitter = OtlpLogEmitter.create("open-data-fusion-outbox-worker", {
      ODF_OTEL_ENABLED: "true",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
    });
    expect(emitter).not.toBeNull();
    emitter?.emit("info", "worker_started", JSON.stringify({ marker, password: "[REDACTED]" }));
    await emitter?.shutdown();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(requestBody.length).toBeGreaterThan(0);
    expect(requestBody.toString("utf8")).toContain(marker);
    expect(requestBody.toString("utf8")).toContain("[REDACTED]");
  });
});
