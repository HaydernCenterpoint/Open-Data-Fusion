import { pipeline } from 'node:stream/promises';

import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';

import type { DataPlanePermission } from './auth.js';
import {
  governedObjectIdSchema,
  governedObjectListQuerySchema,
  governedUploadMetadataSchema,
  governedVersionSchema,
} from './object-schemas.js';
import {
  ObjectTooLargeError,
  type GovernedObjectByteRange,
  type GovernedObjectContext,
  type GovernedObjectPersistence,
} from './object-store.js';
import type { PlatformProjectRole } from './platform.js';

function parse<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.output<TSchema> {
  return schema.parse(value) as z.output<TSchema>;
}

export interface GovernedObjectRouteAuthorization {
  identity: { userId: string };
  context: GovernedObjectContext;
}

export type GovernedObjectRouteAuthorizer = (
  request: Request,
  permission: DataPlanePermission,
  roles?: readonly PlatformProjectRole[],
) => Promise<GovernedObjectRouteAuthorization>;

class InvalidRangeError extends Error {}

function parseRange(value: string, size: number): GovernedObjectByteRange {
  if (size === 0 || value.includes(',')) throw new InvalidRangeError('Only one satisfiable byte range is supported');
  const match = value.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2])) throw new InvalidRangeError('Invalid byte range');
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new InvalidRangeError('Invalid byte range');
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    throw new InvalidRangeError('Unsatisfiable byte range');
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').map((value) => value.trim()).some((value) => value === '*' || value === etag);
}

function contentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function unavailable(response: Parameters<RequestHandler>[1]): void {
  response.status(503).json({
    error: {
      code: 'object_store_unavailable',
      message: 'Governed object storage is not configured',
      correlationId: response.locals.correlationId,
    },
  });
}

async function sendContent(
  request: Request,
  response: Parameters<RequestHandler>[1],
  store: GovernedObjectPersistence,
  context: GovernedObjectContext,
  actor: string,
  objectId: string,
  version: number | undefined,
): Promise<void> {
  const download = await store.download(context, objectId, version);
  response.setHeader('etag', download.etag);
  response.setHeader('accept-ranges', 'bytes');
  response.setHeader('content-type', download.mimeType);
  response.setHeader('content-disposition', contentDisposition(download.fileName));
  response.setHeader('cache-control', 'private, no-cache');
  if (etagMatches(request.header('if-none-match'), download.etag)) {
    response.status(304).end();
    return;
  }

  let range: GovernedObjectByteRange | null = null;
  const rangeHeader = request.header('range');
  const ifRange = request.header('if-range');
  if (rangeHeader && (!ifRange || ifRange === download.etag)) {
    try {
      range = parseRange(rangeHeader, download.sizeBytes);
    } catch (error) {
      if (!(error instanceof InvalidRangeError)) throw error;
      response.setHeader('content-range', `bytes */${download.sizeBytes}`);
      response.removeHeader('content-disposition');
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.status(416).json({
        error: {
          code: 'range_not_satisfiable',
          message: error.message,
          correlationId: response.locals.correlationId,
        },
      });
      return;
    }
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, download.sizeBytes - 1);
  const contentLength = range ? end - start + 1 : download.sizeBytes;
  response.setHeader('content-length', String(contentLength));
  if (range) {
    response.setHeader('content-range', `bytes ${start}-${end}/${download.sizeBytes}`);
    response.status(206);
  } else {
    response.status(200);
  }
  await store.recordDownload(context, download, actor, response.locals.correlationId, range);
  if (request.method === 'HEAD' || download.sizeBytes === 0) {
    response.end();
    return;
  }
  try {
    await pipeline(await store.openContent(download, range ?? undefined), response);
  } catch (error) {
    if (!request.destroyed && !response.destroyed) throw error;
  }
}

export function registerGovernedObjectRoutes(
  app: Express,
  store: GovernedObjectPersistence | null,
  authorizeProject: GovernedObjectRouteAuthorizer,
): void {
  const upload: RequestHandler = async (request, response) => {
    const { context, identity } = await authorizeProject(request, 'data:ingest', ['owner', 'editor']);
    if (!store) {
      request.resume();
      unavailable(response);
      return;
    }
    const objectId = parse(governedObjectIdSchema, request.params.objectId);
    const rawLength = request.header('content-length');
    const contentLength = rawLength === undefined ? undefined : Number(rawLength);
    const requestedFileName = request.header('x-odf-file-name') ?? request.query.fileName;
    const requestedTitle = request.header('x-odf-title') ?? request.query.title;
    const metadata = parse(governedUploadMetadataSchema, {
      fileName: requestedFileName ?? `${objectId}.bin`,
      title: requestedTitle ?? requestedFileName ?? objectId,
      mimeType: request.header('content-type') ?? 'application/octet-stream',
      ...(contentLength !== undefined ? { contentLength } : {}),
    });
    if (metadata.contentLength !== undefined && metadata.contentLength > store.maxObjectBytes) {
      request.resume();
      response.status(413).json({
        error: {
          code: 'object_too_large',
          message: `Object exceeds the ${store.maxObjectBytes}-byte upload limit`,
          correlationId: response.locals.correlationId,
        },
      });
      return;
    }
    try {
      response.status(201).json(await store.upload(
        context,
        objectId,
        metadata,
        request,
        identity.userId,
        response.locals.correlationId,
      ));
    } catch (error) {
      if (!(error instanceof ObjectTooLargeError)) throw error;
      response.status(413).json({
        error: {
          code: 'object_too_large',
          message: error.message,
          correlationId: response.locals.correlationId,
        },
      });
    }
  };

  app.post([
    '/api/v1/platform/objects/:objectId/versions',
    '/api/v1/platform/files/:objectId/versions',
  ], upload);
  app.put('/api/v1/platform/objects/:objectId/content', upload);

  app.get(['/api/v1/platform/objects', '/api/v1/platform/files'], async (request, response) => {
    const { context } = await authorizeProject(request, 'data:read');
    if (!store) return unavailable(response);
    response.json(await store.listObjects(context, parse(governedObjectListQuerySchema, request.query)));
  });

  app.get([
    '/api/v1/platform/objects/:objectId',
    '/api/v1/platform/files/:objectId',
  ], async (request, response) => {
    const { context } = await authorizeProject(request, 'data:read');
    if (!store) return unavailable(response);
    response.json(await store.getObject(context, parse(governedObjectIdSchema, request.params.objectId)));
  });

  app.get([
    '/api/v1/platform/objects/:objectId/versions',
    '/api/v1/platform/files/:objectId/versions',
  ], async (request, response) => {
    const { context } = await authorizeProject(request, 'data:read');
    if (!store) return unavailable(response);
    response.json(await store.listVersions(
      context,
      parse(governedObjectIdSchema, request.params.objectId),
      parse(governedObjectListQuerySchema, request.query),
    ));
  });

  app.get([
    '/api/v1/platform/objects/:objectId/events',
    '/api/v1/platform/files/:objectId/events',
  ], async (request, response) => {
    const { context } = await authorizeProject(request, 'audit:read');
    if (!store) return unavailable(response);
    response.json(await store.listEvents(
      context,
      parse(governedObjectIdSchema, request.params.objectId),
      parse(governedObjectListQuerySchema, request.query),
    ));
  });

  app.get([
    '/api/v1/platform/objects/:objectId/content',
    '/api/v1/platform/files/:objectId/content',
  ], async (request, response) => {
    const { context, identity } = await authorizeProject(request, 'data:read');
    if (!store) return unavailable(response);
    await sendContent(
      request,
      response,
      store,
      context,
      identity.userId,
      parse(governedObjectIdSchema, request.params.objectId),
      undefined,
    );
  });

  app.get([
    '/api/v1/platform/objects/:objectId/versions/:version/content',
    '/api/v1/platform/files/:objectId/versions/:version/content',
  ], async (request, response) => {
    const { context, identity } = await authorizeProject(request, 'data:read');
    if (!store) return unavailable(response);
    await sendContent(
      request,
      response,
      store,
      context,
      identity.userId,
      parse(governedObjectIdSchema, request.params.objectId),
      parse(governedVersionSchema, request.params.version),
    );
  });
}
