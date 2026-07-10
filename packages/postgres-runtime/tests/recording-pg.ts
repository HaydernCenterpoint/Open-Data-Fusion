import type {
  RuntimeClient,
  RuntimePool,
  SqlQuery,
  SqlQueryResult,
} from "../src/types.js";

export type QueryHandler = (
  query: SqlQuery,
  index: number,
) => SqlQueryResult<Record<string, unknown>> | Error | Promise<SqlQueryResult<Record<string, unknown>> | Error>;

export class RecordingClient implements RuntimeClient {
  readonly queries: SqlQuery[] = [];
  released = false;
  releasedWithError = false;

  constructor(private readonly handler: QueryHandler = () => ({ rows: [], rowCount: 0 })) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(query: SqlQuery): Promise<SqlQueryResult<Row>> {
    this.queries.push({
      text: query.text,
      ...(query.values ? { values: [...query.values] } : {}),
    });
    const response = await this.handler(query, this.queries.length - 1);
    if (response instanceof Error) throw response;
    return response as SqlQueryResult<Row>;
  }

  release(error?: boolean): void {
    this.released = true;
    this.releasedWithError = error === true;
  }
}

export class RecordingPool implements RuntimePool {
  connectCalls = 0;
  endCalls = 0;
  readonly directQueries: SqlQuery[] = [];

  constructor(
    readonly client: RecordingClient,
    private readonly directHandler: QueryHandler = () => ({ rows: [], rowCount: 0 }),
  ) {}

  async connect(): Promise<RuntimeClient> {
    this.connectCalls += 1;
    return this.client;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(query: SqlQuery): Promise<SqlQueryResult<Row>> {
    this.directQueries.push(query);
    const response = await this.directHandler(query, this.directQueries.length - 1);
    if (response instanceof Error) throw response;
    return response as SqlQueryResult<Row>;
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

export function result<Row extends Record<string, unknown>>(rows: Row[] = []): SqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

export function pgFailure(code: string, constraint?: string): Error {
  return Object.assign(new Error("internal postgres detail must not leak"), {
    code,
    ...(constraint ? { constraint } : {}),
  });
}
