import { describe, expect, it } from "vitest";

import { resolveOtlpLogsEndpoint } from "../src/otlp-logs.js";

describe("pipeline OTLP log configuration", () => {
  it("uses the logs-specific endpoint and disables unsupported exporters", () => {
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318/base",
    })).toBe("http://collector.example:4318/base/v1/logs");
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.example/v1/logs",
      OTEL_LOGS_EXPORTER: "otlp",
    })).toBe("https://collector.example/v1/logs");
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "false",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
    })).toBeNull();
    expect(resolveOtlpLogsEndpoint({
      ODF_OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
      OTEL_LOGS_EXPORTER: "console",
    })).toBeNull();
  });
});
