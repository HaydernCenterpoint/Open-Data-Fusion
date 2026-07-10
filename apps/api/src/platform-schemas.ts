import { z } from 'zod';

export const platformIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Use letters, numbers, dots, colons, slashes, underscores, or dashes');

const nameSchema = z.string().trim().min(1).max(255);
const descriptionSchema = z.string().trim().max(4_000).nullable().optional();
const jsonObjectSchema = z.record(z.unknown());

export const platformContextSchema = z.object({
  tenantId: platformIdSchema,
  projectId: platformIdSchema,
});

export const cursorListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(2_048).optional(),
});

export const tenantCreateSchema = z.object({ id: platformIdSchema, name: nameSchema }).strict();
export const projectCreateSchema = z.object({ id: platformIdSchema, name: nameSchema, description: descriptionSchema }).strict();
export const datasetCreateSchema = z.object({ id: platformIdSchema, name: nameSchema, description: descriptionSchema }).strict();
export const sourceCreateSchema = z.object({
  id: platformIdSchema,
  name: nameSchema,
  type: z.string().trim().min(1).max(100),
  description: descriptionSchema,
}).strict();

function hasSensitiveConfigurationKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasSensitiveConfigurationKey);
  return Object.entries(value).some(([key, nested]) => {
    const isReference = /(?:ref|reference)$/i.test(key);
    return (!isReference && /password|secret|token|api[-_]?key|private[-_]?key/i.test(key)) || hasSensitiveConfigurationKey(nested);
  });
}

export const connectorCreateSchema = z.object({
  id: platformIdSchema,
  name: nameSchema,
  sourceId: platformIdSchema,
  type: z.string().trim().min(1).max(100),
  configuration: jsonObjectSchema.default({}),
  enabled: z.boolean().default(true),
}).strict().superRefine((connector, context) => {
  if (hasSensitiveConfigurationKey(connector.configuration)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['configuration'],
      message: 'Connector configuration must use secret references instead of inline credentials',
    });
  }
});

export const dataModelVersionCreateSchema = z.object({
  name: nameSchema,
  schema: jsonObjectSchema,
  status: z.enum(['draft', 'published']).default('draft'),
}).strict();

export const pipelineCreateSchema = z.object({
  id: platformIdSchema,
  name: nameSchema,
  sourceId: platformIdSchema.nullable().optional(),
  datasetId: platformIdSchema.nullable().optional(),
  definition: jsonObjectSchema.default({}),
  enabled: z.boolean().default(true),
}).strict();

export const pipelineRunTriggerSchema = z.object({
  idempotencyKey: platformIdSchema,
  input: jsonObjectSchema.default({}),
}).strict();

const qualityCheckSchema = z.discriminatedUnion('operator', [
  z.object({ operator: z.literal('required'), field: z.string().trim().min(1).max(255) }).strict(),
  z.object({ operator: z.literal('equals'), field: z.string().trim().min(1).max(255), value: z.unknown() }).strict(),
  z.object({ operator: z.literal('gte'), field: z.string().trim().min(1).max(255), value: z.number().finite() }).strict(),
  z.object({ operator: z.literal('lte'), field: z.string().trim().min(1).max(255), value: z.number().finite() }).strict(),
]);

export const qualityRuleCreateSchema = z.object({
  id: platformIdSchema,
  name: nameSchema,
  targetType: z.string().trim().min(1).max(100).default('pipeline'),
  check: qualityCheckSchema,
  severity: z.enum(['info', 'warning', 'error']).default('error'),
  enabled: z.boolean().default(true),
}).strict();

const candidateEndpointSchema = z.object({
  type: z.string().trim().min(1).max(100),
  id: platformIdSchema,
}).strict();

export const candidateCreateSchema = z.object({
  id: platformIdSchema.optional(),
  source: candidateEndpointSchema,
  target: candidateEndpointSchema,
  relationType: z.string().trim().min(1).max(100),
  confidence: z.number().min(0).max(1),
  evidence: jsonObjectSchema.default({}),
}).strict();

export const candidateReviewSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  comment: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export const platformSearchQuerySchema = cursorListQuerySchema.extend({
  q: z.string().trim().min(1).max(200),
  entityType: z.string().trim().min(1).max(100).optional(),
});

export type PlatformContext = z.infer<typeof platformContextSchema>;
export type CursorListQuery = z.infer<typeof cursorListQuerySchema>;
export type TenantCreate = z.infer<typeof tenantCreateSchema>;
export type ProjectCreate = z.infer<typeof projectCreateSchema>;
export type DatasetCreate = z.infer<typeof datasetCreateSchema>;
export type SourceCreate = z.infer<typeof sourceCreateSchema>;
export type ConnectorCreate = z.infer<typeof connectorCreateSchema>;
export type DataModelVersionCreate = z.infer<typeof dataModelVersionCreateSchema>;
export type PipelineCreate = z.infer<typeof pipelineCreateSchema>;
export type PipelineRunTrigger = z.infer<typeof pipelineRunTriggerSchema>;
export type QualityRuleCreate = z.infer<typeof qualityRuleCreateSchema>;
export type CandidateCreate = z.infer<typeof candidateCreateSchema>;
export type CandidateReview = z.infer<typeof candidateReviewSchema>;
export type PlatformSearchQuery = z.infer<typeof platformSearchQuerySchema>;
