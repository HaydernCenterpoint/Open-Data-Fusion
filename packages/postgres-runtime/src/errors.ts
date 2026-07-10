export class PostgresRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConflictError extends PostgresRuntimeError {}
export class NotFoundError extends PostgresRuntimeError {}
export class ForbiddenError extends PostgresRuntimeError {}
export class DatabaseUnavailableError extends PostgresRuntimeError {}

interface PgErrorShape {
  code?: unknown;
  constraint?: unknown;
}

function pgError(error: unknown): PgErrorShape | null {
  return error && typeof error === "object" ? error as PgErrorShape : null;
}

/**
 * Convert PostgreSQL failures into stable domain errors. The original SQL
 * message is deliberately never exposed to callers because it can disclose
 * table names, query fragments, and internal topology.
 */
export function mapPostgresError(error: unknown): Error {
  if (error instanceof PostgresRuntimeError) return error;

  const details = pgError(error);
  const code = typeof details?.code === "string" ? details.code : "";
  const constraint = typeof details?.constraint === "string" ? details.constraint : "";

  if (constraint === "workspace_must_retain_owner") {
    return new ConflictError("Workspace must retain at least one owner");
  }
  if (code === "42501" || code === "28000") {
    return new ForbiddenError("Database access is not permitted");
  }
  if (code === "23503") {
    return new NotFoundError("A referenced resource was not found");
  }
  if (code === "23505" || code === "23514" || code === "23P01" || code === "40001" || code === "40P01") {
    return new ConflictError("The requested change conflicts with current data");
  }
  if (code.startsWith("08") || code === "57P01") {
    return new DatabaseUnavailableError("Database is temporarily unavailable");
  }
  return new DatabaseUnavailableError("Database operation failed");
}
