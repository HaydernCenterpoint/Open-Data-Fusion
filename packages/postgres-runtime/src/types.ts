export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SqlQuery {
  text: string;
  values?: readonly unknown[];
}

export interface SqlQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface TransactionClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(query: SqlQuery): Promise<SqlQueryResult<Row>>;
}

export interface RuntimeClient extends TransactionClient {
  release(error?: boolean): void;
}

export interface RuntimePool extends TransactionClient {
  connect(): Promise<RuntimeClient>;
  end(): Promise<void>;
}

/**
 * Calling set_config with the third argument true gives PostgreSQL SET LOCAL
 * semantics. Every setting is applied at the beginning of a transaction so a
 * pooled connection cannot retain a prior request identity.
 */
export interface TransactionContext {
  tenantId: string | null;
  /** Optional project scope used by project-aware RLS policies such as audit. */
  projectId?: string | null;
  userId: string;
  platformAdmin?: boolean;
}

/**
 * Workspace history is legacy data, but production access is now always tied
 * to the immutable workspace-to-project scope established at cutover.
 */
export interface WorkspaceScope extends TransactionContext {
  tenantId: string;
  projectId: string;
}

export interface ScopedTransaction extends TransactionClient {
  /**
   * Only database access is exposed. Complete network I/O before entering a
   * transaction and enqueue delivery through the transactional outbox.
   */
  readonly kind: "database-transaction";
}

export interface TransactionRunner {
  withTransaction<T>(
    context: TransactionContext,
    work: (transaction: ScopedTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface DatabaseHealth {
  status: "ok" | "degraded";
  database: string | null;
  timestamp: string;
}

export interface DatabaseReadiness {
  status: "ready" | "not_ready";
  schemaPresent: boolean;
  tenantDataPlanePresent: boolean;
  workspaceScopePresent: boolean;
  projectMembershipPresent: boolean;
  workspaceGrantsPresent: boolean;
  /**
   * The connected principal is suitable for the production Canvas API: it is
   * a non-elevated application login without cutover, bootstrap, or
   * outbox-publisher capabilities.
   */
  apiPrincipalAttested: boolean;
  timestamp: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  snapshot: JsonObject;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface WorkspaceRevisionRecord {
  workspaceId: string;
  version: number;
  snapshot: JsonObject;
  changeSummary: string;
  actor: string;
  createdAt: string;
  correlationId: string;
}

export type WorkspaceRole = "owner" | "editor" | "reviewer" | "viewer";

export interface WorkspaceMemberRecord {
  workspaceId: string;
  userId: string;
  displayName: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceCreateInput {
  workspaceId: string;
  name: string;
  correlationId: string;
}

export interface WorkspaceMutationInput {
  workspaceId: string;
  expectedVersion: number;
  snapshot: JsonObject;
  changeSummary: string;
  actor: string;
  correlationId: string;
  /**
   * The durable audit action. The default preserves the original
   * `workspace.saved` behavior for callers that do not need a more specific
   * canvas action.
   */
  auditAction?: string;
  /** Extra, JSON-safe fields to retain with the immutable audit record. */
  auditDetails?: JsonObject;
  eventType?: string;
  topic?: string;
  /** Extra, JSON-safe fields to retain with the transactional outbox event. */
  eventPayload?: JsonObject;
  headers?: JsonObject;
  deduplicationKey?: string;
}

export interface WorkspaceMembershipUpsertInput {
  workspaceId: string;
  actor: string;
  member: Omit<WorkspaceMemberRecord, "workspaceId" | "createdAt">;
  correlationId: string;
}

export interface WorkspaceMembershipRemoveInput {
  workspaceId: string;
  actor: string;
  memberUserId: string;
  correlationId: string;
}

export interface WorkspaceMemberUpsertResult {
  member: WorkspaceMemberRecord;
  created: boolean;
}

export interface WorkspaceRevisionPage {
  items: WorkspaceRevisionRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface WorkspaceRepository {
  createWorkspace(context: WorkspaceScope, input: WorkspaceCreateInput): Promise<WorkspaceRecord>;
  getWorkspace(context: WorkspaceScope, workspaceId: string): Promise<WorkspaceRecord>;
  getWorkspaceMember(context: WorkspaceScope, workspaceId: string): Promise<WorkspaceMemberRecord>;
  listWorkspaceMembers(context: WorkspaceScope, workspaceId: string): Promise<WorkspaceMemberRecord[]>;
  listWorkspaceRevisions(
    context: WorkspaceScope,
    workspaceId: string,
    limit: number,
    offset: number,
  ): Promise<WorkspaceRevisionPage>;
  getWorkspaceRevision(
    context: WorkspaceScope,
    workspaceId: string,
    version: number,
  ): Promise<WorkspaceRevisionRecord>;
  mutateWorkspace(context: WorkspaceScope, input: WorkspaceMutationInput): Promise<WorkspaceRecord>;
  upsertWorkspaceMember(context: WorkspaceScope, input: WorkspaceMembershipUpsertInput): Promise<WorkspaceMemberRecord>;
  removeWorkspaceMember(context: WorkspaceScope, input: WorkspaceMembershipRemoveInput): Promise<WorkspaceMemberRecord>;
}

export type IngestionRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "quarantined";

export interface RawIngestObjectRecord {
  rawObjectId: string;
  tenantId: string;
  projectId: string;
  datasetId: string | null;
  sourceConnectionId: string;
  storageUri: string;
  contentSha256: string;
  contentType: string | null;
  byteSize: number;
  receivedAt: string;
  retentionUntil: string | null;
  encryptionKeyRef: string | null;
  metadata: JsonObject;
}

export interface IngestionRunRecord {
  ingestionRunId: string;
  tenantId: string;
  projectId: string;
  datasetId: string | null;
  sourceConnectionId: string;
  rawObjectId: string | null;
  idempotencyKey: string;
  state: IngestionRunState;
  checkpointBefore: JsonObject | null;
  checkpointAfter: JsonObject | null;
  acceptedRecords: number;
  rejectedRecords: number;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  correlationId: string;
}

export interface CanonicalIngestInput {
  tenantId: string;
  projectId: string;
  datasetId?: string | null;
  sourceConnectionId: string;
  idempotencyKey: string;
  actor: string;
  correlationId: string;
  raw: {
    storageUri: string;
    contentSha256: string;
    contentType?: string | null;
    byteSize: number;
    retentionUntil?: string | null;
    encryptionKeyRef?: string | null;
    metadata?: JsonObject;
  };
  checkpointBefore?: JsonObject | null;
}

export interface CanonicalIngestResult {
  rawObject: RawIngestObjectRecord;
  ingestionRun: IngestionRunRecord;
  rawObjectCreated: boolean;
  ingestionRunCreated: boolean;
}

export interface RawObjectCursor {
  receivedAt: string;
  rawObjectId: string;
}

export interface IngestionRunCursor {
  startedAt: string;
  ingestionRunId: string;
}

export interface KeysetPage<T, Cursor> {
  items: T[];
  nextCursor: Cursor | null;
}

export interface IngestionRepository {
  createCanonicalIngest(input: CanonicalIngestInput): Promise<CanonicalIngestResult>;
  listRawObjects(
    context: TransactionContext,
    projectId: string,
    limit: number,
    cursor?: RawObjectCursor,
  ): Promise<KeysetPage<RawIngestObjectRecord, RawObjectCursor>>;
  listIngestionRuns(
    context: TransactionContext,
    projectId: string,
    limit: number,
    cursor?: IngestionRunCursor,
  ): Promise<KeysetPage<IngestionRunRecord, IngestionRunCursor>>;
}

export interface OutboxEventRecord {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  topic: string;
  messageKey: string;
  payload: JsonObject;
  headers: JsonObject;
  deduplicationKey: string;
  correlationId: string;
  occurredAt: string;
  attemptCount: number;
}

export interface ClaimOutboxInput {
  workerId: string;
  batchSize: number;
  leaseMilliseconds: number;
}

export interface PipelineRunRecord {
  pipelineRunId: string;
  tenantId: string;
  projectId: string;
  pipelineId: string;
  pipelineVersion: number;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  triggerType: "manual" | "schedule" | "event";
  correlationId: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: JsonObject;
}

export interface ClaimPipelineRunsInput {
  tenantId: string;
  projectId: string;
  workerId: string;
  batchSize: number;
  correlationId: string;
}

export interface QueueRepository {
  claimOutboxEvents(input: ClaimOutboxInput): Promise<OutboxEventRecord[]>;
  markOutboxPublished(eventId: string, workerId: string): Promise<void>;
  releaseOutboxEvent(eventId: string, workerId: string, errorMessage: string, delayMilliseconds: number): Promise<void>;
  claimPipelineRuns(input: ClaimPipelineRunsInput): Promise<PipelineRunRecord[]>;
}
