import type {
  JsonObject,
  KeysetPage,
  TransactionContext,
} from "./types.js";

/** A project-scoped transaction whose tenant is always present for RLS. */
export interface ProjectScope extends TransactionContext {
  tenantId: string;
  projectId: string;
}

export interface TenantScope extends TransactionContext {
  tenantId: string;
}

export type ProjectRole = "owner" | "editor" | "reviewer" | "viewer";
export type TenantMemberRole = "owner" | "admin" | "viewer";

/** Durable tenant-wide membership, managed only through migration 012 routines. */
export interface TenantMemberRecord {
  tenantId: string;
  userId: string;
  role: TenantMemberRole;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Durable project membership, distinct from per-workspace Canvas membership. */
export interface ProjectMemberRecord {
  tenantId: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Migration 003 deliberately has no project-membership table. Callers inject
 * this resolver from their identity/authorization system before a database
 * transaction begins. The built-in default rejects every request.
 */
export interface ProjectAccessResolver {
  resolve(scope: ProjectScope): Promise<{ role: ProjectRole } | null>;
  /** Tenant-wide discovery/bootstrap is unavailable unless explicitly granted. */
  resolveTenantManagement?(scope: TenantScope): Promise<{ canManageProjects: boolean } | null>;
}

export interface TextCursor {
  value: string;
}

export interface TimestampIdCursor {
  timestamp: string;
  id: string;
}

export interface NumericCursor {
  value: string;
}

export interface UnifiedSearchCursor {
  timestamp: string;
  entityType: UnifiedSearchResult["entityType"];
  entityId: string;
}

export interface TenantRecord {
  tenantId: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "retired";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  projectId: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  status: "active" | "suspended" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface DatasetRecord {
  datasetId: string;
  tenantId: string;
  projectId: string;
  externalId: string;
  name: string;
  description: string | null;
  classification: "public" | "internal" | "confidential" | "restricted";
  retentionUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelSpaceRecord {
  spaceId: string;
  tenantId: string;
  projectId: string;
  externalId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceConnectionRecord {
  sourceConnectionId: string;
  tenantId: string;
  projectId: string;
  datasetId: string | null;
  externalId: string;
  name: string;
  connectorKind: "opcua" | "jdbc" | "csv" | "http";
  state: "draft" | "ready" | "running" | "degraded" | "disabled";
  endpoint: string | null;
  secretRef: string | null;
  connectorConfig: JsonObject;
  lastSuccessfulRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataModelRecord {
  dataModelId: string;
  tenantId: string;
  projectId: string;
  spaceId: string;
  externalId: string;
  version: string;
  name: string;
  description: string | null;
  definition: JsonObject;
  state: "draft" | "published" | "deprecated";
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface ModelViewRecord {
  modelViewId: string;
  tenantId: string;
  dataModelId: string;
  externalId: string;
  version: string;
  name: string;
  definition: JsonObject;
  createdAt: string;
}

export type PublicModelPropertyType =
  | "text"
  | "int64"
  | "float64"
  | "boolean"
  | "timestamp"
  | "date"
  | "json"
  | "direct";

export interface PublicModelPropertyDefinition {
  type: PublicModelPropertyType;
  required?: boolean;
  nullable?: boolean;
  list?: boolean;
}

export interface PublicModelViewDefinition {
  externalId: string;
  name: string;
  usedFor: "node" | "edge";
  properties: Record<string, PublicModelPropertyDefinition>;
}

export interface PublicModelVersion {
  tenantId: string;
  projectId: string;
  id: string;
  version: number;
  name: string;
  schema: JsonObject;
  status: "draft" | "published";
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface PublicModelView extends PublicModelViewDefinition {
  modelId: string;
  modelVersion: number;
  createdAt: string;
}

export interface ModelVersionCursor {
  createdAt: string;
  modelId: string;
  version: number;
}

export interface GraphInstanceRecord {
  instanceId: string;
  tenantId: string;
  projectId: string;
  datasetId: string | null;
  spaceId: string;
  externalId: string;
  instanceKind: "node" | "edge";
  dataModelId: string | null;
  properties: JsonObject;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetRecord {
  assetId: string;
  tenantId: string;
  projectId: string;
  parentAssetId: string | null;
  assetKind: "site" | "system" | "equipment" | "instrument" | "location";
  assetType: string;
  name: string;
  description: string | null;
  site: string | null;
  sourceSystem: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface TimeSeriesRecord {
  timeSeriesId: string;
  tenantId: string;
  projectId: string;
  datasetId: string | null;
  assetId: string | null;
  name: string;
  unit: string | null;
  valueType: "numeric" | "string" | "state";
  interpolation: "linear" | "step" | "none";
  sourceSystem: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface TimeSeriesPointRecord {
  tenantId: string;
  projectId: string;
  timeSeriesId: string;
  observedAt: string;
  sequence: string;
  numericValue: number | null;
  textValue: string | null;
  quality: "good" | "uncertain" | "bad" | "unknown";
  sourceConnectionId: string | null;
  ingestionRunId: string | null;
  receivedAt: string;
}

export interface TimeSeriesBucket {
  bucketStart: string;
  pointCount: string;
  numericMinimum: number | null;
  numericMaximum: number | null;
  numericAverage: number | null;
  latestTextValue: string | null;
}

export interface DocumentRecord {
  documentId: string;
  tenantId: string;
  projectId: string;
  datasetId: string | null;
  rawObjectId: string | null;
  title: string;
  mimeType: string | null;
  storageUri: string | null;
  byteSize: string | null;
  contentSha256: string | null;
  sourceSystem: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentAssetLinkRecord {
  tenantId: string;
  projectId: string;
  documentId: string;
  assetId: string;
  relationType: string;
  createdAt: string;
}

export interface RelationRecord {
  relationId: string;
  tenantId: string;
  projectId: string;
  datasetId: string | null;
  sourceInstanceId: string;
  targetInstanceId: string;
  relationType: string;
  state: "accepted" | "superseded";
  sourceSystem: string;
  evidence: JsonObject;
  createdAt: string;
  supersededAt: string | null;
}

export interface RelationCandidateRecord {
  relationCandidateId: string;
  tenantId: string;
  projectId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  relationType: string;
  confidence: number;
  evidence: JsonObject[];
  ruleVersion: string | null;
  modelVersion: string | null;
  state: "proposed" | "accepted" | "rejected" | "superseded";
  reviewer: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  acceptedRelationId: string | null;
  createdAt: string;
}

export interface PipelineRecord {
  pipelineId: string;
  tenantId: string;
  projectId: string;
  externalId: string;
  name: string;
  description: string | null;
  currentVersion: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineVersionRecord {
  pipelineVersionId: string;
  tenantId: string;
  projectId: string;
  pipelineId: string;
  version: number;
  definition: JsonObject;
  schedule: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PipelineRunRecordV2 {
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

export interface QualityRuleRecord {
  qualityRuleId: string;
  tenantId: string;
  projectId: string;
  externalId: string;
  version: number;
  name: string;
  ruleKind: "required" | "range" | "regex" | "unique" | "reference";
  targetModelExternalId: string;
  fieldName: string | null;
  configuration: JsonObject;
  severity: "info" | "warning" | "error";
  enabled: boolean;
  createdAt: string;
}

export interface QualityResultRecord {
  qualityResultId: string;
  tenantId: string;
  projectId: string;
  qualityRuleId: string;
  pipelineRunId: string | null;
  passed: boolean;
  checkedRecords: string;
  failedRecords: string;
  sampleFailures: JsonObject[];
  occurredAt: string;
}

export interface WritebackRequestRecord {
  writebackRequestId: string;
  tenantId: string;
  projectId: string;
  sourceConnectionId: string;
  targetInstanceId: string | null;
  targetExternalId: string;
  operation: string;
  payload: JsonObject;
  risk: "low" | "medium" | "high" | "critical";
  state: "draft" | "pending_approval" | "approved" | "executing" | "succeeded" | "failed" | "cancelled";
  requestedBy: string;
  requestedAt: string;
  dryRunResult: JsonObject | null;
  executedAt: string | null;
  updatedAt: string;
}

export interface WritebackApprovalRecord {
  writebackApprovalId: string;
  tenantId: string;
  writebackRequestId: string;
  actor: string;
  decision: "approved" | "rejected";
  comment: string | null;
  occurredAt: string;
}

/** Audit log is the migration-003 recovery/event boundary for write-back. */
export interface WritebackEventRecord {
  id: string;
  actor: string;
  action: string;
  entityId: string | null;
  details: JsonObject;
  correlationId: string;
  occurredAt: string;
}

export interface UnifiedSearchResult {
  /** Projection entity type; migration-013 is intentionally extensible. */
  entityType: string;
  entityId: string;
  title: string;
  summary: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  projectId: string;
  slug: string;
  name: string;
  description?: string | null;
  status?: ProjectRecord["status"];
  correlationId: string;
}

export interface UpdateProjectInput {
  projectId: string;
  name?: string;
  description?: string | null;
  status?: ProjectRecord["status"];
  correlationId: string;
}

/** Inputs for the governed user-facing project administration boundary. */
export interface ManagedProjectCreateInput {
  projectId: string;
  slug: string;
  name: string;
  description?: string | null;
  correlationId: string;
}

export interface ManagedTenantUpdateInput {
  name?: string;
  status?: TenantRecord["status"];
  correlationId: string;
}

export interface ManagedProjectUpdateInput {
  name?: string;
  /** `undefined` leaves it unchanged while `null` clears the description. */
  description?: string | null;
  status?: ProjectRecord["status"];
  correlationId: string;
}

export interface TenantMemberUpsertInput {
  userId: string;
  role: TenantMemberRole;
  correlationId: string;
}

export interface ProjectMemberUpsertInput {
  userId: string;
  role: ProjectRole;
  correlationId: string;
}

export interface ManagedProjectMutation {
  project: ProjectRecord;
  created?: boolean;
  changed: boolean;
}

export interface ManagedTenantMutation {
  tenant: TenantRecord;
  changed: boolean;
}

export interface ManagedMemberMutation<TMember> {
  member: TMember;
  created: boolean;
  changed: boolean;
}

export interface CreateDatasetInput {
  datasetId: string;
  externalId: string;
  name: string;
  description?: string | null;
  classification?: DatasetRecord["classification"];
  retentionUntil?: string | null;
  correlationId: string;
}

export interface CreateModelSpaceInput {
  spaceId: string;
  externalId: string;
  name: string;
  description?: string | null;
  correlationId: string;
}

export interface CreateSourceConnectionInput {
  sourceConnectionId: string;
  datasetId?: string | null;
  externalId: string;
  name: string;
  connectorKind: SourceConnectionRecord["connectorKind"];
  state?: SourceConnectionRecord["state"];
  endpoint?: string | null;
  secretRef?: string | null;
  connectorConfig?: JsonObject;
  correlationId: string;
}

export interface CreateDataModelInput {
  dataModelId: string;
  spaceId: string;
  externalId: string;
  version: string;
  name: string;
  description?: string | null;
  definition: JsonObject;
  state?: DataModelRecord["state"];
  correlationId: string;
}

export interface CreateModelViewInput {
  modelViewId: string;
  dataModelId: string;
  externalId: string;
  version: string;
  name: string;
  definition: JsonObject;
  correlationId: string;
}

export interface CreatePublicModelVersionInput {
  name: string;
  schema: JsonObject;
  status?: "draft" | "published";
  views?: PublicModelViewDefinition[];
  correlationId: string;
}

export interface CreatePublicModelViewInput extends PublicModelViewDefinition {
  correlationId: string;
}

export interface CreateGraphInstanceInput {
  instanceId: string;
  datasetId?: string | null;
  spaceId: string;
  externalId: string;
  instanceKind: GraphInstanceRecord["instanceKind"];
  dataModelId?: string | null;
  properties?: JsonObject;
  validFrom?: string | null;
  validTo?: string | null;
  correlationId: string;
}

export interface CreateAssetInput extends Omit<CreateGraphInstanceInput, "instanceKind" | "correlationId"> {
  parentAssetId?: string | null;
  assetKind: AssetRecord["assetKind"];
  assetType: string;
  name: string;
  description?: string | null;
  site?: string | null;
  sourceSystem: string;
  metadata?: JsonObject;
  correlationId: string;
}

export interface CreateTimeSeriesInput extends Omit<CreateGraphInstanceInput, "instanceKind" | "correlationId"> {
  assetId?: string | null;
  name: string;
  unit?: string | null;
  valueType?: TimeSeriesRecord["valueType"];
  interpolation?: TimeSeriesRecord["interpolation"];
  sourceSystem: string;
  metadata?: JsonObject;
  correlationId: string;
}

export interface TimeSeriesPointInput {
  observedAt: string;
  sequence?: string;
  numericValue?: number;
  textValue?: string;
  quality?: TimeSeriesPointRecord["quality"];
  sourceConnectionId?: string | null;
  ingestionRunId?: string | null;
}

export interface CreateDocumentInput extends Omit<CreateGraphInstanceInput, "instanceKind" | "correlationId"> {
  title: string;
  mimeType?: string | null;
  storageUri?: string | null;
  byteSize?: string | null;
  contentSha256?: string | null;
  sourceSystem: string;
  metadata?: JsonObject;
  rawObjectId?: string | null;
  correlationId: string;
}

export interface CreateRelationInput {
  relationId: string;
  datasetId?: string | null;
  sourceInstanceId: string;
  targetInstanceId: string;
  relationType: string;
  sourceSystem: string;
  evidence?: JsonObject;
  correlationId: string;
}

export interface CreateRelationCandidateInput {
  relationCandidateId: string;
  sourceInstanceId: string;
  targetInstanceId: string;
  relationType: string;
  confidence: number;
  evidence?: JsonObject[];
  ruleVersion?: string | null;
  modelVersion?: string | null;
  correlationId: string;
}

export interface ReviewRelationCandidateInput {
  decision: "accepted" | "rejected";
  comment?: string | null;
  sourceSystem?: string;
  correlationId: string;
}

export interface CreatePipelineInput {
  pipelineId: string;
  pipelineVersionId: string;
  externalId: string;
  name: string;
  description?: string | null;
  enabled?: boolean;
  definition: JsonObject;
  schedule?: string | null;
  correlationId: string;
}

export interface CreatePipelineVersionInput {
  pipelineVersionId: string;
  definition: JsonObject;
  schedule?: string | null;
  correlationId: string;
}

export interface CreatePipelineRunInput {
  pipelineRunId: string;
  pipelineId: string;
  pipelineVersion: number;
  triggerType: PipelineRunRecordV2["triggerType"];
  correlationId: string;
  summary?: JsonObject;
}

export interface TransitionPipelineRunInput {
  pipelineRunId: string;
  expectedState: PipelineRunRecordV2["state"];
  nextState: PipelineRunRecordV2["state"];
  summary?: JsonObject;
  correlationId: string;
}

export interface CreateQualityRuleInput {
  qualityRuleId: string;
  externalId: string;
  version?: number;
  name: string;
  ruleKind: QualityRuleRecord["ruleKind"];
  targetModelExternalId: string;
  fieldName?: string | null;
  configuration: JsonObject;
  severity: QualityRuleRecord["severity"];
  enabled?: boolean;
  correlationId: string;
}

export interface RecordQualityResultInput {
  qualityRuleId: string;
  pipelineRunId?: string | null;
  passed: boolean;
  checkedRecords: string;
  failedRecords: string;
  sampleFailures?: JsonObject[];
  occurredAt?: string;
  correlationId: string;
}

export interface CreateWritebackRequestInput {
  writebackRequestId: string;
  sourceConnectionId: string;
  targetInstanceId?: string | null;
  targetExternalId: string;
  operation: string;
  payload: JsonObject;
  risk: WritebackRequestRecord["risk"];
  dryRunResult?: JsonObject | null;
  /** Optional API compatibility identifier retained in immutable audit details. */
  legacyId?: string;
  /** Safety-gate reasons for an immediately cancelled draft request. */
  blockedReasons?: readonly string[];
  correlationId: string;
}

export interface RecordWritebackApprovalInput {
  writebackRequestId: string;
  decision: WritebackApprovalRecord["decision"];
  comment?: string | null;
  correlationId: string;
}

export interface CompleteWritebackInput {
  writebackRequestId: string;
  expectedState: "executing";
  succeeded: boolean;
  /** Durable executor outcome retained with the completion audit event. */
  executionResult?: JsonObject;
  correlationId: string;
}

export interface TenantProjectRepository {
  getTenant(context: TenantScope): Promise<TenantRecord>;
  getProject(scope: ProjectScope): Promise<ProjectRecord>;
  listProjects(scope: TenantScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<ProjectRecord, TimestampIdCursor>>;
  createProject(scope: TenantScope, input: CreateProjectInput): Promise<ProjectRecord>;
  updateProject(scope: ProjectScope, input: UpdateProjectInput): Promise<ProjectRecord>;
  resolveMember(scope: ProjectScope, allowedRoles?: readonly ProjectRole[]): Promise<ProjectRole>;
}

/**
 * Purpose-specific tenant/project administration. Its implementation invokes
 * security-definer routines rather than granting the application role direct
 * membership or project mutation privileges.
 */
export interface TenantProjectAdministrationRepository {
  updateTenant(scope: TenantScope, input: ManagedTenantUpdateInput): Promise<ManagedTenantMutation>;
  createProject(scope: TenantScope, input: ManagedProjectCreateInput): Promise<ManagedProjectMutation>;
  updateProject(scope: ProjectScope, input: ManagedProjectUpdateInput): Promise<ManagedProjectMutation>;
  listTenantMembers(scope: TenantScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<TenantMemberRecord, TextCursor>>;
  upsertTenantMember(scope: TenantScope, input: TenantMemberUpsertInput): Promise<ManagedMemberMutation<TenantMemberRecord>>;
  removeTenantMember(scope: TenantScope, userId: string, correlationId: string): Promise<void>;
  listProjectMembers(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<ProjectMemberRecord, TextCursor>>;
  upsertProjectMember(scope: ProjectScope, input: ProjectMemberUpsertInput): Promise<ManagedMemberMutation<ProjectMemberRecord>>;
  removeProjectMember(scope: ProjectScope, userId: string, correlationId: string): Promise<void>;
}

export interface CatalogRepository {
  listDatasets(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<DatasetRecord, TimestampIdCursor>>;
  createDataset(scope: ProjectScope, input: CreateDatasetInput): Promise<DatasetRecord>;
  listModelSpaces(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<ModelSpaceRecord, TextCursor>>;
  createModelSpace(scope: ProjectScope, input: CreateModelSpaceInput): Promise<ModelSpaceRecord>;
  listSourceConnections(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<SourceConnectionRecord, TextCursor>>;
  createSourceConnection(scope: ProjectScope, input: CreateSourceConnectionInput): Promise<SourceConnectionRecord>;
}

export interface ModelRepository {
  createDataModel(scope: ProjectScope, input: CreateDataModelInput): Promise<DataModelRecord>;
  listDataModels(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<DataModelRecord, TimestampIdCursor>>;
  createModelViewRecord(scope: ProjectScope, input: CreateModelViewInput): Promise<ModelViewRecord>;
  createGraphInstance(scope: ProjectScope, input: CreateGraphInstanceInput): Promise<GraphInstanceRecord>;
  listModelVersions(scope: ProjectScope, limit: number, cursor?: ModelVersionCursor): Promise<KeysetPage<PublicModelVersion, ModelVersionCursor>>;
  listVersionsForModel(scope: ProjectScope, modelId: string, limit: number, cursor?: ModelVersionCursor): Promise<KeysetPage<PublicModelVersion, ModelVersionCursor>>;
  getModelVersion(scope: ProjectScope, modelId: string, version: number): Promise<PublicModelVersion>;
  createModelVersion(scope: ProjectScope, modelId: string, input: CreatePublicModelVersionInput): Promise<PublicModelVersion>;
  listModelViews(scope: ProjectScope, modelId: string, version: number): Promise<PublicModelView[]>;
  createModelView(scope: ProjectScope, modelId: string, version: number, input: CreatePublicModelViewInput): Promise<PublicModelView>;
  publishModelVersion(scope: ProjectScope, modelId: string, version: number, correlationId: string): Promise<PublicModelVersion>;
}

export interface PipelineQualityRepository {
  createPipeline(scope: ProjectScope, input: CreatePipelineInput): Promise<PipelineRecord>;
  appendPipelineVersion(scope: ProjectScope, pipelineId: string, input: CreatePipelineVersionInput): Promise<PipelineVersionRecord>;
  getPipelineVersion(scope: ProjectScope, pipelineId: string, version: number): Promise<PipelineVersionRecord>;
  createPipelineRun(scope: ProjectScope, input: CreatePipelineRunInput): Promise<PipelineRunRecordV2>;
  transitionPipelineRun(scope: ProjectScope, input: TransitionPipelineRunInput): Promise<PipelineRunRecordV2>;
  listPipelineRuns(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<PipelineRunRecordV2, TextCursor>>;
  createQualityRule(scope: ProjectScope, input: CreateQualityRuleInput): Promise<QualityRuleRecord>;
  listEnabledQualityRules(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<QualityRuleRecord, TextCursor>>;
  recordQualityResult(scope: ProjectScope, input: RecordQualityResultInput): Promise<QualityResultRecord>;
}

export interface IndustrialRepository {
  createAsset(scope: ProjectScope, input: CreateAssetInput): Promise<AssetRecord>;
  listAssets(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<AssetRecord, TimestampIdCursor>>;
  createTimeSeries(scope: ProjectScope, input: CreateTimeSeriesInput): Promise<TimeSeriesRecord>;
  listTimeSeries(scope: ProjectScope, limit: number, cursor?: TextCursor): Promise<KeysetPage<TimeSeriesRecord, TextCursor>>;
  upsertTimeSeriesPoints(scope: ProjectScope, timeSeriesId: string, points: readonly TimeSeriesPointInput[], correlationId: string): Promise<TimeSeriesPointRecord[]>;
  latestTimeSeriesPoint(scope: ProjectScope, timeSeriesId: string): Promise<TimeSeriesPointRecord | null>;
  bucketTimeSeries(scope: ProjectScope, timeSeriesId: string, from: string, to: string, bucketSeconds: number): Promise<TimeSeriesBucket[]>;
  createDocument(scope: ProjectScope, input: CreateDocumentInput): Promise<DocumentRecord>;
  listDocuments(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<DocumentRecord, TimestampIdCursor>>;
  linkDocumentAsset(scope: ProjectScope, documentId: string, assetId: string, relationType: string, correlationId: string): Promise<DocumentAssetLinkRecord>;
  createRelation(scope: ProjectScope, input: CreateRelationInput): Promise<RelationRecord>;
  listRelations(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<RelationRecord, TimestampIdCursor>>;
  createRelationCandidate(scope: ProjectScope, input: CreateRelationCandidateInput): Promise<RelationCandidateRecord>;
  listRelationCandidates(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<RelationCandidateRecord, TimestampIdCursor>>;
  reviewRelationCandidate(scope: ProjectScope, candidateId: string, input: ReviewRelationCandidateInput): Promise<RelationCandidateRecord>;
}

export interface DiagramMatchingSpatialRepository {
  /** Persists a diagram through the documents + metadata recovery boundary. */
  createDiagramDocument(scope: ProjectScope, input: CreateDocumentInput): Promise<DocumentRecord>;
  /** Persists matching predictions through relation_candidates evidence. */
  createMatchingCandidate(scope: ProjectScope, input: CreateRelationCandidateInput): Promise<RelationCandidateRecord>;
  /** Persists a spatial proposal through relation_candidates evidence. */
  createSpatialLinkCandidate(scope: ProjectScope, input: CreateRelationCandidateInput): Promise<RelationCandidateRecord>;
}

export interface WritebackRepository {
  createWritebackRequest(scope: ProjectScope, input: CreateWritebackRequestInput): Promise<WritebackRequestRecord>;
  listWritebackRequests(scope: ProjectScope, limit: number, cursor?: TimestampIdCursor): Promise<KeysetPage<WritebackRequestRecord, TimestampIdCursor>>;
  recordWritebackApproval(scope: ProjectScope, input: RecordWritebackApprovalInput): Promise<WritebackRequestRecord>;
  beginWriteback(scope: ProjectScope, requestId: string, correlationId: string): Promise<WritebackRequestRecord>;
  completeWriteback(scope: ProjectScope, input: CompleteWritebackInput): Promise<WritebackRequestRecord>;
  listWritebackEvents(scope: ProjectScope, requestId: string, limit: number, cursor?: NumericCursor): Promise<KeysetPage<WritebackEventRecord, NumericCursor>>;
}

export interface SearchRepository {
  search(
    scope: ProjectScope,
    query: string,
    limit: number,
    cursor?: UnifiedSearchCursor,
    entityType?: string,
  ): Promise<KeysetPage<UnifiedSearchResult, UnifiedSearchCursor>>;
}
