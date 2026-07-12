import { json } from "./mappers.js";
import type { JsonObject, ScopedTransaction } from "./types.js";

export interface PlatformAuditEvent {
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  tenantId: string;
  projectId: string;
  correlationId: string;
  details: JsonObject;
  topic?: string;
  aggregateType?: string;
}

/**
 * Persists recovery evidence and the delivery intent in the same short
 * transaction as the aggregate mutation. No network operation belongs here.
 */
export async function appendPlatformAuditAndOutbox(
  transaction: ScopedTransaction,
  event: PlatformAuditEvent,
): Promise<void> {
  const scopedDetails: JsonObject = {
    ...event.details,
    tenantId: event.tenantId,
    projectId: event.projectId,
  };
  const payload: JsonObject = {
    tenantId: event.tenantId,
    projectId: event.projectId,
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    details: event.details,
  };
  await transaction.query({
    text: [
      "INSERT INTO odf.audit_log",
      "  (tenant_id, project_id, actor, action, entity_type, entity_id, details, correlation_id)",
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::uuid)",
    ].join("\n"),
    values: [
      event.tenantId,
      event.projectId,
      event.actor,
      event.action,
      event.entityType,
      event.entityId,
      json(scopedDetails),
      event.correlationId,
    ],
  });
  await transaction.query({
    text: [
      "INSERT INTO odf.outbox_events",
      "  (aggregate_type, aggregate_id, event_type, topic, message_key, payload, headers, deduplication_key, correlation_id)",
      "VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7, $8::uuid)",
      "ON CONFLICT (aggregate_type, aggregate_id, event_type, deduplication_key) DO NOTHING",
    ].join("\n"),
    values: [
      event.aggregateType ?? event.entityType,
      event.entityId,
      event.action,
      event.topic ?? "platform-events",
      event.entityId,
      json(payload),
      "platform:" + event.action + ":" + event.correlationId,
      event.correlationId,
    ],
  });
}
