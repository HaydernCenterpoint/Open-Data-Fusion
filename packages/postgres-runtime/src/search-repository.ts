import { PolicyAwareRepository } from "./platform-repository-base.js";
import { boundedPageSize, requiredText } from "./platform-support.js";
import { optionalRowString, requiredRowString } from "./platform-mappers.js";
import type {
  ProjectAccessResolver,
  ProjectScope,
  SearchRepository,
  UnifiedSearchCursor,
  UnifiedSearchResult,
} from "./platform-types.js";
import type { KeysetPage, TransactionRunner } from "./types.js";

function searchResultFromRow(row: Record<string, unknown>): UnifiedSearchResult {
  const entityType = requiredRowString(row, "entity_type");
  if (!["asset", "document", "sourceConnection", "dataset", "pipeline", "modelSpace"].includes(entityType)) {
    throw new TypeError("Unexpected unified search entity type from PostgreSQL");
  }
  return {
    entityType: entityType as UnifiedSearchResult["entityType"],
    entityId: requiredRowString(row, "entity_id"),
    title: requiredRowString(row, "title"),
    summary: optionalRowString(row, "summary") ?? "",
    updatedAt: requiredRowString(row, "updated_at"),
  };
}

/**
 * Migration 003 has no search projection or tsvector index. This bounded,
 * static UNION is deliberately project/RLS-scoped; introduce migration 004
 * before replacing it with a persistent full-text projection at scale.
 */
export class PostgresSearchRepository extends PolicyAwareRepository implements SearchRepository {
  constructor(runner: TransactionRunner, policy: ProjectAccessResolver) {
    super(runner, policy);
  }

  async search(
    scope: ProjectScope,
    query: string,
    limit: number,
    cursor?: UnifiedSearchCursor,
  ): Promise<KeysetPage<UnifiedSearchResult, UnifiedSearchCursor>> {
    const text = requiredText(query, "query");
    if (text.length > 200) throw new RangeError("query must not exceed 200 characters");
    const bounded = boundedPageSize(limit, 100);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "WITH candidates AS (",
          "  SELECT 'asset'::text AS entity_type, asset_id::text AS entity_id, name AS title,",
          "         COALESCE(description, asset_type) AS summary, updated_at",
          "  FROM odf.assets",
          "  WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND (name ILIKE '%' || $3 || '%' OR COALESCE(description, '') ILIKE '%' || $3 || '%' OR asset_type ILIKE '%' || $3 || '%')",
          "  UNION ALL",
          "  SELECT 'document'::text, document_id::text, title, COALESCE(mime_type, source_system), updated_at",
          "  FROM odf.documents",
          "  WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND (title ILIKE '%' || $3 || '%' OR COALESCE(mime_type, '') ILIKE '%' || $3 || '%' OR source_system ILIKE '%' || $3 || '%')",
          "  UNION ALL",
          "  SELECT 'sourceConnection'::text, source_connection_id::text, name, connector_kind, updated_at",
          "  FROM odf.source_connections",
          "  WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND (name ILIKE '%' || $3 || '%' OR external_id ILIKE '%' || $3 || '%' OR connector_kind ILIKE '%' || $3 || '%')",
          "  UNION ALL",
          "  SELECT 'dataset'::text, dataset_id::text, name, COALESCE(description, classification), updated_at",
          "  FROM odf.datasets",
          "  WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND (name ILIKE '%' || $3 || '%' OR external_id ILIKE '%' || $3 || '%' OR COALESCE(description, '') ILIKE '%' || $3 || '%')",
          "  UNION ALL",
          "  SELECT 'pipeline'::text, pipeline_id::text, name, COALESCE(description, external_id), updated_at",
          "  FROM odf.pipelines",
          "  WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND (name ILIKE '%' || $3 || '%' OR external_id ILIKE '%' || $3 || '%' OR COALESCE(description, '') ILIKE '%' || $3 || '%')",
          "  UNION ALL",
          "  SELECT 'modelSpace'::text, space_id::text, name, COALESCE(description, external_id), updated_at",
          "  FROM odf.model_spaces",
          "  WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND (name ILIKE '%' || $3 || '%' OR external_id ILIKE '%' || $3 || '%' OR COALESCE(description, '') ILIKE '%' || $3 || '%')",
          ")",
          "SELECT entity_type, entity_id, title, summary, updated_at",
          "FROM candidates",
          "WHERE ($4::timestamptz IS NULL OR (updated_at, entity_type, entity_id) < ($4::timestamptz, $5, $6))",
          "ORDER BY updated_at DESC, entity_type DESC, entity_id DESC",
          "LIMIT $7",
        ].join("\n"),
        values: [
          scope.tenantId, scope.projectId, text, cursor?.timestamp ?? null, cursor?.entityType ?? null,
          cursor?.entityId ?? null, bounded + 1,
        ],
      });
      const rows = result.rows.map(searchResultFromRow);
      const items = rows.slice(0, bounded);
      const tail = items.at(-1);
      return {
        items,
        nextCursor: rows.length > bounded && tail
          ? { timestamp: tail.updatedAt, entityType: tail.entityType, entityId: tail.entityId }
          : null,
      };
    });
  }
}
