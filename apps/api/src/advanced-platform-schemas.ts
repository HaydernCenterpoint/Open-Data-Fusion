import { z } from 'zod';

import { platformIdSchema } from './platform-schemas.js';

const nonEmptyEvidenceSchema = z.union([
  z.array(z.unknown()).min(1),
  z.record(z.unknown()).refine((value) => Object.keys(value).length > 0, 'Dry-run evidence must not be empty'),
]);

export const diagramExtractionCreateSchema = z.object({
  id: platformIdSchema.optional(),
  documentExternalId: platformIdSchema,
  text: z.string().min(1).max(1_000_000),
  page: z.number().int().positive().max(100_000).optional(),
}).strict();

const matchPredictionSchema = z.object({
  sourceExternalId: platformIdSchema,
  targetExternalId: platformIdSchema,
  score: z.number().finite().min(0).max(1),
}).strict();

const matchGroundTruthSchema = z.object({
  sourceExternalId: platformIdSchema,
  targetExternalId: platformIdSchema,
  accepted: z.boolean(),
}).strict();

export const matchingEvaluationCreateSchema = z.object({
  id: platformIdSchema.optional(),
  threshold: z.number().finite().min(0).max(1),
  predictions: z.array(matchPredictionSchema).max(10_000),
  truth: z.array(matchGroundTruthSchema).max(10_000),
}).strict();

export const spatialLinkCreateSchema = z.object({
  id: platformIdSchema.optional(),
  assetExternalId: platformIdSchema,
  sceneExternalId: platformIdSchema,
  nodeExternalId: platformIdSchema,
  transform: z.array(z.number().finite()).length(16),
  confidence: z.number().finite().min(0).max(1),
}).strict().superRefine((input, context) => {
  if (Math.abs(input.transform[15] ?? 0) < Number.EPSILON) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['transform', 15],
      message: 'A spatial transform must have a non-zero homogeneous scale',
    });
  }
});

export const spatialLinkReviewSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  comment: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export const writebackRequestCreateSchema = z.object({
  id: platformIdSchema.optional(),
  sourceId: platformIdSchema,
  targetExternalId: platformIdSchema,
  operation: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  payload: z.record(z.unknown()),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  dryRunResult: z.object({
    safe: z.boolean(),
    evidence: nonEmptyEvidenceSchema,
    performedAt: z.string().datetime({ offset: true }).optional(),
    summary: z.string().trim().max(4_000).optional(),
  }).passthrough(),
}).strict();

export const writebackApprovalCreateSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().trim().max(2_000).nullable().optional(),
}).strict();

export const writebackExecuteSchema = z.object({}).strict().default({});

export const projectMemberUpsertSchema = z.object({
  role: z.enum(['owner', 'editor', 'reviewer', 'viewer']),
}).strict();

export type DiagramExtractionCreate = z.infer<typeof diagramExtractionCreateSchema>;
export type MatchingEvaluationCreate = z.infer<typeof matchingEvaluationCreateSchema>;
export type SpatialLinkCreate = z.infer<typeof spatialLinkCreateSchema>;
export type SpatialLinkReview = z.infer<typeof spatialLinkReviewSchema>;
export type WritebackRequestCreate = z.infer<typeof writebackRequestCreateSchema>;
export type WritebackApprovalCreate = z.infer<typeof writebackApprovalCreateSchema>;
export type ProjectMemberUpsert = z.infer<typeof projectMemberUpsertSchema>;
