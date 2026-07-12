import type { Express, Request } from 'express';
import { z } from 'zod';

import {
  diagramExtractionCreateSchema,
  matchingEvaluationCreateSchema,
  projectMemberUpsertSchema,
  spatialLinkCreateSchema,
  spatialLinkReviewSchema,
  writebackApprovalCreateSchema,
  writebackExecuteSchema,
  writebackRequestCreateSchema,
} from './advanced-platform-schemas.js';
import {
  AdvancedPlatformCatalog,
  type IndustrialWritebackExecutor,
} from './advanced-platform.js';
import type { DataPlanePermission, IdentityProvider } from './auth.js';
import { ForbiddenError } from './database.js';
import type { PlatformAdministrationPersistence } from './platform-administration.js';
import { cursorListQuerySchema, platformContextSchema, platformIdSchema, type PlatformContext } from './platform-schemas.js';
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
const writebackApprovalRoles: readonly PlatformProjectRole[] = ['owner', 'reviewer'];
const ownerRoles: readonly PlatformProjectRole[] = ['owner'];

const diagramPaths = ['/api/v1/platform/diagrams/tag-extractions', '/api/v1/platform/diagram-extractions'];
const matchingPaths = ['/api/v1/platform/matching/evaluations', '/api/v1/platform/matching-evaluations'];
const spatialPaths = ['/api/v1/platform/spatial/asset-links', '/api/v1/platform/spatial-links'];
const memberPaths = ['/api/v1/platform/project/members', '/api/v1/platform/project-members'];

export interface AdvancedPlatformRouteOptions {
  writebackExecutor?: IndustrialWritebackExecutor;
  /** PostgreSQL membership authority; avoids shadow SQLite memberships. */
  platformAdministration?: PlatformAdministrationPersistence;
  /** Deny legacy membership fallback when the process serves PostgreSQL data. */
  postgresMode?: boolean;
}

export function registerAdvancedPlatformRoutes(
  app: Express,
  projectCatalog: PlatformCatalog,
  catalog: AdvancedPlatformCatalog,
  identityProvider: IdentityProvider,
  options: AdvancedPlatformRouteOptions = {},
): void {
  app.get(diagramPaths, async (request, response) => {
    const { context } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:read');
    response.json(catalog.listDiagramExtractions(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post(diagramPaths, async (request, response) => {
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createDiagramExtraction(
      context,
      parse(diagramExtractionCreateSchema, request.body),
      identity.userId,
      response.locals.correlationId,
    ));
  });

  app.get(matchingPaths, async (request, response) => {
    const { context } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:read');
    response.json(catalog.listMatchingEvaluations(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post(matchingPaths, async (request, response) => {
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createMatchingEvaluation(
      context,
      parse(matchingEvaluationCreateSchema, request.body),
      identity.userId,
      response.locals.correlationId,
    ));
  });

  app.get(spatialPaths, async (request, response) => {
    const { context } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:read');
    response.json(catalog.listSpatialLinks(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post(spatialPaths, async (request, response) => {
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:ingest', writeRoles);
    response.status(201).json(catalog.createSpatialLink(
      context,
      parse(spatialLinkCreateSchema, request.body),
      identity.userId,
      response.locals.correlationId,
    ));
  });
  app.post([
    '/api/v1/platform/spatial/asset-links/:linkId/review',
    '/api/v1/platform/spatial-links/:linkId/review',
  ], async (request, response) => {
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'relations:review', reviewRoles);
    const linkId = parse(platformIdSchema, request.params.linkId);
    response.json(catalog.reviewSpatialLink(
      context,
      linkId,
      parse(spatialLinkReviewSchema, request.body),
      identity.userId,
      response.locals.correlationId,
    ));
  });

  app.get(memberPaths, async (request, response) => {
    if (options.platformAdministration) {
      const identity = await requirePermission(identityProvider, request, 'data:read');
      const context = requestContext(request);
      response.json(await options.platformAdministration.listProjectMembers(
        context.tenantId,
        context.projectId,
        identity.userId,
        parse(cursorListQuerySchema, request.query),
      ));
      return;
    }
    if (options.postgresMode) {
      throw new ForbiddenError('PostgreSQL project membership administration is not configured');
    }
    const { context } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:read');
    response.json(catalog.listProjectMembers(context, parse(cursorListQuerySchema, request.query)));
  });
  app.put([
    '/api/v1/platform/project/members/:userId',
    '/api/v1/platform/project-members/:userId',
  ], async (request, response) => {
    if (options.platformAdministration) {
      const identity = await requirePermission(identityProvider, request, 'platform:admin');
      const context = requestContext(request);
      const userId = parse(workspaceUserIdSchema, request.params.userId);
      const input = parse(projectMemberUpsertSchema, request.body);
      const result = await options.platformAdministration.upsertProjectMember(
        context.tenantId,
        context.projectId,
        identity.userId,
        userId,
        input.role,
        response.locals.correlationId,
      );
      response.status(result.created ? 201 : 200).json(result.member);
      return;
    }
    if (options.postgresMode) {
      throw new ForbiddenError('PostgreSQL project membership administration is not configured');
    }
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'platform:admin', ownerRoles);
    const userId = parse(workspaceUserIdSchema, request.params.userId);
    const created = !catalog.hasProjectMember(context, userId);
    const member = catalog.upsertProjectMember(
      context,
      userId,
      parse(projectMemberUpsertSchema, request.body),
      identity.userId,
      response.locals.correlationId,
    );
    response.status(created ? 201 : 200).json(member);
  });
  app.delete([
    '/api/v1/platform/project/members/:userId',
    '/api/v1/platform/project-members/:userId',
  ], async (request, response) => {
    if (options.platformAdministration) {
      const identity = await requirePermission(identityProvider, request, 'platform:admin');
      const context = requestContext(request);
      const userId = parse(workspaceUserIdSchema, request.params.userId);
      await options.platformAdministration.removeProjectMember(
        context.tenantId,
        context.projectId,
        identity.userId,
        userId,
        response.locals.correlationId,
      );
      response.status(204).end();
      return;
    }
    if (options.postgresMode) {
      throw new ForbiddenError('PostgreSQL project membership administration is not configured');
    }
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'platform:admin', ownerRoles);
    const userId = parse(workspaceUserIdSchema, request.params.userId);
    catalog.removeProjectMember(context, userId, identity.userId, response.locals.correlationId);
    response.status(204).end();
  });

  app.get('/api/v1/platform/writeback/requests', async (request, response) => {
    const { context } = await requireProjectAccess(projectCatalog, identityProvider, request, 'data:read');
    response.json(catalog.listWritebackRequests(context, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/writeback/requests', async (request, response) => {
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'writeback:request', writeRoles);
    response.status(201).json(catalog.createWritebackRequest(
      context,
      parse(writebackRequestCreateSchema, request.body),
      identity.userId,
      response.locals.correlationId,
    ));
  });
  app.post('/api/v1/platform/writeback/requests/:requestId/approvals', async (request, response) => {
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'writeback:approve', writebackApprovalRoles);
    const requestId = parse(platformIdSchema, request.params.requestId);
    response.json(catalog.approveWritebackRequest(
      context,
      requestId,
      parse(writebackApprovalCreateSchema, request.body),
      identity.userId,
      response.locals.correlationId,
    ));
  });
  app.post('/api/v1/platform/writeback/requests/:requestId/execute', async (request, response) => {
    const { context, identity } = await requireProjectAccess(projectCatalog, identityProvider, request, 'writeback:execute', writeRoles);
    const requestId = parse(platformIdSchema, request.params.requestId);
    parse(writebackExecuteSchema, request.body);
    if (!options.writebackExecutor) {
      catalog.assertWritebackExecutable(context, requestId);
      catalog.recordUnavailableExecutor(context, requestId, identity.userId, response.locals.correlationId);
      response.status(503).json({
        error: {
          code: 'writeback_executor_unavailable',
          message: 'No industrial write-back executor is configured; the request was not executed',
          correlationId: response.locals.correlationId,
        },
      });
      return;
    }

    const execution = catalog.beginWritebackExecution(context, requestId, identity.userId, response.locals.correlationId);
    let result: Record<string, unknown>;
    try {
      result = await options.writebackExecutor.execute(execution);
      const encoded = JSON.stringify(result);
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 1_000_000) {
        throw new Error('Industrial write-back executor returned an invalid or oversized result');
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Industrial write-back executor failed')
        .replace(/[\r\n\t]+/gu, ' ')
        .slice(0, 4_000);
      const failed = catalog.completeWritebackExecution(
        context,
        requestId,
        identity.userId,
        response.locals.correlationId,
        { succeeded: false, error: message },
      );
      response.status(502).json({
        ...failed,
        error: { code: 'writeback_execution_failed', message, correlationId: response.locals.correlationId },
      });
      return;
    }
    response.json(catalog.completeWritebackExecution(
      context,
      requestId,
      identity.userId,
      response.locals.correlationId,
      { succeeded: true, result },
    ));
  });
  app.get('/api/v1/platform/writeback/requests/:requestId/events', async (request, response) => {
    const { context } = await requireProjectAccess(projectCatalog, identityProvider, request, 'audit:read');
    const requestId = parse(platformIdSchema, request.params.requestId);
    response.json(catalog.listWritebackEvents(context, requestId, parse(cursorListQuerySchema, request.query)));
  });
}
