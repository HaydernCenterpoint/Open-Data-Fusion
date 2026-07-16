import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

export interface ApiObservability {
  logger: Logger;
  registry: Registry;
  middleware: RequestHandler;
  metricsHandler: RequestHandler;
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
}

function equalSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

const SENSITIVE_FIELD = /password|passwd|secret|token|api.?key|access.?key|credential|private.?key|authorization|cookie/iu;
const SENSITIVE_ASSIGNMENT = /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|credential|private[_ -]?key|authorization|cookie)\b\s*[:=]\s*(?:Bearer\s+)?("[^"]*"|'[^']*'|[^\s,;]+)/giu;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:)[^@\s/]+@/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/giu;
const MAX_LOG_DEPTH = 8;
const MAX_LOG_ARRAY_ITEMS = 100;
const MAX_LOG_OBJECT_KEYS = 100;
const MAX_LOG_STRING_LENGTH = 2_000;
const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

function redactedText(value: string): string {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[REDACTED]")
    .replace(URL_CREDENTIAL, "$1[REDACTED]@")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .slice(0, MAX_LOG_STRING_LENGTH);
}

function redactedLogValue(value: unknown, depth: number): unknown {
  if (depth > MAX_LOG_DEPTH) return TRUNCATED;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return redactedText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (value instanceof Error) {
    return {
      name: redactedText(value.name),
      message: redactedText(value.message),
    };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return "[BINARY]";
  if (Array.isArray(value)) return value.slice(0, MAX_LOG_ARRAY_ITEMS).map((item) => redactedLogValue(item, depth + 1));
  if (typeof value !== "object") return `[${typeof value}]`;

  let entries: [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return "[UNSERIALIZABLE]";
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
    result[key] = SENSITIVE_FIELD.test(key) ? REDACTED : redactedLogValue(nested, depth + 1);
  }
  return result;
}

function redactedLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactedLogValue(record, 0);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

function redactedSerializedLog(serialized: string): string {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pino emitted a non-object record");
    return `${JSON.stringify(redactedLogRecord(parsed as Record<string, unknown>))}\n`;
  } catch {
    // Never pass an unparseable serialized record through the export boundary.
    return `${JSON.stringify({
      level: 50,
      service: "open-data-fusion-api",
      msg: "[UNSERIALIZABLE_LOG_RECORD]",
    })}\n`;
  }
}

/**
 * Pino auto-instrumentation copies its finalized JSON stream into the OTel Logs
 * API. Redact and bound the final stream so child bindings, stdout, and OTLP
 * records have the same safe representation.
 */
export function createApiLogger(
  destination?: DestinationStream,
  environment: NodeJS.ProcessEnv = process.env,
): Logger {
  const options: LoggerOptions = {
    name: "open-data-fusion-api",
    level: environment.NODE_ENV === "test" ? "silent" : environment.ODF_LOG_LEVEL ?? "info",
    base: { service: "open-data-fusion-api" },
    formatters: {
      bindings: redactedLogRecord,
      log: redactedLogRecord,
    },
    hooks: {
      streamWrite: redactedSerializedLog,
    },
    // The final stream hook is the primary boundary; retain Pino's path
    // redactor for built-in request/error handling and future configuration.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "authorization",
        "cookie",
        "password",
        "passwd",
        "secret",
        "token",
        "apiKey",
        "api_key",
        "accessKey",
        "access_key",
        "credential",
        "privateKey",
        "private_key",
      ],
      censor: REDACTED,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export function createApiObservability(metricsToken?: string, logger?: Logger): ApiObservability {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "odf_api_" });
  const requests = new Counter({
    name: "odf_api_http_requests_total",
    help: "Completed Open Data Fusion API requests",
    labelNames: ["method", "route", "status_class"] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "odf_api_http_request_duration_seconds",
    help: "Open Data Fusion API request duration",
    labelNames: ["method", "route", "status_class"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const inFlight = new Gauge({
    name: "odf_api_http_requests_in_flight",
    help: "Open Data Fusion API requests currently in flight",
    registers: [registry],
  });
  const activeLogger = logger ?? createApiLogger();

  const middleware: RequestHandler = (request, response, next) => {
    const started = process.hrtime.bigint();
    inFlight.inc();
    response.once("finish", () => {
      inFlight.dec();
      const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      const route = typeof request.route?.path === "string" ? request.route.path : "unmatched";
      const statusClass = `${Math.floor(response.statusCode / 100)}xx`;
      requests.inc({ method: request.method, route, status_class: statusClass });
      duration.observe({ method: request.method, route, status_class: statusClass }, elapsedSeconds);
      activeLogger.info({
        correlationId: response.locals.correlationId,
        method: request.method,
        route,
        statusCode: response.statusCode,
        durationMs: Math.round(elapsedSeconds * 1000),
      }, "request completed");
    });
    next();
  };

  const metricsHandler: RequestHandler = async (request, response) => {
    if (metricsToken) {
      const supplied = bearerToken(request.header("authorization"));
      if (!supplied || !equalSecret(supplied, metricsToken)) {
        response.setHeader("www-authenticate", "Bearer");
        response.status(401).json({ error: { code: "unauthorized", message: "A valid metrics token is required", correlationId: response.locals.correlationId } });
        return;
      }
    }
    response.setHeader("content-type", registry.contentType);
    response.send(await registry.metrics());
  };

  return { logger: activeLogger, registry, middleware, metricsHandler };
}
