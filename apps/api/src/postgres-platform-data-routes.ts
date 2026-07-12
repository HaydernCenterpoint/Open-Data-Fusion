import type { Express, Request } from 'express';
import { z } from 'zod';

import type { DataPlanePermission, IdentityProvider } from './auth.js';
import { ForbiddenError } from './database.js';
import {
  candidateCreateSchema,
  candidateReviewSchema,
  connectorCreateSchema,
  cursorListQuerySchema,
  dataModelVersionCreateSchema,
  datasetCreateSchema,
  pipelineCreateSchema,
  pipelineRunTriggerSchema,
  platformContextSchema,
  platformIdSchema,
  platformSearchQuerySchema,
  qualityRuleCreateSchema,
  sourceCreateSchema,
} from './platform-schemas.js';
import {
  diagramExtractionCreateSchema,
  matchingEvaluationCreateSchema,
  spatialLinkCreateSchema,
  spatialLinkReviewSchema,
} from './advanced-platform-schemas.js';
import type { PostgresPlatformDataPersistence } from './postgres-platform-data.js';
import { workspaceUserIdSchema } from './schemas.js';

function parse<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.output<TSchema> {
  return schema.parse(value) as z.output<TSchema>;
}

async function requirePermission(identityProvider: IdentityProvider, request: Request, permission: DataPlanePermission) {
  const identity = await identityProvider.authenticate(request);
  const userId = parse(workspaceUserIdSchema, identity.userId);
  if (!identity.permissions.has(permission)) throw new ForbiddenError(`Permission '${permission}' is required`);
  return { ...identity, userId };
}

function context(request: Request) {
  return parse(platformContextSchema, {
    tenantId: request.header('x-odf-tenant-id'),
    projectId: request.header('x-odf-project-id'),
  });
}

const diagrams = ['/api/v1/platform/diagrams/tag-extractions', '/api/v1/platform/diagram-extractions'];
const matching = ['/api/v1/platform/matching/evaluations', '/api/v1/platform/matching-evaluations'];
const spatial = ['/api/v1/platform/spatial/asset-links', '/api/v1/platform/spatial-links'];

/**
 * Register before the legacy SQLite route modules. In PostgreSQL mode every
 * route here is authoritative; explicitly blocked paths prevent a request
 * from falling through to a replica-local SQLite store.
 */
export function registerPostgresPlatformDataRoutes(
  app: Express,
  persistence: PostgresPlatformDataPersistence,
  identityProvider: IdentityProvider,
): void {
  app.get('/api/v1/platform/datasets', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listDatasets(context(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/datasets', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createDataset(context(request), identity.userId, parse(datasetCreateSchema, request.body), response.locals.correlationId));
  });

  app.get('/api/v1/platform/sources', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listSources(context(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/sources', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createSource(context(request), identity.userId, parse(sourceCreateSchema, request.body), response.locals.correlationId));
  });

  app.get('/api/v1/platform/connectors', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listConnectors(context(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/connectors', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createConnector(context(request), identity.userId, parse(connectorCreateSchema, request.body), response.locals.correlationId));
  });

  app.get(diagrams, async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listDiagramExtractions(context(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post(diagrams, async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createDiagramExtraction(context(request), identity.userId, parse(diagramExtractionCreateSchema, request.body), response.locals.correlationId));
  });

  app.get(matching, async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listMatchingEvaluations(context(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post(matching, async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createMatchingEvaluation(context(request), identity.userId, parse(matchingEvaluationCreateSchema, request.body), response.locals.correlationId));
  });

  app.get(spatial, async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listSpatialLinks(context(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post(spatial, async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createSpatialLink(context(request), identity.userId, parse(spatialLinkCreateSchema, request.body), response.locals.correlationId));
  });
  app.post(['/api/v1/platform/spatial/asset-links/:linkId/review', '/api/v1/platform/spatial-links/:linkId/review'], async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'relations:review');
    response.json(await persistence.reviewSpatialLink(context(request), identity.userId, parse(platformIdSchema, request.params.linkId), parse(spatialLinkReviewSchema, request.body), response.locals.correlationId));
  });

  app.get('/api/v1/platform/search', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.search(context(request), identity.userId, parse(platformSearchQuerySchema, request.query)));
  });

  // These legacy API contracts have no one-to-one mapping to the normalized
  // PostgreSQL data plane yet. Block them here so PostgreSQL never silently
  // falls back to a local SQLite metadata store.
  const unsupported = (label: string) => () => {
    throw new ForbiddenError(`${label} is not enabled for PostgreSQL platform persistence`);
  };
  app.use('/api/v1/platform/data-models', unsupported('Data-model compatibility routes'));
  app.use('/api/v1/platform/pipelines', unsupported('Pipeline compatibility routes'));
  app.use('/api/v1/platform/pipeline-runs', unsupported('Pipeline-run compatibility routes'));
  app.use('/api/v1/platform/quality-rules', unsupported('Quality-rule compatibility routes'));
  app.use('/api/v1/platform/quality-results', unsupported('Quality-result compatibility routes'));
  app.use('/api/v1/platform/contextualization', unsupported('Contextualization compatibility routes'));
  app.use('/api/v1/platform/writeback', unsupported('Write-back compatibility routes'));

  // Keep these schemas imported and compiled here: callers get the same input
  // validation surface once their normalized adapters are added, rather than a
  // hidden SQLite fallback in a PostgreSQL process.
  void dataModelVersionCreateSchema;
  void pipelineCreateSchema;
  void pipelineRunTriggerSchema;
  void qualityRuleCreateSchema;
  void candidateCreateSchema;
  void candidateReviewSchema;
}
