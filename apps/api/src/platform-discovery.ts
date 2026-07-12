import {
  ConflictError as RuntimeConflictError,
  DatabaseUnavailableError as RuntimeDatabaseUnavailableError,
  ForbiddenError as RuntimeForbiddenError,
  NotFoundError as RuntimeNotFoundError,
  type PostgresRuntime,
} from '@open-data-fusion/postgres-runtime';
import { z } from 'zod';

import { ConflictError, ForbiddenError, NotFoundError } from './database.js';
import { cursorListQuerySchema, type CursorListQuery } from './platform-schemas.js';
import type { PlatformCatalog } from './platform.js';

export interface PlatformTenantDiscovery {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface PlatformProjectDiscovery {
  tenantId: string;
  id: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PlatformDiscoveryPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Tenant/project selection is a separate persistence seam from the remaining
 * platform catalog. PostgreSQL mode is intentionally read-only at the API
 * edge; tenant bootstrap remains the purpose-specific provisioning workflow.
 */
export interface PlatformDiscoveryPersistence {
  readonly mode: 'sqlite' | 'postgres';
  listTenants(
    userId: string,
    includeAll: boolean,
    query: CursorListQuery,
  ): Promise<PlatformDiscoveryPage<PlatformTenantDiscovery>>;
  listProjects(
    tenantId: string,
    userId: string,
    includeAll: boolean,
    query: CursorListQuery,
  ): Promise<PlatformDiscoveryPage<PlatformProjectDiscovery>>;
}

const uuidSchema = z.string().uuid();
const uuidCursorSchema = z.object({ id: uuidSchema }).strict();

type PostgresDiscoveryRow = Record<string, unknown>;

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  let decoded: unknown = null;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // Zod below produces the same stable validation response as other cursors.
  }
  return uuidCursorSchema.parse(decoded).id;
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`PostgreSQL discovery returned an invalid ${label}`);
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function timestamp(value: unknown, label: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return requiredString(value, label);
}

function tenantFromRow(row: PostgresDiscoveryRow): PlatformTenantDiscovery {
  return {
    id: requiredString(row.id, 'tenant id'),
    name: requiredString(row.name, 'tenant name'),
    createdBy: requiredString(row.created_by, 'tenant creator'),
    createdAt: timestamp(row.created_at, 'tenant creation timestamp'),
  };
}

function projectFromRow(row: PostgresDiscoveryRow): PlatformProjectDiscovery {
  return {
    tenantId: requiredString(row.tenant_id, 'project tenant id'),
    id: requiredString(row.id, 'project id'),
    name: requiredString(row.name, 'project name'),
    description: nullableString(row.description),
    createdBy: requiredString(row.created_by, 'project creator'),
    createdAt: timestamp(row.created_at, 'project creation timestamp'),
  };
}

function pageFromRows<T extends { id: string }>(rows: PostgresDiscoveryRow[], limit: number, mapper: (row: PostgresDiscoveryRow) => T): PlatformDiscoveryPage<T> {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapper);
  const tail = items.at(-1);
  return {
    items,
    nextCursor: hasMore && tail ? encodeCursor(tail.id) : null,
  };
}

function translateRuntimeError(error: unknown): Error {
  if (error instanceof RuntimeForbiddenError) return new ForbiddenError(error.message);
  if (error instanceof RuntimeNotFoundError) return new NotFoundError(error.message);
  if (error instanceof RuntimeConflictError) return new ConflictError(error.message);
  if (error instanceof RuntimeDatabaseUnavailableError) return error;
  return error instanceof Error ? error : new Error('PostgreSQL project discovery failed');
}

export class SqlitePlatformDiscoveryPersistence implements PlatformDiscoveryPersistence {
  readonly mode = 'sqlite' as const;

  constructor(private readonly catalog: PlatformCatalog) {}

  async listTenants(
    userId: string,
    includeAll: boolean,
    query: CursorListQuery,
  ): Promise<PlatformDiscoveryPage<PlatformTenantDiscovery>> {
    return this.catalog.listTenants(userId, includeAll, query) as unknown as PlatformDiscoveryPage<PlatformTenantDiscovery>;
  }

  async listProjects(
    tenantId: string,
    userId: string,
    includeAll: boolean,
    query: CursorListQuery,
  ): Promise<PlatformDiscoveryPage<PlatformProjectDiscovery>> {
    return this.catalog.listProjects(tenantId, userId, includeAll, query) as unknown as PlatformDiscoveryPage<PlatformProjectDiscovery>;
  }
}

export class PostgresPlatformDiscoveryPersistence implements PlatformDiscoveryPersistence {
  readonly mode = 'postgres' as const;

  constructor(private readonly runtime: PostgresRuntime) {}

  /** Fail startup before serving a profile whose discovery migration/grants are missing. */
  async assertReady(): Promise<void> {
    try {
      const ready = await this.runtime.withTransaction({
        tenantId: null,
        userId: 'odf-api-readiness',
        platformAdmin: false,
      }, async (transaction) => transaction.query<{ ready: unknown }>({
        text: [
          'SELECT (',
          "  to_regprocedure('odf.discover_accessible_tenants(uuid,integer)') IS NOT NULL",
          "  AND to_regprocedure('odf.discover_accessible_projects(uuid,integer)') IS NOT NULL",
          "  AND has_function_privilege(current_user, 'odf.discover_accessible_tenants(uuid,integer)', 'EXECUTE')",
          "  AND has_function_privilege(current_user, 'odf.discover_accessible_projects(uuid,integer)', 'EXECUTE')",
          ') AS ready',
        ].join('\n'),
      }));
      if (ready.rows[0]?.ready !== true) throw new Error('PostgreSQL project discovery is not ready');
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async listTenants(
    userId: string,
    _includeAll: boolean,
    rawQuery: CursorListQuery,
  ): Promise<PlatformDiscoveryPage<PlatformTenantDiscovery>> {
    const query = cursorListQuerySchema.parse(rawQuery);
    const after = decodeCursor(query.cursor);
    try {
      return await this.runtime.withTransaction({ tenantId: null, userId, platformAdmin: false }, async (transaction) => {
        const result = await transaction.query({
          text: [
            'SELECT id, name, created_by, created_at',
            'FROM odf.discover_accessible_tenants($1::uuid, $2::integer)',
            'ORDER BY id',
          ].join('\n'),
          values: [after, query.limit + 1],
        });
        return pageFromRows(result.rows, query.limit, tenantFromRow);
      });
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }

  async listProjects(
    rawTenantId: string,
    userId: string,
    _includeAll: boolean,
    rawQuery: CursorListQuery,
  ): Promise<PlatformDiscoveryPage<PlatformProjectDiscovery>> {
    const tenantId = uuidSchema.parse(rawTenantId);
    const query = cursorListQuerySchema.parse(rawQuery);
    const after = decodeCursor(query.cursor);
    try {
      return await this.runtime.withTransaction({ tenantId, userId, platformAdmin: false }, async (transaction) => {
        const result = await transaction.query({
          text: [
            'SELECT tenant_id, id, name, description, created_by, created_at',
            'FROM odf.discover_accessible_projects($1::uuid, $2::integer)',
            'ORDER BY id',
          ].join('\n'),
          values: [after, query.limit + 1],
        });
        return pageFromRows(result.rows, query.limit, projectFromRow);
      });
    } catch (error) {
      throw translateRuntimeError(error);
    }
  }
}
