import { z } from "zod";
import { platformIdSchema } from "./platform-schemas.js";

const nameSchema = z.string().trim().min(1).max(255);
const jsonObjectSchema = z.record(z.unknown());
const propertyNameSchema = platformIdSchema;

const modelPropertyDefinitionSchema = z.object({
  type: z.enum(["text", "int64", "float64", "boolean", "timestamp", "date", "json", "direct"]),
  required: z.boolean().optional(),
  nullable: z.boolean().optional(),
  list: z.boolean().optional(),
}).strict();

export const modelViewDefinitionSchema = z.object({
  externalId: platformIdSchema,
  name: nameSchema,
  usedFor: z.enum(["node", "edge"]),
  properties: z.record(propertyNameSchema, modelPropertyDefinitionSchema)
    .refine((value) => Object.keys(value).length <= 200, "Use at most 200 properties"),
}).strict();

export const createModelVersionSchema = z.object({
  name: nameSchema,
  schema: jsonObjectSchema,
  status: z.enum(["draft", "published"]).optional(),
  views: z.array(modelViewDefinitionSchema).max(100).optional(),
}).strict();

export const modelVersionPathSchema = z.object({
  modelId: platformIdSchema,
  version: z.coerce.number().int().positive(),
}).strict();

const instanceKeySchema = z.object({
  space: platformIdSchema,
  externalId: platformIdSchema,
}).strict();

const instanceUpsertItemSchema = z.object({
  space: platformIdSchema,
  externalId: platformIdSchema,
  kind: z.enum(["node", "edge"]),
  viewExternalId: platformIdSchema,
  source: instanceKeySchema.optional(),
  target: instanceKeySchema.optional(),
  properties: jsonObjectSchema,
}).strict();

export const instanceUpsertSchema = z.object({
  idempotencyKey: platformIdSchema,
  instances: z.array(instanceUpsertItemSchema).min(1).max(100),
}).strict();

const equalsFilterSchema = z.object({
  equals: z.object({ property: propertyNameSchema, value: z.unknown() }).strict(),
}).strict();
const inFilterSchema = z.object({
  in: z.object({ property: propertyNameSchema, values: z.array(z.unknown()).min(1).max(100) }).strict(),
}).strict();
const rangeFilterSchema = z.object({
  range: z.object({
    property: propertyNameSchema,
    gt: z.unknown().optional(),
    gte: z.unknown().optional(),
    lt: z.unknown().optional(),
    lte: z.unknown().optional(),
  }).strict().refine(
    (value) => value.gt !== undefined || value.gte !== undefined || value.lt !== undefined || value.lte !== undefined,
    "Provide at least one range bound",
  ),
}).strict();
const existsFilterSchema = z.object({
  exists: z.object({ property: propertyNameSchema }).strict(),
}).strict();

export const modelFilterSchema: z.ZodType = z.lazy(() => z.union([
  equalsFilterSchema,
  inFilterSchema,
  rangeFilterSchema,
  existsFilterSchema,
  z.object({ and: z.array(modelFilterSchema).min(1).max(20) }).strict(),
  z.object({ or: z.array(modelFilterSchema).min(1).max(20) }).strict(),
  z.object({ not: modelFilterSchema }).strict(),
]));

export const instanceQuerySchema = z.object({
  viewExternalId: platformIdSchema,
  projection: z.array(propertyNameSchema).max(50).optional(),
  filter: modelFilterSchema.optional(),
  sort: z.object({
    property: propertyNameSchema,
    direction: z.enum(["asc", "desc"]).optional(),
  }).strict().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict();

export const instanceTraverseSchema = z.object({
  starts: z.array(instanceKeySchema).min(1).max(20),
  direction: z.enum(["in", "out", "both"]),
  edgeViewExternalId: platformIdSchema.optional(),
  maxHops: z.number().int().min(1).max(3).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

const aggregateMetricSchema = z.object({
  name: platformIdSchema,
  operation: z.enum(["count", "min", "max", "sum", "avg"]),
  property: propertyNameSchema.optional(),
}).strict();

export const instanceAggregateSchema = z.object({
  viewExternalId: platformIdSchema,
  filter: modelFilterSchema.optional(),
  groupBy: z.array(propertyNameSchema).max(3).optional(),
  metrics: z.array(aggregateMetricSchema).min(1).max(10),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const emptyBodySchema = z.object({}).strict();
