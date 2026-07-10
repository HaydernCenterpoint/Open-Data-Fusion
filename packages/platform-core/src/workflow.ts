import type { PipelineStepDefinition } from "@open-data-fusion/contracts";

export class WorkflowDefinitionError extends Error {}

export interface WorkflowPlan {
  orderedStepIds: string[];
  stages: string[][];
}

export function planPipeline(steps: readonly PipelineStepDefinition[]): WorkflowPlan {
  if (steps.length === 0) throw new WorkflowDefinitionError("A pipeline must contain at least one step");

  const byId = new Map<string, PipelineStepDefinition>();
  for (const step of steps) {
    if (byId.has(step.id)) throw new WorkflowDefinitionError(`Pipeline step '${step.id}' is duplicated`);
    byId.set(step.id, step);
  }

  const dependents = new Map<string, string[]>();
  const remainingDependencies = new Map<string, number>();
  for (const step of steps) {
    const uniqueDependencies = new Set(step.dependsOn);
    if (uniqueDependencies.size !== step.dependsOn.length) {
      throw new WorkflowDefinitionError(`Pipeline step '${step.id}' contains duplicate dependencies`);
    }
    for (const dependency of uniqueDependencies) {
      if (dependency === step.id) throw new WorkflowDefinitionError(`Pipeline step '${step.id}' cannot depend on itself`);
      if (!byId.has(dependency)) {
        throw new WorkflowDefinitionError(`Pipeline step '${step.id}' depends on unknown step '${dependency}'`);
      }
      const children = dependents.get(dependency) ?? [];
      children.push(step.id);
      dependents.set(dependency, children);
    }
    remainingDependencies.set(step.id, uniqueDependencies.size);
  }

  let ready = steps.filter((step) => remainingDependencies.get(step.id) === 0).map((step) => step.id);
  const orderedStepIds: string[] = [];
  const stages: string[][] = [];

  while (ready.length > 0) {
    const stage = ready;
    stages.push(stage);
    orderedStepIds.push(...stage);
    const nextReady = new Set<string>();
    for (const completedId of stage) {
      for (const dependentId of dependents.get(completedId) ?? []) {
        const nextCount = (remainingDependencies.get(dependentId) ?? 0) - 1;
        remainingDependencies.set(dependentId, nextCount);
        if (nextCount === 0) nextReady.add(dependentId);
      }
    }
    ready = steps.filter((step) => nextReady.has(step.id)).map((step) => step.id);
  }

  if (orderedStepIds.length !== steps.length) {
    const blocked = steps.filter((step) => !orderedStepIds.includes(step.id)).map((step) => step.id);
    throw new WorkflowDefinitionError(`Pipeline contains a dependency cycle involving: ${blocked.join(", ")}`);
  }

  return { orderedStepIds, stages };
}
