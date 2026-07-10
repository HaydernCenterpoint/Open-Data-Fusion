import { loadEnvFile } from "node:process";

import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

try {
  loadEnvFile();
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

export const telemetrySdk = endpoint && process.env.ODF_OTEL_ENABLED !== "false"
  ? new NodeSDK({
      serviceName: "open-data-fusion-api",
      traceExporter: new OTLPTraceExporter({
        url: endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/$/u, "")}/v1/traces`,
      }),
      instrumentations: [getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      })],
    })
  : null;

telemetrySdk?.start();

let telemetryShutdown: Promise<void> | null = null;

export function shutdownTelemetry(): Promise<void> {
  if (!telemetrySdk) return Promise.resolve();
  telemetryShutdown ??= telemetrySdk.shutdown();
  return telemetryShutdown;
}

process.once("beforeExit", () => {
  void shutdownTelemetry();
});
