import type {
  PublicInstanceAggregateRequest,
  PublicInstanceQueryRequest,
  PublicModelFilter,
  PublicModelPropertyDefinition,
  PublicModelViewDefinition,
} from "./platform-types.js";
import type { SqlQuery } from "./types.js";

interface ModelSqlContext {
  tenantId: string;
  projectId: string;
  dataModelId: string;
  modelViewId: string;
  view: PublicModelViewDefinition;
}

export interface PostgresModelQueryContext extends ModelSqlContext {
  request: PublicInstanceQueryRequest;
}

export interface PostgresModelAggregateContext extends ModelSqlContext {
  request: PublicInstanceAggregateRequest;
}

interface QueryCursor {
  version: 1;
  sortNull: boolean;
  sortValue: unknown;
  space: string;
  externalId: string;
}

class Parameters {
  readonly values: unknown[] = [];

  add(value: unknown, cast = ""): string {
    this.values.push(value);
    return `$${this.values.length}${cast}`;
  }
}

function propertyDefinition(view: PublicModelViewDefinition, property: string): PublicModelPropertyDefinition {
  const definition = view.properties[property];
  if (!definition) throw new RangeError(`Unknown model property '${property}'`);
  return definition;
}

function propertyExpression(
  parameters: Parameters,
  view: PublicModelViewDefinition,
  property: string,
  alias = "graph",
): { expression: string; definition: PublicModelPropertyDefinition } {
  const definition = propertyDefinition(view, property);
  const key = parameters.add(property);
  if (definition.list || definition.type === "json" || definition.type === "direct") {
    return { expression: `${alias}.properties -> ${key}`, definition };
  }
  const text = `${alias}.properties ->> ${key}`;
  switch (definition.type) {
    case "int64":
    case "float64":
      return { expression: `(${text})::double precision`, definition };
    case "boolean":
      return { expression: `(${text})::boolean`, definition };
    case "timestamp":
      return { expression: `(${text})::timestamptz`, definition };
    case "date":
      return { expression: `(${text})::date`, definition };
    case "text":
      return { expression: text, definition };
    default:
      return { expression: `${alias}.properties -> ${key}`, definition };
  }
}

function valueParameter(parameters: Parameters, definition: PublicModelPropertyDefinition, value: unknown): string {
  if (definition.list || definition.type === "json" || definition.type === "direct") {
    return parameters.add(JSON.stringify(value), "::jsonb");
  }
  switch (definition.type) {
    case "int64":
    case "float64":
      return parameters.add(value, "::double precision");
    case "boolean":
      return parameters.add(value, "::boolean");
    case "timestamp":
      return parameters.add(value, "::timestamptz");
    case "date":
      return parameters.add(value, "::date");
    case "text":
      return parameters.add(value, "::text");
    default:
      return parameters.add(JSON.stringify(value), "::jsonb");
  }
}

function compileFilter(
  parameters: Parameters,
  view: PublicModelViewDefinition,
  filter: PublicModelFilter,
): string {
  if ("and" in filter) return `(${filter.and.map((child) => compileFilter(parameters, view, child)).join(" AND ")})`;
  if ("or" in filter) return `(${filter.or.map((child) => compileFilter(parameters, view, child)).join(" OR ")})`;
  if ("not" in filter) return `(NOT ${compileFilter(parameters, view, filter.not)})`;
  if ("exists" in filter) return `(graph.properties ? ${parameters.add(filter.exists.property)})`;
  if ("equals" in filter) {
    const property = propertyExpression(parameters, view, filter.equals.property);
    return `(${property.expression} IS NOT DISTINCT FROM ${valueParameter(parameters, property.definition, filter.equals.value)})`;
  }
  if ("in" in filter) {
    const property = propertyExpression(parameters, view, filter.in.property);
    return `(${filter.in.values.map((value) => (
      `${property.expression} IS NOT DISTINCT FROM ${valueParameter(parameters, property.definition, value)}`
    )).join(" OR ")})`;
  }
  const property = propertyExpression(parameters, view, filter.range.property);
  const comparisons: string[] = [];
  for (const [bound, operator] of [["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="]] as const) {
    const value = filter.range[bound];
    if (value !== undefined) comparisons.push(`${property.expression} ${operator} ${valueParameter(parameters, property.definition, value)}`);
  }
  return `(${comparisons.join(" AND ")})`;
}

function decodeCursor(value: string): QueryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<QueryCursor>;
    if (parsed.version !== 1 || typeof parsed.sortNull !== "boolean" || typeof parsed.space !== "string" || typeof parsed.externalId !== "string") {
      throw new Error("invalid shape");
    }
    return parsed as QueryCursor;
  } catch {
    throw new RangeError("Invalid model instance cursor");
  }
}

function cursorPredicate(
  parameters: Parameters,
  expression: string | null,
  direction: "asc" | "desc",
  cursor: QueryCursor,
): string {
  const space = parameters.add(cursor.space, "::text");
  const externalId = parameters.add(cursor.externalId, "::text");
  const keyAfter = `(space.external_id, graph.external_id) > (${space}, ${externalId})`;
  if (!expression) return keyAfter;
  if (cursor.sortNull) return `((${expression}) IS NULL AND ${keyAfter})`;
  const sortValue = parameters.add(cursor.sortValue);
  const comparison = direction === "asc" ? ">" : "<";
  return `(((${expression}) IS NULL) OR ((${expression}) IS NOT NULL AND ((${expression}) ${comparison} ${sortValue} OR ((${expression}) IS NOT DISTINCT FROM ${sortValue} AND ${keyAfter}))))`;
}

export function compilePostgresModelQuery(context: PostgresModelQueryContext): SqlQuery {
  const parameters = new Parameters();
  const tenant = parameters.add(context.tenantId, "::uuid");
  const project = parameters.add(context.projectId, "::uuid");
  const model = parameters.add(context.dataModelId, "::uuid");
  const modelView = parameters.add(context.modelViewId, "::uuid");
  const where = [
    `graph.tenant_id = ${tenant}`,
    `graph.project_id = ${project}`,
    `graph.data_model_id = ${model}`,
    `graph.model_view_id = ${modelView}`,
  ];
  if (context.request.filter) where.push(compileFilter(parameters, context.view, context.request.filter));

  let sortExpression: string | null = null;
  const direction = context.request.sort?.direction ?? "asc";
  if (context.request.sort) {
    sortExpression = propertyExpression(parameters, context.view, context.request.sort.property).expression;
  }
  if (context.request.cursor) {
    where.push(cursorPredicate(parameters, sortExpression, direction, decodeCursor(context.request.cursor)));
  }

  const properties = context.request.projection === undefined
    ? "graph.properties"
    : `COALESCE((SELECT jsonb_object_agg(projected.key, graph.properties -> projected.key) FROM unnest(${parameters.add(context.request.projection, "::text[]")}) AS projected(key) WHERE graph.properties ? projected.key), '{}'::jsonb)`;
  const order = sortExpression
    ? `(${sortExpression}) IS NULL ASC, ${sortExpression} ${direction.toUpperCase()}, space.external_id ASC, graph.external_id ASC`
    : "space.external_id ASC, graph.external_id ASC";
  const limit = parameters.add((context.request.limit ?? 50) + 1, "::integer");

  return {
    text: [
      "SELECT graph.instance_kind, view.external_id AS view_external_id, space.external_id AS space_external_id,",
      `  graph.external_id, ${properties} AS properties, graph.created_at, graph.updated_at,`,
      "  source_space.external_id AS source_space_external_id, source_graph.external_id AS source_external_id,",
      "  target_space.external_id AS target_space_external_id, target_graph.external_id AS target_external_id,",
      `  ${sortExpression ? `(${sortExpression}) IS NULL` : "false"} AS sort_is_null,`,
      `  ${sortExpression ?? "NULL::text"} AS sort_value`,
      "FROM odf.graph_instances graph",
      "JOIN odf.model_spaces space ON space.tenant_id = graph.tenant_id AND space.project_id = graph.project_id AND space.space_id = graph.space_id",
      "JOIN odf.model_views view ON view.tenant_id = graph.tenant_id AND view.model_view_id = graph.model_view_id",
      "LEFT JOIN odf.graph_instances source_graph ON source_graph.tenant_id = graph.tenant_id AND source_graph.project_id = graph.project_id AND source_graph.instance_id = graph.source_instance_id",
      "LEFT JOIN odf.model_spaces source_space ON source_space.tenant_id = source_graph.tenant_id AND source_space.project_id = source_graph.project_id AND source_space.space_id = source_graph.space_id",
      "LEFT JOIN odf.graph_instances target_graph ON target_graph.tenant_id = graph.tenant_id AND target_graph.project_id = graph.project_id AND target_graph.instance_id = graph.target_instance_id",
      "LEFT JOIN odf.model_spaces target_space ON target_space.tenant_id = target_graph.tenant_id AND target_space.project_id = target_graph.project_id AND target_space.space_id = target_graph.space_id",
      `WHERE ${where.join(" AND ")}`,
      `ORDER BY ${order}`,
      `LIMIT ${limit}`,
    ].join("\n"),
    values: parameters.values,
  };
}

export function compilePostgresModelAggregate(context: PostgresModelAggregateContext): SqlQuery {
  const parameters = new Parameters();
  const tenant = parameters.add(context.tenantId, "::uuid");
  const project = parameters.add(context.projectId, "::uuid");
  const model = parameters.add(context.dataModelId, "::uuid");
  const modelView = parameters.add(context.modelViewId, "::uuid");
  const where = [
    `graph.tenant_id = ${tenant}`,
    `graph.project_id = ${project}`,
    `graph.data_model_id = ${model}`,
    `graph.model_view_id = ${modelView}`,
  ];
  if (context.request.filter) where.push(compileFilter(parameters, context.view, context.request.filter));

  const groups = (context.request.groupBy ?? []).map((property) => ({
    name: parameters.add(property),
    expression: propertyExpression(parameters, context.view, property).expression,
  }));
  const groupJson = groups.length === 0
    ? "'{}'::jsonb"
    : `jsonb_build_object(${groups.flatMap((group) => [group.name, group.expression]).join(", ")})`;
  const metrics = context.request.metrics.map((metric) => {
    const name = parameters.add(metric.name);
    if (metric.operation === "count") {
      const expression = metric.property
        ? propertyExpression(parameters, context.view, metric.property).expression
        : "*";
      return [name, `count(${expression})::double precision`];
    }
    if (!metric.property) throw new RangeError(`Metric '${metric.name}' requires a property`);
    const expression = propertyExpression(parameters, context.view, metric.property).expression;
    return [name, `${metric.operation}(${expression})::double precision`];
  });
  const metricJson = `jsonb_build_object(${metrics.flat().join(", ")})`;
  const limit = parameters.add((context.request.limit ?? 200) + 1, "::integer");

  return {
    text: [
      `SELECT ${groupJson} AS group_values, ${metricJson} AS metric_values`,
      "FROM odf.graph_instances graph",
      `WHERE ${where.join(" AND ")}`,
      ...(groups.length > 0 ? [
        `GROUP BY ${groups.map((group) => group.expression).join(", ")}`,
        `ORDER BY ${groups.map((group) => `${group.expression} ASC NULLS LAST`).join(", ")}`,
      ] : []),
      `LIMIT ${limit}`,
    ].join("\n"),
    values: parameters.values,
  };
}

export function encodePostgresModelQueryCursor(row: Record<string, unknown>): string {
  const payload: QueryCursor = {
    version: 1,
    sortNull: row.sort_is_null === true || row.sort_is_null === "t",
    sortValue: row.sort_value instanceof Date ? row.sort_value.toISOString() : row.sort_value ?? null,
    space: String(row.space_external_id),
    externalId: String(row.external_id),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
