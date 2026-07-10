export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface PipelineScope {
  tenantId: string;
  projectId: string;
}

export interface RepositoryScope extends PipelineScope {
  userId: string;
}

export type PipelineRunState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface PipelineRun {
  pipelineRunId: string;
  tenantId: string;
  projectId: string;
  pipelineId: string;
  pipelineVersion: number;
  state: PipelineRunState;
  triggerType: "manual" | "schedule" | "event";
  correlationId: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: JsonObject;
}

export interface PipelineVersion {
  pipelineVersionId: string;
  tenantId: string;
  projectId: string;
  pipelineId: string;
  version: number;
  definition: JsonObject;
  schedule: string | null;
  createdBy: string;
  createdAt: string;
}

export interface QualityRule {
  qualityRuleId: string;
  externalId: string;
  ruleKind: "required" | "range" | "regex" | "unique" | "reference";
  fieldName: string | null;
  configuration: JsonObject;
  severity: "info" | "warning" | "error";
  enabled: boolean;
}

export interface TextCursor {
  value: string;
}

export interface QualityRulePage {
  items: QualityRule[];
  nextCursor: TextCursor | null;
}

export interface PipelineWorkerRuntime {
  claimPipelineRuns(input: {
    tenantId: string;
    projectId: string;
    workerId: string;
    batchSize: number;
    correlationId: string;
  }): Promise<PipelineRun[]>;
  getPipelineVersion(scope: RepositoryScope, pipelineId: string, version: number): Promise<PipelineVersion>;
  listEnabledQualityRules(scope: RepositoryScope, limit: number, cursor?: TextCursor): Promise<QualityRulePage>;
  transitionPipelineRun(scope: RepositoryScope, input: {
    pipelineRunId: string;
    expectedState: PipelineRunState;
    nextState: PipelineRunState;
    summary?: JsonObject;
    correlationId: string;
  }): Promise<PipelineRun>;
  close?(): Promise<void>;
}

export interface PipelineExecutionRequest {
  run: PipelineRun;
  version: PipelineVersion;
  qualityRules: readonly QualityRule[];
  signal: AbortSignal;
}

export interface PipelineExecutionResult {
  output: JsonObject;
}

export interface PipelineExecutor {
  readonly name: string;
  execute(request: PipelineExecutionRequest): Promise<PipelineExecutionResult>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogger {
  log(level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>): void;
}
