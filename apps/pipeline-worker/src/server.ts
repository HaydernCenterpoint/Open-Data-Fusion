import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { loadEnvFile } from "node:process";

import { PostgresRuntime } from "@open-data-fusion/postgres-runtime";

import { loadPipelineWorkerConfig } from "./config.js";
import { BuiltinDagExecutor } from "./executor.js";
import { JsonLogger } from "./logger.js";
import { ConfiguredScopeAccessResolver, PostgresPipelineWorkerRuntime } from "./postgres.js";
import { PipelineWorker } from "./worker.js";

try {
  loadEnvFile();
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

const config = loadPipelineWorkerConfig();
// Claiming a durable run without an executor would strand it in `running`, so
// server startup fails before opening PostgreSQL or polling any scope.
if (config.executor === "disabled") {
  throw new Error("ODF_PIPELINE_EXECUTOR is disabled; configure an injected executor or explicitly set it to builtin");
}

const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const logger = new JsonLogger("pipeline-worker", workerId);
const policy = new ConfiguredScopeAccessResolver(config.scopes, config.actorId);
const postgres = PostgresRuntime.connect({
  connectionString: config.postgresUrl,
  max: config.databasePoolSize,
  applicationName: "open-data-fusion-pipeline-worker",
}, { projectAccessResolver: policy });
const runtime = new PostgresPipelineWorkerRuntime(postgres);
const worker = new PipelineWorker(runtime, new BuiltinDagExecutor(), logger, {
  workerId,
  actorId: config.actorId,
  scopes: config.scopes,
  batchSize: config.batchSize,
  maxScopesPerPoll: config.maxScopesPerPoll,
  concurrency: config.concurrency,
  qualityRulePageSize: config.qualityRulePageSize,
  maxQualityRules: config.maxQualityRules,
  pollMilliseconds: config.pollMilliseconds,
  retryBaseMilliseconds: config.retryBaseMilliseconds,
  retryMaxMilliseconds: config.retryMaxMilliseconds,
  shutdownGraceMilliseconds: config.shutdownGraceMilliseconds,
});

let shutdownPromise: Promise<void> | null = null;
function beginShutdown(signal: string): void {
  shutdownPromise ??= worker.shutdown(signal);
}

process.once("SIGINT", () => beginShutdown("SIGINT"));
process.once("SIGTERM", () => beginShutdown("SIGTERM"));

try {
  await worker.run();
  await shutdownPromise;
} finally {
  await runtime.close();
}
