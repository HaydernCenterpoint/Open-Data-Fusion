import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock("./auth", () => ({
  initialize: authMocks.initialize,
  getAccessToken: authMocks.getAccessToken,
}));

const workspaceContext = { tenantId: "tenant-a", projectId: "project-a" };

describe("authenticated API transport", () => {
  beforeEach(() => {
    vi.resetModules();
    authMocks.initialize.mockReset().mockResolvedValue({
      enabled: true,
      authenticated: true,
      identity: { userId: "harper.dennis", displayName: "Harper Dennis" },
    });
    authMocks.getAccessToken.mockReset().mockResolvedValue("verified-access-token");
  });

  it("uses the bearer token and removes the development identity header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "workspace-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./api");

    await api.getWorkspace("workspace-1", workspaceContext, undefined, "forged.development-user");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer verified-access-token");
    expect(headers["x-odf-user"]).toBeUndefined();
    expect(init.credentials).toBe("include");
    expect(headers["x-odf-tenant-id"]).toBe(workspaceContext.tenantId);
    expect(headers["x-odf-project-id"]).toBe(workspaceContext.projectId);
  });

  it("parses authenticated SSE frames over fetch without putting identity in the URL", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          "retry: 2500\n" +
          "event: presence.updated\n" +
          "data: {\"workspaceId\":\"workspace-1\",\"users\":[],\"occurredAt\":\"2026-07-10T00:00:00.000Z\"}\n\n" +
          "event: members.updated\n" +
          "data: {\"workspaceId\":\"workspace-1\",\"actor\":\"harper.dennis\",\"change\":\"updated\",\"member\":{\"workspaceId\":\"workspace-1\",\"userId\":\"riley.chen\",\"displayName\":\"Riley Chen\",\"role\":\"reviewer\"},\"occurredAt\":\"2026-07-10T00:00:00.000Z\"}\n\n",
        ));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./api");

    const presence = vi.fn();
    const members = vi.fn();
    let unsubscribe: () => void = () => undefined;
    const received = new Promise<void>((resolve) => {
      unsubscribe = api.subscribeToWorkspaceEvents("workspace-1", workspaceContext, {
        onWorkspaceUpdated: vi.fn(),
        onPresenceUpdated: presence,
        onMembersUpdated: (event) => {
          members(event);
          unsubscribe();
          resolve();
        },
      }, "development.user");
    });

    await received;
    expect(presence).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", users: [] }));
    expect(members).toHaveBeenCalledWith(expect.objectContaining({ change: "updated" }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/workspaces/workspace-1/events");
    expect(url).not.toContain("user=");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer verified-access-token");
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["x-odf-tenant-id"]).toBe(workspaceContext.tenantId);
    expect((init.headers as Record<string, string>)["x-odf-project-id"]).toBe(workspaceContext.projectId);
    unsubscribe();
  });
});
