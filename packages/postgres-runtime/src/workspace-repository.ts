import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.js";
import {
  json,
  workspaceFromRow,
  workspaceMemberFromRow,
} from "./mappers.js";
import type {
  JsonObject,
  ScopedTransaction,
  TransactionContext,
  TransactionRunner,
  WorkspaceMemberRecord,
  WorkspaceMembershipRemoveInput,
  WorkspaceMembershipUpsertInput,
  WorkspaceMutationInput,
  WorkspaceRecord,
  WorkspaceRepository,
} from "./types.js";

function assertActor(context: TransactionContext, actor: string): void {
  if (context.platformAdmin === true) return;
  if (context.userId !== actor) {
    throw new ForbiddenError("Actor must match the transaction user");
  }
}

export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly runner: TransactionRunner) {}

  async getWorkspace(context: TransactionContext, workspaceId: string): Promise<WorkspaceRecord> {
    return this.runner.withTransaction(context, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT workspace.id, workspace.name, workspace.snapshot, workspace.version,",
          "       workspace.created_by, workspace.created_at, workspace.updated_by, workspace.updated_at",
          "FROM odf.workspaces AS workspace",
          "WHERE workspace.id = $1",
          "  AND EXISTS (",
          "    SELECT 1 FROM odf.workspace_members AS membership",
          "    WHERE membership.workspace_id = workspace.id",
          "      AND membership.user_id = $2",
          "  )",
        ].join("\n"),
        values: [workspaceId, context.userId],
      });
      const row = result.rows[0];
      if (!row) {
        const existing = await transaction.query({
          text: "SELECT id FROM odf.workspaces WHERE id = $1",
          values: [workspaceId],
        });
        if (existing.rows[0]) throw new ForbiddenError("Workspace membership is required");
        throw new NotFoundError("Workspace was not found");
      }
      return workspaceFromRow(row);
    });
  }

  async mutateWorkspace(context: TransactionContext, input: WorkspaceMutationInput): Promise<WorkspaceRecord> {
    assertActor(context, input.actor);
    return this.runner.withTransaction(context, async (transaction) => {
      const snapshot = json(input.snapshot);
      const updated = await transaction.query({
        text: [
          "UPDATE odf.workspaces",
          "SET snapshot = $1::jsonb,",
          "    version = version + 1,",
          "    updated_by = $2,",
          "    updated_at = now()",
          "WHERE id = $3",
          "  AND version = $4",
          "  AND EXISTS (",
          "    SELECT 1 FROM odf.workspace_members",
          "    WHERE workspace_id = $3",
          "      AND user_id = $2",
          "      AND role IN ('owner', 'editor')",
          "  )",
          "RETURNING id, name, snapshot, version, created_by, created_at, updated_by, updated_at",
        ].join("\n"),
        values: [snapshot, input.actor, input.workspaceId, input.expectedVersion],
      });
      const row = updated.rows[0];
      if (!row) {
        const membership = await transaction.query({
          text: [
            "SELECT role FROM odf.workspace_members",
            "WHERE workspace_id = $1 AND user_id = $2",
          ].join("\n"),
          values: [input.workspaceId, input.actor],
        });
        const existing = await transaction.query({
          text: "SELECT id FROM odf.workspaces WHERE id = $1",
          values: [input.workspaceId],
        });
        if (!existing.rows[0]) throw new NotFoundError("Workspace was not found");
        const role = membership.rows[0]?.role;
        if (role !== "owner" && role !== "editor") {
          throw new ForbiddenError("Workspace editor permission is required");
        }
        throw new ConflictError("Workspace version is no longer current");
      }

      const workspace = workspaceFromRow(row);
      const auditDetails: JsonObject = {
        previousVersion: input.expectedVersion,
        version: workspace.version,
        changeSummary: input.changeSummary,
      };
      const eventPayload: JsonObject = {
        workspaceId: workspace.id,
        version: workspace.version,
        actor: input.actor,
        changeSummary: input.changeSummary,
      };
      const deduplicationKey = input.deduplicationKey
        ?? "workspace:" + workspace.id + ":v" + String(workspace.version);

      await transaction.query({
        text: [
          "INSERT INTO odf.workspace_revisions",
          "  (workspace_id, version, snapshot, change_summary, actor, correlation_id)",
          "VALUES ($1, $2, $3::jsonb, $4, $5, $6::uuid)",
        ].join("\n"),
        values: [
          workspace.id,
          workspace.version,
          snapshot,
          input.changeSummary,
          input.actor,
          input.correlationId,
        ],
      });
      await this.insertAudit(
        transaction,
        input.actor,
        "workspace.saved",
        "workspace",
        workspace.id,
        auditDetails,
        input.correlationId,
      );
      await this.insertOutbox(
        transaction,
        "workspace",
        workspace.id,
        input.eventType ?? "workspace.saved",
        input.topic ?? "workspace-events",
        workspace.id,
        eventPayload,
        input.headers ?? {},
        deduplicationKey,
        input.correlationId,
      );
      return workspace;
    });
  }

  async upsertWorkspaceMember(
    context: TransactionContext,
    input: WorkspaceMembershipUpsertInput,
  ): Promise<WorkspaceMemberRecord> {
    assertActor(context, input.actor);
    return this.runner.withTransaction(context, async (transaction) => {
      await this.assertWorkspaceOwner(transaction, input.workspaceId, input.actor);
      const before = await transaction.query({
        text: [
          "SELECT workspace_id, user_id, display_name, role, created_at",
          "FROM odf.workspace_members",
          "WHERE workspace_id = $1 AND user_id = $2",
        ].join("\n"),
        values: [input.workspaceId, input.member.userId],
      });
      const result = await transaction.query({
        text: [
          "INSERT INTO odf.workspace_members (workspace_id, user_id, display_name, role)",
          "VALUES ($1, $2, $3, $4)",
          "ON CONFLICT (workspace_id, user_id) DO UPDATE",
          "SET display_name = EXCLUDED.display_name, role = EXCLUDED.role",
          "RETURNING workspace_id, user_id, display_name, role, created_at",
        ].join("\n"),
        values: [
          input.workspaceId,
          input.member.userId,
          input.member.displayName,
          input.member.role,
        ],
      });
      const row = result.rows[0];
      if (!row) throw new ConflictError("Workspace member could not be saved");
      const member = workspaceMemberFromRow(row);
      const action = before.rows[0] ? "workspace.member_updated" : "workspace.member_added";
      await this.insertAudit(
        transaction,
        input.actor,
        action,
        "workspaceMember",
        input.member.userId,
        {
          workspaceId: input.workspaceId,
          userId: input.member.userId,
          role: input.member.role,
        },
        input.correlationId,
      );
      await this.insertOutbox(
        transaction,
        "workspace",
        input.workspaceId,
        action,
        "workspace-events",
        input.workspaceId,
        {
          workspaceId: input.workspaceId,
          userId: input.member.userId,
          role: input.member.role,
        },
        {},
        "workspace-member:" + input.workspaceId + ":" + input.member.userId + ":" + input.correlationId,
        input.correlationId,
      );
      return member;
    });
  }

  async removeWorkspaceMember(
    context: TransactionContext,
    input: WorkspaceMembershipRemoveInput,
  ): Promise<WorkspaceMemberRecord> {
    assertActor(context, input.actor);
    return this.runner.withTransaction(context, async (transaction) => {
      await this.assertWorkspaceOwner(transaction, input.workspaceId, input.actor);
      // Migration 002 serializes owner deletion and rejects removal of the
      // final owner. Its constraint is mapped to ConflictError by the runtime.
      const result = await transaction.query({
        text: [
          "DELETE FROM odf.workspace_members",
          "WHERE workspace_id = $1 AND user_id = $2",
          "RETURNING workspace_id, user_id, display_name, role, created_at",
        ].join("\n"),
        values: [input.workspaceId, input.memberUserId],
      });
      const row = result.rows[0];
      if (!row) throw new NotFoundError("Workspace member was not found");
      const member = workspaceMemberFromRow(row);
      await this.insertAudit(
        transaction,
        input.actor,
        "workspace.member_removed",
        "workspaceMember",
        member.userId,
        {
          workspaceId: input.workspaceId,
          userId: member.userId,
          role: member.role,
        },
        input.correlationId,
      );
      await this.insertOutbox(
        transaction,
        "workspace",
        input.workspaceId,
        "workspace.member_removed",
        "workspace-events",
        input.workspaceId,
        {
          workspaceId: input.workspaceId,
          userId: member.userId,
          role: member.role,
        },
        {},
        "workspace-member-removed:" + input.workspaceId + ":" + member.userId + ":" + input.correlationId,
        input.correlationId,
      );
      return member;
    });
  }

  private async assertWorkspaceOwner(
    transaction: ScopedTransaction,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const result = await transaction.query({
      text: [
        "SELECT role FROM odf.workspace_members",
        "WHERE workspace_id = $1 AND user_id = $2",
      ].join("\n"),
      values: [workspaceId, userId],
    });
    if (result.rows[0]?.role !== "owner") {
      throw new ForbiddenError("Workspace owner permission is required");
    }
  }

  private async insertAudit(
    transaction: ScopedTransaction,
    actor: string,
    action: string,
    entityType: string,
    entityId: string,
    details: JsonObject,
    correlationId: string,
  ): Promise<void> {
    await transaction.query({
      text: [
        "INSERT INTO odf.audit_log",
        "  (actor, action, entity_type, entity_id, details, correlation_id)",
        "VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid)",
      ].join("\n"),
      values: [actor, action, entityType, entityId, json(details), correlationId],
    });
  }

  private async insertOutbox(
    transaction: ScopedTransaction,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    topic: string,
    messageKey: string,
    payload: JsonObject,
    headers: JsonObject,
    deduplicationKey: string,
    correlationId: string,
  ): Promise<void> {
    await transaction.query({
      text: [
        "INSERT INTO odf.outbox_events",
        "  (aggregate_type, aggregate_id, event_type, topic, message_key, payload, headers, deduplication_key, correlation_id)",
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::uuid)",
        "ON CONFLICT (aggregate_type, aggregate_id, event_type, deduplication_key) DO NOTHING",
      ].join("\n"),
      values: [
        aggregateType,
        aggregateId,
        eventType,
        topic,
        messageKey,
        json(payload),
        json(headers),
        deduplicationKey,
        correlationId,
      ],
    });
  }
}
