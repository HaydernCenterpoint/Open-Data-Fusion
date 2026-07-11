import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock("./auth", () => ({
  initialize: authMocks.initialize,
  getAccessToken: authMocks.getAccessToken,
}));

const workspaceContext = {
  tenantId: "tenant-a",
  projectId: "project-a",
};

describe("workspace API scope", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    authMocks.initialize.mockReset().mockResolvedValue({ enabled: false, authenticated: false, identity: null });
    authMocks.getAccessToken.mockReset().mockResolvedValue(null);
  });

  it("sends the selected tenant and project headers on every Canvas HTTP request", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./api");

    await Promise.all([
      api.getWorkspace("workspace-1", workspaceContext, undefined, "development.user"),
      api.saveWorkspace("workspace-1", workspaceContext, {
        expectedVersion: 1,
        actor: "development.user",
        changeSummary: "Saved canvas viewport",
        snapshot: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] },
      }),
      api.applyWorkspaceOperations("workspace-1", workspaceContext, {
        baseVersion: 1,
        changeSummary: "Moved a node",
        operations: [],
      }, "development.user"),
      api.listWorkspaceMembers("workspace-1", workspaceContext, "development.user"),
      api.upsertWorkspaceMember("workspace-1", workspaceContext, "riley.chen", {
        displayName: "Riley Chen",
        role: "editor",
      }, "development.user"),
      api.removeWorkspaceMember("workspace-1", workspaceContext, "riley.chen", "development.user"),
      api.listWorkspaceRevisions("workspace-1", workspaceContext, { limit: 50, offset: 0 }, "development.user"),
      api.rollbackWorkspace("workspace-1", workspaceContext, {
        expectedVersion: 2,
        targetVersion: 1,
        actor: "development.user",
      }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(8);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      const headers = new Headers(init.headers);
      expect(headers.get("x-odf-tenant-id")).toBe(workspaceContext.tenantId);
      expect(headers.get("x-odf-project-id")).toBe(workspaceContext.projectId);
    }
  });

  it("keeps scope in the development EventSource URL when custom headers are unavailable", async () => {
    const sources: Array<{ url: string; close: () => void }> = [];
    class DevelopmentEventSource {
      readonly url: string;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        sources.push(this);
      }

      addEventListener() {}
      close() {}
    }

    vi.stubGlobal("EventSource", DevelopmentEventSource);
    const api = await import("./api");
    const unsubscribe = api.subscribeToWorkspaceEvents("workspace-1", workspaceContext, {
      onWorkspaceUpdated: vi.fn(),
      onPresenceUpdated: vi.fn(),
    }, "development.user");

    await vi.waitFor(() => expect(sources).toHaveLength(1));
    const url = new URL(sources[0].url, "http://test.local");
    expect(url.searchParams.get("user")).toBe("development.user");
    expect(url.searchParams.get("tenantId")).toBe(workspaceContext.tenantId);
    expect(url.searchParams.get("projectId")).toBe(workspaceContext.projectId);
    unsubscribe();
  });
});
