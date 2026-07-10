import type { PipelineScope } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONFIGURED_SCOPES = 100;

export interface PipelineWorkerConfig {
  postgresUrl: string;
  actorId: string;
  scopes: readonly PipelineScope[];
  batchSize: number;
  maxScopesPerPoll: number;
  concurrency: number;
  qualityRulePageSize: number;
  maxQualityRules: number;
  pollMilliseconds: number;
  retryBaseMilliseconds: number;
  retryMaxMilliseconds: number;
  shutdownGraceMilliseconds: number;
  databasePoolSize: number;
  executor: "builtin" | "disabled";
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseScopes(environment: NodeJS.ProcessEnv): PipelineScope[] {
  const raw = required(environment, "ODF_PIPELINE_SCOPES");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ODF_PIPELINE_SCOPES must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_CONFIGURED_SCOPES) {
    throw new Error(`ODF_PIPELINE_SCOPES must contain between 1 and ${MAX_CONFIGURED_SCOPES} scopes`);
  }
  const seen = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`ODF_PIPELINE_SCOPES[${index}] must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "tenantId" && key !== "projectId")) {
      throw new Error(`ODF_PIPELINE_SCOPES[${index}] contains unsupported fields`);
    }
    const tenantId = typeof record.tenantId === "string" ? record.tenantId.trim() : "";
    const projectId = typeof record.projectId === "string" ? record.projectId.trim() : "";
    if (!UUID_PATTERN.test(tenantId) || !UUID_PATTERN.test(projectId)) {
      throw new Error(`ODF_PIPELINE_SCOPES[${index}] tenantId and projectId must be UUIDs`);
    }
    const key = `${tenantId.toLowerCase()}/${projectId.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`ODF_PIPELINE_SCOPES contains duplicate scope ${key}`);
    seen.add(key);
    return { tenantId, projectId };
  });
}

export function loadPipelineWorkerConfig(environment: NodeJS.ProcessEnv = process.env): PipelineWorkerConfig {
  const scopes = parseScopes(environment);
  const executor = (environment.ODF_PIPELINE_EXECUTOR ?? "disabled").trim();
  if (executor !== "builtin" && executor !== "disabled") {
    throw new Error("ODF_PIPELINE_EXECUTOR must be builtin or disabled");
  }
  const retryBaseMilliseconds = boundedInteger(environment, "ODF_PIPELINE_RETRY_BASE_MS", 250, 10, 60_000);
  const retryMaxMilliseconds = boundedInteger(environment, "ODF_PIPELINE_RETRY_MAX_MS", 30_000, 10, 300_000);
  if (retryMaxMilliseconds < retryBaseMilliseconds) {
    throw new Error("ODF_PIPELINE_RETRY_MAX_MS must be greater than or equal to ODF_PIPELINE_RETRY_BASE_MS");
  }
  const maxScopesPerPoll = boundedInteger(environment, "ODF_PIPELINE_MAX_SCOPES_PER_POLL", Math.min(10, scopes.length), 1, 50);
  if (maxScopesPerPoll > scopes.length) {
    throw new Error("ODF_PIPELINE_MAX_SCOPES_PER_POLL cannot exceed the configured scope count");
  }
  return {
    postgresUrl: required(environment, "ODF_POSTGRES_URL"),
    actorId: (environment.ODF_PIPELINE_ACTOR_ID ?? "pipeline-worker").trim() || "pipeline-worker",
    scopes,
    batchSize: boundedInteger(environment, "ODF_PIPELINE_BATCH_SIZE", 20, 1, 200),
    maxScopesPerPoll,
    concurrency: boundedInteger(environment, "ODF_PIPELINE_CONCURRENCY", 4, 1, 32),
    qualityRulePageSize: boundedInteger(environment, "ODF_PIPELINE_QUALITY_RULE_PAGE_SIZE", 100, 1, 200),
    maxQualityRules: boundedInteger(environment, "ODF_PIPELINE_MAX_QUALITY_RULES", 1_000, 1, 10_000),
    pollMilliseconds: boundedInteger(environment, "ODF_PIPELINE_POLL_MS", 1_000, 10, 60_000),
    retryBaseMilliseconds,
    retryMaxMilliseconds,
    shutdownGraceMilliseconds: boundedInteger(environment, "ODF_PIPELINE_SHUTDOWN_GRACE_MS", 30_000, 100, 300_000),
    databasePoolSize: boundedInteger(environment, "ODF_PIPELINE_DB_POOL_SIZE", 10, 1, 50),
    executor,
  };
}
