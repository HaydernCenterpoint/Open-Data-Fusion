import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { ApiAsset, ApiWorkspace, AssetDetailResponse, PlatformSpatialLink, PlatformWritebackRequest, WorkspaceMember, WorkspaceOperation, WorkspaceRevision } from "./types";

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

const apiAssets: ApiAsset[] = [
  {
    externalId: "AREA-A",
    name: "Cooling Water System",
    description: "Cooling water area",
    type: "System",
    parentExternalId: null,
    metadata: { site: "North Plant" },
    sourceSystem: "SAP PM",
    createdAt: "2025-05-14T00:00:00.000Z",
    updatedAt: "2025-05-14T11:58:12.000Z",
  },
  {
    externalId: "P-101",
    name: "Pump P-101",
    description: "Primary pump",
    type: "Pump",
    parentExternalId: "AREA-A",
    metadata: { site: "North Plant" },
    sourceSystem: "OSIsoft PI",
    createdAt: "2025-05-14T00:00:00.000Z",
    updatedAt: "2025-05-14T11:58:12.000Z",
  },
  {
    externalId: "P-102",
    name: "Pump P-102",
    description: "Standby pump",
    type: "Pump",
    parentExternalId: "AREA-A",
    metadata: { site: "North Plant" },
    sourceSystem: "SAP PM",
    createdAt: "2025-05-14T00:00:00.000Z",
    updatedAt: "2025-05-14T12:00:00.000Z",
  },
];

const acceptedRelation = {
  id: "rel-p101-v401",
  source: { type: "asset", externalId: "P-101" },
  target: { type: "asset", externalId: "V-401" },
  type: "dischargesTo",
  status: "accepted" as const,
  confidence: 0.92,
  evidence: [{ field: "drawing", value: "DWG-2314" }],
  ruleVersion: "rule-1",
  reviewer: "harper.dennis",
  reviewComment: "Confirmed",
  reviewedAt: "2025-05-13T16:22:31.000Z",
  sourceSystem: "Context engine",
  createdAt: "2025-05-12T12:00:00.000Z",
  updatedAt: "2025-05-13T16:22:31.000Z",
};

const platformTenant = { id: "demo", name: "Demo Industrial Tenant", createdBy: "system", createdAt: "2025-05-14T00:00:00.000Z" };
const platformProject = { tenantId: "demo", id: "north-plant", name: "North Plant", description: "Seeded industrial project", createdBy: "system", createdAt: "2025-05-14T00:00:00.000Z" };
const platformSource = { tenantId: "demo", projectId: "north-plant", id: "opcua-north", name: "North OPC-UA", type: "opcua", description: "Read-only plant source", createdBy: "riley.chen", createdAt: "2025-05-14T00:00:00.000Z" };
const platformSourceTwo = { ...platformSource, id: "jdbc-maintenance", name: "Maintenance JDBC", type: "jdbc" };
const platformConnector = { tenantId: "demo", projectId: "north-plant", id: "opcua-reader", name: "OPC-UA Reader", sourceId: "opcua-north", type: "opcua", configuration: { endpoint: "opc.tcp://edge.local:4840", secretRef: "vault://odf/opcua" }, enabled: true, createdBy: "riley.chen", createdAt: "2025-05-14T00:00:00.000Z" };
const platformDataset = { tenantId: "demo", projectId: "north-plant", id: "operations", name: "Operations", description: "Curated operations data", createdBy: "riley.chen", createdAt: "2025-05-14T00:00:00.000Z" };
const platformPipeline = { tenantId: "demo", projectId: "north-plant", id: "normalize-telemetry", name: "Normalize telemetry", sourceId: "opcua-north", datasetId: "operations", definition: { transform: "identity" }, version: 1, enabled: true, createdBy: "riley.chen", createdAt: "2025-05-14T00:00:00.000Z" };
const platformRun = { tenantId: "demo", projectId: "north-plant", id: "run-normalize", pipelineId: "normalize-telemetry", idempotencyKey: "hour-001", status: "completed" as const, inputHash: "hash", result: { quality: { total: 1, passed: 1, failed: 0 } }, triggeredBy: "riley.chen", startedAt: "2025-05-14T12:00:00.000Z", completedAt: "2025-05-14T12:00:01.000Z", replayed: false };
const platformQualityResult = { id: 1, tenantId: "demo", projectId: "north-plant", ruleId: "temperature-minimum", runId: "run-normalize", passed: true, observed: { temperature: 65 }, evaluatedAt: "2025-05-14T12:00:01.000Z" };
const platformModel = { tenantId: "demo", projectId: "north-plant", id: "equipment", version: 1, name: "Equipment", schema: { properties: { tag: { type: "string" } } }, status: "published" as const, createdBy: "riley.chen", createdAt: "2025-05-14T00:00:00.000Z" };
const platformCandidate = { tenantId: "demo", projectId: "north-plant", id: "candidate-1", source: { type: "asset", id: "P-101" }, target: { type: "document", id: "DOC-P101-MANUAL" }, relationType: "hasDocument", confidence: 0.94, evidence: { matchedTag: "P-101" }, status: "proposed" as const, reviewedBy: null, reviewComment: null, reviewedAt: null, createdBy: "riley.chen", createdAt: "2025-05-14T00:00:00.000Z" };
const diagramExtraction = { tenantId: "demo", projectId: "north-plant", id: "pid-001-extraction", documentExternalId: "PID-001", textSha256: "a".repeat(64), tags: [{ tag: "P-101", kind: "equipment" as const, page: 2, bounds: null, confidence: 0.9 }, { tag: "PT-1001", kind: "instrument" as const, page: 2, bounds: null, confidence: 0.94 }], createdBy: "riley.chen", createdAt: "2025-05-14T12:00:00.000Z" };
const diagramExtractionTwo = { ...diagramExtraction, id: "pid-002-extraction", documentExternalId: "PID-002", textSha256: "b".repeat(64), tags: [{ tag: "V-401", kind: "equipment" as const, page: 1, bounds: null, confidence: 0.9 }] };
const matchingEvaluation = { tenantId: "demo", projectId: "north-plant", id: "matching-001", threshold: 0.8, inputSha256: "c".repeat(64), predictionCount: 2, truthCount: 2, evaluation: { threshold: 0.8, truePositives: 1, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1, f1: 1, evaluatedPairs: 2 }, proposals: [{ sourceExternalId: "PT-1001", targetExternalId: "P-101-PRESSURE", score: 0.91, state: "proposed" as const }, { sourceExternalId: "PT-1001", targetExternalId: "P-102-PRESSURE", score: 0.4, state: "proposed" as const }], createdBy: "riley.chen", createdAt: "2025-05-14T12:05:00.000Z" };
const spatialLinkFixture = { tenantId: "demo", projectId: "north-plant", id: "spatial-p101", assetExternalId: "P-101", sceneExternalId: "north-plant-3d", nodeExternalId: "node-p101", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], confidence: 0.96, reviewState: "proposed" as const, reviewedBy: null, reviewComment: null, reviewedAt: null, createdBy: "riley.chen", createdAt: "2025-05-14T12:10:00.000Z" };
const highRiskWriteback = { id: "wb-high-001", tenantId: "demo", projectId: "north-plant", sourceId: "control-system", targetExternalId: "P-101", operation: "set.control_mode", payload: { mode: "manual" }, risk: "high" as const, state: "pending_approval" as const, requestedBy: "riley.chen", requestedAt: "2025-05-14T12:15:00.000Z", approvals: [], dryRunResult: { safe: true, evidence: { interlocks: "passed", simulator: "passed" } }, executedAt: null, blockedReasons: [], executionResult: null, updatedAt: "2025-05-14T12:15:00.000Z", safety: { allowed: false, requiredApprovals: 2, validApprovals: 0, reasons: ["2 distinct non-requester approval(s) required"] } };
const criticalWriteback = { ...highRiskWriteback, id: "wb-critical", operation: "reset.trip", risk: "critical" as const, state: "cancelled" as const, blockedReasons: ["Critical write-back requires an external safety case and cannot be approved automatically"], safety: { allowed: false, requiredApprovals: 2, validApprovals: 0, reasons: ["Critical write-back requires an external safety case and cannot be approved automatically", "2 distinct non-requester approval(s) required"] } };

const assetDetail: AssetDetailResponse = {
  asset: {
    externalId: "P-101",
    name: "Pump P-101",
    description: "Primary pump",
    type: "Pump",
    parentExternalId: "AREA-A",
    metadata: { site: "North Plant" },
    sourceSystem: "OSIsoft PI",
    createdAt: "2025-05-14T00:00:00.000Z",
    updatedAt: "2025-05-14T11:58:12.000Z",
  },
  parent: null,
  children: [],
  timeSeries: [
    { externalId: "P-101-PRESSURE", assetExternalId: "P-101", name: "Pressure", unit: "psi", description: null, sourceSystem: "OSIsoft PI" },
    { externalId: "P-101-FLOW", assetExternalId: "P-101", name: "Discharge Flow", unit: "gpm", description: null, sourceSystem: "OSIsoft PI" },
    { externalId: "P-101-CURRENT", assetExternalId: "P-101", name: "Motor Current", unit: "A", description: null, sourceSystem: "OSIsoft PI" },
  ],
  documents: [
    { externalId: "DOC-P101-OM", assetExternalId: "P-101", title: "P-101 O&M Manual", mimeType: "application/pdf", uri: "/documents/p101-om.pdf", sourceSystem: "Manual Upload" },
    { externalId: "DOC-P101-CURVE", assetExternalId: "P-101", title: "P-101 Performance Curve", mimeType: "application/pdf", uri: "/documents/p101-curve.pdf", sourceSystem: "Manual Upload" },
  ],
  relations: [acceptedRelation],
  provenance: [
    { id: 1, entityType: "asset", entityId: "P-101", sourceSystem: "SAP PM", sourceRecordId: "P-101", ingestionRunId: "run-101", rawHash: "hash", modelVersion: "v1", validFrom: "2025-05-14T00:00:00.000Z", transactionTime: "2025-05-14T00:01:00.000Z", metadata: {} },
  ],
};

function revisionFixture(version: number): WorkspaceRevision {
  return {
    workspaceId: "cooling-water-system",
    version,
    snapshot: workspaceFixture(version).snapshot,
    changeSummary: `Revision ${version}`,
    actor: version % 2 === 0 ? "riley.chen" : "harper.dennis",
    createdAt: new Date(Date.UTC(2025, 4, 14, 12, version % 60)).toISOString(),
    correlationId: `revision-${version}`,
  };
}

describe("Open Data Fusion workspace", () => {
  let serverWorkspace: ApiWorkspace;
  let serverMembers: WorkspaceMember[];
  let serverRevisions: WorkspaceRevision[];
  let conflictNextOperation: boolean;
  let memberMutationFailure: { status: number; message: string } | null;
  let platformFailure: { path: string; status: number; message: string } | null;
  let triggeredRunKeys: Set<string>;
  let serverSpatialLink: PlatformSpatialLink;
  let serverWritebacks: PlatformWritebackRequest[];
  let writebackApprovalCount: number;
  let fetchMock: ReturnType<typeof vi.fn>;
  let blockProjectRequests: boolean;
  let releaseProjectRequest: (() => void) | null;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    serverWorkspace = workspaceFixture();
    serverMembers = [
      { workspaceId: serverWorkspace.id, userId: "harper.dennis", displayName: "Harper Dennis", role: "owner" },
      { workspaceId: serverWorkspace.id, userId: "riley.chen", displayName: "Riley Chen", role: "editor" },
    ];
    serverRevisions = [];
    conflictNextOperation = false;
    memberMutationFailure = null;
    platformFailure = null;
    triggeredRunKeys = new Set();
    serverSpatialLink = structuredClone(spatialLinkFixture);
    serverWritebacks = [structuredClone(highRiskWriteback), structuredClone(criticalWriteback)];
    writebackApprovalCount = 0;
    blockProjectRequests = false;
    releaseProjectRequest = null;
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

      const parsedUrl = new URL(url, "http://test.local");
      if (parsedUrl.pathname === "/api/health") return success({ status: "ok" });
      if (platformFailure && parsedUrl.pathname === platformFailure.path) {
        const failure = platformFailure;
        return {
          ok: false,
          status: failure.status,
          json: async () => ({}),
          text: async () => JSON.stringify({ error: { code: "platform_error", message: failure.message, correlationId: "platform-test" } }),
        };
      }
      if (parsedUrl.pathname === "/api/v1/platform/diagrams/tag-extractions") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { documentExternalId: string; page?: number; text: string };
          return success({ ...diagramExtraction, id: "extraction-created", documentExternalId: body.documentExternalId, tags: [{ tag: "P-101", kind: "equipment", page: body.page ?? null, bounds: null, confidence: 0.9 }] }, 201);
        }
        return parsedUrl.searchParams.has("cursor")
          ? success({ items: [diagramExtractionTwo], nextCursor: null })
          : success({ items: [diagramExtraction], nextCursor: "diagram-next" });
      }
      if (parsedUrl.pathname === "/api/v1/platform/matching/evaluations") {
        if (init?.method === "POST") return success(matchingEvaluation, 201);
        return success({ items: [matchingEvaluation], nextCursor: null });
      }
      const spatialReviewMatch = parsedUrl.pathname.match(/^\/api\/v1\/platform\/spatial\/asset-links\/([^/]+)\/review$/);
      if (spatialReviewMatch && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { decision: "accepted" | "rejected"; comment?: string };
        serverSpatialLink = { ...serverSpatialLink, reviewState: body.decision, reviewedBy: "harper.dennis", reviewComment: body.comment ?? null, reviewedAt: "2025-05-14T12:30:00.000Z" };
        return success(serverSpatialLink);
      }
      if (parsedUrl.pathname === "/api/v1/platform/spatial/asset-links") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Pick<PlatformSpatialLink, "assetExternalId" | "sceneExternalId" | "nodeExternalId" | "transform" | "confidence">;
          serverSpatialLink = { ...spatialLinkFixture, ...body, id: "spatial-created" };
          return success(serverSpatialLink, 201);
        }
        return success({ items: [serverSpatialLink], nextCursor: null });
      }
      const writebackApprovalMatch = parsedUrl.pathname.match(/^\/api\/v1\/platform\/writeback\/requests\/([^/]+)\/approvals$/);
      if (writebackApprovalMatch && init?.method === "POST") {
        const requestId = decodeURIComponent(writebackApprovalMatch[1]);
        const current = serverWritebacks.find((request) => request.id === requestId)!;
        const body = JSON.parse(String(init.body)) as { decision: "approved" | "rejected"; comment?: string };
        writebackApprovalCount += 1;
        const actor = writebackApprovalCount === 1 ? "monica.reyes" : "harper.dennis";
        const approvals = [...current.approvals, { actor, decision: body.decision, occurredAt: `2025-05-14T12:${30 + writebackApprovalCount}:00.000Z`, comment: body.comment ?? null }];
        const validApprovals = approvals.filter((approval) => approval.decision === "approved").length;
        const state = body.decision === "rejected" ? "cancelled" : validApprovals >= current.safety.requiredApprovals ? "approved" : "pending_approval";
        const allowed = state === "approved";
        const updated: PlatformWritebackRequest = { ...current, approvals, state, safety: { ...current.safety, allowed, validApprovals, reasons: allowed ? [] : [`${current.safety.requiredApprovals} distinct non-requester approval(s) required`] } };
        serverWritebacks = serverWritebacks.map((request) => request.id === requestId ? updated : request);
        return success(updated);
      }
      const writebackExecuteMatch = parsedUrl.pathname.match(/^\/api\/v1\/platform\/writeback\/requests\/([^/]+)\/execute$/);
      if (writebackExecuteMatch && init?.method === "POST") {
        const requestId = decodeURIComponent(writebackExecuteMatch[1]);
        const current = serverWritebacks.find((request) => request.id === requestId)!;
        const updated: PlatformWritebackRequest = { ...current, state: "succeeded", executedAt: "2025-05-14T12:40:00.000Z", executionResult: { externalWriteId: `write-${requestId}`, applied: true } };
        serverWritebacks = serverWritebacks.map((request) => request.id === requestId ? updated : request);
        return success(updated);
      }
      if (parsedUrl.pathname === "/api/v1/platform/writeback/requests") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { sourceId: string; targetExternalId: string; operation: string; payload: Record<string, unknown>; risk: PlatformWritebackRequest["risk"]; dryRunResult: PlatformWritebackRequest["dryRunResult"] };
          const blockedReasons = body.risk === "critical" ? ["Critical write-back requires an external safety case and cannot be approved automatically"] : body.dryRunResult?.safe === true ? [] : ["A successful safe dry-run is required"];
          const created: PlatformWritebackRequest = { ...highRiskWriteback, ...body, id: "wb-created", state: blockedReasons.length ? "cancelled" : "pending_approval", blockedReasons, approvals: [], safety: { allowed: false, requiredApprovals: body.risk === "high" || body.risk === "critical" ? 2 : 1, validApprovals: 0, reasons: blockedReasons.length ? blockedReasons : [`${body.risk === "high" ? 2 : 1} distinct non-requester approval(s) required`] } };
          serverWritebacks = [created, ...serverWritebacks];
          return success(created, 201);
        }
        return success({ items: serverWritebacks, nextCursor: null });
      }
      if (parsedUrl.pathname === "/api/v1/platform/tenants") return success({ items: [platformTenant], nextCursor: null });
      if (parsedUrl.pathname === "/api/v1/platform/tenants/demo/projects") {
        if (blockProjectRequests) {
          await new Promise<void>((resolve) => { releaseProjectRequest = resolve; });
        }
        return success({ items: [platformProject], nextCursor: null });
      }
      if (parsedUrl.pathname === "/api/v1/platform/sources") {
        return parsedUrl.searchParams.has("cursor")
          ? success({ items: [platformSourceTwo], nextCursor: null })
          : success({ items: [platformSource], nextCursor: "sources-next" });
      }
      if (parsedUrl.pathname === "/api/v1/platform/connectors") return success({ items: [platformConnector], nextCursor: null });
      if (parsedUrl.pathname === "/api/v1/platform/datasets") return success({ items: [platformDataset], nextCursor: null });
      if (parsedUrl.pathname === "/api/v1/platform/data-models") return success({ items: [platformModel], nextCursor: null });
      if (parsedUrl.pathname === "/api/v1/platform/pipelines") return success({ items: [platformPipeline], nextCursor: null });
      if (parsedUrl.pathname === "/api/v1/platform/pipeline-runs") return success({ items: [platformRun], nextCursor: null });
      if (parsedUrl.pathname === "/api/v1/platform/quality-results") return success({ items: [platformQualityResult], nextCursor: null });
      if (parsedUrl.pathname === "/api/v1/platform/contextualization/candidates") return success({ items: [platformCandidate], nextCursor: null });
      const candidateReviewMatch = parsedUrl.pathname.match(/^\/api\/v1\/platform\/contextualization\/candidates\/([^/]+)\/review$/);
      if (candidateReviewMatch && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { decision: "accepted" | "rejected" };
        return success({ ...platformCandidate, status: body.decision, reviewedBy: "harper.dennis", reviewedAt: "2025-05-14T12:30:00.000Z" });
      }
      const pipelineRunMatch = parsedUrl.pathname.match(/^\/api\/v1\/platform\/pipelines\/([^/]+)\/runs$/);
      if (pipelineRunMatch && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { idempotencyKey: string; input: Record<string, unknown> };
        const replayed = triggeredRunKeys.has(body.idempotencyKey);
        triggeredRunKeys.add(body.idempotencyKey);
        return success({ ...platformRun, id: `run-${body.idempotencyKey}`, idempotencyKey: body.idempotencyKey, result: { quality: { total: 1, passed: 1, failed: 0 }, input: body.input }, replayed }, replayed ? 200 : 201);
      }
      if (parsedUrl.pathname === "/api/v1/platform/search") {
        const q = parsedUrl.searchParams.get("q") ?? "";
        const result = q.toLowerCase().includes("102")
          ? { tenantId: "demo", projectId: "north-plant", entityType: "asset", entityId: "P-102", title: "Pump P-102", summary: "Standby pump", updatedAt: "2025-05-14T12:00:00.000Z" }
          : { tenantId: "demo", projectId: "north-plant", entityType: "pipeline", entityId: "normalize-telemetry", title: "Normalize telemetry", summary: "Pipeline", updatedAt: "2025-05-14T12:00:00.000Z" };
        return success({ items: [result], nextCursor: null });
      }
      if (parsedUrl.pathname === "/api/v1/assets") {
        const query = parsedUrl.searchParams.get("q")?.toLowerCase() ?? "";
        const offset = Number(parsedUrl.searchParams.get("offset") ?? 0);
        const limit = Number(parsedUrl.searchParams.get("limit") ?? 50);
        const filtered = apiAssets.filter((asset) => `${asset.externalId} ${asset.name} ${asset.description ?? ""}`.toLowerCase().includes(query));
        return success({ items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset });
      }
      const telemetryMatch = parsedUrl.pathname.match(/^\/api\/v1\/assets\/([^/]+)\/telemetry$/);
      if (telemetryMatch) {
        const externalId = decodeURIComponent(telemetryMatch[1]);
        const series = externalId === "P-101" ? assetDetail.timeSeries.map((item, index) => ({ ...item, points: [{ timestamp: "2025-05-14T11:58:00.000Z", value: index === 0 ? 111.2 : index === 1 ? 482 : 68.4, quality: "good" }] })) : [];
        return success({ assetExternalId: externalId, range: { from: "2025-05-13T12:00:00.000Z", to: "2025-05-14T12:00:00.000Z" }, series });
      }
      const assetMatch = parsedUrl.pathname.match(/^\/api\/v1\/assets\/([^/]+)$/);
      if (assetMatch) {
        const externalId = decodeURIComponent(assetMatch[1]);
        if (externalId === "P-101") return success(assetDetail);
        const asset = apiAssets.find((item) => item.externalId === externalId);
        if (asset) return success({ asset, parent: null, children: [], timeSeries: [], documents: [], relations: [], provenance: [] });
      }
      if (parsedUrl.pathname === "/api/v1/relations") return success({ items: [acceptedRelation], total: 1, limit: 200 });
      if (parsedUrl.pathname === "/api/v1/audit") {
        const offset = Number(parsedUrl.searchParams.get("offset") ?? 0);
        const items = [{ id: 1, timestamp: "2025-05-14T12:00:00.000Z", actor: "harper.dennis", action: "workspace.operations_applied", entityType: "workspace", entityId: "cooling-water-system", details: { baseVersion: 1, newVersion: 2 }, correlationId: "audit-correlation-1" }];
        return success({ items: items.slice(offset), total: items.length, limit: 50, offset });
      }
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
      if (parsedUrl.pathname.endsWith("/revisions")) {
        const offset = Number(parsedUrl.searchParams.get("offset") ?? 0);
        const limit = Number(parsedUrl.searchParams.get("limit") ?? 50);
        return success({ items: serverRevisions.slice(offset, offset + limit), total: serverRevisions.length, limit, offset });
      }
      if (parsedUrl.pathname.endsWith("/rollback") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { targetVersion: number };
        const target = serverRevisions.find((revision) => revision.version === body.targetVersion);
        serverWorkspace = { ...serverWorkspace, version: serverWorkspace.version + 1, snapshot: structuredClone(target?.snapshot ?? serverWorkspace.snapshot), updatedBy: "harper.dennis" };
        return success(serverWorkspace);
      }
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

  it("waits for a selected tenant and project before loading the Canvas workspace", async () => {
    blockProjectRequests = true;
    render(<App />);

    await waitFor(() => expect(releaseProjectRequest).not.toBeNull());
    const workspaceRequestsBeforeContext = fetchMock.mock.calls.filter(([url]) =>
      new URL(String(url), "http://test.local").pathname === "/api/v1/workspaces/cooling-water-system",
    );
    expect(workspaceRequestsBeforeContext).toHaveLength(0);

    releaseProjectRequest?.();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      new URL(String(url), "http://test.local").pathname === "/api/v1/workspaces/cooling-water-system",
    )).toBe(true));

    const [, init] = fetchMock.mock.calls.find(([url]) =>
      new URL(String(url), "http://test.local").pathname === "/api/v1/workspaces/cooling-water-system",
    ) as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-odf-tenant-id")).toBe("demo");
    expect(headers.get("x-odf-project-id")).toBe("north-plant");
  });

  it("groups canvas tools in a dedicated toolbar without a duplicate brand control", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });

    const toolbar = screen.getByRole("toolbar", { name: "Canvas tools" });
    expect(within(toolbar).getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Layers" })).toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "Open Data Fusion Explorer" })).not.toBeInTheDocument();
    expect(toolbar.querySelectorAll(".canvas-tool-group")).toHaveLength(3);
  });

  it("opens real layer navigation and the responsive selection inspector", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });

    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    const layers = screen.getByRole("region", { name: "Canvas layers" });
    fireEvent.click(within(layers).getByRole("button", { name: /Operator note/ }));

    expect(screen.getByRole("complementary", { name: "Selection inspector" })).toHaveClass("is-open");
    expect(screen.getByRole("button", { name: "Open selection inspector" })).toHaveAttribute("aria-expanded", "true");
  });

  it("renders positions and edges from the workspace snapshot", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    expect(pump).toHaveStyle({ left: "0px", top: "0px", transform: "translate3d(321px, 123px, 0)" });
    expect(pump).toHaveAttribute("data-canvas-x", "321");
    expect(pump).toHaveAttribute("data-canvas-y", "123");
    expect(document.querySelector('[data-edge-id="canvas-p101-pressure"]')).toBeInTheDocument();
  });

  it("fits canvas content into the visible stage", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    const stage = screen.getByRole("main", { name: "Open Data Fusion industrial canvas" });
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 840 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 720 });

    const world = stage.querySelector(".canvas-dots") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "Fit canvas" }));

    await waitFor(() => expect(world.style.transform).not.toBe("translate(0px, 0px) scale(1)"));
    expect(world.style.transform).toMatch(/scale\(0\.[0-9]+\)/);
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

  it("previews connected geometry during drag and commits one move on pointer release", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    const edge = document.querySelector('[data-edge-id="canvas-p101-pressure"]') as SVGPathElement;
    const initialPath = edge.getAttribute("d");

    fireEvent.pointerDown(pump, { pointerId: 7, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pump, { pointerId: 7, clientX: 150, clientY: 160 });
    await waitFor(() => expect(edge.getAttribute("d")).not.toBe(initialPath));
    expect(pump).toHaveAttribute("data-canvas-x", "371");
    expect(pump).toHaveAttribute("data-canvas-y", "183");
    expect(operationRequests()).toHaveLength(0);
    const previewPath = edge.getAttribute("d");

    fireEvent.pointerUp(pump, { pointerId: 7, clientX: 150, clientY: 160 });

    await waitFor(() => expect(operationRequests()).toHaveLength(1));
    const [, init] = operationRequests()[0];
    const body = JSON.parse(String(init?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations[0]).toEqual({ type: "moveNode", nodeId: "canvas-p101", position: { x: 371, y: 183 } });
    await waitFor(() => expect(edge.getAttribute("d")).toBe(previewPath));
  });

  it("clears cancelled and lost-capture drag previews without committing", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    const edge = document.querySelector('[data-edge-id="canvas-p101-pressure"]') as SVGPathElement;
    const initialPath = edge.getAttribute("d");

    fireEvent.pointerDown(pump, { pointerId: 8, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pump, { pointerId: 8, clientX: 170, clientY: 160 });
    await waitFor(() => expect(edge.getAttribute("d")).not.toBe(initialPath));
    fireEvent.pointerCancel(pump, { pointerId: 8 });

    await waitFor(() => expect(edge.getAttribute("d")).toBe(initialPath));
    expect(pump).toHaveAttribute("data-canvas-x", "321");
    expect(pump).toHaveAttribute("data-canvas-y", "123");

    fireEvent.pointerDown(pump, { pointerId: 81, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(pump, { pointerId: 81, clientX: 180, clientY: 170 });
    await waitFor(() => expect(edge.getAttribute("d")).not.toBe(initialPath));
    fireEvent.lostPointerCapture(pump, { pointerId: 81 });
    await waitFor(() => expect(edge.getAttribute("d")).toBe(initialPath));

    expect(operationRequests()).toHaveLength(0);
  });

  it("edits note content and size from the node inspector", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "Operator note canvas node" });
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: "Operator note canvas node" }));

    fireEvent.change(screen.getByLabelText("Node label"), { target: { value: "Shift handover" } });
    fireEvent.change(screen.getByLabelText("Note content"), { target: { value: "Inspect seal before restart" } });
    fireEvent.change(screen.getByLabelText("Node X position"), { target: { value: "760" } });
    fireEvent.change(screen.getByLabelText("Node Y position"), { target: { value: "590" } });
    fireEvent.change(screen.getByLabelText("Node width"), { target: { value: "280" } });
    fireEvent.change(screen.getByLabelText("Node height"), { target: { value: "160" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(operationRequests()).toHaveLength(1));
    const [, init] = operationRequests()[0];
    const body = JSON.parse(String(init?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations[0]).toEqual({
      type: "updateNode",
      nodeId: "canvas-note",
      patch: { data: { label: "Shift handover", width: 280, height: 160, text: "Inspect seal before restart" }, position: { x: 760, y: 590 } },
    });
    const updatedNote = await screen.findByRole("button", { name: "Shift handover canvas node" });
    expect(updatedNote).toHaveStyle({ width: "280px", height: "160px", transform: "translate3d(760px, 590px, 0)" });
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

  it("previews connected geometry during resize and commits once before undo/redo", async () => {
    render(<App />);
    const pump = await screen.findByRole("button", { name: "Pump P-101 canvas node" });
    await waitForEditor();
    fireEvent.click(pump);
    await waitFor(() => expect(pump.querySelector(".canvas-node-resize-handle")).toBeInTheDocument());
    const handle = pump.querySelector(".canvas-node-resize-handle") as HTMLElement;
    const edge = document.querySelector('[data-edge-id="canvas-p101-pressure"]') as SVGPathElement;
    const initialPath = edge.getAttribute("d");

    fireEvent.pointerDown(handle, { pointerId: 9, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 9, clientX: 160, clientY: 140 });
    await waitFor(() => expect(edge.getAttribute("d")).not.toBe(initialPath));
    expect(pump).toHaveStyle({ width: "245px", height: "140px" });
    expect(operationRequests()).toHaveLength(0);
    const previewPath = edge.getAttribute("d");

    fireEvent.pointerUp(handle, { pointerId: 9, clientX: 160, clientY: 140 });
    await waitFor(() => expect(operationRequests()).toHaveLength(1));
    let body = JSON.parse(String(operationRequests()[0][1]?.body)) as { operations: WorkspaceOperation[] };
    expect(body.operations).toEqual([{ type: "updateNode", nodeId: "canvas-p101", patch: { data: { width: 245, height: 140 } } }]);
    await waitFor(() => expect(edge.getAttribute("d")).toBe(previewPath));

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
    fireEvent.click(pump);
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
    const edge = document.querySelector('[data-edge-id="canvas-p101-pressure"]') as SVGPathElement;
    const initialPath = edge.getAttribute("d");
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
    serverWorkspace.snapshot.nodes[1].position = { x: 421, y: 173 };
    serverWorkspace.snapshot.nodes[1].data.width = 245;
    serverWorkspace.snapshot.nodes[1].data.height = 140;
    stream.emit("workspace.updated", {
      workspaceId: serverWorkspace.id,
      version: 2,
      actor: "riley.chen",
      changeSummary: "Moved pump",
      operations: [],
      updatedAt: "2025-05-14T12:00:00.000Z",
    });

    expect(await screen.findByText("2 online")).toBeInTheDocument();
    const updatedPump = await screen.findByRole("button", { name: "Pump P-101 · remote update canvas node" });
    expect(updatedPump).toHaveAttribute("data-canvas-x", "421");
    expect(updatedPump).toHaveAttribute("data-canvas-y", "173");
    expect(updatedPump).toHaveStyle({ width: "245px", height: "140px" });
    expect(edge.getAttribute("d")).not.toBe(initialPath);
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

  it("supports deep-linked assets and keeps navigation in the URL", async () => {
    window.history.replaceState({}, "", "/?view=explorer&asset=P-102&tenant=demo&project=north-plant");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Pump P-102" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(await screen.findByRole("heading", { name: "Audit" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("audit");
    expect(new URLSearchParams(window.location.search).get("asset")).toBeNull();

    window.history.pushState({}, "", "/?view=explorer&asset=P-101&tenant=demo&project=north-plant");
    fireEvent.popState(window);
    expect(await screen.findByRole("heading", { name: "Pump P-101" })).toBeInTheDocument();
  });

  it("collapses and expands desktop navigation", async () => {
    render(<App />);
    openExplorer();
    await screen.findByRole("heading", { name: "Asset Explorer" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(document.querySelector(".app-shell")).toHaveClass("navigation-collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(document.querySelector(".app-shell")).not.toHaveClass("navigation-collapsed");
  });

  it("preserves Explorer navigation and data context", async () => {
    render(<App />);
    openExplorer();
    const pump = await screen.findByText("Pump P-101");
    fireEvent.click(pump.closest("button")!);
    expect(await screen.findByRole("heading", { name: "Pressure (24h)" })).toBeInTheDocument();
    expect(await screen.findByText("Related time series (3)")).toBeInTheDocument();
  });

  it("keeps related data available as a responsive drawer", async () => {
    render(<App />);
    openExplorer();
    await screen.findByRole("heading", { name: "Asset Explorer" });

    fireEvent.click(screen.getByRole("button", { name: "Open related data" }));
    expect(screen.getByRole("complementary", { name: "Related data" })).toHaveClass("is-open");
    fireEvent.click(within(screen.getByRole("complementary", { name: "Related data" })).getByRole("button", { name: "Close related data" }));
    expect(screen.getByRole("complementary", { name: "Related data" })).not.toHaveClass("is-open");
  });

  it("opens the ingest workflow from Explorer", () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Ingest data" }));
    expect(screen.getByRole("dialog", { name: "Ingest measurement bundle" })).toBeInTheDocument();
    expect(screen.getByText(/1 asset.*1 time series.*1 data point/)).toBeInTheDocument();
  });

  it("switches Explorer asset tabs", async () => {
    render(<App />);
    openExplorer();
    const pump = await screen.findByText("Pump P-101");
    fireEvent.click(pump.closest("button")!);
    await screen.findByRole("heading", { name: "Pressure (24h)" });
    fireEvent.click(await screen.findByRole("tab", { name: "Documents" }));
    expect(screen.getByRole("heading", { name: "Documents" })).toBeInTheDocument();
    expect(screen.getAllByText("P-101 O&M Manual").length).toBeGreaterThan(0);
  });

  it("loads revision history beyond the first page and restores an older revision", async () => {
    serverWorkspace = workspaceFixture(61);
    serverRevisions = Array.from({ length: 61 }, (_, index) => revisionFixture(61 - index));
    render(<App />);
    await waitForEditor();

    fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more (11)" }));
    const oldRevision = await screen.findByText("v2");
    const revisionRow = oldRevision.closest("li");
    expect(revisionRow).not.toBeNull();
    fireEvent.click(within(revisionRow as HTMLElement).getByRole("button", { name: "Restore" }));

    expect(await screen.findByText("Restored revision v2 as new revision v62")).toBeInTheDocument();
    const rollbackRequest = fetchMock.mock.calls.find(([url, init]) => String(url).includes("/rollback") && init?.method === "POST");
    expect(JSON.parse(String(rollbackRequest?.[1]?.body))).toMatchObject({ targetVersion: 2, expectedVersion: 61 });
  });

  it("exposes revision history and members through the mobile overflow menu", async () => {
    render(<App />);
    await waitForEditor();
    fireEvent.click(screen.getByRole("button", { name: "Mobile canvas actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Revision history" }));
    expect(await screen.findByRole("region", { name: "Revision history" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mobile canvas actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Workspace members" }));
    expect(await screen.findByRole("region", { name: "Workspace members" })).toBeInTheDocument();
  });

  it("searches API assets and opens the selected asset", async () => {
    render(<App />);
    openExplorer();
    const search = screen.getByRole("combobox", { name: "Search project data" });
    fireEvent.change(search, { target: { value: "P-102" } });
    fireEvent.click(await screen.findByRole("option", { name: /Pump P-102/ }));

    expect(await screen.findByRole("heading", { name: "Pump P-102" })).toBeInTheDocument();
    const searchRequest = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/v1/platform/search?") && String(url).includes("q=P-102"));
    expect(searchRequest).toBeDefined();
    expect(searchRequest?.[1]?.headers).toMatchObject({
      "x-odf-tenant-id": "demo",
      "x-odf-project-id": "north-plant",
    });
  });

  it("renders API-backed Context and Audit navigation", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    expect(await screen.findByRole("heading", { name: "Context" })).toBeInTheDocument();
    expect(await screen.findByText("hasDocument")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(await screen.findByText("dischargesTo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(await screen.findByRole("heading", { name: "Audit" })).toBeInTheDocument();
    expect(await screen.findByText("workspace.operations_applied")).toBeInTheDocument();
    expect(screen.getByText("audit-correlation-1")).toBeInTheDocument();
  });

  it("loads project-scoped sources, connectors, datasets, and the next keyset page", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByRole("heading", { name: "Sources" })).toBeInTheDocument();
    expect(await screen.findByText("North OPC-UA")).toBeInTheDocument();
    expect(screen.getByText("OPC-UA Reader")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();

    const firstSourceRequest = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/v1/platform/sources?") && !String(url).includes("cursor="));
    expect(firstSourceRequest?.[1]?.headers).toMatchObject({
      "x-odf-tenant-id": "demo",
      "x-odf-project-id": "north-plant",
    });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Maintenance JDBC")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/platform/sources?") && String(url).includes("cursor=sources-next"))).toBe(true);
  });

  it("runs a pipeline idempotently and exposes run and quality evidence", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Pipelines" }));
    expect(await screen.findByText("Normalize telemetry")).toBeInTheDocument();
    expect(screen.getByText("temperature-minimum")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Idempotency key for Normalize telemetry" }), { target: { value: "manual-test" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Run input for Normalize telemetry" }), { target: { value: '{"temperature":65}' } });
    fireEvent.click(screen.getByRole("button", { name: "Run pipeline" }));
    expect(await screen.findByText("New run run-manual-test is completed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run pipeline" }));
    expect(await screen.findByText("Existing run run-manual-test replayed (completed)")).toBeInTheDocument();

    const runRequests = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith("/api/v1/platform/pipelines/normalize-telemetry/runs") && init?.method === "POST");
    expect(runRequests).toHaveLength(2);
    expect(runRequests[0]?.[1]?.headers).toMatchObject({
      "x-odf-tenant-id": "demo",
      "x-odf-project-id": "north-plant",
    });
    expect(JSON.parse(String(runRequests[0]?.[1]?.body))).toEqual({ idempotencyKey: "manual-test", input: { temperature: 65 } });
  });

  it("renders immutable model versions and schemas", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(await screen.findByText("Equipment")).toBeInTheDocument();
    expect(screen.getByText(/equipment.*version 1/)).toBeInTheDocument();
    expect(screen.getByText("published")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Immutable schema"));
    expect(screen.getByText(/"tag"/)).toBeInTheDocument();
  });

  it("reviews a platform context candidate with the selected tenant and project", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Context" }));
    const acceptButton = await screen.findByRole("button", { name: "Accept" });
    fireEvent.click(acceptButton);
    fireEvent.change(screen.getByLabelText("Review evidence"), { target: { value: "Verified against P&ID tag" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm accept" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument());
    const reviewRequest = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/v1/platform/contextualization/candidates/candidate-1/review") && init?.method === "POST");
    expect(reviewRequest?.[1]?.headers).toMatchObject({
      "x-odf-tenant-id": "demo",
      "x-odf-project-id": "north-plant",
    });
    expect(JSON.parse(String(reviewRequest?.[1]?.body))).toEqual({ decision: "accepted", comment: "Verified against P&ID tag" });
  });

  it("extracts P&ID tags and loads the next governed diagram page", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Diagrams" }));

    expect(await screen.findByText("PID-001")).toBeInTheDocument();
    expect(screen.getByText("PT-1001")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("PID-002")).toBeInTheDocument();
    expect(screen.getByText("V-401")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Document external ID"), { target: { value: "PID-003" } });
    fireEvent.change(screen.getByLabelText("Page (optional)"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("P&ID text"), { target: { value: "Pump P-101 on PT-1001" } });
    fireEvent.click(screen.getByRole("button", { name: "Extract tags" }));
    expect(await screen.findByText("Extraction extraction-created recorded with 1 tag.")).toBeInTheDocument();

    const request = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/v1/platform/diagrams/tag-extractions") && init?.method === "POST");
    expect(request?.[1]?.headers).toMatchObject({ "x-odf-tenant-id": "demo", "x-odf-project-id": "north-plant" });
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ documentExternalId: "PID-003", text: "Pump P-101 on PT-1001", page: 3 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("cursor=diagram-next"))).toBe(true);
  });

  it("shows matching precision, recall, F1, and every output as proposed", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Matching" }));

    expect(await screen.findByRole("heading", { name: "Evaluation dashboard" })).toBeInTheDocument();
    expect(screen.getAllByText("100%")).toHaveLength(3);
    expect(screen.getByText((_, element) => element?.textContent === "1 true positive")).toBeInTheDocument();
    expect(screen.getAllByText("proposed")).toHaveLength(2);
    expect(screen.getByText(/2 ranked outputs; none are automatically accepted/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Evaluate matches" }));
    expect(await screen.findByText("Evaluation matching-001 recorded; all 2 outputs remain proposed.")).toBeInTheDocument();
    const request = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/v1/platform/matching/evaluations") && init?.method === "POST");
    expect(request?.[1]?.headers).toMatchObject({ "x-odf-tenant-id": "demo", "x-odf-project-id": "north-plant" });
  });

  it("reviews a proposed spatial link from the accessible isometric scene", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Spatial" }));

    expect(await screen.findByText("96%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Isometric plant spatial-link review scene/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Review comment"), { target: { value: "Aligned against survey control points" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept link" }));
    expect(await screen.findByText("Spatial link spatial-p101 is accepted.")).toBeInTheDocument();
    expect(screen.getByText(/Review is immutable: accepted/)).toBeInTheDocument();

    const request = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/v1/platform/spatial/asset-links/spatial-p101/review") && init?.method === "POST");
    expect(request?.[1]?.headers).toMatchObject({ "x-odf-tenant-id": "demo", "x-odf-project-id": "north-plant" });
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ decision: "accepted", comment: "Aligned against survey control points" });
  });

  it("keeps advanced sections reachable through the mobile section selector", async () => {
    render(<App />);
    openExplorer();
    fireEvent.change(screen.getByRole("combobox", { name: "Workspace section" }), { target: { value: "Spatial" } });

    expect(await screen.findByRole("heading", { name: "Spatial" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Workspace section" })).toHaveValue("Spatial");
  });

  it("keeps high-risk write-back behind two approvals and an explicit execution confirmation", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Write-back" }));

    const highRiskCard = (await screen.findByText("set.control_mode")).closest("li");
    expect(highRiskCard).not.toBeNull();
    expect(within(highRiskCard as HTMLElement).getByText("Approvals 0/2")).toBeInTheDocument();
    expect(screen.getByText("Critical execution blocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Execute industrial write-back/ })).not.toBeInTheDocument();

    fireEvent.click(within(highRiskCard as HTMLElement).getByRole("button", { name: "Approve write-back wb-high-001" }));
    await waitFor(() => expect(within(highRiskCard as HTMLElement).getByText("Approvals 1/2")).toBeInTheDocument());
    fireEvent.click(within(highRiskCard as HTMLElement).getByRole("button", { name: "Approve write-back wb-high-001" }));
    await waitFor(() => expect(within(highRiskCard as HTMLElement).getByText("Approvals 2/2")).toBeInTheDocument());

    const executeButton = within(highRiskCard as HTMLElement).getByRole("button", { name: "Execute industrial write-back wb-high-001" });
    expect(executeButton).toBeDisabled();
    fireEvent.click(within(highRiskCard as HTMLElement).getByRole("checkbox", { name: /I understand this sends a real industrial command/ }));
    expect(executeButton).toBeEnabled();
    fireEvent.click(executeButton);
    expect(await screen.findByText("API confirmed successful execution for wb-high-001.")).toBeInTheDocument();
    expect(screen.getByText("API confirmed execution succeeded")).toBeInTheDocument();

    const mutationRequests = fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/api/v1/platform/writeback/requests/wb-high-001/") && init?.method === "POST");
    expect(mutationRequests).toHaveLength(3);
    for (const request of mutationRequests) expect(request[1]?.headers).toMatchObject({ "x-odf-tenant-id": "demo", "x-odf-project-id": "north-plant" });
  });

  it("records a critical write-back request as blocked without exposing execution", async () => {
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Write-back" }));
    await screen.findByText("set.control_mode");

    fireEvent.change(screen.getByLabelText("Source ID"), { target: { value: "control-system" } });
    fireEvent.change(screen.getByLabelText("Target external ID"), { target: { value: "P-102" } });
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: "reset.trip" } });
    fireEvent.change(screen.getByLabelText("Risk"), { target: { value: "critical" } });
    expect(screen.getByText(/Critical requests are recorded for audit but execution remains blocked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit request — do not execute" }));

    expect(await screen.findByText("Request wb-created recorded in cancelled state.")).toBeInTheDocument();
    const request = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/api/v1/platform/writeback/requests") && init?.method === "POST");
    expect(request?.[1]?.headers).toMatchObject({ "x-odf-tenant-id": "demo", "x-odf-project-id": "north-plant" });
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ sourceId: "control-system", targetExternalId: "P-102", operation: "reset.trip", risk: "critical", dryRunResult: { safe: true } });
    expect(screen.getAllByText("Critical execution blocked").length).toBeGreaterThan(1);
  });

  it("does not claim write-back success when the executor API fails closed", async () => {
    serverWritebacks = [{ ...structuredClone(highRiskWriteback), state: "approved", approvals: [{ actor: "monica.reyes", decision: "approved", occurredAt: "2025-05-14T12:31:00.000Z", comment: null }, { actor: "harper.dennis", decision: "approved", occurredAt: "2025-05-14T12:32:00.000Z", comment: null }], safety: { allowed: true, requiredApprovals: 2, validApprovals: 2, reasons: [] } }];
    platformFailure = { path: "/api/v1/platform/writeback/requests/wb-high-001/execute", status: 503, message: "No industrial write-back executor is configured; the request was not executed" };
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Write-back" }));
    await screen.findByText("Approvals 2/2");
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand this sends a real industrial command/ }));
    fireEvent.click(screen.getByRole("button", { name: "Execute industrial write-back wb-high-001" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("request was not executed");
    expect(screen.queryByText(/API confirmed successful execution/)).not.toBeInTheDocument();
    const requestCard = screen.getByText("set.control_mode").closest("li");
    expect(requestCard?.querySelector(".writeback-state")).toHaveTextContent("approved");
  });

  it("shows a clear forbidden state on an advanced governed surface", async () => {
    platformFailure = { path: "/api/v1/platform/diagrams/tag-extractions", status: 403, message: "Permission 'data:read' is required" };
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Diagrams" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission 'data:read' is required");
  });

  it("shows a clear forbidden state for a project-scoped resource", async () => {
    platformFailure = { path: "/api/v1/platform/sources", status: 403, message: "Permission 'data:read' is required" };
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission 'data:read' is required");
  });

  it("does not hide an expired platform search session behind legacy results", async () => {
    platformFailure = { path: "/api/v1/platform/search", status: 401, message: "Session expired" };
    render(<App />);
    openExplorer();
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    await screen.findByText("North OPC-UA");
    fireEvent.click(screen.getByRole("button", { name: "Explorer" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search project data" }), { target: { value: "P-102" } });

    expect(await screen.findByText(/sign-in expired/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/v1/assets?") && String(url).includes("q=P-102"))).toBe(false);
  });
});
