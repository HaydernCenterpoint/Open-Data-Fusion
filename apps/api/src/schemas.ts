import { z } from 'zod';

const externalId = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Use letters, numbers, dots, colons, slashes, underscores, or dashes');

const metadata = z.record(z.unknown()).default({});

const timestamp = z.union([z.number().finite(), z.string().trim().min(1)]).transform((value, context) => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || Math.abs(parsed) > 8_640_000_000_000_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an ISO-8601 date or integer epoch milliseconds in the JavaScript Date range' });
    return z.NEVER;
  }
  return parsed;
});

export const assetListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const telemetryQuerySchema = z
  .object({
    from: timestamp.optional(),
    to: timestamp.optional(),
    timeSeriesExternalId: externalId.optional(),
    limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
  })
  .refine(({ from, to }) => from === undefined || to === undefined || from <= to, {
    message: '`from` must be before or equal to `to`',
  });

export const telemetryLatestQuerySchema = z.object({
  timeSeriesExternalId: externalId.optional(),
  at: timestamp.optional(),
});

export const telemetryAggregateQuerySchema = z
  .object({
    from: timestamp.optional(),
    to: timestamp.optional(),
    timeSeriesExternalId: externalId.optional(),
    bucketMs: z.coerce.number().int().min(1_000).max(30 * 24 * 60 * 60 * 1_000),
    aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count']).default('avg'),
    limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
  })
  .refine(({ from, to }) => from === undefined || to === undefined || from <= to, {
    message: '`from` must be before or equal to `to`',
  });

export const auditListQuerySchema = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  entityType: z.string().trim().min(1).max(100).optional(),
  entityId: z.string().trim().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const workspaceIdSchema = externalId;

export const canvasPositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const canvasNodeSchema = z.object({
  id: externalId,
  type: z.string().trim().min(1).max(100),
  position: canvasPositionSchema,
  data: z.record(z.unknown()).default({}),
});

export const canvasEdgeSchema = z.object({
  id: externalId,
  source: externalId,
  target: externalId,
  type: z.string().trim().min(1).max(100).default('relation'),
  data: z.record(z.unknown()).default({}),
});

export const workspaceSnapshotSchema = z.object({
  viewport: z.object({
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
    zoom: z.number().finite().min(0.1).max(4).default(1),
  }).default({ x: 0, y: 0, zoom: 1 }),
  nodes: z.array(canvasNodeSchema).max(10_000),
  edges: z.array(canvasEdgeSchema).max(20_000),
});

const workspaceActorSchema = z.string().trim().min(1).max(255);

export const workspaceUpdateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  actor: workspaceActorSchema,
  changeSummary: z.string().trim().min(1).max(1_000),
  snapshot: workspaceSnapshotSchema,
});

export const workspaceRollbackSchema = z.object({
  expectedVersion: z.number().int().min(1),
  targetVersion: z.number().int().min(1),
  actor: workspaceActorSchema,
  changeSummary: z.string().trim().max(1_000).optional(),
});

export const workspaceRevisionQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const workspaceUserIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\s\u0000-\u001F\u007F]+$/, 'User ID must not contain whitespace or control characters');

export const workspaceRoleSchema = z.enum(['owner', 'editor', 'reviewer', 'viewer']);

export const workspaceMemberUpsertSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), {
        message: 'Display name must not contain control characters',
      }),
    role: workspaceRoleSchema,
  })
  .strict();

const workspaceNodePatchSchema = z
  .object({
    type: z.string().trim().min(1).max(100).optional(),
    position: canvasPositionSchema.optional(),
    data: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Node patch must contain at least one field',
  });

const workspaceEdgePatchSchema = z
  .object({
    type: z.string().trim().min(1).max(100).optional(),
    data: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Edge patch must contain at least one field',
  });

export const workspaceOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('moveNode'),
    nodeId: externalId,
    position: canvasPositionSchema,
  }),
  z.object({
    type: z.literal('addNode'),
    node: canvasNodeSchema,
  }),
  z.object({
    type: z.literal('removeNode'),
    nodeId: externalId,
  }),
  z.object({
    type: z.literal('updateNode'),
    nodeId: externalId,
    patch: workspaceNodePatchSchema,
  }),
  z.object({
    type: z.literal('addEdge'),
    edge: canvasEdgeSchema,
  }),
  z.object({
    type: z.literal('removeEdge'),
    edgeId: externalId,
  }),
  z.object({
    type: z.literal('updateEdge'),
    edgeId: externalId,
    patch: workspaceEdgePatchSchema,
  }),
]);

export const workspaceOperationsSchema = z.object({
  baseVersion: z.number().int().min(1),
  changeSummary: z.string().trim().min(1).max(1_000),
  operations: z.array(workspaceOperationSchema).min(1).max(1_000),
});

const assetSchema = z.object({
  externalId,
  name: z.string().trim().min(1).max(255),
  type: z.string().trim().min(1).max(100),
  parentExternalId: externalId.nullable().optional(),
  description: z.string().trim().max(4_000).nullable().optional(),
  metadata: metadata.optional(),
});

const timeSeriesSchema = z.object({
  externalId,
  assetExternalId: externalId,
  name: z.string().trim().min(1).max(255),
  unit: z.string().trim().max(50).nullable().optional(),
  description: z.string().trim().max(4_000).nullable().optional(),
  metadata: metadata.optional(),
});

const dataPointSchema = z.object({
  timeSeriesExternalId: externalId,
  timestamp,
  value: z.number().finite(),
  quality: z.enum(['good', 'uncertain', 'bad']).default('good'),
});

const documentSchema = z.object({
  externalId,
  assetExternalId: externalId.nullable().optional(),
  title: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(100).nullable().optional(),
  uri: z.string().trim().max(2_000).nullable().optional(),
  metadata: metadata.optional(),
});

export const entityTypeSchema = z.enum(['asset', 'timeSeries', 'document']);

const relationSchema = z.object({
  id: externalId.optional(),
  sourceType: entityTypeSchema,
  sourceExternalId: externalId,
  targetType: entityTypeSchema,
  targetExternalId: externalId,
  relationType: z.string().trim().min(1).max(100),
  status: z.enum(['proposed', 'accepted']).default('proposed'),
  // Null/omitted input means "no score supplied" and is persisted as the
  // cross-backend default 0; relation responses therefore always expose 0..1.
  confidence: z.number().min(0).max(1).nullable().optional(),
  evidence: z.record(z.unknown()).default({}),
  ruleVersion: z.string().trim().max(100).nullable().optional(),
});

export const ingestBundleSchema = z
  .object({
    source: z.object({
      system: z.string().trim().min(1).max(100),
      runId: externalId.optional(),
      actor: z.string().trim().min(1).max(255).default('connector'),
    }),
    assets: z.array(assetSchema).max(10_000).default([]),
    timeSeries: z.array(timeSeriesSchema).max(10_000).default([]),
    dataPoints: z.array(dataPointSchema).max(100_000).default([]),
    documents: z.array(documentSchema).max(10_000).default([]),
    relations: z.array(relationSchema).max(20_000).default([]),
  })
  .superRefine((bundle, context) => {
    const recordCount =
      bundle.assets.length +
      bundle.timeSeries.length +
      bundle.dataPoints.length +
      bundle.documents.length +
      bundle.relations.length;
    if (recordCount === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'The bundle must contain at least one record' });
    }

    const entityTypes = new Map<string, { type: z.infer<typeof entityTypeSchema>; path: Array<string | number> }>();
    const definitions = new Set<string>();
    const register = (
      type: z.infer<typeof entityTypeSchema>,
      id: string | null | undefined,
      path: Array<string | number>,
      definition = false,
    ): void => {
      if (!id) return;
      const prior = entityTypes.get(id);
      if (prior && prior.type !== type) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `External ID '${id}' is already used as ${prior.type}; one model space uses a shared entity namespace`,
        });
      } else if (!prior) {
        entityTypes.set(id, { type, path });
      }
      if (definition) {
        const key = `${type}\u0000${id}`;
        if (definitions.has(key)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path, message: `Duplicate ${type} definition '${id}'` });
        }
        definitions.add(key);
      }
    };

    bundle.assets.forEach((asset, index) => {
      register('asset', asset.externalId, ['assets', index, 'externalId'], true);
      register('asset', asset.parentExternalId, ['assets', index, 'parentExternalId']);
    });
    bundle.timeSeries.forEach((series, index) => {
      register('timeSeries', series.externalId, ['timeSeries', index, 'externalId'], true);
      register('asset', series.assetExternalId, ['timeSeries', index, 'assetExternalId']);
    });
    const pointKeys = new Set<string>();
    bundle.dataPoints.forEach((point, index) => {
      register('timeSeries', point.timeSeriesExternalId, ['dataPoints', index, 'timeSeriesExternalId']);
      const key = `${point.timeSeriesExternalId}\u0000${String(point.timestamp)}`;
      if (pointKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dataPoints', index, 'timestamp'],
          message: `Duplicate observation for '${point.timeSeriesExternalId}' at the same timestamp`,
        });
      }
      pointKeys.add(key);
    });
    bundle.documents.forEach((document, index) => {
      register('document', document.externalId, ['documents', index, 'externalId'], true);
      register('asset', document.assetExternalId, ['documents', index, 'assetExternalId']);
    });
    const relationKeys = new Set<string>();
    bundle.relations.forEach((relation, index) => {
      register(relation.sourceType, relation.sourceExternalId, ['relations', index, 'sourceExternalId']);
      register(relation.targetType, relation.targetExternalId, ['relations', index, 'targetExternalId']);
      if (relation.sourceType === relation.targetType && relation.sourceExternalId === relation.targetExternalId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relations', index],
          message: 'Relation source and target must be different entities',
        });
      }
      const key = JSON.stringify([
        relation.sourceType,
        relation.sourceExternalId,
        relation.targetType,
        relation.targetExternalId,
        relation.relationType,
      ]);
      if (relationKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['relations', index],
          message: 'Duplicate semantic relation in one bundle',
        });
      }
      relationKeys.add(key);
    });
  });

export const relationReviewSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  reviewer: z.string().trim().min(1).max(255).optional().default('authenticated-user'),
  comment: z.string().trim().max(2_000).nullable().optional(),
});

export const workspaceCreateSchema = z.object({
  id: workspaceIdSchema,
  name: z.string().trim().min(1).max(256)
    .refine((value) => !/\p{Cc}/u.test(value), 'Workspace name must not contain control characters'),
});

export type AssetListQuery = z.infer<typeof assetListQuerySchema>;
export type TelemetryQuery = z.infer<typeof telemetryQuerySchema>;
export type TelemetryLatestQuery = z.infer<typeof telemetryLatestQuerySchema>;
export type TelemetryAggregateQuery = z.infer<typeof telemetryAggregateQuerySchema>;
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
export type IngestBundle = z.infer<typeof ingestBundleSchema>;
export type RelationReview = z.infer<typeof relationReviewSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type WorkspaceCreate = z.infer<typeof workspaceCreateSchema>;
export type WorkspaceUpdate = z.infer<typeof workspaceUpdateSchema>;
export type WorkspaceRollback = z.infer<typeof workspaceRollbackSchema>;
export type WorkspaceRevisionQuery = z.infer<typeof workspaceRevisionQuerySchema>;
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;
export type WorkspaceOperations = z.infer<typeof workspaceOperationsSchema>;
export type WorkspaceMemberUpsert = z.infer<typeof workspaceMemberUpsertSchema>;
