import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";
import pino, { type Logger } from "pino";
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
  const activeLogger = logger ?? pino({
    name: "open-data-fusion-api",
    level: process.env.NODE_ENV === "test" ? "silent" : process.env.ODF_LOG_LEVEL ?? "info",
    base: { service: "open-data-fusion-api" },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "authorization", "cookie", "password", "secret"],
      censor: "[REDACTED]",
    },
  });

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
