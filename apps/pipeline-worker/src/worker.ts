import { randomUUID } from "node:crypto";

import { redactedSummary, safeError } from "./redact.js";
import type {
  PipelineExecutor,
  PipelineRun,
  PipelineScope,
  PipelineWorkerRuntime,
  QualityRule,
  RepositoryScope,
  StructuredLogger,
  TextCursor,
} from "./types.js";

export interface PipelineWorkerOptions {
  workerId: string;
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
}

export interface PipelinePollResult {
  scopesPolled: number;
  claimed: number;
  succeeded: number;
  failed: number;
  transitionConflicts: number;
  pollErrors: number;
}

interface ClaimedRun {
  scope: PipelineScope;
  run: PipelineRun;
}

interface ProcessResult {
  state: "failed" | "succeeded" | "transition_conflict";
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "ConflictError"
    || /expected state|state is no longer current|transition is not permitted/i.test(error.message)
  );
}

function elapsed(started: number, finished: number): number {
  return Math.max(0, Math.round(finished - started));
}

export class PipelineWorker {
  private scopeOffset = 0;
  private stopping = false;
  private running: Promise<void> | null = null;
  private activeCycle: Promise<PipelinePollResult> | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private waitResolve: (() => void) | null = null;
  private executionAbort = new AbortController();

  constructor(
    private readonly runtime: PipelineWorkerRuntime,
    private readonly executor: PipelineExecutor,
    private readonly logger: StructuredLogger,
    private readonly options: PipelineWorkerOptions,
    private readonly now: () => number = () => Date.now(),
  ) {
    requireText(options.workerId, "workerId");
    requireText(options.actorId, "actorId");
    if (options.scopes.length === 0 || options.scopes.length > 100) throw new RangeError("scopes must contain between 1 and 100 entries");
    bounded(options.batchSize, 1, 200, "batchSize");
    bounded(options.maxScopesPerPoll, 1, Math.min(50, options.scopes.length), "maxScopesPerPoll");
    bounded(options.concurrency, 1, 32, "concurrency");
    bounded(options.qualityRulePageSize, 1, 200, "qualityRulePageSize");
    bounded(options.maxQualityRules, 1, 10_000, "maxQualityRules");
    bounded(options.pollMilliseconds, 10, 60_000, "pollMilliseconds");
    bounded(options.retryBaseMilliseconds, 10, 60_000, "retryBaseMilliseconds");
    bounded(options.retryMaxMilliseconds, options.retryBaseMilliseconds, 300_000, "retryMaxMilliseconds");
    bounded(options.shutdownGraceMilliseconds, 100, 300_000, "shutdownGraceMilliseconds");
  }

  async runOnce(): Promise<PipelinePollResult> {
    const result: PipelinePollResult = {
      scopesPolled: 0,
      claimed: 0,
      succeeded: 0,
      failed: 0,
      transitionConflicts: 0,
      pollErrors: 0,
    };
    if (this.stopping) return result;

    const scopes = this.nextScopes();
    const claimed: ClaimedRun[] = [];
    for (const scope of scopes) {
      if (this.stopping) break;
      result.scopesPolled += 1;
      try {
        const runs = await this.runtime.claimPipelineRuns({
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          workerId: this.options.workerId,
          batchSize: this.options.batchSize,
          correlationId: randomUUID(),
        });
        for (const run of runs) {
          if (run.tenantId !== scope.tenantId || run.projectId !== scope.projectId || run.state !== "running") {
            this.logger.log("error", "invalid_claim_result", {
              pipelineRunId: run.pipelineRunId,
              tenantId: scope.tenantId,
              projectId: scope.projectId,
              claimedState: run.state,
            });
            continue;
          }
          claimed.push({ scope, run });
        }
      } catch (error) {
        result.pollErrors += 1;
        this.logger.log("error", "scope_claim_failed", { tenantId: scope.tenantId, projectId: scope.projectId, error });
      }
    }
    result.claimed = claimed.length;

    const processResults = await this.mapConcurrent(claimed, (item) => this.processRun(item));
    for (const processed of processResults) {
      if (processed.state === "succeeded") result.succeeded += 1;
      else if (processed.state === "failed") result.failed += 1;
      else result.transitionConflicts += 1;
    }
    return result;
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runLoop();
    return this.running;
  }

  async shutdown(signal = "shutdown"): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.clearWait();
      this.logger.log("info", "shutdown_requested", { signal });
    }
    const active = this.activeCycle;
    if (active) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        active.then(() => false, () => false),
        new Promise<true>((resolve) => {
          graceTimer = setTimeout(() => resolve(true), this.options.shutdownGraceMilliseconds);
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      if (timedOut) {
        this.logger.log("warn", "shutdown_grace_expired", { graceMilliseconds: this.options.shutdownGraceMilliseconds });
        this.executionAbort.abort();
        await active.catch(() => undefined);
      }
    }
    await this.running?.catch(() => undefined);
  }

  private async runLoop(): Promise<void> {
    let consecutiveFailures = 0;
    this.logger.log("info", "worker_started", {
      scopes: this.options.scopes.length,
      maxScopesPerPoll: this.options.maxScopesPerPoll,
      batchSize: this.options.batchSize,
      concurrency: this.options.concurrency,
      executor: this.executor.name,
    });
    while (!this.stopping) {
      const cycle = this.runOnce();
      this.activeCycle = cycle;
      let result: PipelinePollResult;
      try {
        result = await cycle;
      } catch (error) {
        result = { scopesPolled: 0, claimed: 0, succeeded: 0, failed: 0, transitionConflicts: 0, pollErrors: 1 };
        this.logger.log("error", "poll_failed", { error });
      } finally {
        if (this.activeCycle === cycle) this.activeCycle = null;
      }
      if (this.stopping) break;
      if (result.pollErrors > 0) consecutiveFailures += 1;
      else consecutiveFailures = 0;
      if (result.claimed > 0 || result.pollErrors > 0) this.logger.log("info", "poll_completed", { ...result });
      const delay = consecutiveFailures > 0
        ? Math.min(this.options.retryMaxMilliseconds, this.options.retryBaseMilliseconds * 2 ** Math.min(consecutiveFailures - 1, 20))
        : result.claimed === 0 ? this.options.pollMilliseconds : 0;
      if (delay > 0) await this.wait(delay);
    }
    this.logger.log("info", "worker_stopped");
  }

  private nextScopes(): PipelineScope[] {
    const count = Math.min(this.options.maxScopesPerPoll, this.options.scopes.length);
    const selected: PipelineScope[] = [];
    for (let index = 0; index < count; index += 1) {
      const scope = this.options.scopes[(this.scopeOffset + index) % this.options.scopes.length];
      if (scope) selected.push(scope);
    }
    this.scopeOffset = (this.scopeOffset + count) % this.options.scopes.length;
    return selected;
  }

  private repositoryScope(scope: PipelineScope): RepositoryScope {
    return { ...scope, userId: this.options.actorId };
  }

  private async collectQualityRules(scope: RepositoryScope): Promise<QualityRule[]> {
    const rules: QualityRule[] = [];
    let cursor: TextCursor | undefined;
    const seenCursors = new Set<string>();
    while (rules.length < this.options.maxQualityRules) {
      const remaining = this.options.maxQualityRules - rules.length;
      const page = await this.runtime.listEnabledQualityRules(scope, Math.min(this.options.qualityRulePageSize, remaining), cursor);
      if (page.items.length > remaining) throw new Error(`enabled quality rules exceed configured maximum of ${this.options.maxQualityRules}`);
      rules.push(...page.items);
      if (!page.nextCursor) return rules;
      if (seenCursors.has(page.nextCursor.value)) throw new Error("quality rule pagination cursor repeated");
      seenCursors.add(page.nextCursor.value);
      cursor = page.nextCursor;
    }
    throw new Error(`enabled quality rules exceed configured maximum of ${this.options.maxQualityRules}`);
  }

  private async processRun(item: ClaimedRun): Promise<ProcessResult> {
    const started = this.now();
    const scope = this.repositoryScope(item.scope);
    let successSummary;
    try {
      const version = await this.runtime.getPipelineVersion(scope, item.run.pipelineId, item.run.pipelineVersion);
      if (version.pipelineId !== item.run.pipelineId || version.version !== item.run.pipelineVersion) {
        throw new Error("pipeline repository returned a mismatched immutable version");
      }
      const qualityRules = await this.collectQualityRules(scope);
      const execution = await this.executor.execute({
        run: item.run,
        version,
        qualityRules,
        signal: this.executionAbort.signal,
      });
      successSummary = redactedSummary({
        ...item.run.summary,
        execution: {
          executor: this.executor.name,
          durationMilliseconds: elapsed(started, this.now()),
          output: execution.output,
        },
      });
    } catch (error) {
      const summary = redactedSummary({
        ...item.run.summary,
        execution: {
          executor: this.executor.name,
          durationMilliseconds: elapsed(started, this.now()),
          error: safeError(error),
        },
      });
      try {
        await this.runtime.transitionPipelineRun(scope, {
          pipelineRunId: item.run.pipelineRunId,
          expectedState: "running",
          nextState: "failed",
          summary,
          correlationId: item.run.correlationId,
        });
        this.logger.log("error", "pipeline_run_failed", { pipelineRunId: item.run.pipelineRunId, error });
        return { state: "failed" };
      } catch (transitionError) {
        if (isConflict(transitionError)) {
          this.logger.log("warn", "pipeline_run_transition_conflict", { pipelineRunId: item.run.pipelineRunId, transitionError });
          return { state: "transition_conflict" };
        }
        this.logger.log("error", "pipeline_run_failure_transition_failed", {
          pipelineRunId: item.run.pipelineRunId,
          executionError: error,
          transitionError,
        });
        return { state: "failed" };
      }
    }

    try {
      await this.runtime.transitionPipelineRun(scope, {
        pipelineRunId: item.run.pipelineRunId,
        expectedState: "running",
        nextState: "succeeded",
        summary: successSummary,
        correlationId: item.run.correlationId,
      });
      this.logger.log("info", "pipeline_run_succeeded", { pipelineRunId: item.run.pipelineRunId, durationMilliseconds: elapsed(started, this.now()) });
      return { state: "succeeded" };
    } catch (transitionError) {
      if (isConflict(transitionError)) {
        this.logger.log("warn", "pipeline_run_transition_conflict", { pipelineRunId: item.run.pipelineRunId, transitionError });
        return { state: "transition_conflict" };
      }
      this.logger.log("error", "pipeline_run_success_transition_failed", { pipelineRunId: item.run.pipelineRunId, transitionError });
      return { state: "failed" };
    }
  }

  private async mapConcurrent<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        if (item !== undefined) results[index] = await work(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency, items.length) }, () => worker()));
    return results;
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.waitResolve = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.waitResolve = null;
        resolve();
      }, milliseconds);
    });
  }

  private clearWait(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const resolve = this.waitResolve;
    this.waitResolve = null;
    resolve?.();
  }
}
