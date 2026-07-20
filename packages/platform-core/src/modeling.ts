import type {
  InstanceAggregateRequest,
  InstanceQueryRequest,
  InstanceUpsertItem,
  ModelFilter,
  ModelPropertyDefinition,
  ModelPropertyType,
  ModelViewDefinition,
} from "@open-data-fusion/contracts";

export interface ModelValidationIssue {
  path: string;
  message: string;
}

export class ModelValidationError extends Error {
  readonly issues: ModelValidationIssue[];

  constructor(issues: ModelValidationIssue[]) {
    super("Model graph validation failed");
    this.name = "ModelValidationError";
    this.issues = issues;
  }
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PROPERTY_TYPES = new Set<ModelPropertyType>([
  "text", "int64", "float64", "boolean", "timestamp", "date", "json", "direct",
]);
const VIEW_KEYS = new Set(["externalId", "name", "usedFor", "properties"]);
const PROPERTY_KEYS = new Set(["type", "required", "nullable", "list"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new ModelValidationError([{ path, message }]);
}

function strictKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) fail(path, `Unknown field '${unknown[0]}'`);
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "Expected a string identifier");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 255 || !IDENTIFIER.test(normalized)) {
    fail(path, "Use 1-255 letters, numbers, dots, colons, slashes, underscores, or dashes");
  }
  return normalized;
}

function name(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "Expected a string");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 255) fail(path, "Use 1-255 characters");
  return normalized;
}

function bool(value: unknown, path: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") fail(path, "Expected a boolean");
  return value;
}

export function normalizeModelView(input: ModelViewDefinition): ModelViewDefinition {
  if (!isRecord(input)) fail("view", "Expected an object");
  strictKeys(input, VIEW_KEYS, "view");
  if (input.usedFor !== "node" && input.usedFor !== "edge") {
    fail("usedFor", "Expected 'node' or 'edge'");
  }
  if (!isRecord(input.properties)) fail("properties", "Expected an object");
  const entries = Object.entries(input.properties);
  if (entries.length > 200) fail("properties", "Use at most 200 properties");

  const properties: Record<string, ModelPropertyDefinition> = {};
  for (const [propertyName, definition] of entries) {
    identifier(propertyName, `properties.${propertyName}`);
    if (!isRecord(definition)) fail(`properties.${propertyName}`, "Expected an object");
    strictKeys(definition, PROPERTY_KEYS, `properties.${propertyName}`);
    if (typeof definition.type !== "string" || !PROPERTY_TYPES.has(definition.type as ModelPropertyType)) {
      fail(`properties.${propertyName}.type`, "Expected an approved property type");
    }
    properties[propertyName] = {
      type: definition.type as ModelPropertyType,
      required: bool(definition.required, `properties.${propertyName}.required`, false),
      nullable: bool(definition.nullable, `properties.${propertyName}.nullable`, false),
      list: bool(definition.list, `properties.${propertyName}.list`, false),
    };
  }

  return {
    externalId: identifier(input.externalId, "externalId"),
    name: name(input.name, "name"),
    usedFor: input.usedFor,
    properties,
  };
}

export function normalizeModelViews(inputs: ModelViewDefinition[]): ModelViewDefinition[] {
  if (!Array.isArray(inputs)) fail("views", "Expected an array");
  if (inputs.length > 100) fail("views", "Use at most 100 views");
  const views = inputs.map(normalizeModelView);
  const seen = new Set<string>();
  for (const view of views) {
    if (seen.has(view.externalId)) fail("views", `Duplicate view '${view.externalId}'`);
    seen.add(view.externalId);
  }
  return views;
}

function normalizeKey(value: unknown, path: string): { space: string; externalId: string } {
  if (!isRecord(value)) fail(path, "Expected an instance key");
  strictKeys(value, new Set(["space", "externalId"]), path);
  return {
    space: identifier(value.space, `${path}.space`),
    externalId: identifier(value.externalId, `${path}.externalId`),
  };
}

function normalizeJsonValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "Expected a finite JSON number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeJsonValue(item, `${path}.${index}`));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJsonValue(item, `${path}.${key}`)]));
  }
  return fail(path, "Expected a JSON value");
}

function normalizeDate(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, "Expected a YYYY-MM-DD date");
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail(path, "Expected a real calendar date");
  }
  return value;
}

function normalizeScalar(type: ModelPropertyType, value: unknown, path: string): unknown {
  switch (type) {
    case "text":
      if (typeof value !== "string") fail(path, "Expected text");
      return value;
    case "int64":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "Expected a safe integer");
      return value;
    case "float64":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "Expected a finite number");
      return value;
    case "boolean":
      if (typeof value !== "boolean") fail(path, "Expected a boolean");
      return value;
    case "timestamp": {
      if (typeof value !== "string") fail(path, "Expected an ISO timestamp");
      const timestamp = new Date(value);
      if (!Number.isFinite(timestamp.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
        fail(path, "Expected an ISO timestamp");
      }
      return timestamp.toISOString();
    }
    case "date":
      return normalizeDate(value, path);
    case "json":
      return normalizeJsonValue(value, path);
    case "direct":
      return normalizeKey(value, path);
  }
}

function normalizedDefinition(view: ModelViewDefinition, property: string, path: string): ModelPropertyDefinition {
  const definition = view.properties[property];
  if (!definition) fail(path, `Unknown property '${property}'`);
  return {
    type: definition.type,
    required: definition.required ?? false,
    nullable: definition.nullable ?? false,
    list: definition.list ?? false,
  };
}

function normalizeProperty(definition: ModelPropertyDefinition, value: unknown, path: string): unknown {
  if (value === null) {
    if (!definition.nullable) fail(path, "Property is not nullable");
    return null;
  }
  if (definition.list) {
    if (!Array.isArray(value)) fail(path, "Expected a list");
    if (value.length > 1_000) fail(path, "Use at most 1,000 list items");
    return value.map((item, index) => normalizeScalar(definition.type, item, `${path}.${index}`));
  }
  if (Array.isArray(value)) fail(path, "Expected a scalar value");
  return normalizeScalar(definition.type, value, path);
}

export function normalizeModelInstance(
  viewInput: ModelViewDefinition,
  input: InstanceUpsertItem,
): InstanceUpsertItem {
  const view = normalizeModelView(viewInput);
  if (!isRecord(input)) fail("instance", "Expected an object");
  const key = normalizeKey({ space: input.space, externalId: input.externalId }, "instance");
  if (input.kind !== "node" && input.kind !== "edge") fail("kind", "Expected 'node' or 'edge'");
  if (input.kind !== view.usedFor) fail("kind", `Expected '${view.usedFor}' for view '${view.externalId}'`);
  if (input.viewExternalId !== view.externalId) fail("viewExternalId", `Expected '${view.externalId}'`);
  if (!isRecord(input.properties)) fail("properties", "Expected an object");

  const unknown = Object.keys(input.properties).filter((property) => !(property in view.properties));
  if (unknown.length > 0) fail(`properties.${unknown[0]}`, "Property is not defined by the view");
  const properties: Record<string, unknown> = {};
  for (const [property, definition] of Object.entries(view.properties)) {
    const present = Object.prototype.hasOwnProperty.call(input.properties, property);
    if (!present) {
      if (definition.required) fail(`properties.${property}`, "Required property is missing");
      continue;
    }
    properties[property] = normalizeProperty(definition, input.properties[property], `properties.${property}`);
  }

  const encodedSize = new TextEncoder().encode(JSON.stringify(properties)).byteLength;
  if (encodedSize > 256 * 1024) fail("properties", "Serialized properties exceed 256 KiB");

  if (input.kind === "node") {
    if (input.source !== undefined || input.target !== undefined) fail("instance", "Node instances cannot define endpoints");
    return { ...key, kind: "node", viewExternalId: view.externalId, properties };
  }
  if (input.source === undefined || input.target === undefined) fail("instance", "Edge instances require source and target");
  return {
    ...key,
    kind: "edge",
    viewExternalId: view.externalId,
    source: normalizeKey(input.source, "source"),
    target: normalizeKey(input.target, "target"),
    properties,
  };
}

interface FilterBudget {
  leaves: number;
}

function normalizeFilter(
  view: ModelViewDefinition,
  input: ModelFilter,
  depth: number,
  budget: FilterBudget,
): ModelFilter {
  if (depth > 5) fail("filter", "Filter depth exceeds 5");
  if (!isRecord(input)) fail("filter", "Expected a filter object");
  const keys = Object.keys(input);
  if (keys.length !== 1) fail("filter", "Use exactly one filter operator");
  const operator = keys[0];
  if (operator === "and" || operator === "or") {
    const children = operator === "and"
      ? (input as { and: ModelFilter[] }).and
      : (input as { or: ModelFilter[] }).or;
    if (!Array.isArray(children) || children.length === 0) fail(`filter.${operator}`, "Expected a non-empty array");
    return { [operator]: children.map((child) => normalizeFilter(view, child, depth + 1, budget)) } as ModelFilter;
  }
  if (operator === "not") {
    return { not: normalizeFilter(view, (input as { not: ModelFilter }).not, depth + 1, budget) };
  }

  budget.leaves += 1;
  if (budget.leaves > 20) fail("filter", "Filter exceeds 20 leaves");
  if (operator === "equals") {
    const clause = (input as { equals: unknown }).equals;
    if (!isRecord(clause)) fail("filter.equals", "Expected an object");
    const property = identifier(clause.property, "filter.equals.property");
    const definition = normalizedDefinition(view, property, "filter.equals.property");
    return { equals: { property, value: normalizeProperty(definition, clause.value, "filter.equals.value") } };
  }
  if (operator === "in") {
    const clause = (input as { in: unknown }).in;
    if (!isRecord(clause)) fail("filter.in", "Expected an object");
    const property = identifier(clause.property, "filter.in.property");
    const definition = normalizedDefinition(view, property, "filter.in.property");
    if (!Array.isArray(clause.values) || clause.values.length < 1 || clause.values.length > 100) {
      fail("filter.in.values", "Use 1-100 values");
    }
    return { in: { property, values: clause.values.map((value, index) => normalizeProperty(definition, value, `filter.in.values.${index}`)) } };
  }
  if (operator === "exists") {
    const clause = (input as { exists: unknown }).exists;
    if (!isRecord(clause)) fail("filter.exists", "Expected an object");
    const property = identifier(clause.property, "filter.exists.property");
    normalizedDefinition(view, property, "filter.exists.property");
    return { exists: { property } };
  }
  if (operator === "range") {
    const clause = (input as { range: unknown }).range;
    if (!isRecord(clause)) fail("filter.range", "Expected an object");
    const property = identifier(clause.property, "filter.range.property");
    const definition = normalizedDefinition(view, property, "filter.range.property");
    if (definition.list || !new Set<ModelPropertyType>(["text", "int64", "float64", "timestamp", "date"]).has(definition.type)) {
      fail("filter.range.property", "Range requires a comparable scalar property");
    }
    const result: { property: string; gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown } = { property };
    let operands = 0;
    for (const bound of ["gt", "gte", "lt", "lte"] as const) {
      if (clause[bound] !== undefined) {
        result[bound] = normalizeProperty(definition, clause[bound], `filter.range.${bound}`);
        operands += 1;
      }
    }
    if (operands === 0) fail("filter.range", "Provide at least one range bound");
    return { range: result };
  }
  return fail("filter", `Unknown filter operator '${operator}'`);
}

function boundedInteger(value: unknown, path: string, defaultValue: number, maximum: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    fail(path, `Expected an integer from 1 to ${maximum}`);
  }
  return value;
}

export function normalizeInstanceQuery(
  viewInput: ModelViewDefinition,
  input: InstanceQueryRequest,
): InstanceQueryRequest {
  const view = normalizeModelView(viewInput);
  if (input.viewExternalId !== view.externalId) fail("viewExternalId", `Expected '${view.externalId}'`);
  const result: InstanceQueryRequest = {
    viewExternalId: view.externalId,
    limit: boundedInteger(input.limit, "limit", 50, 200),
  };
  if (input.projection !== undefined) {
    if (!Array.isArray(input.projection) || input.projection.length > 50) fail("projection", "Use at most 50 properties");
    result.projection = input.projection.map((property, index) => {
      const normalized = identifier(property, `projection.${index}`);
      normalizedDefinition(view, normalized, `projection.${index}`);
      return normalized;
    });
  }
  if (input.filter !== undefined) result.filter = normalizeFilter(view, input.filter, 1, { leaves: 0 });
  if (input.sort !== undefined) {
    const property = identifier(input.sort.property, "sort.property");
    const definition = normalizedDefinition(view, property, "sort.property");
    if (definition.list || definition.type === "json" || definition.type === "direct") {
      fail("sort.property", "Sort requires a scalar property");
    }
    result.sort = { property, direction: input.sort.direction ?? "asc" };
  }
  if (input.cursor !== undefined) result.cursor = input.cursor;
  return result;
}

export function normalizeInstanceAggregate(
  viewInput: ModelViewDefinition,
  input: InstanceAggregateRequest,
): InstanceAggregateRequest {
  const view = normalizeModelView(viewInput);
  if (input.viewExternalId !== view.externalId) fail("viewExternalId", `Expected '${view.externalId}'`);
  if (!Array.isArray(input.metrics) || input.metrics.length < 1 || input.metrics.length > 10) {
    fail("metrics", "Use 1-10 metrics");
  }
  const result: InstanceAggregateRequest = {
    viewExternalId: view.externalId,
    metrics: input.metrics.map((metric, index) => {
      const metricName = identifier(metric.name, `metrics.${index}.name`);
      if (metric.operation === "count") {
        if (metric.property === undefined) return { name: metricName, operation: "count" };
        const property = identifier(metric.property, `metrics.${index}.property`);
        normalizedDefinition(view, property, `metrics.${index}.property`);
        return { name: metricName, operation: "count", property };
      }
      if (!new Set(["min", "max", "sum", "avg"]).has(metric.operation) || metric.property === undefined) {
        fail(`metrics.${index}`, "Numeric metrics require an operation and property");
      }
      const property = identifier(metric.property, `metrics.${index}.property`);
      const definition = normalizedDefinition(view, property, `metrics.${index}.property`);
      if (definition.list || (definition.type !== "int64" && definition.type !== "float64")) {
        fail(`metrics.${index}.property`, "Metric requires a numeric scalar property");
      }
      return { name: metricName, operation: metric.operation, property };
    }),
    limit: boundedInteger(input.limit, "limit", 200, 200),
  };
  if (input.filter !== undefined) result.filter = normalizeFilter(view, input.filter, 1, { leaves: 0 });
  if (input.groupBy !== undefined) {
    if (!Array.isArray(input.groupBy) || input.groupBy.length > 3) fail("groupBy", "Use at most 3 properties");
    result.groupBy = input.groupBy.map((property, index) => {
      const normalized = identifier(property, `groupBy.${index}`);
      const definition = normalizedDefinition(view, normalized, `groupBy.${index}`);
      if (definition.list || definition.type === "json" || definition.type === "direct") {
        fail(`groupBy.${index}`, "Group-by requires a scalar property");
      }
      return normalized;
    });
  }
  return result;
}

function canonicalValue(value: unknown, path: string): unknown {
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}.${index}`));
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key], `${path}.${key}`)]));
  }
  return normalizeJsonValue(value, path);
}

export function canonicalModelGraphJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, "value"));
}
