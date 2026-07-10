import { describe, expect, it } from "vitest";

import type {
  CanvasWorkspaceSnapshot,
  PipelineStepDefinition,
  QualityRule,
  WritebackRequest,
} from "@open-data-fusion/contracts";

import {
  compareContextValues,
  evaluateQualityRule,
  evaluateWritebackSafety,
  evaluateMatchingPredictions,
  extractDiagramTags,
  mergeWorkspaceOperationBatches,
  planPipeline,
  rankProposedMatches,
  scoreContextualizationEvidence,
  createProposedSpatialLink,
  WorkflowDefinitionError,
} from "../src/index.js";

const step = (id: string, dependsOn: string[] = []): PipelineStepDefinition => ({
  id,
  kind: "transform",
  name: id,
  dependsOn,
  configuration: {},
  timeoutSeconds: 30,
  maxAttempts: 2,
});

describe("workflow planning", () => {
  it("groups independent work and produces dependency order", () => {
    expect(planPipeline([step("extract"), step("quality", ["extract"]), step("enrich", ["extract"]), step("publish", ["quality", "enrich"])]))
      .toEqual({ orderedStepIds: ["extract", "quality", "enrich", "publish"], stages: [["extract"], ["quality", "enrich"], ["publish"]] });
  });

  it("rejects dependency cycles", () => {
    expect(() => planPipeline([step("a", ["b"]), step("b", ["a"])]))
      .toThrow(WorkflowDefinitionError);
  });
});

describe("contextualization scoring", () => {
  it("normalizes exact identifiers and keeps candidates review-only", () => {
    const exact = compareContextValues("tag", "P-101", "p 101");
    const fuzzy = compareContextValues("name", "Cooling water pump", "Cooling pump");
    expect(exact.kind).toBe("exact");
    expect(scoreContextualizationEvidence([exact, fuzzy])).toBeGreaterThan(0.7);
  });
});

describe("quality rules", () => {
  const rangeRule: QualityRule = {
    id: "pressure-range",
    tenantId: "tenant",
    projectId: "project",
    externalId: "pressure-range",
    name: "Pressure range",
    kind: "range",
    targetModelExternalId: "pump",
    field: "pressure",
    configuration: { min: 0, max: 250 },
    severity: "error",
    enabled: true,
  };

  it("returns bounded failure evidence", () => {
    const result = evaluateQualityRule(rangeRule, [
      { externalId: "P-101", properties: { pressure: 111 } },
      { externalId: "P-102", properties: { pressure: 300 } },
    ]);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ externalId: "P-102" })]);
  });
});

describe("diagram tag extraction", () => {
  it("extracts and classifies equipment, instruments and line numbers", () => {
    const tags = extractDiagramTags('P-101 feeds HX-201; PT-301 reads line 6"-CW-1001');
    expect(tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: "P-101", kind: "equipment" }),
      expect.objectContaining({ tag: "PT-301", kind: "instrument" }),
      expect.objectContaining({ tag: '6"-CW-1001', kind: "line" }),
    ]));
  });
});

describe("write-back safety", () => {
  const request: WritebackRequest = {
    id: "wb-1",
    tenantId: "tenant",
    projectId: "project",
    sourceId: "source",
    targetExternalId: "P-101",
    operation: "set-maintenance-note",
    payload: { note: "Inspect seal" },
    risk: "high",
    state: "pending_approval",
    requestedBy: "requester",
    requestedAt: "2026-07-11T00:00:00Z",
    approvals: [
      { actor: "reviewer-a", decision: "approved", occurredAt: "2026-07-11T00:01:00Z", comment: null },
      { actor: "reviewer-b", decision: "approved", occurredAt: "2026-07-11T00:02:00Z", comment: null },
    ],
    dryRunResult: { safe: true },
    executedAt: null,
  };

  it("requires allowlisting, dry-run and two-person approval for high risk", () => {
    expect(evaluateWritebackSafety(request, {
      enabled: true,
      allowedOperations: ["set-maintenance-note"],
      maximumRisk: "high",
      requireDryRun: true,
    })).toEqual(expect.objectContaining({ allowed: true, validApprovals: 2 }));
  });

  it("never auto-approves critical write-back", () => {
    expect(evaluateWritebackSafety({ ...request, risk: "critical" }, {
      enabled: true,
      allowedOperations: ["set-maintenance-note"],
      maximumRisk: "critical",
      requireDryRun: true,
    }).allowed).toBe(false);
  });
});

describe("matching evaluation guardrails", () => {
  it("measures precision/recall and keeps every model output proposed", () => {
    const predictions = [
      { sourceExternalId: "TS-1", targetExternalId: "P-101", score: 0.95 },
      { sourceExternalId: "TS-2", targetExternalId: "P-102", score: 0.9 },
    ];
    const evaluation = evaluateMatchingPredictions(predictions, [
      { sourceExternalId: "TS-1", targetExternalId: "P-101", accepted: true },
      { sourceExternalId: "TS-2", targetExternalId: "P-102", accepted: false },
    ], 0.8);
    expect(evaluation).toMatchObject({ truePositives: 1, falsePositives: 1, precision: 0.5, recall: 1 });
    expect(rankProposedMatches(predictions).every((candidate) => candidate.state === "proposed")).toBe(true);
  });
});

describe("spatial links", () => {
  it("validates a finite 4x4 transform and always starts in review", () => {
    const link = createProposedSpatialLink({
      assetExternalId: "P-101",
      sceneExternalId: "north-plant",
      nodeExternalId: "mesh-p-101",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1],
      confidence: 0.92,
    });
    expect(link).toMatchObject({ reviewState: "proposed", confidence: 0.92 });
  });
});

describe("offline operation merge", () => {
  const snapshot: CanvasWorkspaceSnapshot = {
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "a", type: "asset", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "asset", position: { x: 10, y: 10 }, data: {} },
    ],
    edges: [],
  };

  it("merges disjoint semantic operations", () => {
    const result = mergeWorkspaceOperationBatches(
      snapshot,
      { baseVersion: 1, changeSummary: "Move A", operations: [{ type: "moveNode", nodeId: "a", position: { x: 1, y: 1 } }] },
      { baseVersion: 1, changeSummary: "Move B", operations: [{ type: "moveNode", nodeId: "b", position: { x: 11, y: 11 } }] },
    );
    expect(result.merged?.operations).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
  });

  it("reports same-resource conflicts instead of overwriting", () => {
    const result = mergeWorkspaceOperationBatches(
      snapshot,
      { baseVersion: 1, changeSummary: "Move A", operations: [{ type: "moveNode", nodeId: "a", position: { x: 1, y: 1 } }] },
      { baseVersion: 1, changeSummary: "Edit A", operations: [{ type: "updateNode", nodeId: "a", patch: { data: { note: "conflict" } } }] },
    );
    expect(result.merged).toBeNull();
    expect(result.conflicts[0]?.resource).toBe("node:a");
  });
});
