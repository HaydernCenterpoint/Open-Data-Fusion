import type { Express, Request } from 'express';
import { z } from 'zod';

import type { DataPlanePermission, IdentityProvider } from './auth.js';
import { ForbiddenError } from './database.js';
import type { PlatformDiscoveryPersistence } from './platform-discovery.js';
import type { PlatformAdministrationPersistence } from './platform-administration.js';
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
  projectUpdateSchema,
  qualityRuleCreateSchema,
  sourceCreateSchema,
  tenantCreateSchema,
  tenantMemberUpsertSchema,
  tenantUpdateSchema,
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

export function registerPlatformRoutes(
  app: Express,
  catalog: PlatformCatalog,
  identityProvider: IdentityProvider,
  discovery: PlatformDiscoveryPersistence,
  administration?: PlatformAdministrationPersistence,
  postgresMode = discovery.mode === 'postgres',
): void {
  app.get('/api/v1/platform/tenants', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    const query = parse(cursorListQuerySchema, request.query);
    response.json(await discovery.listTenants(identity.userId, identity.permissions.has('platform:admin'), query));
  });

  app.post('/api/v1/platform/tenants', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    if (postgresMode) {
      throw new ForbiddenError('Tenant creation is an operational PostgreSQL provisioning workflow');
    }
    const input = parse(tenantCreateSchema, request.body);
    response.status(201).json(catalog.createTenant(input, identity.userId, response.locals.correlationId));
  });

  app.patch('/api/v1/platform/tenants/:tenantId', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    if (!administration) {
      throw new ForbiddenError('Tenant administration is not configured for this persistence profile');
    }
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const input = parse(tenantUpdateSchema, request.body);
    response.json(await administration.updateTenant(tenantId, identity.userId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      correlationId: response.locals.correlationId,
    }));
  });

  app.get('/api/v1/platform/tenants/:tenantId/projects', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const query = parse(cursorListQuerySchema, request.query);
    response.json(await discovery.listProjects(tenantId, identity.userId, identity.permissions.has('platform:admin'), query));
  });

  app.post('/api/v1/platform/tenants/:tenantId/projects', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const input = parse(projectCreateSchema, request.body);
    if (administration) {
      const project = await administration.createProject(tenantId, identity.userId, {
        projectId: input.id,
        slug: input.slug ?? input.id.toLowerCase(),
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        correlationId: response.locals.correlationId,
      });
      response.status(project.created ? 201 : 200).json(project);
      return;
    }
    if (postgresMode) {
      throw new ForbiddenError('Project creation is an operational PostgreSQL provisioning workflow');
    }
    response.status(201).json(catalog.createProject(tenantId, input, identity.userId, response.locals.correlationId));
  });

  app.patch('/api/v1/platform/tenants/:tenantId/projects/:projectId', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    if (!administration) {
      throw new ForbiddenError('Project administration is not configured for this persistence profile');
    }
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const projectId = parse(platformIdSchema, request.params.projectId);
    const input = parse(projectUpdateSchema, request.body);
    response.json(await administration.updateProject(tenantId, projectId, identity.userId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      correlationId: response.locals.correlationId,
    }));
  });

  app.get('/api/v1/platform/tenants/:tenantId/members', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    if (!administration) {
      throw new ForbiddenError('Tenant administration is not configured for this persistence profile');
    }
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    response.json(await administration.listTenantMembers(
      tenantId,
      identity.userId,
      parse(cursorListQuerySchema, request.query),
    ));
  });

  app.put('/api/v1/platform/tenants/:tenantId/members/:userId', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    if (!administration) {
      throw new ForbiddenError('Tenant administration is not configured for this persistence profile');
    }
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const userId = parse(workspaceUserIdSchema, request.params.userId);
    const input = parse(tenantMemberUpsertSchema, request.body);
    const result = await administration.upsertTenantMember(
      tenantId,
      identity.userId,
      userId,
      input.role,
      response.locals.correlationId,
    );
    response.status(result.created ? 201 : 200).json(result.member);
  });

  app.delete('/api/v1/platform/tenants/:tenantId/members/:userId', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'platform:admin');
    if (!administration) {
      throw new ForbiddenError('Tenant administration is not configured for this persistence profile');
    }
    const tenantId = parse(platformIdSchema, request.params.tenantId);
    const userId = parse(workspaceUserIdSchema, request.params.userId);
    await administration.removeTenantMember(tenantId, identity.userId, userId, response.locals.correlationId);
    response.status(204).end();
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
