import type { Logger } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

export type OtlpLogLevel = "debug" | "info" | "warn" | "error";

const MAX_RECORD_LENGTH = 64 * 1024;

function configuredOtlpExporter(environment: NodeJS.ProcessEnv): boolean {
  const configured = environment.OTEL_LOGS_EXPORTER?.trim();
  if (!configured) return true;
  return configured
    .split(",")
    .map((exporter) => exporter.trim().toLowerCase())
    .includes("otlp");
}

export function resolveOtlpLogsEndpoint(environment: NodeJS.ProcessEnv = process.env): string | null {
  if (environment.ODF_OTEL_ENABLED === "false" || !configuredOtlpExporter(environment)) return null;

  const protocol = environment.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL?.trim().toLowerCase();
  if (protocol && protocol !== "http/protobuf") return null;

  const configured = environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim()
    ?? environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!configured) return null;

  try {
    const endpoint = new URL(configured);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return null;
    if (endpoint.username || endpoint.password) return null;
    if (!endpoint.pathname.endsWith("/v1/logs")) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/v1/logs`;
    }
    return endpoint.toString();
  } catch {
    return null;
  }
}

function severity(level: OtlpLogLevel): SeverityNumber {
  switch (level) {
    case "debug": return SeverityNumber.DEBUG;
    case "info": return SeverityNumber.INFO;
    case "warn": return SeverityNumber.WARN;
    case "error": return SeverityNumber.ERROR;
  }
}

/**
 * Sends an already redacted JSON record over OTLP without registering a global
 * provider. Keeping the provider process-local prevents worker telemetry from
 * changing another library's logging configuration.
 */
export class OtlpLogEmitter {
  private constructor(
    private readonly provider: LoggerProvider,
    private readonly logger: Logger,
  ) {}

  static create(serviceName: string, environment: NodeJS.ProcessEnv = process.env): OtlpLogEmitter | null {
    const endpoint = resolveOtlpLogsEndpoint(environment);
    if (!endpoint) return null;

    try {
      const provider = new LoggerProvider({
        resource: resourceFromAttributes({ "service.name": serviceName }),
        forceFlushTimeoutMillis: 5_000,
        logRecordLimits: {
          attributeCountLimit: 8,
          attributeValueLengthLimit: 2_000,
        },
        processors: [new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: endpoint }),
          maxQueueSize: 512,
          maxExportBatchSize: 64,
          scheduledDelayMillis: 1_000,
          exportTimeoutMillis: 5_000,
        })],
      });
      return new OtlpLogEmitter(provider, provider.getLogger(serviceName));
    } catch {
      // Logging must never prevent a durable worker from starting. The stdout
      // sink remains available if telemetry setup is invalid or unavailable.
      return null;
    }
  }

  emit(level: OtlpLogLevel, event: string, redactedJson: string): void {
    try {
      this.logger.emit({
        eventName: event,
        severityNumber: severity(level),
        severityText: level.toUpperCase(),
        body: redactedJson.slice(0, MAX_RECORD_LENGTH),
        attributes: { "odf.log.format": "json" },
      });
    } catch {
      // An asynchronous telemetry path must not disrupt the worker loop.
    }
  }

  shutdown(): Promise<void> {
    return this.provider.shutdown();
  }
}
