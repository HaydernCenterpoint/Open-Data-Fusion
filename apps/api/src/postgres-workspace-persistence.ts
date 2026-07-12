import {
  ConflictError as RuntimeConflictError,
  ForbiddenError as RuntimeForbiddenError,
  NotFoundError as RuntimeNotFoundError,
  PostgresRuntime,
  type JsonObject,
  type JsonValue,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
  type WorkspaceRevisionRecord,
  type WorkspaceScope,
} from '@open-data-fusion/postgres-runtime';

import type { WorkspaceMember } from './collaboration.js';
import { ConflictError, DataIntegrityError, ForbiddenError, NotFoundError } from './database.js';
import {
  workspaceSnapshotSchema,
  type WorkspaceCreate,
  type WorkspaceMemberUpsert,
  type WorkspaceOperations,
  type WorkspaceRollback,
  type WorkspaceRevisionQuery,
  type WorkspaceSnapshot,
  type WorkspaceUpdate,
} from './schemas.js';

/**
 * Every PostgreSQL workspace request carries the tenant and project selected
 * by trusted server-side routing. The runtime verifies this scope before it
 * opens a transaction and the SQL additionally joins the immutable workspace
 * scope recorded at cutover.
 */
export type WorkspaceRequestScope = WorkspaceScope;

export interface PersistedWorkspace {
  id: string;
  name: string;
  version: number;
  snapshot: WorkspaceSnapshot;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface PersistedWorkspaceRevision {
  workspaceId: string;
  version: number;
  snapshot: WorkspaceSnapshot;
  changeSummary: string;
  actor: string;
  createdAt: string;
  correlationId: string;
}

export interface WorkspaceMemberUpsertOutcome {
  member: WorkspaceMember;
  created: boolean;
}

export interface WorkspacePersistenceHealth {
  status: 'ok' | 'degraded';
  service: 'open-data-fusion-api';
  database: string | null;
  timestamp: string;
}

function toWorkspaceSnapshot(value: JsonObject): WorkspaceSnapshot {
  const parsed = workspaceSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new DataIntegrityError('Stored workspace snapshot is not valid');
  }
  return parsed.data;
}

function toJsonValue(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Value is not JSON-serializable');
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new DataIntegrityError('Workspace data is not JSON-serializable');
  }
}

function toJsonObject(value: unknown): JsonObject {
  const parsed = toJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DataIntegrityError('Workspace snapshot must be an object');
  }
  return parsed as JsonObject;
}

function asWorkspace(record: WorkspaceRecord): PersistedWorkspace {
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    snapshot: toWorkspaceSnapshot(record.snapshot),
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedBy: record.updatedBy,
    updatedAt: record.updatedAt,
  };
}

function asWorkspaceRevision(record: WorkspaceRevisionRecord): PersistedWorkspaceRevision {
  return {
    workspaceId: record.workspaceId,
    version: record.version,
    snapshot: toWorkspaceSnapshot(record.snapshot),
    changeSummary: record.changeSummary,
    actor: record.actor,
    createdAt: record.createdAt,
    correlationId: record.correlationId,
  };
}

function asWorkspaceMember(record: WorkspaceMemberRecord): WorkspaceMember {
  return {
    workspaceId: record.workspaceId,
    userId: record.userId,
    displayName: record.displayName,
    role: record.role,
  };
}

function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
  const nodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (nodeIds.has(node.id)) throw new DataIntegrityError(`Canvas node '${node.id}' already exists`);
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edgeIds.has(edge.id)) throw new DataIntegrityError(`Canvas edge '${edge.id}' already exists`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) {
      throw new DataIntegrityError(`Canvas edge '${edge.id}' references missing source node '${edge.source}'`);
    }
    if (!nodeIds.has(edge.target)) {
      throw new DataIntegrityError(`Canvas edge '${edge.id}' references missing target node '${edge.target}'`);
    }
  }
}

function applyCanvasOperations(
  snapshot: WorkspaceSnapshot,
  operations: WorkspaceOperations['operations'],
): WorkspaceSnapshot {
  const next = structuredClone(snapshot);

  for (const operation of operations) {
    switch (operation.type) {
      case 'moveNode': {
        const node = next.nodes.find((candidate) => candidate.id === operation.nodeId);
        if (!node) throw new DataIntegrityError(`Canvas node '${operation.nodeId}' was not found`);
        node.position = structuredClone(operation.position);
        break;
      }
      case 'addNode':
        if (next.nodes.some((node) => node.id === operation.node.id)) {
          throw new DataIntegrityError(`Canvas node '${operation.node.id}' already exists`);
        }
        next.nodes.push(structuredClone(operation.node));
        break;
      case 'removeNode': {
        const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
        if (index < 0) throw new DataIntegrityError(`Canvas node '${operation.nodeId}' was not found`);
        next.nodes.splice(index, 1);
        break;
      }
      case 'updateNode': {
        const node = next.nodes.find((candidate) => candidate.id === operation.nodeId);
        if (!node) throw new DataIntegrityError(`Canvas node '${operation.nodeId}' was not found`);
        if (operation.patch.type !== undefined) node.type = operation.patch.type;
        if (operation.patch.position !== undefined) node.position = structuredClone(operation.patch.position);
        if (operation.patch.data !== undefined) {
          node.data = { ...node.data, ...structuredClone(operation.patch.data) };
        }
        break;
      }
      case 'addEdge':
        if (next.edges.some((edge) => edge.id === operation.edge.id)) {
          throw new DataIntegrityError(`Canvas edge '${operation.edge.id}' already exists`);
        }
        next.edges.push(structuredClone(operation.edge));
        break;
      case 'removeEdge': {
        const index = next.edges.findIndex((edge) => edge.id === operation.edgeId);
        if (index < 0) throw new DataIntegrityError(`Canvas edge '${operation.edgeId}' was not found`);
        next.edges.splice(index, 1);
        break;
      }
      case 'updateEdge': {
        const edge = next.edges.find((candidate) => candidate.id === operation.edgeId);
        if (!edge) throw new DataIntegrityError(`Canvas edge '${operation.edgeId}' was not found`);
        if (operation.patch.type !== undefined) edge.type = operation.patch.type;
        if (operation.patch.data !== undefined) {
          edge.data = { ...edge.data, ...structuredClone(operation.patch.data) };
        }
        break;
      }
    }
  }

  validateWorkspaceSnapshot(next);
  return next;
}

function translateRuntimeError(error: unknown): Error {
  if (error instanceof RuntimeNotFoundError) return new NotFoundError(error.message);
  if (error instanceof RuntimeForbiddenError) return new ForbiddenError(error.message);
  if (error instanceof RuntimeConflictError) return new ConflictError(error.message);
  return error instanceof Error ? error : new Error('PostgreSQL workspace operation failed');
}

/**
 * Async, PostgreSQL-backed persistence for the existing Canvas endpoints.
 * SQLite is deliberately not touched: callers switch all workspace reads and
 * writes to this adapter together after the cutover importer commits.
 */
export class PostgresWorkspacePersistence {
  constructor(private readonly runtime: PostgresRuntime) {}

  async close(): Promise<void> {
    await this.runtime.close();
  }

  async health(): Promise<WorkspacePersistenceHealth> {
    const health = await this.runtime.health();
    return {
      status: health.status,
      service: 'open-data-fusion-api',
      database: health.database,
      timestamp: health.timestamp,
    };
  }

  async getWorkspace(scope: WorkspaceRequestScope, id: string): Promise<PersistedWorkspace> {
    return this.translate(async () => asWorkspace(await this.runtime.workspaces.getWorkspace(scope, id)));
  }

  async createWorkspace(
    scope: WorkspaceRequestScope,
    input: WorkspaceCreate,
    correlationId: string,
  ): Promise<PersistedWorkspace> {
    return this.translate(async () => asWorkspace(await this.runtime.workspaces.createWorkspace(scope, {
      workspaceId: input.id,
      name: input.name,
      correlationId,
    })));
  }

  async getWorkspaceMember(scope: WorkspaceRequestScope, id: string): Promise<WorkspaceMember> {
    return this.translate(async () => asWorkspaceMember(await this.runtime.workspaces.getWorkspaceMember(scope, id)));
  }

  async listWorkspaceMembers(
    scope: WorkspaceRequestScope,
    id: string,
  ): Promise<{ items: WorkspaceMember[]; total: number }> {
    return this.translate(async () => {
      const members = await this.runtime.workspaces.listWorkspaceMembers(scope, id);
      return { items: members.map(asWorkspaceMember), total: members.length };
    });
  }

  async upsertWorkspaceMember(
    scope: WorkspaceRequestScope,
    id: string,
    actor: string,
    targetUserId: string,
    update: WorkspaceMemberUpsert,
    correlationId: string,
  ): Promise<WorkspaceMemberUpsertOutcome> {
    return this.translate(async () => {
      const result = await this.runtime.workspaces.upsertWorkspaceMemberWithOutcome(scope, {
        workspaceId: id,
        actor,
        member: {
          userId: targetUserId,
          displayName: update.displayName,
          role: update.role,
        },
        correlationId,
      });
      return { member: asWorkspaceMember(result.member), created: result.created };
    });
  }

  async removeWorkspaceMember(
    scope: WorkspaceRequestScope,
    id: string,
    actor: string,
    targetUserId: string,
    correlationId: string,
  ): Promise<WorkspaceMember> {
    return this.translate(async () => asWorkspaceMember(await this.runtime.workspaces.removeWorkspaceMember(scope, {
      workspaceId: id,
      actor,
      memberUserId: targetUserId,
      correlationId,
    })));
  }

  async updateWorkspace(
    scope: WorkspaceRequestScope,
    id: string,
    update: WorkspaceUpdate,
    correlationId: string,
  ): Promise<PersistedWorkspace> {
    validateWorkspaceSnapshot(update.snapshot);
    return this.mutate(scope, {
      workspaceId: id,
      expectedVersion: update.expectedVersion,
      snapshot: update.snapshot,
      changeSummary: update.changeSummary,
      actor: update.actor,
      correlationId,
      auditAction: 'workspace.saved',
      eventType: 'workspace.updated',
    });
  }

  async applyWorkspaceOperations(
    scope: WorkspaceRequestScope,
    id: string,
    actor: string,
    update: WorkspaceOperations,
    correlationId: string,
  ): Promise<PersistedWorkspace> {
    const [current, member] = await Promise.all([
      this.getWorkspace(scope, id),
      this.getWorkspaceMember(scope, id),
    ]);
    if (member.role !== 'owner' && member.role !== 'editor') {
      throw new ForbiddenError(`User '${actor}' has read-only access to workspace '${id}'`);
    }
    if (current.version !== update.baseVersion) {
      throw new ConflictError(
        `Workspace '${id}' is at version ${current.version}; reload and merge before applying operations to version ${update.baseVersion}`,
      );
    }
    const snapshot = applyCanvasOperations(current.snapshot, update.operations);
    return this.mutate(scope, {
      workspaceId: id,
      expectedVersion: update.baseVersion,
      snapshot,
      changeSummary: update.changeSummary,
      actor,
      correlationId,
      auditAction: 'workspace.operations_applied',
      auditDetails: { operations: toJsonValue(update.operations) },
      eventType: 'workspace.updated',
      eventPayload: { operations: toJsonValue(update.operations) },
    });
  }

  async listWorkspaceRevisions(
    scope: WorkspaceRequestScope,
    id: string,
    query: WorkspaceRevisionQuery,
  ): Promise<{ items: PersistedWorkspaceRevision[]; total: number; limit: number; offset: number }> {
    return this.translate(async () => {
      const page = await this.runtime.workspaces.listWorkspaceRevisions(scope, id, query.limit, query.offset);
      return { ...page, items: page.items.map(asWorkspaceRevision) };
    });
  }

  async rollbackWorkspace(
    scope: WorkspaceRequestScope,
    id: string,
    rollback: WorkspaceRollback,
    correlationId: string,
  ): Promise<PersistedWorkspace> {
    const [current, member] = await Promise.all([
      this.getWorkspace(scope, id),
      this.getWorkspaceMember(scope, id),
    ]);
    if (member.role !== 'owner' && member.role !== 'editor') {
      throw new ForbiddenError(`User '${rollback.actor}' has read-only access to workspace '${id}'`);
    }
    if (current.version !== rollback.expectedVersion) {
      throw new ConflictError(
        `Workspace '${id}' is at version ${current.version}; reload and merge before rolling back version ${rollback.expectedVersion}`,
      );
    }
    const target = await this.translate(async () => (
      asWorkspaceRevision(await this.runtime.workspaces.getWorkspaceRevision(scope, id, rollback.targetVersion))
    ));
    validateWorkspaceSnapshot(target.snapshot);
    const changeSummary = rollback.changeSummary || `Rolled back to revision ${rollback.targetVersion}`;
    return this.mutate(scope, {
      workspaceId: id,
      expectedVersion: rollback.expectedVersion,
      snapshot: target.snapshot,
      changeSummary,
      actor: rollback.actor,
      correlationId,
      auditAction: 'workspace.rolled_back',
      auditDetails: { restoredFromVersion: rollback.targetVersion },
      eventType: 'workspace.updated',
      eventPayload: { restoredFromVersion: rollback.targetVersion },
    });
  }

  private async mutate(inputScope: WorkspaceRequestScope, input: {
    workspaceId: string;
    expectedVersion: number;
    snapshot: WorkspaceSnapshot;
    changeSummary: string;
    actor: string;
    correlationId: string;
    auditAction: string;
    auditDetails?: JsonObject;
    eventType: string;
    eventPayload?: JsonObject;
  }): Promise<PersistedWorkspace> {
    validateWorkspaceSnapshot(input.snapshot);
    return this.translate(async () => asWorkspace(await this.runtime.workspaces.mutateWorkspace(inputScope, {
      workspaceId: input.workspaceId,
      expectedVersion: input.expectedVersion,
      snapshot: toJsonObject(input.snapshot),
      changeSummary: input.changeSummary,
      actor: input.actor,
      correlationId: input.correlationId,
      auditAction: input.auditAction,
      ...(input.auditDetails ? { auditDetails: input.auditDetails } : {}),
      eventType: input.eventType,
      ...(input.eventPayload ? { eventPayload: input.eventPayload } : {}),
    })));
  }

  private async translate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }
}
