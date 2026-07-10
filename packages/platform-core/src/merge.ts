import type { CanvasWorkspaceSnapshot, WorkspaceOperation, WorkspaceOperationRequest } from "@open-data-fusion/contracts";

export interface OperationMergeConflict {
  resource: string;
  leftOperation: WorkspaceOperation["type"];
  rightOperation: WorkspaceOperation["type"];
}

export interface OperationMergeResult {
  merged: WorkspaceOperationRequest | null;
  conflicts: OperationMergeConflict[];
}

function touchedResources(operation: WorkspaceOperation, snapshot: CanvasWorkspaceSnapshot): Set<string> {
  const resources = new Set<string>();
  if (operation.type === "moveNode" || operation.type === "updateNode") resources.add(`node:${operation.nodeId}`);
  if (operation.type === "addNode") resources.add(`node:${operation.node.id}`);
  if (operation.type === "removeNode") {
    resources.add(`node:${operation.nodeId}`);
    for (const edge of snapshot.edges) {
      if (edge.source === operation.nodeId || edge.target === operation.nodeId) resources.add(`edge:${edge.id}`);
    }
  }
  if (operation.type === "addEdge") {
    resources.add(`edge:${operation.edge.id}`);
    resources.add(`node:${operation.edge.source}`);
    resources.add(`node:${operation.edge.target}`);
  }
  if (operation.type === "updateEdge") resources.add(`edge:${operation.edgeId}`);
  if (operation.type === "removeEdge") {
    resources.add(`edge:${operation.edgeId}`);
    const edge = snapshot.edges.find((candidate) => candidate.id === operation.edgeId);
    if (edge) {
      resources.add(`node:${edge.source}`);
      resources.add(`node:${edge.target}`);
    }
  }
  return resources;
}

export function mergeWorkspaceOperationBatches(
  snapshot: CanvasWorkspaceSnapshot,
  left: WorkspaceOperationRequest,
  right: WorkspaceOperationRequest,
): OperationMergeResult {
  if (left.baseVersion !== right.baseVersion) {
    return {
      merged: null,
      conflicts: [{ resource: "workspace:baseVersion", leftOperation: left.operations[0]?.type ?? "moveNode", rightOperation: right.operations[0]?.type ?? "moveNode" }],
    };
  }

  const conflicts: OperationMergeConflict[] = [];
  for (const leftOperation of left.operations) {
    const leftResources = touchedResources(leftOperation, snapshot);
    for (const rightOperation of right.operations) {
      for (const resource of touchedResources(rightOperation, snapshot)) {
        if (leftResources.has(resource)) conflicts.push({ resource, leftOperation: leftOperation.type, rightOperation: rightOperation.type });
      }
    }
  }
  if (conflicts.length > 0) return { merged: null, conflicts };
  return {
    merged: {
      baseVersion: left.baseVersion,
      changeSummary: `${left.changeSummary}; ${right.changeSummary}`,
      operations: [...left.operations, ...right.operations],
    },
    conflicts: [],
  };
}
