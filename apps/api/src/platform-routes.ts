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
  projectCreateSchema,
  qualityRuleCreateSchema,
  sourceCreateSchema,
  tenantCreateSchema,
  type PlatformContext,
} from './platform-schemas.js';
import { PlatformCatalog, type PlatformProjectRole } from './platform.js';
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

function requestContext(request: Request): PlatformContext {
  return parse(platformContextSchema, {
    tenantId: request.header('x-odf-tenant-id'),
    projectId: request.header('x-odf-project-id'),
  });
}

async function requireProjectAccess(
  catalog: PlatformCatalog,
  identityProvider: IdentityProvider,
  request: Request,
  permission: DataPlanePermission,
  roles?: readonly PlatformProjectRole[],
) {
  const identity = await requirePermission(identityProvider, request, permission);
  const context = requestContext(request);
  const role = catalog.assertProjectAccess(context, identity.userId, roles);
  return { identity, context, role };
}

const writeRoles: readonly PlatformProjectRole[] = ['owner', 'editor'];
const reviewRoles: readonly PlatformProjectRole[] = ['owner', 'editor', 'reviewer'];

export function registerPlatformRoutes(app: Express, catalog: PlatformCatalog, identityProvider: IdentityProvider): void {
  app.get('/api/v1/platform/tenants', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    const query = parse(cursorListQuerySchema, request.query);
    response.json(catalog.listTenants(identity.userId, identity.permissions.has('platform:admin'), query));
  });

  app.post('/api/v1/platform/tenants', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    const input = parse(tenantCreateSchema, request.body);
    response.status(201).json(catalog.createTenant(input, identity.userId, response.locals.correlationId));
  });

  app.get('/api/v1/platform/tenants/:tenantId/projects', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const query = parse(cursorListQuerySchema, request.query);
    response.json(catalog.listProjects(tenantId, identity.userId, identity.permissions.has('platform:admin'), query));
  });

  app.post('/api/v1/platform/tenants/:tenantId/projects', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const input = parse(projectCreateSchema, request.body);
    response.status(201).json(catalog.createProject(tenantId, input, identity.userId, response.locals.correlationId));
  });

  app.get('/api/v1/platform/datasets', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listDatasets(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/datasets', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createDataset(context, parse(datasetCreateSchema, request.body), identity.userId, response.locals.correlationId));
  });

  app.get('/api/v1/platform/sources', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listSources(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/sources', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createSource(context, parse(sourceCreateSchema, request.body), identity.userId, response.locals.correlationId));
  });

  app.get('/api/v1/platform/connectors', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listConnectors(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/connectors', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createConnector(context, parse(connectorCreateSchema, request.body), identity.userId, response.locals.correlationId));
  });

  app.get('/api/v1/platform/data-models', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listDataModels(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/data-models/:modelId/versions', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    const modelId = parse(platformIdSchema, request.params.modelId);
    response.status(201).json(catalog.createDataModelVersion(context, modelId, parse(dataModelVersionCreateSchema, request.body), identity.userId, response.locals.correlationId));
  });

  app.get('/api/v1/platform/pipelines', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listPipelines(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/pipelines', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createPipeline(context, parse(pipelineCreateSchema, request.body), identity.userId, response.locals.correlationId));
  });
  app.post('/api/v1/platform/pipelines/:pipelineId/runs', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    const pipelineId = parse(platformIdSchema, request.params.pipelineId);
    const run = catalog.triggerPipelineRun(context, pipelineId, parse(pipelineRunTriggerSchema, request.body), identity.userId, response.locals.correlationId);
    response.status(run.replayed === true ? 200 : 201).json(run);
  });
  app.get('/api/v1/platform/pipeline-runs', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listPipelineRuns(context, parse(cursorListQuerySchema, request.query)));
  });

  app.get('/api/v1/platform/quality-rules', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listQualityRules(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/quality-rules', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createQualityRule(context, parse(qualityRuleCreateSchema, request.body), identity.userId, response.locals.correlationId));
  });
  app.get('/api/v1/platform/quality-results', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listQualityResults(context, parse(cursorListQuerySchema, request.query)));
  });

  app.get('/api/v1/platform/contextualization/candidates', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.listCandidates(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/contextualization/candidates', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createCandidate(context, parse(candidateCreateSchema, request.body), identity.userId, response.locals.correlationId));
  });
  app.post('/api/v1/platform/contextualization/candidates/:candidateId/review', async (request, response) => {
    const { context, identity } = await requireProjectAccess(catalog, identityProvider, request, 'relations:review', reviewRoles);
    const candidateId = parse(platformIdSchema, request.params.candidateId);
    response.json(catalog.reviewCandidate(context, candidateId, parse(candidateReviewSchema, request.body), identity.userId, response.locals.correlationId));
  });

  app.get('/api/v1/platform/search', async (request, response) => {
    const { context } = await requireProjectAccess(catalog, identityProvider, request, 'data:read');
    response.json(catalog.search(context, parse(platformSearchQuerySchema, request.query)));
  });
}
