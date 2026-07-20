import type {
  AssetListResponse,
  AssetDetailResponse,
  ApiWorkspace,
  AuditListResponse,
  CanvasSnapshot,
  ExplorerSnapshot,
  IngestBundle,
  IngestResult,
  CursorPage,
  PlatformConnector,
  PlatformContext,
  PlatformContextCandidate,
  PlatformDataModel,
  PlatformDataset,
  PlatformDiagramExtraction,
  PlatformMatchGroundTruth,
  PlatformMatchingEvaluation,
  PlatformMatchPrediction,
  PlatformPipeline,
  PlatformPipelineRun,
  PlatformProject,
  PlatformQualityResult,
  PlatformSearchResult,
  PlatformSource,
  PlatformSpatialLink,
  PlatformTenant,
  PlatformWritebackRequest,
  PlatformWritebackRisk,
  RelationListResponse,
  TelemetryResponse,
  WorkspaceMemberList,
  WorkspaceMember,
  WorkspaceMemberUpsert,
  WorkspaceMembersUpdatedEvent,
  WorkspaceOperation,
  WorkspacePresenceEvent,
  WorkspaceRevisionList,
  WorkspaceUpdatedEvent,
} from "../types";
import { getAccessToken, initialize as initializeAuth } from "./auth";

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const URL_WORKSPACE_USER = typeof window === "undefined"
  ? ""
  : new URLSearchParams(window.location.search).get("user")?.trim() ?? "";
export const WORKSPACE_USER = URL_WORKSPACE_USER
  || import.meta.env.VITE_WORKSPACE_USER
  || (import.meta.env.MODE === "test" ? "harper.dennis" : "local-user");

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const providedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...providedHeaders,
  };
  const accessToken = await getAccessToken();
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    delete headers["x-odf-user"];
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    const detail = await response.text();
    let parsedDetail: unknown = detail;
    let message = detail || `Request failed (${response.status})`;
    try {
      parsedDetail = JSON.parse(detail) as unknown;
      if (
        parsedDetail &&
        typeof parsedDetail === "object" &&
        "error" in parsedDetail &&
        parsedDetail.error &&
        typeof parsedDetail.error === "object" &&
        "message" in parsedDetail.error &&
        typeof parsedDetail.error.message === "string"
      ) {
        message = parsedDetail.error.message;
      }
    } catch {
      // Plain-text API errors remain useful as-is.
    }
    throw new ApiRequestError(message, response.status, parsedDetail);
  }

  if (response.status === 204) return {} as T;
  return (await response.json()) as T;
}

export async function getHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    await request<unknown>("/api/health", { signal });
    return true;
  } catch {
    return false;
  }
}

export function ingestBundle(context: PlatformContext, bundle: IngestBundle): Promise<IngestResult> {
  return request<IngestResult>("/api/ingest", {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(bundle),
  });
}

export async function getExplorerSnapshot(
  context: PlatformContext,
  externalId: string,
  signal?: AbortSignal,
): Promise<ExplorerSnapshot> {
  const encodedId = encodeURIComponent(externalId);
  const telemetryTo = Date.now();
  const telemetryFrom = telemetryTo - 30 * 24 * 60 * 60 * 1_000;
  const telemetryQuery = new URLSearchParams({
    from: new Date(telemetryFrom).toISOString(),
    to: new Date(telemetryTo).toISOString(),
    limit: "5000",
  });
  const [detail, telemetry] = await Promise.all([
    request<AssetDetailResponse>(`/api/v1/assets/${encodedId}`, { signal, headers: platformHeaders(context) }),
    request<TelemetryResponse>(`/api/v1/assets/${encodedId}/telemetry?${telemetryQuery.toString()}`, { signal, headers: platformHeaders(context) }),
  ]);
  return { detail, telemetry };
}

export function listAssets(
  context: PlatformContext,
  query: { q?: string; type?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AssetListResponse> {
  const parameters = new URLSearchParams();
  if (query.q) parameters.set("q", query.q);
  if (query.type) parameters.set("type", query.type);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  if (query.offset !== undefined) parameters.set("offset", String(query.offset));
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return request<AssetListResponse>(`/api/v1/assets${suffix}`, { signal, headers: platformHeaders(context) });
}

export function listRelations(
  context: PlatformContext,
  query: { status?: "proposed" | "accepted" | "rejected" | "superseded"; limit?: number } = {},
  signal?: AbortSignal,
): Promise<RelationListResponse> {
  const parameters = new URLSearchParams();
  if (query.status) parameters.set("status", query.status);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return request<RelationListResponse>(`/api/v1/relations${suffix}`, { signal, headers: platformHeaders(context) });
}

export function listAudit(
  context: PlatformContext,
  query: { action?: string; entityType?: string; entityId?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AuditListResponse> {
  const parameters = new URLSearchParams();
  if (query.action) parameters.set("action", query.action);
  if (query.entityType) parameters.set("entityType", query.entityType);
  if (query.entityId) parameters.set("entityId", query.entityId);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  if (query.offset !== undefined) parameters.set("offset", String(query.offset));
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return request<AuditListResponse>(`/api/v1/audit${suffix}`, { signal, headers: platformHeaders(context) });
}

function cursorSuffix(query: { limit?: number; cursor?: string }): string {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  if (query.cursor) parameters.set("cursor", query.cursor);
  return parameters.size > 0 ? `?${parameters.toString()}` : "";
}

function platformHeaders(context: PlatformContext): Record<string, string> {
  return {
    "x-odf-tenant-id": context.tenantId,
    "x-odf-project-id": context.projectId,
  };
}

/**
 * The tenant/project boundary for Canvas workspace requests. Keep this
 * separate from the current user: authentication determines the user, while
 * these values determine the workspace data boundary.
 */
export type WorkspaceRequestContext = Pick<PlatformContext, "tenantId" | "projectId">;

function workspaceHeaders(context: WorkspaceRequestContext, user: string): Record<string, string> {
  return {
    ...platformHeaders(context),
    "x-odf-user": user,
  };
}

function listPlatformScoped<T>(
  resource: string,
  context: PlatformContext,
  query: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<CursorPage<T>> {
  return request<CursorPage<T>>(`/api/v1/platform/${resource}${cursorSuffix(query)}`, {
    signal,
    headers: platformHeaders(context),
  });
}

export function listPlatformTenants(
  query: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<CursorPage<PlatformTenant>> {
  return request<CursorPage<PlatformTenant>>(`/api/v1/platform/tenants${cursorSuffix(query)}`, { signal });
}

export function listPlatformProjects(
  tenantId: string,
  query: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal,
): Promise<CursorPage<PlatformProject>> {
  return request<CursorPage<PlatformProject>>(`/api/v1/platform/tenants/${encodeURIComponent(tenantId)}/projects${cursorSuffix(query)}`, { signal });
}

export function listPlatformDatasets(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformDataset>("datasets", context, query, signal);
}

export function listPlatformSources(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformSource>("sources", context, query, signal);
}

export function listPlatformConnectors(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformConnector>("connectors", context, query, signal);
}

export function listPlatformDataModels(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformDataModel>("data-models", context, query, signal);
}

export function listPlatformPipelines(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformPipeline>("pipelines", context, query, signal);
}

export function listPlatformPipelineRuns(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformPipelineRun>("pipeline-runs", context, query, signal);
}

export function listPlatformQualityResults(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformQualityResult>("quality-results", context, query, signal);
}

export function listPlatformCandidates(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformContextCandidate>("contextualization/candidates", context, query, signal);
}

export function triggerPlatformPipelineRun(
  context: PlatformContext,
  pipelineId: string,
  body: { idempotencyKey: string; input: Record<string, unknown> },
): Promise<PlatformPipelineRun> {
  return request<PlatformPipelineRun>(`/api/v1/platform/pipelines/${encodeURIComponent(pipelineId)}/runs`, {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function reviewPlatformCandidate(
  context: PlatformContext,
  candidateId: string,
  body: { decision: "accepted" | "rejected"; comment?: string | null },
): Promise<PlatformContextCandidate> {
  return request<PlatformContextCandidate>(`/api/v1/platform/contextualization/candidates/${encodeURIComponent(candidateId)}/review`, {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function searchPlatform(
  context: PlatformContext,
  query: { q: string; entityType?: string; limit?: number; cursor?: string },
  signal?: AbortSignal,
): Promise<CursorPage<PlatformSearchResult>> {
  const parameters = new URLSearchParams({ q: query.q });
  if (query.entityType) parameters.set("entityType", query.entityType);
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  if (query.cursor) parameters.set("cursor", query.cursor);
  return request<CursorPage<PlatformSearchResult>>(`/api/v1/platform/search?${parameters.toString()}`, {
    signal,
    headers: platformHeaders(context),
  });
}

export function listPlatformDiagramExtractions(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformDiagramExtraction>("diagrams/tag-extractions", context, query, signal);
}

export function createPlatformDiagramExtraction(
  context: PlatformContext,
  body: { id?: string; documentExternalId: string; text: string; page?: number },
): Promise<PlatformDiagramExtraction> {
  return request<PlatformDiagramExtraction>("/api/v1/platform/diagrams/tag-extractions", {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function listPlatformMatchingEvaluations(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformMatchingEvaluation>("matching/evaluations", context, query, signal);
}

export function createPlatformMatchingEvaluation(
  context: PlatformContext,
  body: { id?: string; threshold: number; predictions: PlatformMatchPrediction[]; truth: PlatformMatchGroundTruth[] },
): Promise<PlatformMatchingEvaluation> {
  return request<PlatformMatchingEvaluation>("/api/v1/platform/matching/evaluations", {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function listPlatformSpatialLinks(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformSpatialLink>("spatial/asset-links", context, query, signal);
}

export function createPlatformSpatialLink(
  context: PlatformContext,
  body: { id?: string; assetExternalId: string; sceneExternalId: string; nodeExternalId: string; transform: number[]; confidence: number },
): Promise<PlatformSpatialLink> {
  return request<PlatformSpatialLink>("/api/v1/platform/spatial/asset-links", {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function reviewPlatformSpatialLink(
  context: PlatformContext,
  linkId: string,
  body: { decision: "accepted" | "rejected"; comment?: string | null },
): Promise<PlatformSpatialLink> {
  return request<PlatformSpatialLink>(`/api/v1/platform/spatial/asset-links/${encodeURIComponent(linkId)}/review`, {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function listPlatformWritebackRequests(context: PlatformContext, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  return listPlatformScoped<PlatformWritebackRequest>("writeback/requests", context, query, signal);
}

export function createPlatformWritebackRequest(
  context: PlatformContext,
  body: {
    id?: string;
    sourceId: string;
    targetExternalId: string;
    operation: string;
    payload: Record<string, unknown>;
    risk: PlatformWritebackRisk;
    dryRunResult: { safe: boolean; evidence: unknown; performedAt?: string; summary?: string };
  },
): Promise<PlatformWritebackRequest> {
  return request<PlatformWritebackRequest>("/api/v1/platform/writeback/requests", {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function approvePlatformWritebackRequest(
  context: PlatformContext,
  requestId: string,
  body: { decision: "approved" | "rejected"; comment?: string | null },
): Promise<PlatformWritebackRequest> {
  return request<PlatformWritebackRequest>(`/api/v1/platform/writeback/requests/${encodeURIComponent(requestId)}/approvals`, {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify(body),
  });
}

export function executePlatformWritebackRequest(context: PlatformContext, requestId: string): Promise<PlatformWritebackRequest> {
  return request<PlatformWritebackRequest>(`/api/v1/platform/writeback/requests/${encodeURIComponent(requestId)}/execute`, {
    method: "POST",
    headers: platformHeaders(context),
    body: JSON.stringify({}),
  });
}

export function getWorkspace(
  id: string,
  context: WorkspaceRequestContext,
  signal?: AbortSignal,
  user = WORKSPACE_USER,
): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
    signal,
    headers: workspaceHeaders(context, user),
  });
}

export function saveWorkspace(
  id: string,
  context: WorkspaceRequestContext,
  body: { expectedVersion: number; actor: string; changeSummary: string; snapshot: CanvasSnapshot },
): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: workspaceHeaders(context, body.actor),
    body: JSON.stringify(body),
  });
}

export function applyWorkspaceOperations(
  id: string,
  context: WorkspaceRequestContext,
  body: { baseVersion: number; changeSummary: string; operations: WorkspaceOperation[] },
  user = WORKSPACE_USER,
): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}/operations`, {
    method: "POST",
    headers: workspaceHeaders(context, user),
    body: JSON.stringify(body),
  });
}

export function listWorkspaceMembers(
  id: string,
  context: WorkspaceRequestContext,
  user = WORKSPACE_USER,
): Promise<WorkspaceMemberList> {
  return request<WorkspaceMemberList>(`/api/v1/workspaces/${encodeURIComponent(id)}/members`, {
    headers: workspaceHeaders(context, user),
  });
}

export function upsertWorkspaceMember(
  id: string,
  context: WorkspaceRequestContext,
  userId: string,
  body: WorkspaceMemberUpsert,
  user = WORKSPACE_USER,
): Promise<WorkspaceMember> {
  return request<WorkspaceMember>(`/api/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: workspaceHeaders(context, user),
    body: JSON.stringify(body),
  });
}

export function removeWorkspaceMember(
  id: string,
  context: WorkspaceRequestContext,
  userId: string,
  user = WORKSPACE_USER,
): Promise<void> {
  return request<void>(`/api/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: workspaceHeaders(context, user),
  });
}

export function subscribeToWorkspaceEvents(
  id: string,
  context: WorkspaceRequestContext,
  handlers: {
    onWorkspaceUpdated: (event: WorkspaceUpdatedEvent) => void;
    onPresenceUpdated: (event: WorkspacePresenceEvent) => void;
    onMembersUpdated?: (event: WorkspaceMembersUpdatedEvent) => void;
    onConnectionChange?: (connected: boolean) => void;
  },
  user = WORKSPACE_USER,
): () => void {
  let disposed = false;
  let eventSource: EventSource | null = null;
  const controller = new AbortController();

  void initializeAuth()
    .then((session) => {
      if (disposed) return;
      if (session.enabled) {
        void runAuthenticatedEventStream(id, context, handlers, controller.signal);
        return;
      }
      if (typeof EventSource === "undefined") return;
      eventSource = createDevelopmentEventSource(id, context, user, handlers);
    })
    .catch(() => handlers.onConnectionChange?.(false));

  return () => {
    disposed = true;
    controller.abort();
    eventSource?.close();
  };
}

interface WorkspaceEventHandlers {
  onWorkspaceUpdated: (event: WorkspaceUpdatedEvent) => void;
  onPresenceUpdated: (event: WorkspacePresenceEvent) => void;
  onMembersUpdated?: (event: WorkspaceMembersUpdatedEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

function dispatchWorkspaceEvent(type: string, data: string, handlers: WorkspaceEventHandlers): void {
  try {
    if (type === "workspace.updated") handlers.onWorkspaceUpdated(JSON.parse(data) as WorkspaceUpdatedEvent);
    else if (type === "presence.updated") handlers.onPresenceUpdated(JSON.parse(data) as WorkspacePresenceEvent);
    else if (type === "members.updated") handlers.onMembersUpdated?.(JSON.parse(data) as WorkspaceMembersUpdatedEvent);
  } catch {
    // One malformed frame must not stop later collaboration events.
  }
}

function createDevelopmentEventSource(
  id: string,
  context: WorkspaceRequestContext,
  user: string,
  handlers: WorkspaceEventHandlers,
): EventSource {
  const parameters = new URLSearchParams({
    user,
    tenantId: context.tenantId,
    projectId: context.projectId,
  });
  const eventSource = new EventSource(
    `${API_BASE}/api/v1/workspaces/${encodeURIComponent(id)}/events?${parameters.toString()}`,
  );
  const listener = (event: Event) => {
    const message = event as MessageEvent<string>;
    dispatchWorkspaceEvent(event.type, message.data, handlers);
  };
  eventSource.addEventListener("workspace.updated", listener);
  eventSource.addEventListener("presence.updated", listener);
  eventSource.addEventListener("members.updated", listener);
  eventSource.onopen = () => handlers.onConnectionChange?.(true);
  eventSource.onerror = () => handlers.onConnectionChange?.(false);
  return eventSource;
}

function reconnectDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  handlers: WorkspaceEventHandlers,
  signal: AbortSignal,
  onRetry: (milliseconds: number) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      if (dataLines.length) dispatchWorkspaceEvent(eventType, dataLines.join("\n"), handlers);
      eventType = "message";
      dataLines = [];
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") eventType = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "retry" && /^\d+$/.test(value)) onRetry(Math.min(30_000, Math.max(500, Number(value))));
  };

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

async function runAuthenticatedEventStream(
  id: string,
  context: WorkspaceRequestContext,
  handlers: WorkspaceEventHandlers,
  signal: AbortSignal,
): Promise<void> {
  let delay = 1_000;
  const url = `${API_BASE}/api/v1/workspaces/${encodeURIComponent(id)}/events`;
  while (!signal.aborted) {
    try {
      const accessToken = await getAccessToken();
      const response = await fetch(url, {
        headers: {
          Accept: "text/event-stream",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...platformHeaders(context),
        },
        cache: "no-store",
        credentials: "include",
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        handlers.onConnectionChange?.(false);
        return;
      }
      if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("text/event-stream")) throw new Error("Event stream returned an unexpected content type");
      handlers.onConnectionChange?.(true);
      delay = 1_000;
      await consumeEventStream(response.body, handlers, signal, (milliseconds) => { delay = milliseconds; });
    } catch {
      if (signal.aborted) return;
    }
    handlers.onConnectionChange?.(false);
    await reconnectDelay(delay, signal);
    delay = Math.min(delay * 2, 10_000);
  }
}

export function isConflictError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 409;
}

export function listWorkspaceRevisions(
  id: string,
  context: WorkspaceRequestContext,
  query: { limit?: number; offset?: number } = {},
  user = WORKSPACE_USER,
): Promise<WorkspaceRevisionList> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  if (query.offset !== undefined) parameters.set("offset", String(query.offset));
  const suffix = parameters.size > 0 ? `?${parameters.toString()}` : "";
  return request<WorkspaceRevisionList>(`/api/v1/workspaces/${encodeURIComponent(id)}/revisions${suffix}`, {
    headers: workspaceHeaders(context, user),
  });
}

export function rollbackWorkspace(
  id: string,
  context: WorkspaceRequestContext,
  body: { expectedVersion: number; targetVersion: number; actor: string; changeSummary?: string },
): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}/rollback`, {
    method: "POST",
    headers: workspaceHeaders(context, body.actor),
    body: JSON.stringify(body),
  });
}
