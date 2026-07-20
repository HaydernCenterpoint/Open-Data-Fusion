import { randomUUID } from 'node:crypto';

import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from 'express';
import type { WritebackSafetyPolicy } from '@open-data-fusion/platform-core';
import {
  ConflictError as RuntimeConflictError,
  DatabaseUnavailableError as RuntimeDatabaseUnavailableError,
  ForbiddenError as RuntimeForbiddenError,
  NotFoundError as RuntimeNotFoundError,
} from '@open-data-fusion/postgres-runtime';
import { z, ZodError } from 'zod';

import {
  AuthenticationError,
  DevelopmentIdentityProvider,
  type DataPlanePermission,
  type IdentityProvider,
} from './auth.js';
import { registerAdvancedPlatformRoutes } from './advanced-platform-routes.js';
import {
  AdvancedPlatformCatalog,
  type IndustrialWritebackExecutor,
} from './advanced-platform.js';
import { WorkspaceEventHub } from './collaboration.js';
import { ConflictError, DataIntegrityError, ForbiddenError, FusionDatabase, NotFoundError } from './database.js';
import { createApiObservability } from './observability.js';
import { registerGovernedObjectRoutes } from './object-routes.js';
import { ObjectStorageUnavailableError, type ImmutableBlobStore } from './object-storage.js';
import { GovernedObjectStore, type GovernedObjectPersistence } from './object-store.js';
import {
  industrialIngestRunId,
  type IndustrialPersistence,
  type IndustrialRequestScope,
} from './industrial-persistence.js';
import {
  SqlitePlatformDiscoveryPersistence,
  type PlatformDiscoveryPersistence,
} from './platform-discovery.js';
import type { PlatformAdministrationPersistence } from './platform-administration.js';
import {
  registerPostgresPlatformDataRoutes,
} from './postgres-platform-data-routes.js';
import type { PostgresPlatformDataPersistence } from './postgres-platform-data.js';
import {
  registerPostgresPlatformCompatibilityRoutes,
} from './postgres-platform-compatibility-routes.js';
import type { PostgresPlatformCompatibilityPersistence } from './postgres-platform-compatibility.js';
import { registerPlatformRoutes } from './platform-routes.js';
import { cursorListQuerySchema, platformContextSchema, platformIdSchema, type PlatformContext } from './platform-schemas.js';
import { PlatformCatalog } from './platform.js';
import { PostgresGovernedObjectStore } from './postgres-governed-object-store.js';
import { PostgresRawLandingStore } from './postgres-raw-landing.js';
import { PostgresWorkspacePersistence, type WorkspaceRequestScope } from './postgres-workspace-persistence.js';
import { RawLandingStore, type RawLandingPersistence } from './raw-landing.js';
import { SqliteIndustrialPersistence } from './sqlite-industrial-persistence.js';
import type { PostgresRuntime } from '@open-data-fusion/postgres-runtime';
import {
  assetListQuerySchema,
  auditListQuerySchema,
  ingestBundleSchema,
  relationReviewSchema,
  telemetryAggregateQuerySchema,
  telemetryLatestQuerySchema,
  telemetryQuerySchema,
  type IngestBundle,
  workspaceCreateSchema,
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
  platformCatalog: PlatformCatalog,
  workspacePersistence: PostgresWorkspacePersistence | undefined,
  identityProvider: IdentityProvider,
  id: string,
  request: Request,
  queryUser?: unknown,
  scopeHint?: WorkspaceScopeHint,
) {
  const actor = await workspaceActor(identityProvider, request, queryUser);
  if (workspacePersistence) {
    const scope = workspaceRequestScopeWithHint(request, actor, scopeHint);
    return {
      actor,
      context: { tenantId: scope.tenantId, projectId: scope.projectId },
      scope,
      member: await workspacePersistence.getWorkspaceMember(scope, id),
    };
  }
  const selectedContext = optionalWorkspacePlatformContext(request, scopeHint);
  const recordedContext = database.getWorkspaceScope(id);
  if (recordedContext) {
    if (
      !selectedContext
      || selectedContext.tenantId !== recordedContext.tenantId
      || selectedContext.projectId !== recordedContext.projectId
    ) {
      throw new NotFoundError(`Workspace '${id}' was not found in the selected project`);
    }
    platformCatalog.assertProjectAccess(selectedContext, actor);
  }
  return {
    actor,
    context: recordedContext ? selectedContext : undefined,
    member: database.getWorkspaceMember(id, actor, recordedContext ? selectedContext : undefined),
  };
}

async function requireWorkspaceEditor(
  database: FusionDatabase,
  platformCatalog: PlatformCatalog,
  workspacePersistence: PostgresWorkspacePersistence | undefined,
  identityProvider: IdentityProvider,
  id: string,
  request: Request,
) {
  const identity = await requireWorkspaceMember(
    database,
    platformCatalog,
    workspacePersistence,
    identityProvider,
    id,
    request,
  );
  if (identity.member.role !== 'owner' && identity.member.role !== 'editor') {
    throw new ForbiddenError(`User '${identity.actor}' has read-only access to workspace '${id}'`);
  }
  if (!workspacePersistence && identity.context) {
    platformCatalog.assertProjectAccess(identity.context, identity.actor, ['owner', 'editor']);
  }
  return identity;
}

async function requireWorkspaceOwner(
  database: FusionDatabase,
  platformCatalog: PlatformCatalog,
  workspacePersistence: PostgresWorkspacePersistence | undefined,
  identityProvider: IdentityProvider,
  id: string,
  request: Request,
) {
  const identity = await requireWorkspaceMember(
    database,
    platformCatalog,
    workspacePersistence,
    identityProvider,
    id,
    request,
  );
  if (identity.member.role !== 'owner') {
    throw new ForbiddenError(`Only owners can manage members of workspace '${id}'`);
  }
  if (!workspacePersistence && identity.context) {
    platformCatalog.assertProjectAccess(identity.context, identity.actor, ['owner', 'editor']);
  }
  return identity;
}

function workspaceRequestScope(request: Request, userId: string): WorkspaceRequestScope {
  return workspaceRequestScopeWithHint(request, userId);
}

interface WorkspaceScopeHint {
  tenantId?: unknown;
  projectId?: unknown;
}

function workspaceRequestScopeWithHint(
  request: Request,
  userId: string,
  hint?: WorkspaceScopeHint,
): WorkspaceRequestScope {
  return {
    tenantId: parse(z.string().uuid(), request.header('x-odf-tenant-id') ?? hint?.tenantId),
    projectId: parse(z.string().uuid(), request.header('x-odf-project-id') ?? hint?.projectId),
    userId,
  };
}

function optionalWorkspacePlatformContext(
  request: Request,
  hint?: WorkspaceScopeHint,
): PlatformContext | undefined {
  const tenantId = request.header('x-odf-tenant-id') ?? hint?.tenantId;
  const projectId = request.header('x-odf-project-id') ?? hint?.projectId;
  if (tenantId === undefined && projectId === undefined) return undefined;
  return parse(platformContextSchema, { tenantId, projectId });
}

async function requireDataPlanePermission(
  identityProvider: IdentityProvider,
  request: Request,
  permission: DataPlanePermission,
) {
  const identity = await identityProvider.authenticate(request);
  const userId = parse(workspaceUserIdSchema, identity.userId);
  if (!identity.permissions.has(permission)) {
    throw new ForbiddenError(`Permission '${permission}' is required`);
  }
  return { ...identity, userId };
}

function correlationMiddleware(requireUuid: boolean): RequestHandler {
  return (request, response, next) => {
    const supplied = request.header('x-correlation-id')?.trim();
    const correlationId = supplied && supplied.length <= 255 ? supplied : randomUUID();
    if (requireUuid && !z.string().uuid().safeParse(correlationId).success) {
      const generated = randomUUID();
      response.locals.correlationId = generated;
      response.setHeader('x-correlation-id', generated);
      response.status(400).json({
        error: {
          code: 'invalid_correlation_id',
          message: 'x-correlation-id must be a UUID when PostgreSQL Canvas persistence is enabled',
          correlationId: generated,
        },
      });
      return;
    }
    response.locals.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    next();
  };
}

export interface CreateAppOptions {
  identityProvider?: IdentityProvider;
  metricsToken?: string;
  rawLandingDirectory?: string;
  writebackPolicy?: WritebackSafetyPolicy;
  writebackExecutor?: IndustrialWritebackExecutor;
  objectStorePath?: string;
  objectStoreMaxBytes?: number;
  /** Ephemeral staging path used only while streaming an S3 upload. */
  objectStorageTemporaryPath?: string;
  /** Shared immutable byte store required by PostgreSQL multi-replica mode. */
  sharedBlobStore?: ImmutableBlobStore;
  /** Runtime used for PostgreSQL raw/governed object metadata. */
  postgresRuntime?: PostgresRuntime;
  /** PostgreSQL persistence for all Canvas/workspace reads and writes. */
  workspacePersistence?: PostgresWorkspacePersistence;
  /** Exactly one industrial data backend selected for this process. */
  industrialPersistence?: IndustrialPersistence;
  /** Tenant/project discovery selected with the process data backend. */
  platformDiscovery?: PlatformDiscoveryPersistence;
  /** PostgreSQL governed tenant/project and membership administration. */
  platformAdministration?: PlatformAdministrationPersistence;
  /** PostgreSQL-backed remaining platform catalog and advanced data routes. */
  platformDataPersistence?: PostgresPlatformDataPersistence;
  /** PostgreSQL compatibility persistence for the remaining public v1 platform contracts. */
  platformCompatibilityPersistence?: PostgresPlatformCompatibilityPersistence;
  /** Explicit convenience scope for tests or a single-project embedded deployment. */
  defaultPlatformContext?: PlatformContext;
  /** Redis delivery must remain healthy for this API instance to be ready. */
  sharedEventsRequired?: boolean;
}

export function createApp(
  database: FusionDatabase,
  eventHub = new WorkspaceEventHub(),
  options: CreateAppOptions = {},
): Express {
  const identityProvider = options.identityProvider ?? new DevelopmentIdentityProvider();
  const workspacePersistence = options.workspacePersistence;
  const industrialPersistence = options.industrialPersistence ?? new SqliteIndustrialPersistence(database.database);
  const usesScopedSqliteIndustrialPersistence = industrialPersistence instanceof SqliteIndustrialPersistence;
  const platformCatalog = new PlatformCatalog(database.database);
  if (usesScopedSqliteIndustrialPersistence) platformCatalog.rebuildSqliteAssetSearchIndex();
  const platformDiscovery = options.platformDiscovery ?? new SqlitePlatformDiscoveryPersistence(platformCatalog);
  const advancedPlatformCatalog = new AdvancedPlatformCatalog(database.database, {
    ...(options.writebackPolicy ? { writebackPolicy: options.writebackPolicy } : {}),
  });
  let governedObjectStore: GovernedObjectPersistence | null;
  let rawLanding: RawLandingPersistence | null;
  // The production server always supplies postgresRuntime. Narrow test
  // doubles that only exercise an IndustrialPersistence error path retain
  // their embedded stores, but a real PostgreSQL runtime can never fall back
  // to per-replica SQLite metadata.
  const usesSharedPostgresObjectMetadata = industrialPersistence.mode === 'postgres'
    && (options.postgresRuntime !== undefined || options.sharedBlobStore !== undefined);
  if (usesSharedPostgresObjectMetadata) {
    if (!options.sharedBlobStore || !options.postgresRuntime || !options.objectStorageTemporaryPath) {
      throw new Error('PostgreSQL persistence requires shared object storage, its PostgreSQL runtime, and an ephemeral object staging path');
    }
    governedObjectStore = new PostgresGovernedObjectStore(options.postgresRuntime, options.sharedBlobStore, {
      temporaryPath: options.objectStorageTemporaryPath,
      ...(options.objectStoreMaxBytes !== undefined ? { maxObjectBytes: options.objectStoreMaxBytes } : {}),
    });
    rawLanding = new PostgresRawLandingStore(options.postgresRuntime, options.sharedBlobStore);
  } else {
    if (industrialPersistence.mode === 'postgres' && process.env.NODE_ENV === 'production') {
      throw new Error('Production PostgreSQL persistence requires a shared PostgreSQL object metadata runtime');
    }
    governedObjectStore = options.objectStorePath
      ? new GovernedObjectStore(database.database, platformCatalog, {
          rootPath: options.objectStorePath,
          ...(options.objectStoreMaxBytes !== undefined ? { maxObjectBytes: options.objectStoreMaxBytes } : {}),
        })
      : null;
    rawLanding = options.rawLandingDirectory
      ? new RawLandingStore(database.database, options.rawLandingDirectory)
      : null;
  }
  const observability = createApiObservability(options.metricsToken);
  const app = express();
  app.disable('x-powered-by');
  app.use(correlationMiddleware(workspacePersistence !== undefined || industrialPersistence.mode === 'postgres'));
  app.use(observability.middleware);

  const healthHandler: RequestHandler = async (_request, response) => {
    const workspaceHealth = workspacePersistence ? await workspacePersistence.health() : null;
    const industrialHealth = await industrialPersistence.health();
    const sharedEventDelivery = eventHub.eventDeliveryHealth();
    const objectStorage = options.sharedBlobStore ? await options.sharedBlobStore.health() : null;
    response.json({
      ...database.health(),
      authMode: identityProvider.mode,
      ...(workspaceHealth ? { workspacePersistence: workspaceHealth } : {}),
      industrialPersistence: industrialHealth,
      sharedEventDelivery,
      ...(objectStorage ? { objectStorage } : {}),
    });
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);
  app.get('/api/v1/auth/session', async (request, response) => {
    const identity = await identityProvider.authenticate(request);
    response.json({
      authenticated: true,
      identity: {
        userId: identity.userId,
        displayName: identity.displayName ?? identity.userId,
        role: identity.role ?? null,
      },
      expiresAt: typeof identity.claims?.exp === 'number' ? identity.claims.exp : null,
    });
  });
  app.get('/ready', async (_request, response) => {
    const health = database.health();
    const workspaceHealth = workspacePersistence ? await workspacePersistence.health() : null;
    const industrialHealth = await industrialPersistence.health();
    const sharedEventDelivery = eventHub.eventDeliveryHealth();
    const objectStorage = options.sharedBlobStore ? await options.sharedBlobStore.health() : null;
    const ready = health.status === 'ok'
      && (workspaceHealth === null || workspaceHealth.status === 'ok')
      && industrialHealth.status === 'ok'
      && (objectStorage === null || objectStorage.status === 'ok')
      && (options.sharedEventsRequired !== true || sharedEventDelivery.status === 'ok');
    response.status(ready ? 200 : 503).json({
      ...health,
      readiness: ready ? 'ready' : 'not_ready',
      ...(workspaceHealth ? { workspacePersistence: workspaceHealth } : {}),
      industrialPersistence: industrialHealth,
      sharedEventDelivery,
      ...(objectStorage ? { objectStorage } : {}),
    });
  });
  app.get('/metrics', observability.metricsHandler);

  const platformContext = (request: Request): PlatformContext => parse(platformContextSchema, {
    tenantId: request.header('x-odf-tenant-id') ?? options.defaultPlatformContext?.tenantId,
    projectId: request.header('x-odf-project-id') ?? options.defaultPlatformContext?.projectId,
  });

  const industrialScope = async (
    request: Request,
    permission: DataPlanePermission,
    allowedRoles?: readonly import('./platform.js').PlatformProjectRole[],
  ): Promise<IndustrialRequestScope> => {
    const identity = await requireDataPlanePermission(identityProvider, request, permission);
    const context = platformContext(request);
    if (industrialPersistence.mode === 'sqlite') {
      platformCatalog.assertProjectAccess(context, identity.userId, allowedRoles);
    }
    const scope = { ...context, userId: identity.userId };
    await industrialPersistence.authorize(scope, allowedRoles);
    return scope;
  };

  const indexSqliteAssets = (context: PlatformContext, assets: IngestBundle['assets']): void => {
    if (!usesScopedSqliteIndustrialPersistence) return;
    for (const asset of assets) {
      platformCatalog.indexSearchDocument(
        context,
        'asset',
        asset.externalId,
        asset.name,
        `${asset.description ?? ''} ${asset.type}`.trim(),
      );
    }
  };

  // Register binary upload/download routes before JSON parsing so a governed
  // `application/json` file remains an opaque stream rather than an API body.
  registerGovernedObjectRoutes(app, governedObjectStore, async (request, permission, roles) => {
    const scope = await industrialScope(request, permission, roles);
    return { identity: { userId: scope.userId }, context: scope };
  });
  app.use(express.json({ limit: '10mb', strict: true }));

  const requireAcceptedRelationPermission = async (request: Request, bundle: import('./schemas.js').IngestBundle): Promise<void> => {
    if (bundle.relations.some((relation) => relation.status === 'accepted')) {
      await requireDataPlanePermission(identityProvider, request, 'relations:review');
    }
  };

  app.get('/api/v1/assets', async (request, response) => {
    const scope = await industrialScope(request, 'data:read');
    const query = parse(assetListQuerySchema, request.query);
    response.json(await industrialPersistence.listAssets(scope, query));
  });

  app.get('/api/v1/assets/:externalId/telemetry', async (request, response) => {
    const scope = await industrialScope(request, 'data:read');
    const externalId = parse(z.string().trim().min(1).max(255), request.params.externalId);
    const query = parse(telemetryQuerySchema, request.query);
    response.json(await industrialPersistence.getTelemetry(scope, externalId, query));
  });

  app.get('/api/v1/assets/:externalId/telemetry/latest', async (request, response) => {
    const scope = await industrialScope(request, 'data:read');
    const externalId = parse(z.string().trim().min(1).max(255), request.params.externalId);
    response.json(await industrialPersistence.getLatestTelemetry(
      scope,
      externalId,
      parse(telemetryLatestQuerySchema, request.query),
    ));
  });

  app.get([
    '/api/v1/assets/:externalId/telemetry/aggregate',
    '/api/v1/assets/:externalId/telemetry/buckets',
  ], async (request, response) => {
    const scope = await industrialScope(request, 'data:read');
    const externalId = parse(z.string().trim().min(1).max(255), request.params.externalId);
    response.json(await industrialPersistence.getAggregatedTelemetry(
      scope,
      externalId,
      parse(telemetryAggregateQuerySchema, request.query),
    ));
  });

  app.get('/api/v1/assets/:externalId', async (request, response) => {
    const scope = await industrialScope(request, 'data:read');
    const externalId = parse(z.string().trim().min(1).max(255), request.params.externalId);
    response.json(await industrialPersistence.getAsset(scope, externalId));
  });

  const ingestHandler: RequestHandler = async (request, response) => {
    const scope = await industrialScope(request, 'data:ingest', ['owner', 'editor']);
    const identity = { userId: scope.userId };
    const bundle = parse(ingestBundleSchema, request.body);
    await requireAcceptedRelationPermission(request, bundle);
    const actorBundle = {
      ...bundle,
      source: { ...bundle.source, actor: identity.userId },
    };
    const authorizedBundle = {
      ...actorBundle,
      source: { ...actorBundle.source, runId: industrialIngestRunId(actorBundle) },
    };
    let rawRecord: Awaited<ReturnType<RawLandingPersistence['archive']>> | null = null;
    let context: PlatformContext | null = null;
    if (rawLanding) {
      context = scope;
      rawRecord = await rawLanding.archive(context, authorizedBundle, identity.userId, response.locals.correlationId);
    }
    try {
      const result = await industrialPersistence.ingest(
        scope,
        authorizedBundle,
        response.locals.correlationId,
        rawRecord ? {
          storageUri: rawRecord.rawObjectUri,
          sha256: rawRecord.sha256,
          byteSize: rawRecord.byteSize,
          contentType: 'application/json',
        } : undefined,
      );
      indexSqliteAssets(scope, authorizedBundle.assets);
      if (rawLanding && rawRecord && context) await rawLanding.complete(context, rawRecord.id, 'accepted');
      response.status(result.status === 'already_processed' ? 200 : 201).json({
        ...result,
        ...(rawRecord ? { rawObjectId: rawRecord.id, rawSha256: rawRecord.sha256 } : {}),
      });
    } catch (error) {
      if (rawLanding && rawRecord && context) {
        await rawLanding.complete(context, rawRecord.id, 'failed', error instanceof Error ? error.message : 'Unknown ingestion failure');
      }
      throw error;
    }
  };
  app.post('/api/ingest', ingestHandler);
  app.post('/api/v1/ingest/bundle', ingestHandler);

  app.get('/api/v1/relations', async (request, response) => {
    const scope = await industrialScope(request, 'data:read');
    const query = parse(
      z.object({
        status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      request.query,
    );
    response.json(await industrialPersistence.listRelations(scope, query.status, query.limit));
  });

  app.post('/api/v1/relations/:id/review', async (request, response) => {
    const scope = await industrialScope(request, 'relations:review', ['owner', 'editor', 'reviewer']);
    const id = parse(z.string().trim().min(1).max(255), request.params.id);
    const review = parse(relationReviewSchema, request.body);
    const authorizedReview = { ...review, reviewer: scope.userId };
    response.json(await industrialPersistence.reviewRelation(scope, id, authorizedReview, response.locals.correlationId));
  });

  app.get('/api/v1/audit', async (request, response) => {
    const scope = await industrialScope(request, 'audit:read');
    const query = parse(auditListQuerySchema, request.query);
    response.json(await industrialPersistence.listAudit(scope, query));
  });

  const postgresPlatformMode = industrialPersistence.mode === 'postgres' || platformDiscovery.mode === 'postgres';
  if (options.platformCompatibilityPersistence) {
    registerPostgresPlatformCompatibilityRoutes(
      app,
      options.platformCompatibilityPersistence,
      identityProvider,
      options.writebackExecutor ? { writebackExecutor: options.writebackExecutor } : {},
    );
  }
  if (options.platformDataPersistence) {
    registerPostgresPlatformDataRoutes(app, options.platformDataPersistence, identityProvider);
  }
  registerPlatformRoutes(
    app,
    platformCatalog,
    identityProvider,
    platformDiscovery,
    options.platformAdministration,
    postgresPlatformMode,
  );
  registerAdvancedPlatformRoutes(app, platformCatalog, advancedPlatformCatalog, identityProvider, {
    ...(options.writebackExecutor ? { writebackExecutor: options.writebackExecutor } : {}),
    ...(options.platformAdministration ? { platformAdministration: options.platformAdministration } : {}),
    postgresMode: postgresPlatformMode,
  });

  app.get('/api/v1/platform/ingestion/raw', async (request, response) => {
    const context = await industrialScope(request, 'audit:read');
    if (!rawLanding) {
      response.status(503).json({ error: { code: 'raw_landing_unavailable', message: 'Raw landing storage is not configured', correlationId: response.locals.correlationId } });
      return;
    }
    const query = parse(cursorListQuerySchema, request.query);
    response.json(await rawLanding.list(context, query.limit, query.cursor));
  });

  app.post('/api/v1/platform/ingestion/raw/:rawId/replay', async (request, response) => {
    const context = await industrialScope(request, 'data:ingest', ['owner', 'editor']);
    if (!rawLanding) {
      response.status(503).json({ error: { code: 'raw_landing_unavailable', message: 'Raw landing storage is not configured', correlationId: response.locals.correlationId } });
      return;
    }
    const rawId = parse(platformIdSchema, request.params.rawId);
    const sourceBundle = parse(ingestBundleSchema, await rawLanding.replayBundle(context, rawId));
    await requireAcceptedRelationPermission(request, sourceBundle);
    const replayRunId = `replay-${Date.now()}-${rawId.slice(0, 48)}`;
    const bundle = {
      ...sourceBundle,
      source: { ...sourceBundle.source, runId: replayRunId, actor: context.userId },
    };
    const sourceRawObject = await rawLanding.get(context, rawId);
    const result = await industrialPersistence.ingest(
      context,
      bundle,
      response.locals.correlationId,
      {
        storageUri: sourceRawObject.rawObjectUri,
        sha256: sourceRawObject.sha256,
        byteSize: sourceRawObject.byteSize,
        contentType: 'application/json',
      },
    );
    indexSqliteAssets(context, bundle.assets);
    const rawObject = await rawLanding.markReplayed(context, rawId, replayRunId);
    response.status(201).json({ ...result, replayedFromRawObjectId: rawId, rawObject });
  });

  app.post('/api/v1/workspaces', async (request, response) => {
    const identity = await requireDataPlanePermission(identityProvider, request, 'data:ingest');
    const context = platformContext(request);
    const input = parse(workspaceCreateSchema, request.body);
    let workspace: unknown;
    if (workspacePersistence) {
      workspace = await workspacePersistence.createWorkspace(
        workspaceRequestScope(request, identity.userId),
        input,
        response.locals.correlationId,
      );
    } else {
      platformCatalog.assertProjectAccess(context, identity.userId, ['owner']);
      workspace = database.createWorkspace(
        context,
        input,
        identity.userId,
        identity.displayName ?? identity.userId,
        response.locals.correlationId,
      );
    }
    response.status(201).json(workspace);
  });

  app.get('/api/v1/workspaces/:id', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const { actor } = await requireWorkspaceMember(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    response.json(workspacePersistence
      ? await workspacePersistence.getWorkspace(workspaceRequestScope(request, actor), id)
      : database.getWorkspace(id));
  });

  app.put('/api/v1/workspaces/:id', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const update = parse(workspaceUpdateSchema, request.body);
    const { actor } = await requireWorkspaceEditor(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    const authorizedUpdate = { ...update, actor };
    const workspace = workspacePersistence
      ? await workspacePersistence.updateWorkspace(
        workspaceRequestScope(request, actor),
        id,
        authorizedUpdate,
        response.locals.correlationId,
      )
      : database.updateWorkspace(id, authorizedUpdate, response.locals.correlationId);
    if (!workspacePersistence) {
      eventHub.publishWorkspaceUpdated({
        workspaceId: id,
        version: workspace.version,
        actor,
        changeSummary: update.changeSummary,
        updatedAt: workspace.updatedAt,
      });
    }
    response.json(workspace);
  });

  app.get('/api/v1/workspaces/:id/members', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const { actor } = await requireWorkspaceMember(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    response.json(workspacePersistence
      ? await workspacePersistence.listWorkspaceMembers(workspaceRequestScope(request, actor), id)
      : database.listWorkspaceMembers(id));
  });

  app.put('/api/v1/workspaces/:id/members/:userId', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const targetUserId = parse(workspaceUserIdSchema, request.params.userId);
    const update = parse(workspaceMemberUpsertSchema, request.body);
    const { actor, context } = await requireWorkspaceOwner(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    const result = workspacePersistence
      ? await workspacePersistence.upsertWorkspaceMember(
        workspaceRequestScope(request, actor),
        id,
        actor,
        targetUserId,
        update,
        response.locals.correlationId,
      )
      : database.upsertWorkspaceMember(id, actor, targetUserId, update, response.locals.correlationId, context);
    if (!workspacePersistence) {
      eventHub.publishMembersUpdated({
        workspaceId: id,
        actor,
        change: result.created ? 'added' : 'updated',
        member: result.member,
        occurredAt: new Date().toISOString(),
      });
    }
    response.status(result.created ? 201 : 200).json(result.member);
  });

  app.delete('/api/v1/workspaces/:id/members/:userId', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const targetUserId = parse(workspaceUserIdSchema, request.params.userId);
    const { actor, context } = await requireWorkspaceOwner(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    const member = workspacePersistence
      ? await workspacePersistence.removeWorkspaceMember(
        workspaceRequestScope(request, actor),
        id,
        actor,
        targetUserId,
        response.locals.correlationId,
      )
      : database.removeWorkspaceMember(id, actor, targetUserId, response.locals.correlationId, context);
    if (!workspacePersistence) {
      eventHub.publishMembersUpdated({
        workspaceId: id,
        actor,
        change: 'removed',
        member,
        occurredAt: new Date().toISOString(),
      });
    }
    response.status(204).end();
  });

  app.post('/api/v1/workspaces/:id/operations', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const { actor, context } = await requireWorkspaceEditor(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    const update = parse(workspaceOperationsSchema, request.body);
    const workspace = workspacePersistence
      ? await workspacePersistence.applyWorkspaceOperations(
        workspaceRequestScope(request, actor),
        id,
        actor,
        update,
        response.locals.correlationId,
      )
      : database.applyWorkspaceOperations(id, actor, update, response.locals.correlationId, context);
    if (!workspacePersistence) {
      eventHub.publishWorkspaceUpdated({
        workspaceId: id,
        version: workspace.version,
        actor,
        changeSummary: update.changeSummary,
        operations: update.operations,
        updatedAt: workspace.updatedAt,
      });
    }
    response.json(workspace);
  });

  app.get('/api/v1/workspaces/:id/events', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const query = parse(z.object({
      user: workspaceUserIdSchema.optional(),
      tenantId: platformIdSchema.optional(),
      projectId: platformIdSchema.optional(),
    }), request.query);
    const identity = await requireWorkspaceMember(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
      query.user,
      identityProvider.mode === 'development' ? { tenantId: query.tenantId, projectId: query.projectId } : undefined,
    );
    const { actor, context, member } = identity;
    const scope = 'scope' in identity ? identity.scope : undefined;

    response.status(200);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();
    response.write('retry: 3000\n: connected\n\n');

    let delivery = Promise.resolve();
    const unsubscribe = eventHub.subscribe(id, member, (event) => {
      // Redis outbox delivery is asynchronous and can be observed out of
      // order across replicas. Re-read PostgreSQL membership before every
      // durable frame so a revoked client never receives a later workspace
      // payload just because its local subscription has not been removed yet.
      delivery = delivery.then(async () => {
        if (response.writableEnded || response.destroyed) return;
        const changedMember = event.data.member;
        const removalForActor = event.type === 'members.updated'
          && event.data.change === 'removed'
          && changedMember
          && typeof changedMember === 'object'
          && 'userId' in changedMember
          && changedMember.userId === actor;
        if (removalForActor) {
          response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
          response.end();
          return;
        }
        if (workspacePersistence && scope) {
          try {
            await workspacePersistence.getWorkspaceMember(scope, id);
          } catch {
            response.end();
            return;
          }
        } else if (context) {
          try {
            platformCatalog.assertProjectAccess(context, actor);
            database.getWorkspaceMember(id, actor, context);
          } catch {
            response.end();
            return;
          }
        }
        response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }).catch(() => {
        // A delivery-time authorization failure is fail-closed. It must not
        // keep an SSE connection alive after membership can no longer be read.
        if (!response.writableEnded && !response.destroyed) response.end();
      });
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
    const { actor } = await requireWorkspaceMember(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    const query = parse(workspaceRevisionQuerySchema, request.query);
    response.json(workspacePersistence
      ? await workspacePersistence.listWorkspaceRevisions(workspaceRequestScope(request, actor), id, query)
      : database.listWorkspaceRevisions(id, query));
  });

  app.post('/api/v1/workspaces/:id/rollback', async (request, response) => {
    const id = parse(workspaceIdSchema, request.params.id);
    const rollback = parse(workspaceRollbackSchema, request.body);
    const { actor } = await requireWorkspaceEditor(
      database,
      platformCatalog,
      workspacePersistence,
      identityProvider,
      id,
      request,
    );
    const authorizedRollback = { ...rollback, actor };
    const workspace = workspacePersistence
      ? await workspacePersistence.rollbackWorkspace(
        workspaceRequestScope(request, actor),
        id,
        authorizedRollback,
        response.locals.correlationId,
      )
      : database.rollbackWorkspace(id, authorizedRollback, response.locals.correlationId);
    if (!workspacePersistence) {
      eventHub.publishWorkspaceUpdated({
        workspaceId: id,
        version: workspace.version,
        actor,
        changeSummary: rollback.changeSummary || `Rolled back to revision ${rollback.targetVersion}`,
        restoredFromVersion: rollback.targetVersion,
        updatedAt: workspace.updatedAt,
      });
    }
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
    if (error instanceof NotFoundError || error instanceof RuntimeNotFoundError) {
      response.status(404).json({ error: { code: 'not_found', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof ForbiddenError || error instanceof RuntimeForbiddenError) {
      response.status(403).json({ error: { code: 'forbidden', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof ConflictError || error instanceof RuntimeConflictError) {
      response.status(409).json({ error: { code: 'conflict', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof DataIntegrityError) {
      response.status(422).json({ error: { code: 'data_integrity_error', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof ObjectStorageUnavailableError) {
      response.status(503).json({ error: { code: 'object_storage_unavailable', message: error.message, correlationId: response.locals.correlationId } });
      return;
    }
    if (error instanceof RuntimeDatabaseUnavailableError) {
      response.status(503).json({ error: { code: 'database_unavailable', message: error.message, correlationId: response.locals.correlationId } });
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
