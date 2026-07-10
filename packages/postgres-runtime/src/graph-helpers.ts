import { ConflictError } from "./errors.js";
import { json } from "./mappers.js";
import { graphInstanceFromRow } from "./platform-mappers.js";
import type { CreateGraphInstanceInput, GraphInstanceRecord, ProjectScope } from "./platform-types.js";
import type { ScopedTransaction } from "./types.js";

export const GRAPH_INSTANCE_COLUMNS = [
  "instance_id, tenant_id, project_id, dataset_id, space_id, external_id, instance_kind, data_model_id,",
  "properties, valid_from, valid_to, created_at, updated_at",
].join(" ");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return "{" + entries.map(([key, nested]) => JSON.stringify(key) + ":" + canonical(nested)).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function sameGraphInstance(row: GraphInstanceRecord, input: CreateGraphInstanceInput): boolean {
  return row.instanceId === input.instanceId
    && row.datasetId === (input.datasetId ?? null)
    && row.spaceId === input.spaceId
    && row.externalId === input.externalId
    && row.instanceKind === input.instanceKind
    && row.dataModelId === (input.dataModelId ?? null)
    && row.validFrom === (input.validFrom ?? null)
    && row.validTo === (input.validTo ?? null)
    && canonical(row.properties) === canonical(input.properties ?? {});
}

/** Reuses the migration's graph instance as the shared typed-object anchor. */
export async function insertGraphInstanceIdempotent(
  transaction: ScopedTransaction,
  scope: ProjectScope,
  input: CreateGraphInstanceInput,
): Promise<{ graph: GraphInstanceRecord; created: boolean }> {
  const inserted = await transaction.query({
    text: [
      "INSERT INTO odf.graph_instances",
      "  (instance_id, tenant_id, project_id, dataset_id, space_id, external_id, instance_kind, data_model_id, properties, valid_from, valid_to)",
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::uuid, $9::jsonb, $10::timestamptz, $11::timestamptz)",
      "ON CONFLICT (tenant_id, project_id, instance_id) DO NOTHING",
      "RETURNING " + GRAPH_INSTANCE_COLUMNS,
    ].join("\n"),
    values: [
      input.instanceId, scope.tenantId, scope.projectId, input.datasetId ?? null, input.spaceId, input.externalId,
      input.instanceKind, input.dataModelId ?? null, json(input.properties ?? {}), input.validFrom ?? null, input.validTo ?? null,
    ],
  });
  const row = inserted.rows[0];
  if (row) return { graph: graphInstanceFromRow(row), created: true };

  const existing = await transaction.query({
    text: [
      "SELECT " + GRAPH_INSTANCE_COLUMNS,
      "FROM odf.graph_instances",
      "WHERE tenant_id = $1::uuid AND project_id = $2::uuid AND instance_id = $3::uuid",
    ].join("\n"),
    values: [scope.tenantId, scope.projectId, input.instanceId],
  });
  const existingRow = existing.rows[0];
  if (!existingRow) throw new ConflictError("Graph instance idempotency record could not be resolved");
  const graph = graphInstanceFromRow(existingRow);
  if (!sameGraphInstance(graph, input)) throw new ConflictError("Graph instance identifier is already bound to different input");
  return { graph, created: false };
}
