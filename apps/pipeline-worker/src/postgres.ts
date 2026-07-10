import {
  PostgresRuntime,
  type ProjectAccessResolver,
  type ProjectScope,
} from "@open-data-fusion/postgres-runtime";

import type {
  PipelineScope,
  PipelineWorkerRuntime,
  RepositoryScope,
  TextCursor,
} from "./types.js";

/** Grants the service identity access only to the explicit polling allowlist. */
export class ConfiguredScopeAccessResolver implements ProjectAccessResolver {
  private readonly allowed: ReadonlySet<string>;

  constructor(scopes: readonly PipelineScope[], private readonly actorId: string) {
    this.allowed = new Set(scopes.map((scope) => `${scope.tenantId.toLowerCase()}/${scope.projectId.toLowerCase()}`));
  }

  async resolve(scope: ProjectScope): Promise<{ role: "editor" } | null> {
    if (scope.userId !== this.actorId) return null;
    const key = `${scope.tenantId.toLowerCase()}/${scope.projectId.toLowerCase()}`;
    return this.allowed.has(key) ? { role: "editor" } : null;
  }
}

export class PostgresPipelineWorkerRuntime implements PipelineWorkerRuntime {
  constructor(private readonly runtime: PostgresRuntime) {}

  async claimPipelineRuns(input: Parameters<PipelineWorkerRuntime["claimPipelineRuns"]>[0]) {
    return this.runtime.queues.claimPipelineRuns(input);
  }

  async getPipelineVersion(scope: RepositoryScope, pipelineId: string, version: number) {
    return this.runtime.pipelines.getPipelineVersion(scope, pipelineId, version);
  }

  async listEnabledQualityRules(scope: RepositoryScope, limit: number, cursor?: TextCursor) {
    return this.runtime.pipelines.listEnabledQualityRules(scope, limit, cursor);
  }

  async transitionPipelineRun(scope: RepositoryScope, input: Parameters<PipelineWorkerRuntime["transitionPipelineRun"]>[1]) {
    return this.runtime.pipelines.transitionPipelineRun(scope, input);
  }

  async close(): Promise<void> {
    await this.runtime.close();
  }
}
