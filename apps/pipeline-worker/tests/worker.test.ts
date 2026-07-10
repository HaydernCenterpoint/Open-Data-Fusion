import { describe, expect, it, vi } from "vitest";

import { NullLogger } from "../src/logger.js";
import type {
  JsonObject,
  PipelineExecutor,
  PipelineRun,
  PipelineWorkerRuntime,
  RepositoryScope,
  TextCursor,
} from "../src/types.js";
import { PipelineWorker, type PipelineWorkerOptions } from "../src/worker.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SECOND_PROJECT = "33333333-3333-4333-8333-333333333333";

const run: PipelineRun = {
  pipelineRunId: "44444444-4444-4444-8444-444444444444",
  tenantId: TENANT,
  projectId: PROJECT,
  pipelineId: "55555555-5555-4555-8555-555555555555",
  pipelineVersion: 3,
  state: "running",
  triggerType: "manual",
  correlationId: "66666666-6666-4666-8666-666666666666",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  summary: { input: { pressure: 12 } },
};

class FakeRuntime implements PipelineWorkerRuntime {
  readonly calls: Array<{ method: string; value?: unknown }> = [];
  claimed: PipelineRun[] = [run];
  transitionError: Error | null = null;

  async claimPipelineRuns(input: Parameters<PipelineWorkerRuntime["claimPipelineRuns"]>[0]) {
    this.calls.push({ method: "claim", value: input });
    const claimed = this.claimed;
    this.claimed = [];
    return claimed;
  }

  async getPipelineVersion(scope: RepositoryScope, pipelineId: string, version: number) {
    this.calls.push({ method: "version", value: { scope, pipelineId, version } });
    return {
      pipelineVersionId: "77777777-7777-4777-8777-777777777777",
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      pipelineId,
      version,
      definition: { steps: [{ id: "noop", kind: "noop", dependsOn: [], configuration: {} }] },
      schedule: null,
      createdBy: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  async listEnabledQualityRules(scope: RepositoryScope, limit: number, cursor?: TextCursor) {
    this.calls.push({ method: "rules", value: { scope, limit, cursor } });
    return { items: [], nextCursor: null };
  }

  async transitionPipelineRun(scope: RepositoryScope, input: Parameters<PipelineWorkerRuntime["transitionPipelineRun"]>[1]) {
    this.calls.push({ method: "transition", value: { scope, input } });
    if (this.transitionError) throw this.transitionError;
    return { ...run, state: input.nextState, summary: input.summary ?? {} };
  }
}

function options(overrides: Partial<PipelineWorkerOptions> = {}): PipelineWorkerOptions {
  return {
    workerId: "worker-a",
    actorId: "pipeline-worker",
    scopes: [{ tenantId: TENANT, projectId: PROJECT }],
    batchSize: 10,
    maxScopesPerPoll: 1,
    concurrency: 2,
    qualityRulePageSize: 100,
    maxQualityRules: 1_000,
    pollMilliseconds: 10,
    retryBaseMilliseconds: 10,
    retryMaxMilliseconds: 100,
    shutdownGraceMilliseconds: 100,
    ...overrides,
  };
}

function executor(execute: PipelineExecutor["execute"]): PipelineExecutor {
  return { name: "test-executor", execute };
}

describe("pipeline worker", () => {
  it("delegates a bounded claim and its stable owner to the SKIP LOCKED runtime", async () => {
    const runtime = new FakeRuntime();
    runtime.claimed = [];
    const worker = new PipelineWorker(runtime, executor(async () => ({ output: {} })), new NullLogger(), options({
      scopes: [{ tenantId: TENANT, projectId: PROJECT }, { tenantId: TENANT, projectId: SECOND_PROJECT }],
      maxScopesPerPoll: 1,
      batchSize: 7,
    }));
    await worker.runOnce();
    await worker.runOnce();
    const claims = runtime.calls.filter((call) => call.method === "claim").map((call) => call.value as Record<string, unknown>);
    expect(claims).toHaveLength(2);
    expect(claims.map((claim) => claim.projectId)).toEqual([PROJECT, SECOND_PROJECT]);
    expect(claims.every((claim) => claim.workerId === "worker-a" && claim.batchSize === 7)).toBe(true);
  });

  it("loads the exact immutable version, executes after repository reads, and succeeds", async () => {
    const runtime = new FakeRuntime();
    const execute = vi.fn(async () => {
      runtime.calls.push({ method: "execute" });
      return { output: { apiToken: "must-not-persist", rows: 4 } };
    });
    const worker = new PipelineWorker(runtime, executor(execute), new NullLogger(), options(), () => 1_000);
    const result = await worker.runOnce();
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(runtime.calls.map((call) => call.method)).toEqual(["claim", "version", "rules", "execute", "transition"]);
    const transition = runtime.calls.at(-1)?.value as { scope: RepositoryScope; input: { expectedState: string; nextState: string; summary: JsonObject } };
    expect(transition.scope.userId).toBe("pipeline-worker");
    expect(transition.input).toMatchObject({ expectedState: "running", nextState: "succeeded" });
    expect(transition.input.summary.input).toEqual({ pressure: 12 });
    expect(JSON.stringify(transition.input.summary)).not.toContain("must-not-persist");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("transitions executor failures to failed with a redacted summary", async () => {
    const runtime = new FakeRuntime();
    const worker = new PipelineWorker(runtime, executor(async () => {
      throw new Error("request failed password=super-secret token:abc123");
    }), new NullLogger(), options());
    const result = await worker.runOnce();
    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    const transition = runtime.calls.at(-1)?.value as { input: { nextState: string; summary: JsonObject } };
    expect(transition.input.nextState).toBe("failed");
    const persisted = JSON.stringify(transition.input.summary);
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("super-secret");
    expect(persisted).not.toContain("abc123");
  });

  it("does not overwrite a conflicting terminal transition", async () => {
    const runtime = new FakeRuntime();
    const conflict = new Error("Pipeline run no longer has the expected state");
    conflict.name = "ConflictError";
    runtime.transitionError = conflict;
    const worker = new PipelineWorker(runtime, executor(async () => ({ output: {} })), new NullLogger(), options());
    const result = await worker.runOnce();
    expect(result.transitionConflicts).toBe(1);
    expect(runtime.calls.filter((call) => call.method === "transition")).toHaveLength(1);
  });

  it("stops new claims, waits for the grace period, then aborts an active executor", async () => {
    const runtime = new FakeRuntime();
    let started!: () => void;
    const executorStarted = new Promise<void>((resolve) => { started = resolve; });
    const worker = new PipelineWorker(runtime, executor(async ({ signal }) => {
      started();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { output: {} };
    }), new NullLogger(), options({ shutdownGraceMilliseconds: 100 }));
    const loop = worker.run();
    await executorStarted;
    await worker.shutdown("test");
    await loop;
    expect(runtime.calls.filter((call) => call.method === "claim")).toHaveLength(1);
    const transition = runtime.calls.findLast((call) => call.method === "transition")?.value as { input: { nextState: string } };
    expect(transition.input.nextState).toBe("failed");
  });
});
