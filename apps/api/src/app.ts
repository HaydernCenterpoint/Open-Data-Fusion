import { randomUUID } from 'node:crypto';

import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from 'express';
import { z, ZodError } from 'zod';

import {
  AuthenticationError,
  DevelopmentIdentityProvider,
  type IdentityProvider,
} from './auth.js';
import { WorkspaceEventHub } from './collaboration.js';
import { ConflictError, DataIntegrityError, ForbiddenError, FusionDatabase, NotFoundError } from './database.js';
import {
  assetListQuerySchema,
  auditListQuerySchema,
  ingestBundleSchema,
  relationReviewSchema,
  telemetryQuerySchema,
  workspaceIdSchema,
  workspaceMemberUpsertSchema,
  workspaceRevisionQuerySchema,
  workspaceRollbackSchema,
  workspaceOperationsSchema,
  workspaceUpdateSchema,
  workspaceUserIdSchema,
} from './schemas.js';

declare global {
  namespace Express {
    interface Locals {
      correlationId: string;
    }
  }
}

function parse<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.output<TSchema> {
  return schema.parse(value) as z.output<TSchema>;
}

async function workspaceActor(identityProvider: IdentityProvider, request: Request, queryUser?: unknown): Promise<string> {
  const identity = await identityProvider.authenticate(request, { developmentUserHint: queryUser });
  return parse(workspaceUserIdSchema, identity.userId);
}

async function requireWorkspaceMember(
  database: FusionDatabase,
  identityProvider: IdentityProvider,
  id: string,
  request: Request,
  queryUser?: unknown,
) {
  const actor = await workspaceActor(identityProvider, request, queryUser);
  return { actor, member: database.getWorkspaceMember(id, actor) };
}

async function requireWorkspaceEditor(database: FusionDatabase, identityProvider: IdentityProvider, id: string, request: Request) {
  const identity = await requireWorkspaceMember(database, identityProvider, id, request);
  if (identity.member.role !== 'owner' && identity.member.role !== 'editor') {
    throw new ForbiddenError(`User '${identity.actor}' has read-only access to workspace '${id}'`);
  }
  return identity;
}

async function requireWorkspaceOwner(database: FusionDatabase, identityProvider: IdentityProvider, id: string, request: Request) {
  const identity = await requireWorkspaceMember(database, identityProvider, id, request);
  if (identity.member.role !== 'owner') {
    throw new ForbiddenError(`Only owners can manage members of workspace '${id}'`);
  }
  return identity;
}

const correlationMiddleware: RequestHandler = (request, response, next) => {
  const supplied = request.header('x-correlation-id')?.trim();
  const correlationId = supplied && supplied.length <= 255 ? supplied : randomUUID();
  response.locals.correlationId = correlationId;
  response.setHeader('x-correlation-id', correlationId);
  next();
};

export interface CreateAppOptions {
  identityProvider?: IdentityProvider;
}

export function createApp(
  database: FusionDatabase,
  eventHub = new WorkspaceEventHub(),
  options: CreateAppOptions = {},
): Express {
  const identityProvider = options.identityProvider ?? new DevelopmentIdentityProvider();
  const app = express();
  app.disable('x-powered-by');
  app.use(correlationMiddleware);
  app.use(express.json({ limit: '10mb', strict: true }));

  const healthHandler: RequestHandler = (_request, response) => {
    response.json({ ...database.health(), authMode: identityProvider.mode });
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  app.get('/api/v1/assets', (request, response) => {
    const query = parse(assetListQuerySchema, request.query);
    response.json(database.listAssets(query));
  });

  app.get('/api/v1/assets/:externalId/telemetry', (request, response) => {
    const externalId = parse(z.string().trim().min(1).max(255), request.params.externalId);
    const query = parse(telemetryQuerySchema, request.query);
    response.json(database.getTelemetry(externalId, query));
  });

  app.get('/api/v1/assets/:externalId', (request, response) => {
    const externalId = parse(z.string().trim().min(1).max(255), request.params.externalId);
    response.json(database.getAsset(externalId));
  });

  const ingestHandler: RequestHandler = (request, response) => {
    const bundle = parse(ingestBundleSchema, request.body);
    const result = database.ingest(bundle, response.locals.correlationId);
    response.status(result.status === 'already_processed' ? 200 : 201).json(result);
  };
  app.post('/api/ingest', ingestHandler);
  app.post('/api/v1/ingest/bundle', ingestHandler);

  app.get('/api/v1/relations', (request, response) => {
    const query = parse(
      z.object({
        status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    response.json(database.listRelations(query.status, query.limit));
  });

  app.post('/api/v1/relations/:id/review', (request, response) => {
    const id = parse(z.string().trim().min(1).max(255), request.params.id);
    const review = parse(relationReviewSchema, request.body);
    response.json(database.reviewRelation(id, review, response.locals.correlationId));
  });

  app.get('/api/v1/audit', (request, response) => {
    const query = parse(auditListQuerySchema, request.query);
    response.json(database.listAudit(query));
  });

  app.get('/api/v1/workspaces/:id', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    await requireWorkspaceMember(database, identityProvider, id, request);
    response.json(database.getWorkspace(id));
  });

  app.put('/api/v1/workspaces/:id', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const update = parse(workspaceUpdateSchema, request.body);
    const { actor } = await requireWorkspaceEditor(database, identityProvider, id, request);
    const authorizedUpdate = { ...update, actor };
    const workspace = database.updateWorkspace(id, authorizedUpdate, response.locals.correlationId);
    eventHub.publishWorkspaceUpdated({
      workspaceId: id,
      version: workspace.version,
      actor,
      changeSummary: update.changeSummary,
      updatedAt: workspace.updatedAt,
    });
    response.json(workspace);
  });

  app.get('/api/v1/workspaces/:id/members', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    await requireWorkspaceMember(database, identityProvider, id, request);
    response.json(database.listWorkspaceMembers(id));
  });

  app.put('/api/v1/workspaces/:id/members/:userId', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const targetUserId = parse(workspaceUserIdSchema, request.params.userId);
    const update = parse(workspaceMemberUpsertSchema, request.body);
    const { actor } = await requireWorkspaceOwner(database, identityProvider, id, request);
    const result = database.upsertWorkspaceMember(id, actor, targetUserId, update, response.locals.correlationId);
    eventHub.publishMembersUpdated({
      workspaceId: id,
      actor,
      change: result.created ? 'added' : 'updated',
      member: result.member,
      occurredAt: new Date().toISOString(),
    });
    response.status(result.created ? 201 : 200).json(result.member);
  });

  app.delete('/api/v1/workspaces/:id/members/:userId', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const targetUserId = parse(workspaceUserIdSchema, request.params.userId);
    const { actor } = await requireWorkspaceOwner(database, identityProvider, id, request);
    const member = database.removeWorkspaceMember(id, actor, targetUserId, response.locals.correlationId);
    eventHub.publishMembersUpdated({
      workspaceId: id,
      actor,
      change: 'removed',
      member,
      occurredAt: new Date().toISOString(),
    });
    response.status(204).end();
  });

  app.post('/api/v1/workspaces/:id/operations', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const actor = await workspaceActor(identityProvider, request);
    const update = parse(workspaceOperationsSchema, request.body);
    const workspace = database.applyWorkspaceOperations(id, actor, update, response.locals.correlationId);
    eventHub.publishWorkspaceUpdated({
      workspaceId: id,
      version: workspace.version,
      actor,
      changeSummary: update.changeSummary,
      operations: update.operations,
      updatedAt: workspace.updatedAt,
    });
    response.json(workspace);
  });

  app.get('/api/v1/workspaces/:id/events', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const query = parse(z.object({ user: workspaceUserIdSchema.optional() }), request.query);
    const actor = await workspaceActor(identityProvider, request, query.user);
    const member = database.getWorkspaceMember(id, actor);

    response.status(200);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();
    response.write('retry: 3000\n: connected\n\n');

    const unsubscribe = eventHub.subscribe(id, member, (event) => {
      response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      const changedMember = event.data.member;
      if (
        event.type === 'members.updated' &&
        event.data.change === 'removed' &&
        changedMember &&
        typeof changedMember === 'object' &&
        'userId' in changedMember &&
        changedMember.userId === actor
      ) {
        response.end();
      }
    });
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref();
    const disconnect = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.once('close', disconnect);
    response.once('close', disconnect);
  });

  app.get('/api/v1/workspaces/:id/revisions', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    await requireWorkspaceMember(database, identityProvider, id, request);
    const query = parse(workspaceRevisionQuerySchema, request.query);
    response.json(database.listWorkspaceRevisions(id, query));
  });

  app.post('/api/v1/workspaces/:id/rollback', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const rollback = parse(workspaceRollbackSchema, request.body);
    const { actor } = await requireWorkspaceEditor(database, identityProvider, id, request);
    const authorizedRollback = { ...rollback, actor };
    const workspace = database.rollbackWorkspace(id, authorizedRollback, response.locals.correlationId);
    eventHub.publishWorkspaceUpdated({
      workspaceId: id,
      version: workspace.version,
      actor,
      changeSummary: rollback.changeSummary || `Rolled back to revision ${rollback.targetVersion}`,
      restoredFromVersion: rollback.targetVersion,
      updatedAt: workspace.updatedAt,
    });
    response.json(workspace);
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: 'route_not_found',
        message: 'The requested API route does not exist',
        correlationId: response.locals.correlationId,
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: 'validation_error',
          message: 'The request was not valid',
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          correlationId: response.locals.correlationId,
        },
      });
      return;
    }
    if (error instanceof AuthenticationError) {
      response.setHeader('www-authenticate', 'Bearer');
      response.status(401).json({ error: { code: 'unauthorized', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof NotFoundError) {
      response.status(404).json({ error: { code: 'not_found', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof ForbiddenError) {
      response.status(403).json({ error: { code: 'forbidden', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof ConflictError) {
      response.status(409).json({ error: { code: 'conflict', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof DataIntegrityError) {
      response.status(422).json({ error: { code: 'data_integrity_error', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response.status(400).json({ error: { code: 'invalid_json', message: 'The request body is not valid JSON', correlationId: response.locals.correlationId } });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${response.locals.correlationId}]`, error);
    response.status(500).json({ error: { code: 'internal_error', message, correlationId: response.locals.correlationId } });
  };
  app.use(errorHandler);

  return app;
}
