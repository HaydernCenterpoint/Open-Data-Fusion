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
  return {
    entityType,
    entityId: requiredRowString(row, "entity_id"),
    title: requiredRowString(row, "title"),
    summary: optionalRowString(row, "summary") ?? "",
    updatedAt: requiredRowString(row, "updated_at"),
  };
}

/**
 * Reads the rebuildable migration-013 projection rather than reconstructing
 * a static UNION on every request. The index remains fully tenant/project
 * scoped by both query predicates and forced RLS. If tokenization has no
 * match (for example a punctuation-heavy external identifier), it falls back
 * to a bounded substring query against the same projection.
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
    entityType?: string,
  ): Promise<KeysetPage<UnifiedSearchResult, UnifiedSearchCursor>> {
    const text = requiredText(query, "query");
    if (text.length > 200) throw new RangeError("query must not exceed 200 characters");
    const selectedEntityType = entityType === undefined ? null : requiredText(entityType, "entityType");
    if (selectedEntityType !== null && selectedEntityType.length > 100) {
      throw new RangeError("entityType must not exceed 100 characters");
    }
    const bounded = boundedPageSize(limit, 100);
    return this.read(scope, async (transaction) => {
      const result = await transaction.query({
        text: [
          "WITH fts_matches AS MATERIALIZED (",
          "  SELECT entity_type, entity_id, title, body AS summary, updated_at",
          "  FROM odf.platform_search_index",
          "  WHERE tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND ($4::text IS NULL OR entity_type = $4)",
          "    AND search_vector @@ websearch_to_tsquery('simple'::regconfig, $3)",
          "), candidates AS (",
          "  SELECT entity_type, entity_id, title, summary, updated_at FROM fts_matches",
          "  UNION ALL",
          "  SELECT entity_type, entity_id, title, body AS summary, updated_at",
          "  FROM odf.platform_search_index",
          "  WHERE NOT EXISTS (SELECT 1 FROM fts_matches)",
          "    AND tenant_id = $1::uuid AND project_id = $2::uuid",
          "    AND ($4::text IS NULL OR entity_type = $4)",
          "    AND (title ILIKE '%' || $3 || '%' OR body ILIKE '%' || $3 || '%')",
          ")",
          "SELECT entity_type, entity_id, title, summary, updated_at",
          "FROM candidates",
          "WHERE ($5::timestamptz IS NULL OR (updated_at, entity_type, entity_id) < ($5::timestamptz, $6, $7))",
          "ORDER BY updated_at DESC, entity_type DESC, entity_id DESC",
          "LIMIT $8",
        ].join("\n"),
        values: [
          scope.tenantId, scope.projectId, text, selectedEntityType, cursor?.timestamp ?? null, cursor?.entityType ?? null,
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
