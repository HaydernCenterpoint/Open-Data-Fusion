import { ConflictError, NotFoundError } from "./errors.js";
import { json } from "./mappers.js";
import { appendPlatformAuditAndOutbox } from "./platform-events.js";
import {
  writebackApprovalFromRow,
  writebackEventFromRow,
  writebackRequestFromRow,
} from "./platform-mappers.js";
import { PolicyAwareRepository } from "./platform-repository-base.js";
import { boundedPageSize, pageFromRows, requiredText } from "./platform-support.js";
import type {
  CompleteWritebackInput,
  CreateWritebackRequestInput,
  NumericCursor,
  ProjectAccessResolver,
  ProjectScope,
  RecordWritebackApprovalInput,
  TimestampIdCursor,
  WritebackEventRecord,
  WritebackRepository,
  WritebackRequestRecord,
} from "./platform-types.js";
import type { KeysetPage, ScopedTransaction, TransactionRunner } from "./types.js";

const WRITEBACK_REQUEST_COLUMNS = [
  "writeback_request_id, tenant_id, project_id, source_connection_id, target_instance_id, target_external_id, operation,",
  "payload, risk, state, requested_by, requested_at, dry_run_result, executed_at, updated_at",
].join(" ");
const WRITEBACK_APPROVAL_COLUMNS = "writeback_approval_id, tenant_id, writeback_request_id, actor, decision, comment, occurred_at";
const WRITEBACK_EVENT_COLUMNS = "id, actor, action, entity_id, details, correlation_id, occurred_at";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, nested]) => JSON.stringify(key) + ":" + canonical(nested)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function sameWriteback(row: WritebackRequestRecord, input: CreateWritebackRequestInput): boolean {
  return row.writebackRequestId === input.writebackRequestId
    && row.sourceConnectionId === input.sourceConnectionId
    && row.targetInstanceId === (input.targetInstanceId ?? null)
    && row.targetExternalId === input.targetExternalId
    && row.operation === input.operation
    && row.risk === input.risk
    && canonical(row.payload) === canonical(input.payload)
    && canonical(row.dryRunResult) === canonical(input.dryRunResult ?? null);
}

/**
 * Implements the durable write-back ledger around migration 003's state
 * triggers. The append-only audit log is the event history; external device
 * execution intentionally happens after beginWriteback commits.
 */
export class PostgresWritebackRepository extends PolicyAwareRepository implements WritebackRepository {
  constructor(runner: TransactionRunner, policy: ProjectAccessResolver) {
    super(runner, policy);
  }

  async createWritebackRequest(scope: ProjectScope, input: CreateWritebackRequestInput): Promise<WritebackRequestRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.writeback_requests",
          "  (writeback_request_id, tenant_id, project_id, source_connection_id, target_instance_id, target_external_id, operation, payload, risk, state, requested_by, dry_run_result)",
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9, 'pending_approval', $10, $11::jsonb)",
          "ON CONFLICT (tenant_id, project_id, writeback_request_id) DO NOTHING",
          "RETURNING " + WRITEBACK_REQUEST_COLUMNS,
        ].join("\n"),
        values: [
          input.writebackRequestId, scope.tenantId, scope.projectId, input.sourceConnectionId, input.targetInstanceId ?? null,
          input.targetExternalId, input.operation, json(input.payload), input.risk, scope.userId,
          input.dryRunResult === undefined || input.dryRunResult === null ? null : json(input.dryRunResult),
        ],
      });
      const row = inserted.rows[0];
      if (row) {
        const request = writebackRequestFromRow(row);
        await appendPlatformAuditAndOutbox(transaction, {
          actor: scope.userId, action: "platform.writeback_request_created", entityType: "writebackRequest", entityId: request.writebackRequestId,
          tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
          details: { sourceConnectionId: request.sourceConnectionId, targetExternalId: request.targetExternalId, operation: request.operation, risk: request.risk, state: request.state },
        });
        return request;
      }
      const existing = await this.getRequest(transaction, scope, input.writebackRequestId);
      if (!sameWriteback(existing, input)) throw new ConflictError("Write-back request identifier is already bound to different input");
      return existing;
    });
  }

  async listWritebackRequests(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<WritebackRequestRecord, TimestampIdCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "SELECT " + WRITEBACK_REQUEST_COLUMNS,
          "FROM odf.writeback_requests",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "  AND ($3::timestamptz IS NULL OR (requested_at, writeback_request_id) < ($3::timestamptz, $4::uuid))",
          "ORDER BY requested_at DESC, writeback_request_id DESC",
          "LIMIT $5",
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, cursor?.timestamp ?? null, cursor?.id ?? null, bounded + 1],
      });
      return pageFromRows(result.rows, bounded, writebackRequestFromRow, (request) => ({ timestamp: request.requestedAt, id: request.writebackRequestId }));
    });
  }

  async recordWritebackApproval(scope: ProjectScope, input: RecordWritebackApprovalInput): Promise<WritebackRequestRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.review(scope, async (transaction) => {
      // Serialize distinct approvers so a high-risk request cannot be left
      // pending merely because two approval counts raced each other.
      await transaction.query({
        text: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        values: ["odf:writeback-approval:" + input.writebackRequestId],
      });
      const request = await this.getRequest(transaction, scope, input.writebackRequestId);
      if (request.state !== "pending_approval") {
        throw new ConflictError("Write-back request is not pending approval");
      }
      const inserted = await transaction.query({
        text: [
          "INSERT INTO odf.writeback_approvals (tenant_id, writeback_request_id, actor, decision, comment)",
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5)",
          "ON CONFLICT (writeback_request_id, actor) DO NOTHING",
          "RETURNING " + WRITEBACK_APPROVAL_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, input.writebackRequestId, scope.userId, input.decision, input.comment ?? null],
      });
      const approvalRow = inserted.rows[0];
      if (!approvalRow) {
        const existing = await transaction.query({
          text: "SELECT " + WRITEBACK_APPROVAL_COLUMNS + " FROM odf.writeback_approvals WHERE tenant_id = $1::uuid AND writeback_request_id = $2::uuid AND actor = $3",
          values: [scope.tenantId, input.writebackRequestId, scope.userId],
        });
        const existingRow = existing.rows[0];
        if (!existingRow) throw new ConflictError("Write-back approval idempotency record could not be resolved");
        const approval = writebackApprovalFromRow(existingRow);
        if (approval.decision !== input.decision || approval.comment !== (input.comment ?? null)) {
          throw new ConflictError("Write-back approver already submitted a different decision");
        }
        return this.getRequest(transaction, scope, input.writebackRequestId);
      }
      const approval = writebackApprovalFromRow(approvalRow);
      let resultingState: WritebackRequestRecord["state"] = "pending_approval";
      if (approval.decision === "rejected") {
        resultingState = "cancelled";
      } else {
        const approvals = await transaction.query({
          text: [
            "SELECT count(DISTINCT actor)::integer AS approval_count",
            "FROM odf.writeback_approvals",
            "WHERE tenant_id = $1::uuid AND writeback_request_id = $2::uuid AND decision = 'approved'",
          ].join("\n"),
          values: [scope.tenantId, input.writebackRequestId],
        });
        const count = Number(approvals.rows[0]?.approval_count ?? 0);
        const required = request.risk === "high" || request.risk === "critical" ? 2 : 1;
        if (count >= required) resultingState = "approved";
      }
      const updated = await transaction.query({
        text: [
          "UPDATE odf.writeback_requests",
          "SET state = $4, updated_at = now()",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND writeback_request_id = $3::uuid AND state = 'pending_approval'",
          "RETURNING " + WRITEBACK_REQUEST_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, input.writebackRequestId, resultingState],
      });
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new ConflictError("Write-back request state is no longer current");
      const updatedRequest = writebackRequestFromRow(updatedRow);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.writeback_" + approval.decision, entityType: "writebackRequest", entityId: updatedRequest.writebackRequestId,
        tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
        details: { decision: approval.decision, resultingState: updatedRequest.state, comment: approval.comment },
      });
      return updatedRequest;
    });
  }

  async beginWriteback(scope: ProjectScope, requestId: string, correlationId: string): Promise<WritebackRequestRecord> {
    requiredText(correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const updated = await transaction.query({
        text: [
          "UPDATE odf.writeback_requests",
          "SET state = 'executing', updated_at = now()",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND writeback_request_id = $3::uuid AND state = 'approved'",
          "RETURNING " + WRITEBACK_REQUEST_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, requestId],
      });
      const row = updated.rows[0];
      if (!row) {
        const existing = await this.getRequest(transaction, scope, requestId);
        if (existing.state === "executing") return existing;
        throw new ConflictError("Write-back request is not approved for execution");
      }
      const request = writebackRequestFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.writeback_execution_started", entityType: "writebackRequest", entityId: request.writebackRequestId,
        tenantId: scope.tenantId, projectId: scope.projectId, correlationId,
        details: { state: request.state, risk: request.risk },
      });
      return request;
    });
  }

  async completeWriteback(scope: ProjectScope, input: CompleteWritebackInput): Promise<WritebackRequestRecord> {
    requiredText(input.correlationId, "correlationId");
    return this.write(scope, async (transaction) => {
      const nextState = input.succeeded ? "succeeded" : "failed";
      const updated = await transaction.query({
        text: [
          "UPDATE odf.writeback_requests",
          "SET state = $4, executed_at = now(), updated_at = now()",
          "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND writeback_request_id = $3::uuid AND state = $5",
          "RETURNING " + WRITEBACK_REQUEST_COLUMNS,
        ].join("\n"),
        values: [scope.tenantId, scope.projectId, input.writebackRequestId, nextState, input.expectedState],
      });
      const row = updated.rows[0];
      if (!row) {
        const existing = await this.getRequest(transaction, scope, input.writebackRequestId);
        if (existing.state === nextState) return existing;
        throw new ConflictError("Write-back request is no longer executing");
      }
      const request = writebackRequestFromRow(row);
      await appendPlatformAuditAndOutbox(transaction, {
        actor: scope.userId, action: "platform.writeback_execution_" + nextState, entityType: "writebackRequest", entityId: request.writebackRequestId,
        tenantId: scope.tenantId, projectId: scope.projectId, correlationId: input.correlationId,
        details: { state: request.state, executedAt: request.executedAt },
      });
      return request;
    });
  }

  async listWritebackEvents(
    scope: ProjectScope,
    requestId: string,
    limit: number,
    cursor?: NumericCursor,
  ): Promise<KeysetPage<WritebackEventRecord, NumericCursor>> {
    const bounded = boundedPageSize(limit);
    return this.read(scope, async (transaction) => {
      await this.getRequest(transaction, scope, requestId);
      const result = await transaction.query({
        text: [
          "SELECT " + WRITEBACK_EVENT_COLUMNS,
          "FROM odf.audit_log",
          "WHERE entity_type = 'writebackRequest' AND entity_id = $1 AND id > $2::bigint",
          "ORDER BY id ASC",
          "LIMIT $3",
        ].join("\n"),
        values: [requestId, cursor?.value ?? "0", bounded + 1],
      });
      return pageFromRows(result.rows, bounded, writebackEventFromRow, (event) => ({ value: event.id }));
    });
  }

  private async getRequest(
    transaction: ScopedTransaction,
    scope: ProjectScope,
    requestId: string,
  ): Promise<WritebackRequestRecord> {
    const result = await transaction.query({
      text: [
        "SELECT " + WRITEBACK_REQUEST_COLUMNS,
        "FROM odf.writeback_requests",
        "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND writeback_request_id = $3::uuid",
      ].join("\n"),
      values: [scope.tenantId, scope.projectId, requestId],
    });
    const row = result.rows[0];
    if (!row) throw new NotFoundError("Write-back request was not found");
    return writebackRequestFromRow(row);
  }
}
