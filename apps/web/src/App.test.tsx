import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { ApiWorkspace, WorkspaceMember, WorkspaceOperation } from "./types";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, payload: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  close() {
    this.listeners.clear();
  }
}

function workspaceFixture(version = 1): ApiWorkspace {
  return {
    id: "cooling-water-system",
    name: "Cooling Water System",
    version,
    snapshot: {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: "canvas-pid", type: "diagram", position: { x: 31, y: 72 }, data: { title: "P&ID — Cooling Water System" } },
        { id: "canvas-p101", type: "asset", position: { x: 321, y: 123 }, data: { externalId: "P-101", label: "Pump P-101" } },
        { id: "canvas-pressure", type: "timeSeries", position: { x: 480, y: 310 }, data: { externalId: "P-101-PRESSURE", label: "Pressure psi" } },
        { id: "canvas-system", type: "system", position: { x: 470, y: 475 }, data: { externalId: "AREA-A", label: "Cooling Water System" } },
        { id: "canvas-overview", type: "document", position: { x: 475, y: 655 }, data: { label: "CWS Overview.pdf" } },
        { id: "canvas-note", type: "note", position: { x: 735, y: 560 }, data: { label: "Operator note", text: "Check seal vibration", width: 210, height: 120 } },
      ],
      edges: [
        { id: "canvas-p101-pressure", source: "canvas-p101", target: "canvas-pressure", type: "measures", data: {} },
      ],
    },
    createdBy: "system",
    createdAt: "2025-05-14T00:00:00.000Z",
    updatedBy: version === 1 ? "system" : "riley.chen",
    updatedAt: "2025-05-14T11:58:12.000Z",
  };
}

function applyOperations(workspace: ApiWorkspace, operations: WorkspaceOperation[]): ApiWorkspace {
  const next = structuredClone(workspace);
  for (const operation of operations) {
    if (operation.type === "moveNode") {
      const node = next.snapshot.nodes.find((item) => item.id === operation.nodeId);
      if (node) node.position = operation.position;
    } else if (operation.type === "addNode") {
      next.snapshot.nodes.push(operation.node);
    } else if (operation.type === "updateNode") {
      const node = next.snapshot.nodes.find((item) => item.id === operation.nodeId);
      if (node) {
        if (operation.patch.type !== undefined) node.type = operation.patch.type;
        if (operation.patch.position !== undefined) node.position = operation.patch.position;
        if (operation.patch.data !== undefined) node.data = { ...node.data, ...operation.patch.data };
      }
    } else if (operation.type === "removeNode") {
      next.snapshot.nodes = next.snapshot.nodes.filter((item) => item.id !== operation.nodeId);
      next.snapshot.edges = next.snapshot.edges.filter((edge) => edge.source !== operation.nodeId && edge.target !== operation.nodeId);
    } else if (operation.type === "addEdge") {
      next.snapshot.edges.push(operation.edge);
    } else if (operation.type === "updateEdge") {
      const edge = next.snapshot.edges.find((item) => item.id === operation.edgeId);
      if (edge) {
        if (operation.patch.type !== undefined) edge.type = operation.patch.type;
        if (operation.patch.data !== undefined) edge.data = { ...edge.data, ...operation.patch.data };
      }
    } else if (operation.type === "removeEdge") {
      next.snapshot.edges = next.snapshot.edges.filter((edge) => edge.id !== operation.edgeId);
    }
  }
  next.version += 1;
  next.updatedBy = "harper.dennis";
  return next;
}

const assetDetail = {
  asset: {
    externalId: "P-101",
    name: "Pump P-101",
    description: "Primary pump",
    type: "Pump",
    parentExternalId: "AREA-A",
    metadata: {},
    sourceSystem: "OSIsoft PI",
    createdAt: "2025-05-14T00:00:00.000Z",
    updatedAt: "2025-05-14T11:58:12.000Z",
  },
  parent: null,
  children: [],
  timeSeries: [],
  documents: [],
  relations: [],
  provenance: [],
};

describe("Open Data Fusion workspace", () => {
  let serverWorkspace: ApiWorkspace;
  let serverMembers: WorkspaceMember[];
  let conflictNextOperation: boolean;
  let memberMutationFailure: { status: number; message: string } | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    serverWorkspace = workspaceFixture();
    serverMembers = [
      { workspaceId: serverWorkspace.id, userId: "harper.dennis", displayName: "Harper Dennis", role: "owner" },
      { workspaceId: serverWorkspace.id, userId: "riley.chen", displayName: "Riley Chen", role: "editor" },
    ];
    conflictNextOperation = false;
    memberMutationFailure = null;
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);

    fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const success = (payload: unknown, status = 200) => ({
        ok: true,
        status,
        json: async () => structuredClone(payload),
        text: async () => JSON.stringify(payload),
      });

      if (url.endsWith("/api/health")) return success({ status: "ok" });
      if (url.includes("/telemetry")) return success({ assetExternalId: "P-101", range: { from: "", to: "" }, series: [] });
      if (url.includes("/api/v1/assets/P-101")) return success(assetDetail);
      const memberMatch = url.match(/\/members\/([^/?]+)$/);
      if (memberMatch && memberMutationFailure) {
        const failure = memberMutationFailure;
        memberMutationFailure = null;
        return {
          ok: false,
          status: failure.status,
          json: async () => ({}),
          text: async () => JSON.stringify({ error: { code: failure.status === 409 ? "conflict" : "forbidden", message: failure.message, correlationId: "member-test" } }),
        };
      }
      if (memberMatch && init?.method === "PUT") {
        const userId = decodeURIComponent(memberMatch[1]);
        const body = JSON.parse(String(init.body)) as { displayName: string; role: WorkspaceMember["role"] };
        const existing = serverMembers.some((member) => member.userId === userId);
        const member = { workspaceId: serverWorkspace.id, userId, ...body };
        serverMembers = [...serverMembers.filter((item) => item.userId !== userId), member];
        return success(member, existing ? 200 : 201);
      }
      if (memberMatch && init?.method === "DELETE") {
        const userId = decodeURIComponent(memberMatch[1]);
        serverMembers = serverMembers.filter((member) => member.userId !== userId);
        return success({}, 204);
      }
      if (url.endsWith("/members")) return success({ items: serverMembers, total: serverMembers.length });
      if (url.endsWith("/revisions")) return success({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.endsWith("/operations") && init?.method === "POST") {
        if (conflictNextOperation) {
          conflictNextOperation = false;
          return {
            ok: false,
            status: 409,
            json: async () => ({}),
            text: async () => JSON.stringify({ error: { code: "conflict", message: "Workspace changed", correlationId: "test-conflict" } }),
          };
        }
        const body = JSON.parse(String(init.body)) as { operations: WorkspaceOperation[] };
        serverWorkspace = applyOperations(serverWorkspace, body.operations);
        return success(serverWorkspace);
      }
      if (url.endsWith("/api/v1/workspaces/cooling-water-system")) return success(serverWorkspace);
      return success({ status: "ok" });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  function openExplorer() {
    fireEvent.click(screen.getAllByRole("button", { name: "Open Data Fusion Explorer" })[0]);
  }

  function operationRequest() {
    return fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/operations") && init?.method === "POST");
  }

  function operationRequests() {
    return fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/operations") && init?.method === "POST");
  }

  function memberMutationRequests(method?: "PUT" | "DELETE") {
    return fetchMock.mock.calls.filter(([url, init]) =>
      /\/members\/[^/?]+$/.test(String(url)) && (!method || init?.method === method),
    );
  }

  async function waitForEditor() {
    await waitFor(() => expect(screen.getByRole("button", { name: "Note" })).toBeEnabled());
  }

  it("renders positions and edges from the workspace snapshot", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    expect(pump).toHaveStyle({ left: "321px", top: "123px" });
    expect(document.querySelector('[data-edge-id="canvas-p101-pressure"]')).toBeInTheDocument();
  });

  it("adds a real shared note through the operations endpoint", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: "Note" }));

    await waitFor(() => expect(operationRequest()).toBeDefined());
    const [, init] = operationRequest()!;
    const body = JSON.parse(String(init?.body)) as { baseVersion: number; operations: WorkspaceOperation[] };
    expect(body.baseVersion).toBe(1);
    expect(body.operations[0]).toMatchObject({ type: "addNode", node: { type: "note", data: { label: "New note" } } });
    expect((init?.headers as Record<string, string>)["x-odf-user"]).toBe("harper.dennis");
    expect(await screen.findByRole("button", { name: "New note canvas node" })).toBeInTheDocument();
  });

  it("connects a selected source and target and renders the returned edge", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    const documentNode = screen.getByRole("button", { name: "CWS Overview.pdf canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    fireEvent.click(pump);
    expect(screen.getByText("Select a target node")).toBeInTheDocument();
    fireEvent.click(documentNode);

    await waitFor(() => expect(operationRequest()).toBeDefined());
    const [, init] = operationRequest()!;
    const body = JSON.parse(String(init?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations[0]).toMatchObject({
      type: "addEdge",
      edge: { source: "canvas-p101", target: "canvas-overview", type: "relatedTo" },
    });
    const operation = body.operations[0];
    if (operation.type !== "addEdge") throw new Error("Expected addEdge operation");
    await waitFor(() => expect(document.querySelector(`[data-edge-id="${operation.edge.id}"]`)).toBeInTheDocument());
  });

  it("commits a node move on pointer release", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    fireEvent.pointerDown(pump, { pointerId: 7, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pump, { pointerId: 7, clientX: 150, clientY: 160 });
    fireEvent.pointerUp(pump, { pointerId: 7, clientX: 150, clientY: 160 });

    await waitFor(() => expect(operationRequest()).toBeDefined());
    const [, init] = operationRequest()!;
    const body = JSON.parse(String(init?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations[0]).toEqual({ type: "moveNode", nodeId: "canvas-p101", position: { x: 371, y: 183 } });
  });

  it("edits note content and size from the node inspector", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Operator note canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: "Operator note canvas node" }));

    fireEvent.change(screen.getByLabelText("Node label"), { target: { value: "Shift handover" } });
    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "Inspect seal before restart" } });
    fireEvent.change(screen.getByLabelText("Node width"), { target: { value: "280" } });
    fireEvent.change(screen.getByLabelText("Node height"), { target: { value: "160" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(operationRequests()).toHaveLength(1));
    const [, init] = operationRequests()[0];
    const body = JSON.parse(String(init?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations[0]).toEqual({
      type: "updateNode",
      nodeId: "canvas-note",
      patch: { data: { label: "Shift handover", width: 280, height: 160, text: "Inspect seal before restart" } },
    });
    const updatedNote = await screen.findByRole("button", { name: "Shift handover canvas node" });
    expect(updatedNote).toHaveStyle({ width: "280px", height: "160px" });
  });

  it("edits and deletes a selected relationship", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: "Relationship Pump P-101 to Pressure psi" }));

    fireEvent.change(screen.getByLabelText("Relationship type"), { target: { value: "feeds" } });
    fireEvent.change(screen.getByLabelText("Relationship label"), { target: { value: "Pressure feed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save relationship" }));

    await waitFor(() => expect(operationRequests()).toHaveLength(1));
    let body = JSON.parse(String(operationRequests()[0][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations[0]).toEqual({
      type: "updateEdge",
      edgeId: "canvas-p101-pressure",
      patch: { type: "feeds", data: { label: "Pressure feed" } },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete relationship" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Delete relationship" }));
    await waitFor(() => expect(operationRequests()).toHaveLength(2));
    body = JSON.parse(String(operationRequests()[1][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations).toEqual([{ type: "removeEdge", edgeId: "canvas-p101-pressure" }]);
    expect(screen.queryByRole("button", { name: "Relationship Pump P-101 to Pressure psi" })).not.toBeInTheDocument();
  });

  it("resizes through the canvas handle and undo/redo emits inverse operations", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    await waitFor(() => expect(pump.querySelector(".canvas-node-resize-handle")).toBeInTheDocument());
    const handle = pump.querySelector(".canvas-node-resize-handle") as HTMLElement;

    fireEvent.pointerDown(handle, { pointerId: 9, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 9, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(handle, { pointerId: 9, clientX: 160, clientY: 140 });
    await waitFor(() => expect(operationRequests()).toHaveLength(1));
    let body = JSON.parse(String(operationRequests()[0][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations).toEqual([{ type: "updateNode", nodeId: "canvas-p101", patch: { data: { width: 245, height: 140 } } }]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(operationRequests()).toHaveLength(2));
    body = JSON.parse(String(operationRequests()[1][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations).toEqual([{ type: "updateNode", nodeId: "canvas-p101", patch: { data: { width: 185, height: 100 } } }]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(operationRequests()).toHaveLength(3));
    body = JSON.parse(String(operationRequests()[2][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations).toEqual([{ type: "updateNode", nodeId: "canvas-p101", patch: { data: { width: 245, height: 140 } } }]);
  });

  it("deletes a node and undo restores it with its incident relationships", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: "Pump P-101 canvas node" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete node" }));

    await waitFor(() => expect(operationRequests()).toHaveLength(1));
    let body = JSON.parse(String(operationRequests()[0][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations).toEqual([
      { type: "removeEdge", edgeId: "canvas-p101-pressure" },
      { type: "removeNode", nodeId: "canvas-p101" },
    ]);
    expect(screen.queryByRole("button", { name: "Pump P-101 canvas node" })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(operationRequests()).toHaveLength(2));
    body = JSON.parse(String(operationRequests()[1][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations[0]).toMatchObject({ type: "addNode", node: { id: "canvas-p101" } });
    expect(body.operations[1]).toMatchObject({ type: "addEdge", edge: { id: "canvas-p101-pressure" } });
    expect(await screen.findByRole("button", { name: "Pump P-101 canvas node" })).toBeInTheDocument();
  });

  it("enforces viewer mode across authoring controls and inspector fields", async () => {
    serverMembers[0] = { ...serverMembers[0], role: "viewer" };
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    expect(await screen.findByText(/viewer.*read only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Note" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New canvas" })).toBeDisabled();
    expect(screen.getByLabelText("Node label")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Workspace members/ }));
    expect(screen.getByRole("region", { name: "Workspace members" })).toBeInTheDocument();
    expect(screen.getByText("riley.chen")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Add or update member" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Riley Chen")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Riley Chen" })).not.toBeInTheDocument();

    fireEvent.pointerDown(pump, { pointerId: 11, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pump, { pointerId: 11, clientX: 180, clientY: 180 });
    fireEvent.pointerUp(pump, { pointerId: 11, clientX: 180, clientY: 180 });
    expect(operationRequests()).toHaveLength(0);
  });

  it("shows presence and refreshes when SSE announces a newer version", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    const stream = MockEventSource.instances[0];
    expect(stream.url).toContain("/events?user=harper.dennis");

    fireEvent.click(screen.getByRole("button", { name: /Workspace members/ }));
    const jordan: WorkspaceMember = { workspaceId: serverWorkspace.id, userId: "jordan.kim", displayName: "Jordan Kim", role: "reviewer" };
    serverMembers = [...serverMembers, jordan];
    stream.emit("members.updated", {
      workspaceId: serverWorkspace.id,
      actor: "harper.dennis",
      change: "added",
      member: jordan,
      occurredAt: "2025-05-14T11:59:59.000Z",
    });
    expect(await screen.findByText("jordan.kim")).toBeInTheDocument();

    stream.emit("presence.updated", {
      workspaceId: serverWorkspace.id,
      users: [
        { userId: "harper.dennis", displayName: "Harper Dennis", role: "owner" },
        { userId: "riley.chen", displayName: "Riley Chen", role: "editor" },
      ],
      occurredAt: "2025-05-14T12:00:00.000Z",
    });
    serverWorkspace = workspaceFixture(2);
    serverWorkspace.snapshot.nodes[1].data.label = "Pump P-101 · remote update";
    stream.emit("workspace.updated", {
      workspaceId: serverWorkspace.id,
      version: 2,
      actor: "riley.chen",
      changeSummary: "Moved pump",
      operations: [],
      updatedAt: "2025-05-14T12:00:00.000Z",
    });

    expect(await screen.findByText("2 online")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Pump P-101 · remote update canvas node" })).toBeInTheDocument();
  });

  it("lets an owner add, update, and remove workspace members", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: /Workspace members/ }));

    expect(screen.getByRole("region", { name: "Workspace members" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Member user ID"), { target: { value: "jordan.kim" } });
    fireEvent.change(screen.getByLabelText("Member display name"), { target: { value: "Jordan Kim" } });
    fireEvent.change(screen.getByLabelText("New member role"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "Add or update" }));

    await waitFor(() => expect(memberMutationRequests("PUT")).toHaveLength(1));
    let [, init] = memberMutationRequests("PUT")[0];
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: "Jordan Kim", role: "editor" });
    expect((init?.headers as Record<string, string>)["x-odf-user"]).toBe("harper.dennis");
    expect(await screen.findByText("jordan.kim")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Role for Jordan Kim"), { target: { value: "reviewer" } });
    await waitFor(() => expect(memberMutationRequests("PUT")).toHaveLength(2));
    [, init] = memberMutationRequests("PUT")[1];
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: "Jordan Kim", role: "reviewer" });
    await waitFor(() => expect(screen.getByLabelText("Role for Jordan Kim")).toHaveValue("reviewer"));

    fireEvent.click(screen.getByRole("button", { name: "Remove Jordan Kim" }));
    await waitFor(() => expect(memberMutationRequests("DELETE")).toHaveLength(1));
    expect((memberMutationRequests("DELETE")[0][1]?.headers as Record<string, string>)["x-odf-user"]).toBe("harper.dennis");
    await waitFor(() => expect(screen.queryByText("jordan.kim")).not.toBeInTheDocument());
  });

  it("shows the server conflict when an owner mutation is rejected", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: /Workspace members/ }));
    memberMutationFailure = { status: 409, message: "Workspace must retain at least one owner" };

    fireEvent.change(screen.getByLabelText("Role for Harper Dennis"), { target: { value: "editor" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("must retain at least one owner");
    expect(screen.getByLabelText("Role for Harper Dennis")).toHaveValue("owner");
  });

  it("loads the latest workspace and shows a clear banner after a 409", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    serverWorkspace = workspaceFixture(2);
    conflictNextOperation = true;
    fireEvent.click(screen.getByRole("button", { name: "Note" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Conflict detected");
    await waitFor(() => expect(screen.getByRole("button", { name: /Saved v2/ })).toBeInTheDocument());
  });

  it("preserves Explorer navigation and data context", async () => {
    render(<App />);
    openExplorer();
    expect(screen.getAllByText("Pump P-101").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Pressure (24h)" })).toBeInTheDocument();
    expect(screen.getByText("Related time series (3)")).toBeInTheDocument();
  });

  it("opens the ingest workflow from Explorer", () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Ingest data" }));
    expect(screen.getByRole("dialog", { name: "Ingest data" })).toBeInTheDocument();
    expect(screen.getByText(/1 asset.*1 time series.*1 data point/)).toBeInTheDocument();
  });

  it("switches Explorer asset tabs", () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("tab", { name: "Documents" }));
    expect(screen.getByRole("heading", { name: "Documents" })).toBeInTheDocument();
    expect(screen.getAllByText("P-101 O&M Manual").length).toBeGreaterThan(0);
  });
});
