import type {
  AssetDetailResponse,
  ApiWorkspace,
  CanvasSnapshot,
  ExplorerSnapshot,
  IngestBundle,
  IngestResult,
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
export const WORKSPACE_USER = URL_WORKSPACE_USER || import.meta.env.VITE_WORKSPACE_USER || "harper.dennis";

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

export function ingestBundle(bundle: IngestBundle): Promise<IngestResult> {
  return request<IngestResult>("/api/ingest", {
    method: "POST",
    body: JSON.stringify(bundle),
  });
}

export async function getExplorerSnapshot(
  externalId = "P-101",
  signal?: AbortSignal,
): Promise<ExplorerSnapshot> {
  const encodedId = encodeURIComponent(externalId);
  const [detail, telemetry] = await Promise.all([
    request<AssetDetailResponse>(`/api/v1/assets/${encodedId}`, { signal }),
    request<TelemetryResponse>(`/api/v1/assets/${encodedId}/telemetry?limit=500`, { signal }),
  ]);
  return { detail, telemetry };
}

export function getWorkspace(id: string, signal?: AbortSignal, user = WORKSPACE_USER): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
    signal,
    headers: { "x-odf-user": user },
  });
}

export function saveWorkspace(
  id: string,
  body: { expectedVersion: number; actor: string; changeSummary: string; snapshot: CanvasSnapshot },
): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "x-odf-user": body.actor },
    body: JSON.stringify(body),
  });
}

export function applyWorkspaceOperations(
  id: string,
  body: { baseVersion: number; changeSummary: string; operations: WorkspaceOperation[] },
  user = WORKSPACE_USER,
): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}/operations`, {
    method: "POST",
    headers: { "x-odf-user": user },
    body: JSON.stringify(body),
  });
}

export function listWorkspaceMembers(id: string, user = WORKSPACE_USER): Promise<WorkspaceMemberList> {
  return request<WorkspaceMemberList>(`/api/v1/workspaces/${encodeURIComponent(id)}/members`, {
    headers: { "x-odf-user": user },
  });
}

export function upsertWorkspaceMember(
  id: string,
  userId: string,
  body: WorkspaceMemberUpsert,
  user = WORKSPACE_USER,
): Promise<WorkspaceMember> {
  return request<WorkspaceMember>(`/api/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: { "x-odf-user": user },
    body: JSON.stringify(body),
  });
}

export function removeWorkspaceMember(
  id: string,
  userId: string,
  user = WORKSPACE_USER,
): Promise<void> {
  return request<void>(`/api/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { "x-odf-user": user },
  });
}

export function subscribeToWorkspaceEvents(
  id: string,
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
        void runAuthenticatedEventStream(id, handlers, controller.signal);
        return;
      }
      if (typeof EventSource === "undefined") return;
      eventSource = createDevelopmentEventSource(id, user, handlers);
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

function createDevelopmentEventSource(id: string, user: string, handlers: WorkspaceEventHandlers): EventSource {
  const eventSource = new EventSource(
    `${API_BASE}/api/v1/workspaces/${encodeURIComponent(id)}/events?user=${encodeURIComponent(user)}`,
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
  handlers: WorkspaceEventHandlers,
  signal: AbortSignal,
): Promise<void> {
  let delay = 1_000;
  const url = `${API_BASE}/api/v1/workspaces/${encodeURIComponent(id)}/events`;
  while (!signal.aborted) {
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("No active OIDC access token");
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
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

export function listWorkspaceRevisions(id: string, user = WORKSPACE_USER): Promise<WorkspaceRevisionList> {
  return request<WorkspaceRevisionList>(`/api/v1/workspaces/${encodeURIComponent(id)}/revisions`, {
    headers: { "x-odf-user": user },
  });
}

export function rollbackWorkspace(
  id: string,
  body: { expectedVersion: number; targetVersion: number; actor: string; changeSummary?: string },
): Promise<ApiWorkspace> {
  return request<ApiWorkspace>(`/api/v1/workspaces/${encodeURIComponent(id)}/rollback`, {
    method: "POST",
    headers: { "x-odf-user": body.actor },
    body: JSON.stringify(body),
  });
}
