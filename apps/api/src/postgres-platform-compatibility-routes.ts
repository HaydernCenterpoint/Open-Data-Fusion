import type { Express, Request } from 'express';
import { z } from 'zod';

import {
  writebackApprovalCreateSchema,
  writebackExecuteSchema,
  writebackRequestCreateSchema,
} from './advanced-platform-schemas.js';
import type { IndustrialWritebackExecutor } from './advanced-platform.js';
import type { DataPlanePermission, IdentityProvider } from './auth.js';
import { ForbiddenError } from './database.js';
import type { PostgresPlatformCompatibilityPersistence } from './postgres-platform-compatibility.js';
import {
  candidateCreateSchema,
  candidateReviewSchema,
  cursorListQuerySchema,
  dataModelVersionCreateSchema,
  pipelineCreateSchema,
  pipelineRunTriggerSchema,
  platformContextSchema,
  platformIdSchema,
  qualityRuleCreateSchema,
  type PlatformContext,
} from './platform-schemas.js';
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

export interface PostgresPlatformCompatibilityRouteOptions {
  writebackExecutor?: IndustrialWritebackExecutor;
}

/**
 * PostgreSQL authority for the legacy v1 platform contract. Register this
 * before the SQLite platform route modules so no compatibility request can
 * fall through to replica-local state.
 */
export function registerPostgresPlatformCompatibilityRoutes(
  app: Express,
  persistence: PostgresPlatformCompatibilityPersistence,
  identityProvider: IdentityProvider,
  options: PostgresPlatformCompatibilityRouteOptions = {},
): void {
  app.get('/api/v1/platform/data-models', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listDataModels(requestContext(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/data-models/:modelId/versions', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createDataModelVersion(
      requestContext(request),
      identity.userId,
      parse(platformIdSchema, request.params.modelId),
      parse(dataModelVersionCreateSchema, request.body),
      response.locals.correlationId,
    ));
  });

  app.get('/api/v1/platform/pipelines', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listPipelines(requestContext(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/pipelines', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createPipeline(
      requestContext(request), identity.userId, parse(pipelineCreateSchema, request.body), response.locals.correlationId,
    ));
  });
  app.post('/api/v1/platform/pipelines/:pipelineId/runs', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    const run = await persistence.triggerPipelineRun(
      requestContext(request),
      identity.userId,
      parse(platformIdSchema, request.params.pipelineId),
      parse(pipelineRunTriggerSchema, request.body),
      response.locals.correlationId,
    );
    response.status(run.replayed === true ? 200 : 201).json(run);
  });
  app.get('/api/v1/platform/pipeline-runs', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listPipelineRuns(requestContext(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });

  app.get('/api/v1/platform/quality-rules', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listQualityRules(requestContext(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/quality-rules', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createQualityRule(
      requestContext(request), identity.userId, parse(qualityRuleCreateSchema, request.body), response.locals.correlationId,
    ));
  });
  app.get('/api/v1/platform/quality-results', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listQualityResults(requestContext(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });

  app.get('/api/v1/platform/contextualization/candidates', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listCandidates(requestContext(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/contextualization/candidates', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:ingest');
    response.status(201).json(await persistence.createCandidate(
      requestContext(request), identity.userId, parse(candidateCreateSchema, request.body), response.locals.correlationId,
    ));
  });
  app.post('/api/v1/platform/contextualization/candidates/:candidateId/review', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'relations:review');
    response.json(await persistence.reviewCandidate(
      requestContext(request),
      identity.userId,
      parse(platformIdSchema, request.params.candidateId),
      parse(candidateReviewSchema, request.body),
      response.locals.correlationId,
    ));
  });

  app.get('/api/v1/platform/writeback/requests', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'data:read');
    response.json(await persistence.listWritebackRequests(requestContext(request), identity.userId, parse(cursorListQuerySchema, request.query)));
  });
  app.post('/api/v1/platform/writeback/requests', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'writeback:request');
    response.status(201).json(await persistence.createWritebackRequest(
      requestContext(request), identity.userId, parse(writebackRequestCreateSchema, request.body), response.locals.correlationId,
    ));
  });
  app.post('/api/v1/platform/writeback/requests/:requestId/approvals', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'writeback:approve');
    response.json(await persistence.approveWritebackRequest(
      requestContext(request),
      identity.userId,
      parse(platformIdSchema, request.params.requestId),
      parse(writebackApprovalCreateSchema, request.body),
      response.locals.correlationId,
    ));
  });
  app.post('/api/v1/platform/writeback/requests/:requestId/execute', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'writeback:execute');
    const context = requestContext(request);
    const requestId = parse(platformIdSchema, request.params.requestId);
    parse(writebackExecuteSchema, request.body);
    if (!options.writebackExecutor) {
      await persistence.assertWritebackExecutable(context, identity.userId, requestId);
      await persistence.recordUnavailableExecutor(context, identity.userId, requestId, response.locals.correlationId);
      response.status(503).json({
        error: {
          code: 'writeback_executor_unavailable',
          message: 'No industrial write-back executor is configured; the request was not executed',
          correlationId: response.locals.correlationId,
        },
      });
      return;
    }

    const execution = await persistence.beginWritebackExecution(context, identity.userId, requestId, response.locals.correlationId);
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
      const failed = await persistence.completeWritebackExecution(
        context,
        identity.userId,
        requestId,
        response.locals.correlationId,
        { succeeded: false, error: message },
      );
      response.status(502).json({
        ...failed,
        error: { code: 'writeback_execution_failed', message, correlationId: response.locals.correlationId },
      });
      return;
    }
    response.json(await persistence.completeWritebackExecution(
      context,
      identity.userId,
      requestId,
      response.locals.correlationId,
      { succeeded: true, result },
    ));
  });
  app.get('/api/v1/platform/writeback/requests/:requestId/events', async (request, response) => {
    const identity = await requirePermission(identityProvider, request, 'audit:read');
    response.json(await persistence.listWritebackEvents(
      requestContext(request),
      identity.userId,
      parse(platformIdSchema, request.params.requestId),
      parse(cursorListQuerySchema, request.query),
    ));
  });
}
