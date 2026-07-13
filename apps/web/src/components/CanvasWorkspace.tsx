import {
  AlertTriangle,
  Box,
  Cable,
  ChevronDown,
  Clock3,
  FileText,
  Gauge,
  Hand,
  Layers3,
  Link2,
  LogOut,
  Maximize2,
  MoreHorizontal,
  MousePointer2,
  PanelLeftOpen,
  PanelRightOpen,
  Plus,
  Redo2,
  RotateCcw,
  Save,
  StickyNote,
  Trash2,
  UserPlus,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuthSession } from "./AuthBoundary";
import { BrandLogo } from "./BrandLogo";
import type { PlatformBootstrapState } from "./PlatformWorkspaces";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { navigationGroups, type NavigationLabel } from "./Sidebar";
import {
  WORKSPACE_USER,
  applyWorkspaceOperations,
  getWorkspace,
  isConflictError,
  listWorkspaceMembers,
  listWorkspaceRevisions,
  removeWorkspaceMember,
  rollbackWorkspace,
  saveWorkspace,
  subscribeToWorkspaceEvents,
  upsertWorkspaceMember,
} from "../lib/api";
import type {
  ApiWorkspace,
  CanvasEdgeRecord,
  CanvasNodeRecord,
  ExplorerSnapshot,
  PlatformContext,
  PlatformProject,
  PlatformTenant,
  WorkspaceMember,
  WorkspaceMemberUpsert,
  WorkspaceOperation,
  WorkspaceRole,
  WorkspaceRevision,
} from "../types";

type CanvasTool = "select" | "pan" | "connect";
type NodeKind = "asset" | "series" | "system" | "document" | "note";
type CanvasSelection = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

interface CanvasWorkspaceProps {
  snapshot: ExplorerSnapshot | null;
  workspace: ApiWorkspace | null;
  platformContext: PlatformContext | null;
  tenants: PlatformTenant[];
  projects: PlatformProject[];
  selectedTenantId: string;
  platformState: PlatformBootstrapState;
  onTenantChange: (tenantId: string) => void;
  onProjectChange: (projectId: string) => void;
  onRetryProjectDiscovery: () => void;
  onWorkspaceUpdated: (workspace: ApiWorkspace) => void;
  onOpenExplorer: () => void;
  onNavigate: (label: NavigationLabel) => void;
  onNotify: (message: string) => void;
}

interface NodeDragState {
  baseVersion: number;
  interactionId: number;
  nodeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: CanvasNodeGeometry;
  moved: boolean;
}

interface NodeResizeState {
  baseVersion: number;
  interactionId: number;
  nodeId: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: CanvasNodeGeometry;
  moved: boolean;
}

export interface CanvasNodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EditableNodePatch {
  data?: Record<string, unknown>;
  position?: { x: number; y: number };
}

interface CanvasGeometryPreview {
  baseVersion: number;
  geometry: CanvasNodeGeometry;
  interactionId: number;
  nodeId: string;
}

interface AuthoringHistoryEntry {
  description: string;
  forward: WorkspaceOperation[];
  inverse: WorkspaceOperation[];
  selectionBefore: CanvasSelection;
  selectionAfter: CanvasSelection;
}

const MIN_NODE_WIDTH = 150;
const MAX_NODE_WIDTH = 600;
const MIN_NODE_HEIGHT = 100;
const MAX_NODE_HEIGHT = 420;
const MAX_AUTHORING_HISTORY = 50;
const REVISION_PAGE_SIZE = 50;
const WORKSPACE_ROLES: WorkspaceRole[] = ["owner", "editor", "reviewer", "viewer"];
const CANVAS_CHART_GEOMETRY: CanvasNodeGeometry = { x: 770, y: 105, width: 345, height: 370 };

const fallbackNodes: CanvasNodeRecord[] = [];
const fallbackEdges: CanvasEdgeRecord[] = [];

function dataString(node: CanvasNodeRecord, key: string): string | undefined {
  const value = node.data[key];
  return typeof value === "string" ? value : undefined;
}

function dataNumber(node: CanvasNodeRecord, key: string): number | undefined {
  const value = node.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampDimension(value: number, minimum: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(normalized)));
}

function nodeKind(node: CanvasNodeRecord): NodeKind | null {
  if (node.type === "diagram") return null;
  if (node.type === "timeSeries" || node.type === "time-series") return "series";
  if (node.type === "document") return "document";
  if (node.type === "note") return "note";
  if (
    node.type === "system" ||
    dataString(node, "kind") === "system" ||
    dataString(node, "externalId") === "AREA-A" ||
    dataString(node, "label")?.toLowerCase().includes("system")
  ) return "system";
  return "asset";
}

function nodeLabel(node: CanvasNodeRecord): string {
  return dataString(node, "label") ?? dataString(node, "title") ?? dataString(node, "text") ?? node.id;
}

function nodeSubtitle(node: CanvasNodeRecord, kind: NodeKind): string {
  return dataString(node, "status") ?? (kind === "series" ? "Live" : kind === "note" ? "Shared note" : kind === "system" ? "Active" : kind === "document" ? "Document" : "Reviewed");
}

function nodeTypeLabel(kind: NodeKind): string {
  if (kind === "series") return "Time series";
  if (kind === "system") return "System";
  if (kind === "document") return "Document";
  if (kind === "note") return "Note";
  return "Asset";
}

function nodeDimensions(node: CanvasNodeRecord) {
  if (node.type === "diagram") return { width: 440, height: 410 };
  const kind = nodeKind(node);
  const defaultWidth = kind === "series" ? 250 : kind === "system" || kind === "document" || kind === "note" ? 210 : 185;
  return {
    width: clampDimension(dataNumber(node, "width") ?? defaultWidth, MIN_NODE_WIDTH, MAX_NODE_WIDTH),
    height: clampDimension(dataNumber(node, "height") ?? 100, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT),
  };
}

export function canvasNodeGeometry(node: CanvasNodeRecord): CanvasNodeGeometry {
  const dimensions = nodeDimensions(node);
  return {
    x: node.position.x,
    y: node.position.y,
    width: dimensions.width,
    height: dimensions.height,
  };
}

function edgeLabel(edge: CanvasEdgeRecord, nodeMap: Map<string, CanvasNodeRecord>): string {
  const source = nodeMap.get(edge.source);
  const target = nodeMap.get(edge.target);
  return `${source ? nodeLabel(source) : edge.source} to ${target ? nodeLabel(target) : edge.target}`;
}

function previousNodeDataValue(node: CanvasNodeRecord, key: string): unknown {
  if (key in node.data) return node.data[key];
  if (key === "label") return nodeLabel(node);
  if (key === "width") return nodeDimensions(node).width;
  if (key === "height") return nodeDimensions(node).height;
  if (key === "status") {
    const kind = nodeKind(node);
    return kind ? nodeSubtitle(node, kind) : "";
  }
  return "";
}

export function edgePath(source: CanvasNodeGeometry, target: CanvasNodeGeometry): string {
  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  };
  const targetCenter = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };

  if (Math.abs(targetCenter.y - sourceCenter.y) >= Math.abs(targetCenter.x - sourceCenter.x)) {
    const sourceY = targetCenter.y >= sourceCenter.y ? source.y + source.height : source.y;
    const targetY = targetCenter.y >= sourceCenter.y ? target.y : target.y + target.height;
    const middleY = (sourceY + targetY) / 2;
    return `M${sourceCenter.x} ${sourceY} C${sourceCenter.x} ${middleY} ${targetCenter.x} ${middleY} ${targetCenter.x} ${targetY}`;
  }

  const sourceX = targetCenter.x >= sourceCenter.x ? source.x + source.width : source.x;
  const targetX = targetCenter.x >= sourceCenter.x ? target.x : target.x + target.width;
  const middleX = (sourceX + targetX) / 2;
  return `M${sourceX} ${sourceCenter.y} C${middleX} ${sourceCenter.y} ${middleX} ${targetCenter.y} ${targetX} ${targetCenter.y}`;
}

function createCanvasId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function requestCanvasFrame(callback: FrameRequestCallback): number {
  if (typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(callback);
  return window.setTimeout(() => callback(performance.now()), 16);
}

function cancelCanvasFrame(frame: number): void {
  if (typeof window.cancelAnimationFrame === "function") window.cancelAnimationFrame(frame);
  else window.clearTimeout(frame);
}

function movedNodeGeometry(origin: CanvasNodeGeometry, deltaX: number, deltaY: number, scale: number): CanvasNodeGeometry {
  return {
    ...origin,
    x: Math.round(origin.x + deltaX / scale),
    y: Math.round(origin.y + deltaY / scale),
  };
}

function resizedNodeGeometry(origin: CanvasNodeGeometry, deltaX: number, deltaY: number, scale: number): CanvasNodeGeometry {
  return {
    ...origin,
    width: clampDimension(origin.width + deltaX / scale, MIN_NODE_WIDTH, MAX_NODE_WIDTH),
    height: clampDimension(origin.height + deltaY / scale, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT),
  };
}

function TelemetryChart({ snapshot }: { snapshot: ExplorerSnapshot | null }) {
  const points = snapshot?.telemetry.series[0]?.points ?? [];
  const line = useMemo(() => {
    const values = points.slice(-80).map((point) => point.value);
    if (!values.length) return "0,92 300,92";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = Math.max(max - min, 1);
    return values
      .map((value, index) => `${(index / Math.max(values.length - 1, 1)) * 300},${92 - ((value - min) / spread) * 70}`)
      .join(" ");
  }, [points]);

  return (
    <svg className="canvas-chart" viewBox="0 0 330 170" role="img" aria-label="Pressure time series chart">
      <g className="canvas-chart-grid">
        {[20, 55, 90, 125].map((y) => <line key={y} x1="30" x2="315" y1={y} y2={y} />)}
      </g>
      <text x="4" y="24">120</text><text x="8" y="93">95</text><text x="8" y="128">80</text>
      <polyline points={line} transform="translate(30 0)" />
      <text x="30" y="150">May 16 00:00</text><text x="215" y="150">May 17 00:00</text>
    </svg>
  );
}

function PidPanel({ geometry }: { geometry: CanvasNodeGeometry }) {
  return (
    <div
      className="canvas-panel canvas-pid-panel"
      style={{
        left: 0,
        top: 0,
        width: geometry.width,
        height: geometry.height,
        transform: `translate3d(${geometry.x}px, ${geometry.y}px, 0)`,
      }}
      aria-label="Cooling Water System P and ID drawing"
    >
      <div className="canvas-panel-header"><span>P&amp;ID — Cooling Water System</span><MoreDots /></div>
      <svg viewBox="0 0 480 330" role="img" aria-label="Cooling water system process drawing">
        <g className="pid-lines">
          <path d="M38 82 H442 M100 82 V255 H210 M210 255 V145 H330 V82 M330 145 V255 H442 M330 255 H442" />
          <path d="M100 82 V42 H210 V82 M330 82 V42 H442 V82" strokeDasharray="5 5" />
        </g>
        <g className="pid-symbols">
          <circle cx="210" cy="145" r="28" /><path d="M198 145 h24 M210 133 v24" />
          <rect x="86" y="235" width="28" height="40" rx="5" /><path d="M100 235v-27 M86 208h28" />
          <rect x="316" y="235" width="28" height="40" rx="5" /><path d="M330 235v-27 M316 208h28" />
          <path d="M137 245 l15 10 -15 10z M382 245 l15 10 -15 10z" />
          <circle cx="160" cy="82" r="18" /><text x="151" y="86">PI</text>
          <circle cx="365" cy="82" r="18" /><text x="356" y="86">PIC</text>
        </g>
        <g className="pid-labels"><text x="180" y="191">PUMP</text><text x="168" y="207">PROCESS EQUIPMENT</text><text x="44" y="30">FROM PROCESS</text><text x="340" y="30">TO PROCESS</text></g>
      </svg>

    </div>
  );
}

function MoreDots() { return <span className="more-dots" aria-hidden="true">•••</span>; }

function CanvasNavigationMenu({ onNavigate }: { onNavigate: (label: NavigationLabel) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function menuItems() {
    return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  }

  function focusFirstItem() {
    window.setTimeout(() => menuItems()[0]?.focus(), 0);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = menuItems();
    if (items.length === 0) return;
    const activeIndex = Math.max(0, items.findIndex((item) => item === document.activeElement));
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (activeIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (activeIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  return (
    <div className="canvas-navigation-menu" ref={menuRef}>
      <button className="canvas-navigation-trigger" ref={triggerRef} type="button" aria-label="Open workspace navigation" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => { const next = !value; if (next) focusFirstItem(); return next; })}>
        <PanelLeftOpen size={17} />
        <span className="canvas-navigation-label">Navigate</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="canvas-navigation-popover" role="menu" aria-label="Workspace navigation" onKeyDown={onMenuKeyDown}>
          {navigationGroups.map((group) => (
            <div className="canvas-navigation-group" key={group.label} role="group" aria-label={group.label}>
              <span className="canvas-navigation-group-label">{group.label}</span>
              {group.items.map(({ label, icon: Icon }) => (
                <button key={label} type="button" role="menuitem" onClick={() => { closeMenu(); onNavigate(label); }}>
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MobileCanvasMenu({ hasSelection, onOpenHistory, onOpenInspector, onToggleMembers }: { hasSelection: boolean; onOpenHistory: () => void; onOpenInspector: () => void; onToggleMembers: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnPointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="canvas-mobile-menu" ref={menuRef}>
      <button type="button" aria-label="Mobile canvas actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={18} /></button>
      {open ? (
        <div className="canvas-mobile-menu-popover" role="menu">
          {hasSelection ? <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenInspector(); }}><PanelRightOpen size={16} /> Selection inspector</button> : null}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onOpenHistory(); }}><Clock3 size={16} /> Revision history</button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onToggleMembers(); }}><Users size={16} /> Workspace members</button>
        </div>
      ) : null}
    </div>
  );
}

export function CanvasWorkspace({ snapshot, workspace, platformContext, tenants, projects, selectedTenantId, platformState, onTenantChange, onProjectChange, onRetryProjectDiscovery, onWorkspaceUpdated, onOpenExplorer, onNavigate, onNotify }: CanvasWorkspaceProps) {
  const authSession = useAuthSession();
  const activeUserId = authSession.identity?.userId ?? WORKSPACE_USER;
  const workspaceTenantId = platformContext?.tenantId ?? "";
  const workspaceProjectId = platformContext?.projectId ?? "";
  const [tool, setTool] = useState<CanvasTool>("select");
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [showIntro, setShowIntro] = useState(true);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [revisions, setRevisions] = useState<WorkspaceRevision[]>([]);
  const [revisionTotal, setRevisionTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersRefreshing, setMembersRefreshing] = useState(false);
  const [memberMutation, setMemberMutation] = useState<string | null>(null);
  const [memberError, setMemberError] = useState("");
  const [onlineUsers, setOnlineUsers] = useState<Array<Pick<WorkspaceMember, "userId" | "displayName" | "role">>>([]);
  const [collaborationConnected, setCollaborationConnected] = useState<boolean | null>(null);
  const [conflictMessage, setConflictMessage] = useState("");
  const [undoStack, setUndoStack] = useState<AuthoringHistoryEntry[]>([]);
  const [redoStack, setRedoStack] = useState<AuthoringHistoryEntry[]>([]);
  const [geometryPreview, setGeometryPreview] = useState<CanvasGeometryPreview | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const nodeResizeRef = useRef<NodeResizeState | null>(null);
  const geometryPreviewRef = useRef<CanvasGeometryPreview | null>(null);
  const geometryFrameRef = useRef<number | null>(null);
  const nextInteractionIdRef = useRef(0);
  const suppressClickRef = useRef<string | null>(null);
  const workspaceRef = useRef(workspace);
  const latestVersionRef = useRef(workspace?.version ?? 0);

  const nodes = workspace?.snapshot?.nodes ?? fallbackNodes;
  const edges = workspace?.snapshot?.edges ?? fallbackEdges;
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const geometryMap = useMemo(() => {
    const next = new Map(nodes.map((node) => [node.id, canvasNodeGeometry(node)]));
    if (geometryPreview && geometryPreview.baseVersion === workspace?.version && next.has(geometryPreview.nodeId)) {
      next.set(geometryPreview.nodeId, geometryPreview.geometry);
    }
    return next;
  }, [geometryPreview, nodes, workspace?.version]);
  const edgeMap = useMemo(() => new Map(edges.map((edge) => [edge.id, edge])), [edges]);
  const selectedNode = selection?.kind === "node" ? nodeMap.get(selection.id) ?? null : null;
  const selectedEdge = selection?.kind === "edge" ? edgeMap.get(selection.id) ?? null : null;
  const selectedKind = selectedNode ? nodeKind(selectedNode) : null;
  const presenceUsers = useMemo(() => onlineUsers.map((user) => {
    const member = members.find((item) => item.userId === user.userId);
    return member ?? user;
  }), [members, onlineUsers]);
  const onlineUserIds = useMemo(() => new Set(onlineUsers.map((user) => user.userId)), [onlineUsers]);
  const currentMember = useMemo(
    () => members.find((member) => member.userId === activeUserId) ?? null,
    [activeUserId, members],
  );
  const canEdit = membersLoaded && (currentMember?.role === "owner" || currentMember?.role === "editor");
  const canManageMembers = membersLoaded && currentMember?.role === "owner";
  const canEditRef = useRef(canEdit);

  workspaceRef.current = workspace;
  latestVersionRef.current = Math.max(latestVersionRef.current, workspace?.version ?? 0);
  canEditRef.current = canEdit;

  const scheduleGeometryPreview = useCallback((preview: CanvasGeometryPreview) => {
    geometryPreviewRef.current = preview;
    if (geometryFrameRef.current !== null) return;
    geometryFrameRef.current = requestCanvasFrame(() => {
      geometryFrameRef.current = null;
      setGeometryPreview(geometryPreviewRef.current);
    });
  }, []);

  const flushGeometryPreview = useCallback((preview: CanvasGeometryPreview) => {
    if (geometryFrameRef.current !== null) {
      cancelCanvasFrame(geometryFrameRef.current);
      geometryFrameRef.current = null;
    }
    geometryPreviewRef.current = preview;
    setGeometryPreview(preview);
  }, []);

  const clearGeometryPreview = useCallback((interactionId?: number) => {
    const pending = geometryPreviewRef.current;
    if (interactionId !== undefined && pending?.interactionId !== interactionId) return;
    if (geometryFrameRef.current !== null) {
      cancelCanvasFrame(geometryFrameRef.current);
      geometryFrameRef.current = null;
    }
    geometryPreviewRef.current = null;
    setGeometryPreview((current) => (
      interactionId === undefined || current?.interactionId === interactionId ? null : current
    ));
  }, []);

  const refreshMembers = useCallback(async (workspaceId: string): Promise<boolean> => {
    if (!workspaceTenantId || !workspaceProjectId) return false;
    setMembersRefreshing(true);
    try {
      const result = await listWorkspaceMembers(
        workspaceId,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        activeUserId,
      );
      setMembers(result.items);
      setMembersLoaded(true);
      setMemberError("");
      return true;
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : "Workspace members could not be loaded");
      return false;
    } finally {
      setMembersRefreshing(false);
    }
  }, [activeUserId, workspaceProjectId, workspaceTenantId]);

  const refreshLatestWorkspace = useCallback(async (workspaceId: string) => {
    if (!workspaceTenantId || !workspaceProjectId) return;
    try {
      const latest = await getWorkspace(
        workspaceId,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        undefined,
        activeUserId,
      );
      latestVersionRef.current = Math.max(latestVersionRef.current, latest.version);
      onWorkspaceUpdated(latest);
    } catch {
      onNotify("Could not refresh the latest workspace revision");
    }
  }, [activeUserId, onNotify, onWorkspaceUpdated, workspaceProjectId, workspaceTenantId]);

  const handleOperationError = useCallback(async (error: unknown, workspaceId: string) => {
    if (isConflictError(error)) {
      setConflictMessage("Conflict detected: another collaborator saved first. The latest revision was loaded; repeat your change to apply it.");
      setUndoStack([]);
      setRedoStack([]);
      await refreshLatestWorkspace(workspaceId);
      return;
    }
    onNotify(error instanceof Error ? error.message : "Canvas change could not be saved");
  }, [onNotify, refreshLatestWorkspace]);

  const commitOperations = useCallback(async (
    changeSummary: string,
    operations: WorkspaceOperation[],
    baseVersion?: number,
  ): Promise<ApiWorkspace | null> => {
    const current = workspaceRef.current;
    if (!current) {
      onNotify("Workspace service is still connecting");
      return null;
    }
    if (!canEditRef.current) {
      onNotify("This workspace is read-only for your role");
      return null;
    }
    if (!workspaceTenantId || !workspaceProjectId) {
      onNotify("Select a tenant and project before editing this Canvas");
      return null;
    }
    try {
      const updated = await applyWorkspaceOperations(
        current.id,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        {
          baseVersion: baseVersion ?? current.version,
          changeSummary,
          operations,
        },
        activeUserId,
      );
      latestVersionRef.current = Math.max(latestVersionRef.current, updated.version);
      onWorkspaceUpdated(updated);
      setConflictMessage("");
      return updated;
    } catch (error) {
      await handleOperationError(error, current.id);
      return null;
    }
  }, [activeUserId, handleOperationError, onNotify, onWorkspaceUpdated, workspaceProjectId, workspaceTenantId]);

  const commitAuthoringAction = useCallback(async (
    entry: AuthoringHistoryEntry,
    baseVersion?: number,
  ): Promise<ApiWorkspace | null> => {
    const updated = await commitOperations(entry.description, entry.forward, baseVersion);
    if (!updated) return null;
    setUndoStack((current) => [...current, entry].slice(-MAX_AUTHORING_HISTORY));
    setRedoStack([]);
    setSelection(entry.selectionAfter);
    return updated;
  }, [commitOperations]);

  useEffect(() => () => {
    if (geometryFrameRef.current !== null) cancelCanvasFrame(geometryFrameRef.current);
  }, []);

  useEffect(() => {
    if (!historyOpen && !inspectorOpen && !layersOpen && !membersOpen) return undefined;
    const closeTopPanel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (historyOpen) setHistoryOpen(false);
      else if (membersOpen) setMembersOpen(false);
      else if (layersOpen) setLayersOpen(false);
      else setInspectorOpen(false);
    };
    window.addEventListener("keydown", closeTopPanel);
    return () => window.removeEventListener("keydown", closeTopPanel);
  }, [historyOpen, inspectorOpen, layersOpen, membersOpen]);

  useEffect(() => {
    latestVersionRef.current = workspace?.version ?? 0;
  }, [workspace?.id, workspace?.version, workspaceProjectId, workspaceTenantId]);

  useEffect(() => {
    const preview = geometryPreviewRef.current;
    if (!preview || !workspace || preview.baseVersion === workspace.version) return;
    if (nodeDragRef.current?.interactionId === preview.interactionId) nodeDragRef.current = null;
    if (nodeResizeRef.current?.interactionId === preview.interactionId) nodeResizeRef.current = null;
    clearGeometryPreview(preview.interactionId);
  }, [clearGeometryPreview, workspace?.id, workspace?.version]);

  useEffect(() => {
    if (!workspace) return;
    setScale(workspace.snapshot.viewport.zoom);
    setOffset({ x: workspace.snapshot.viewport.x, y: workspace.snapshot.viewport.y });
  }, [workspace?.id, workspace?.version]);

  useEffect(() => {
    const workspaceId = workspace?.id;
    if (!workspaceId || !workspaceTenantId || !workspaceProjectId) {
      setMembers([]);
      setOnlineUsers([]);
      setMembersLoaded(false);
      setCollaborationConnected(null);
      return undefined;
    }
    let disposed = false;
    let refreshInFlight = false;
    const workspaceContext = { tenantId: workspaceTenantId, projectId: workspaceProjectId };

    setMembersLoaded(false);
    setMembersRefreshing(true);
    setMemberError("");
    listWorkspaceMembers(workspaceId, workspaceContext, activeUserId)
      .then((result) => {
        if (!disposed) setMembers(result.items);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setMembers([]);
          setMemberError(error instanceof Error ? error.message : "Workspace members could not be loaded");
        }
      })
      .finally(() => {
        if (!disposed) {
          setMembersLoaded(true);
          setMembersRefreshing(false);
        }
      });

    const stop = subscribeToWorkspaceEvents(workspaceId, workspaceContext, {
      onWorkspaceUpdated: (event) => {
        if (event.version <= latestVersionRef.current || refreshInFlight) return;
        if (event.actor !== activeUserId) {
          setUndoStack([]);
          setRedoStack([]);
        }
        refreshInFlight = true;
        getWorkspace(workspaceId, workspaceContext, undefined, activeUserId)
          .then((latest) => {
            if (disposed) return;
            latestVersionRef.current = Math.max(latestVersionRef.current, latest.version);
            onWorkspaceUpdated(latest);
          })
          .catch(() => undefined)
          .finally(() => { refreshInFlight = false; });
      },
      onPresenceUpdated: (event) => {
        if (!disposed) setOnlineUsers(event.users);
      },
      onMembersUpdated: (event) => {
        if (disposed) return;
        if (event.change === "removed" && event.member.userId === activeUserId) {
          setMembers((items) => items.filter((member) => member.userId !== activeUserId));
          setMembersLoaded(true);
          setMemberError("Your workspace membership was removed. Server access is now required to continue.");
          setUndoStack([]);
          setRedoStack([]);
          return;
        }
        void refreshMembers(workspaceId);
      },
      onConnectionChange: (connected) => {
        if (!disposed) setCollaborationConnected(connected);
      },
    }, activeUserId);

    return () => {
      disposed = true;
      stop();
    };
  }, [activeUserId, onWorkspaceUpdated, refreshMembers, workspace?.id, workspaceProjectId, workspaceTenantId]);

  function updateZoom(delta: number) {
    setScale((value) => Math.min(1.35, Math.max(0.7, Number((value + delta).toFixed(2)))));
  }

  function openInspector() {
    if (!selection) return;
    setHistoryOpen(false);
    setMembersOpen(false);
    setLayersOpen(false);
    setInspectorOpen(true);
  }

  function openLayers() {
    setHistoryOpen(false);
    setMembersOpen(false);
    setInspectorOpen(false);
    setLayersOpen(true);
  }

  function onStageKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    const movement = event.shiftKey ? 80 : 32;
    if (event.key === "ArrowLeft") setOffset((current) => ({ ...current, x: current.x + movement }));
    else if (event.key === "ArrowRight") setOffset((current) => ({ ...current, x: current.x - movement }));
    else if (event.key === "ArrowUp") setOffset((current) => ({ ...current, y: current.y + movement }));
    else if (event.key === "ArrowDown") setOffset((current) => ({ ...current, y: current.y - movement }));
    else return;
    event.preventDefault();
  }

  function fitCanvas() {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const stageWidth = stage.clientWidth || rect.width || window.innerWidth;
    const stageHeight = stage.clientHeight || rect.height || window.innerHeight;
    if (stageWidth <= 0 || stageHeight <= 0) return;

    const content = [...geometryMap.values(), CANVAS_CHART_GEOMETRY];
    const minX = Math.min(...content.map((geometry) => geometry.x));
    const minY = Math.min(...content.map((geometry) => geometry.y));
    const maxX = Math.max(...content.map((geometry) => geometry.x + geometry.width));
    const maxY = Math.max(...content.map((geometry) => geometry.y + geometry.height));
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const padding = Math.min(64, Math.max(24, stageWidth * 0.08));
    const fittedScale = Math.min(
      1,
      Math.max(0.3, Math.min(
        (stageWidth - padding * 2) / contentWidth,
        (stageHeight - padding * 2) / contentHeight,
      )),
    );
    const nextScale = Number(fittedScale.toFixed(2));

    setScale(nextScale);
    setOffset({
      x: Math.round((stageWidth - contentWidth * nextScale) / 2 - minX * nextScale),
      y: Math.round((stageHeight - contentHeight * nextScale) / 2 - minY * nextScale),
    });
  }

  async function saveRevision() {
    const current = workspaceRef.current;
    if (!current) {
      onNotify("Workspace service is still connecting");
      return;
    }
    if (!canEditRef.current) {
      onNotify("This workspace is read-only for your role");
      return;
    }
    if (!workspaceTenantId || !workspaceProjectId) {
      onNotify("Select a tenant and project before saving this Canvas");
      return;
    }
    try {
      const updated = await saveWorkspace(
        current.id,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        {
          expectedVersion: current.version,
          actor: activeUserId,
          changeSummary: "Saved canvas viewport",
          snapshot: { ...current.snapshot, viewport: { x: offset.x, y: offset.y, zoom: scale } },
        },
      );
      latestVersionRef.current = Math.max(latestVersionRef.current, updated.version);
      onWorkspaceUpdated(updated);
      setConflictMessage("");
      onNotify(`Revision v${updated.version} saved`);
    } catch (error) {
      await handleOperationError(error, current.id);
    }
  }

  async function openHistory() {
    const current = workspaceRef.current;
    if (!current) {
      onNotify("Workspace service is still connecting");
      return;
    }
    if (!workspaceTenantId || !workspaceProjectId) {
      onNotify("Select a tenant and project before viewing Canvas history");
      return;
    }
    setMembersOpen(false);
    setInspectorOpen(false);
    setLayersOpen(false);
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const history = await listWorkspaceRevisions(
        current.id,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        { limit: REVISION_PAGE_SIZE, offset: 0 },
        activeUserId,
      );
      setRevisions(history.items);
      setRevisionTotal(history.total);
    } catch {
      setRevisions([]);
      setRevisionTotal(0);
      setHistoryError("Revision history could not be loaded.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadMoreHistory() {
    const current = workspaceRef.current;
    if (!current || !workspaceTenantId || !workspaceProjectId || historyLoadingMore || revisions.length >= revisionTotal) return;
    setHistoryLoadingMore(true);
    setHistoryError("");
    try {
      const history = await listWorkspaceRevisions(
        current.id,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        { limit: REVISION_PAGE_SIZE, offset: revisions.length },
        activeUserId,
      );
      setRevisions((items) => {
        const knownVersions = new Set(items.map((revision) => revision.version));
        return [...items, ...history.items.filter((revision) => !knownVersions.has(revision.version))];
      });
      setRevisionTotal(history.total);
    } catch {
      setHistoryError("More revision history could not be loaded.");
    } finally {
      setHistoryLoadingMore(false);
    }
  }

  async function restoreRevision(targetVersion: number) {
    const current = workspaceRef.current;
    if (!current) return;
    if (!workspaceTenantId || !workspaceProjectId) {
      setHistoryError("Select a tenant and project before restoring a Canvas revision.");
      return;
    }
    if (!canEditRef.current) {
      setHistoryError("Your workspace role can inspect history but cannot restore revisions.");
      return;
    }
    try {
      const updated = await rollbackWorkspace(
        current.id,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        {
          expectedVersion: current.version,
          targetVersion,
          actor: activeUserId,
        },
      );
      latestVersionRef.current = Math.max(latestVersionRef.current, updated.version);
      onWorkspaceUpdated(updated);
      setHistoryOpen(false);
      setConflictMessage("");
      setUndoStack([]);
      setRedoStack([]);
      setSelection(null);
      setInspectorOpen(false);
      onNotify(`Restored revision v${targetVersion} as new revision v${updated.version}`);
    } catch (error) {
      if (isConflictError(error)) {
        setHistoryError("This workspace changed before rollback. The latest revision has been loaded.");
        setConflictMessage("Conflict detected: another collaborator saved first. Review the latest revision before restoring again.");
        await refreshLatestWorkspace(current.id);
      } else {
        setHistoryError("Revision could not be restored.");
      }
    }
  }

  function onCanvasPointerDown(event: React.PointerEvent<HTMLElement>) {
    if (tool !== "pan") return;
    panRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onCanvasPointerMove(event: React.PointerEvent<HTMLElement>) {
    if (!panRef.current) return;
    setOffset({
      x: panRef.current.ox + event.clientX - panRef.current.x,
      y: panRef.current.oy + event.clientY - panRef.current.y,
    });
  }

  function onCanvasPointerUp() {
    panRef.current = null;
  }

  function onNodePointerDown(event: React.PointerEvent<HTMLButtonElement>, node: CanvasNodeRecord) {
    event.stopPropagation();
    if (tool !== "select" || event.button !== 0) return;
    setSelection({ kind: "node", id: node.id });
    if (!canEditRef.current) return;
    const current = workspaceRef.current;
    if (!current) return;
    if (nodeDragRef.current || nodeResizeRef.current || geometryPreviewRef.current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const interactionId = nextInteractionIdRef.current + 1;
    nextInteractionIdRef.current = interactionId;
    nodeDragRef.current = {
      baseVersion: current.version,
      interactionId,
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: geometryMap.get(node.id) ?? canvasNodeGeometry(node),
      moved: false,
    };
  }

  function onNodePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    drag.moved = drag.moved || Math.abs(deltaX / scale) > 2 || Math.abs(deltaY / scale) > 2;
    if (!drag.moved) return;
    scheduleGeometryPreview({
      baseVersion: drag.baseVersion,
      geometry: movedNodeGeometry(drag.origin, deltaX, deltaY, scale),
      interactionId: drag.interactionId,
      nodeId: drag.nodeId,
    });
  }

  function onNodePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    nodeDragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!drag.moved) {
      clearGeometryPreview(drag.interactionId);
      return;
    }

    const finalGeometry = movedNodeGeometry(
      drag.origin,
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      scale,
    );
    flushGeometryPreview({
      baseVersion: drag.baseVersion,
      geometry: finalGeometry,
      interactionId: drag.interactionId,
      nodeId: drag.nodeId,
    });
    const position = {
      x: finalGeometry.x,
      y: finalGeometry.y,
    };
    suppressClickRef.current = drag.nodeId;
    window.setTimeout(() => { suppressClickRef.current = null; }, 0);
    const description = `Moved ${nodeLabel(nodeMap.get(drag.nodeId) ?? { id: drag.nodeId, type: "asset", position, data: {} })}`;
    const nodeSelection: CanvasSelection = { kind: "node", id: drag.nodeId };
    void commitAuthoringAction({
      description,
      forward: [{ type: "moveNode", nodeId: drag.nodeId, position }],
      inverse: [{ type: "moveNode", nodeId: drag.nodeId, position: { x: drag.origin.x, y: drag.origin.y } }],
      selectionBefore: nodeSelection,
      selectionAfter: nodeSelection,
    }, drag.baseVersion).then((updated) => {
      if (updated) onNotify(`Node moved · revision v${updated.version}`);
    }).finally(() => {
      clearGeometryPreview(drag.interactionId);
    });
  }

  function cancelNodeDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    nodeDragRef.current = null;
    clearGeometryPreview(drag.interactionId);
    if (drag.moved) {
      suppressClickRef.current = drag.nodeId;
      window.setTimeout(() => { suppressClickRef.current = null; }, 0);
    }
  }

  function selectTool(nextTool: CanvasTool) {
    if (nextTool === "connect" && !canEditRef.current) {
      onNotify("This workspace is read-only for your role");
      return;
    }
    setTool(nextTool);
    if (nextTool !== "connect") setConnectSource(null);
  }

  function selectFirstNode(kind: NodeKind) {
    const match = nodes.find((node) => nodeKind(node) === kind);
    if (match) {
      setSelection({ kind: "node", id: match.id });
      setInspectorOpen(true);
      setLayersOpen(false);
      selectTool("select");
    }
  }

  async function activateNode(node: CanvasNodeRecord) {
    if (suppressClickRef.current === node.id) {
      suppressClickRef.current = null;
      return;
    }
    setSelection({ kind: "node", id: node.id });
    if (tool !== "connect") {
      setInspectorOpen(true);
      setLayersOpen(false);
      return;
    }
    if (!connectSource) {
      setConnectSource(node.id);
      onNotify(`Choose a target for ${nodeLabel(node)}`);
      return;
    }
    if (connectSource === node.id) {
      setConnectSource(null);
      onNotify("Connection selection cleared");
      return;
    }
    if (edges.some((edge) => edge.source === connectSource && edge.target === node.id)) {
      setConnectSource(null);
      onNotify("Those nodes are already connected");
      return;
    }

    const sourceNode = nodeMap.get(connectSource);
    const edge: CanvasEdgeRecord = {
      id: createCanvasId("edge"),
      source: connectSource,
      target: node.id,
      type: "relatedTo",
      data: {},
    };
    setConnectSource(null);
    const description = `Connected ${sourceNode ? nodeLabel(sourceNode) : connectSource} to ${nodeLabel(node)}`;
    const updated = await commitAuthoringAction({
      description,
      forward: [{ type: "addEdge", edge }],
      inverse: [{ type: "removeEdge", edgeId: edge.id }],
      selectionBefore: { kind: "node", id: connectSource },
      selectionAfter: { kind: "edge", id: edge.id },
    });
    if (updated) onNotify(`Nodes connected · revision v${updated.version}`);
  }

  async function addNote() {
    const current = workspaceRef.current;
    if (!current) {
      onNotify("Workspace service is still connecting");
      return;
    }
    const stage = stageRef.current;
    const position = {
      x: Math.max(20, Math.round(((stage?.clientWidth ?? 900) / 2 - offset.x) / scale - 105)),
      y: Math.max(20, Math.round(((stage?.clientHeight ?? 700) / 2 - offset.y) / scale - 50)),
    };
    const note: CanvasNodeRecord = {
      id: createCanvasId("note"),
      type: "note",
      position,
      data: { label: "New note", text: "Add shared context here", width: 210, height: 120 },
    };
    const updated = await commitAuthoringAction({
      description: "Added a shared note",
      forward: [{ type: "addNode", node: note }],
      inverse: [{ type: "removeNode", nodeId: note.id }],
      selectionBefore: selection,
      selectionAfter: { kind: "node", id: note.id },
    });
    if (updated) {
      selectTool("select");
      setInspectorOpen(true);
      setLayersOpen(false);
      onNotify(`Note added · revision v${updated.version}`);
    }
  }

  function onResizePointerDown(event: React.PointerEvent<HTMLSpanElement>, node: CanvasNodeRecord) {
    event.preventDefault();
    event.stopPropagation();
    if (!canEditRef.current || event.button !== 0) return;
    const current = workspaceRef.current;
    if (!current) return;
    if (nodeDragRef.current || nodeResizeRef.current || geometryPreviewRef.current) return;
    setSelection({ kind: "node", id: node.id });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const interactionId = nextInteractionIdRef.current + 1;
    nextInteractionIdRef.current = interactionId;
    nodeResizeRef.current = {
      baseVersion: current.version,
      interactionId,
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: geometryMap.get(node.id) ?? canvasNodeGeometry(node),
      moved: false,
    };
  }

  function onResizePointerMove(event: React.PointerEvent<HTMLSpanElement>) {
    event.stopPropagation();
    const resize = nodeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const geometry = resizedNodeGeometry(
      resize.origin,
      event.clientX - resize.startX,
      event.clientY - resize.startY,
      scale,
    );
    resize.moved = resize.moved || geometry.width !== resize.origin.width || geometry.height !== resize.origin.height;
    if (!resize.moved) return;
    scheduleGeometryPreview({
      baseVersion: resize.baseVersion,
      geometry,
      interactionId: resize.interactionId,
      nodeId: resize.nodeId,
    });
  }

  function onResizePointerUp(event: React.PointerEvent<HTMLSpanElement>) {
    event.stopPropagation();
    const resize = nodeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    nodeResizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!resize.moved) {
      clearGeometryPreview(resize.interactionId);
      return;
    }

    const finalGeometry = resizedNodeGeometry(
      resize.origin,
      event.clientX - resize.startX,
      event.clientY - resize.startY,
      scale,
    );
    flushGeometryPreview({
      baseVersion: resize.baseVersion,
      geometry: finalGeometry,
      interactionId: resize.interactionId,
      nodeId: resize.nodeId,
    });
    const { width, height } = finalGeometry;
    const node = nodeMap.get(resize.nodeId);
    const nodeSelection: CanvasSelection = { kind: "node", id: resize.nodeId };
    suppressClickRef.current = resize.nodeId;
    window.setTimeout(() => { suppressClickRef.current = null; }, 0);
    void commitAuthoringAction({
      description: `Resized ${node ? nodeLabel(node) : resize.nodeId}`,
      forward: [{ type: "updateNode", nodeId: resize.nodeId, patch: { data: { width, height } } }],
      inverse: [{ type: "updateNode", nodeId: resize.nodeId, patch: { data: { width: resize.origin.width, height: resize.origin.height } } }],
      selectionBefore: nodeSelection,
      selectionAfter: nodeSelection,
    }, resize.baseVersion).then((updated) => {
      if (updated) onNotify(`Node resized · revision v${updated.version}`);
    }).finally(() => {
      clearGeometryPreview(resize.interactionId);
    });
  }

  function cancelNodeResize(event: React.PointerEvent<HTMLSpanElement>) {
    event.stopPropagation();
    const resize = nodeResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    nodeResizeRef.current = null;
    clearGeometryPreview(resize.interactionId);
    if (resize.moved) {
      suppressClickRef.current = resize.nodeId;
      window.setTimeout(() => { suppressClickRef.current = null; }, 0);
    }
  }

  async function saveNodePatch(node: CanvasNodeRecord, patch: EditableNodePatch, baseVersion?: number) {
    if (!patch.position && (!patch.data || Object.keys(patch.data).length === 0)) {
      onNotify("No node changes to save");
      return;
    }
    const inverse: EditableNodePatch = {};
    if (patch.position) inverse.position = { ...node.position };
    if (patch.data) {
      inverse.data = Object.fromEntries(
        Object.keys(patch.data).map((key) => [key, previousNodeDataValue(node, key)]),
      );
    }
    const nodeSelection: CanvasSelection = { kind: "node", id: node.id };
    const updated = await commitAuthoringAction({
      description: `Updated ${nodeLabel(node)}`,
      forward: [{ type: "updateNode", nodeId: node.id, patch }],
      inverse: [{ type: "updateNode", nodeId: node.id, patch: inverse }],
      selectionBefore: nodeSelection,
      selectionAfter: nodeSelection,
    }, baseVersion);
    if (updated) onNotify(`Node updated · revision v${updated.version}`);
  }

  async function saveEdgePatch(
    edge: CanvasEdgeRecord,
    patch: { type?: string; data?: Record<string, unknown> },
    baseVersion?: number,
  ) {
    if (Object.keys(patch).length === 0) {
      onNotify("No relationship changes to save");
      return;
    }
    const inverse: { type?: string; data?: Record<string, unknown> } = {};
    if (patch.type !== undefined) inverse.type = edge.type;
    if (patch.data) {
      inverse.data = Object.fromEntries(
        Object.keys(patch.data).map((key) => [key, key in edge.data ? edge.data[key] : ""]),
      );
    }
    const edgeSelection: CanvasSelection = { kind: "edge", id: edge.id };
    const updated = await commitAuthoringAction({
      description: `Updated relationship ${edgeLabel(edge, nodeMap)}`,
      forward: [{ type: "updateEdge", edgeId: edge.id, patch }],
      inverse: [{ type: "updateEdge", edgeId: edge.id, patch: inverse }],
      selectionBefore: edgeSelection,
      selectionAfter: edgeSelection,
    }, baseVersion);
    if (updated) onNotify(`Relationship updated · revision v${updated.version}`);
  }

  async function deleteNode(node: CanvasNodeRecord, baseVersion?: number) {
    const incidentEdges = edges.filter((edge) => edge.source === node.id || edge.target === node.id);
    const nodeSelection: CanvasSelection = { kind: "node", id: node.id };
    const updated = await commitAuthoringAction({
      description: `Deleted ${nodeLabel(node)}`,
      forward: [
        ...incidentEdges.map<WorkspaceOperation>((edge) => ({ type: "removeEdge", edgeId: edge.id })),
        { type: "removeNode", nodeId: node.id },
      ],
      inverse: [
        { type: "addNode", node },
        ...incidentEdges.map<WorkspaceOperation>((edge) => ({ type: "addEdge", edge })),
      ],
      selectionBefore: nodeSelection,
      selectionAfter: null,
    }, baseVersion);
    if (updated) onNotify(`Node deleted · revision v${updated.version}`);
  }

  async function deleteEdge(edge: CanvasEdgeRecord, baseVersion?: number) {
    const edgeSelection: CanvasSelection = { kind: "edge", id: edge.id };
    const updated = await commitAuthoringAction({
      description: `Deleted relationship ${edgeLabel(edge, nodeMap)}`,
      forward: [{ type: "removeEdge", edgeId: edge.id }],
      inverse: [{ type: "addEdge", edge }],
      selectionBefore: edgeSelection,
      selectionAfter: null,
    }, baseVersion);
    if (updated) onNotify(`Relationship deleted · revision v${updated.version}`);
  }

  async function undoLatest() {
    const entry = undoStack.at(-1);
    if (!entry) {
      onNotify("Nothing to undo");
      return;
    }
    const updated = await commitOperations(`Undo: ${entry.description}`, entry.inverse);
    if (!updated) return;
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, entry].slice(-MAX_AUTHORING_HISTORY));
    setSelection(entry.selectionBefore);
    onNotify(`Undid ${entry.description.toLowerCase()} · revision v${updated.version}`);
  }

  async function redoLatest() {
    const entry = redoStack.at(-1);
    if (!entry) {
      onNotify("Nothing to redo");
      return;
    }
    const updated = await commitOperations(`Redo: ${entry.description}`, entry.forward);
    if (!updated) return;
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, entry].slice(-MAX_AUTHORING_HISTORY));
    setSelection(entry.selectionAfter);
    onNotify(`Redid ${entry.description.toLowerCase()} · revision v${updated.version}`);
  }

  async function upsertMember(userId: string, update: WorkspaceMemberUpsert): Promise<boolean> {
    const current = workspaceRef.current;
    if (!current) {
      setMemberError("Workspace service is still connecting");
      return false;
    }
    if (!workspaceTenantId || !workspaceProjectId) {
      setMemberError("Select a tenant and project before changing workspace members");
      return false;
    }
    const existing = members.some((member) => member.userId === userId);
    setMemberMutation(`upsert:${userId}`);
    setMemberError("");
    try {
      const member = await upsertWorkspaceMember(
        current.id,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        userId,
        update,
        activeUserId,
      );
      setMembers((items) => {
        const withoutTarget = items.filter((item) => item.userId !== member.userId);
        return [...withoutTarget, member].sort((left, right) => left.displayName.localeCompare(right.displayName));
      });
      await refreshMembers(current.id);
      onNotify(`${member.displayName} ${existing ? "updated" : "added"}`);
      return true;
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : "Workspace member could not be saved");
      return false;
    } finally {
      setMemberMutation(null);
    }
  }

  async function removeMember(member: WorkspaceMember) {
    const current = workspaceRef.current;
    if (!current) {
      setMemberError("Workspace service is still connecting");
      return;
    }
    if (!workspaceTenantId || !workspaceProjectId) {
      setMemberError("Select a tenant and project before changing workspace members");
      return;
    }
    setMemberMutation(`remove:${member.userId}`);
    setMemberError("");
    try {
      await removeWorkspaceMember(
        current.id,
        { tenantId: workspaceTenantId, projectId: workspaceProjectId },
        member.userId,
        activeUserId,
      );
      setMembers((items) => items.filter((item) => item.userId !== member.userId));
      if (member.userId === activeUserId) {
        setMemberError("Your workspace membership was removed. Server access is now required to continue.");
      } else {
        await refreshMembers(current.id);
      }
      onNotify(`${member.displayName} removed`);
    } catch (error) {
      setMemberError(error instanceof Error ? error.message : "Workspace member could not be removed");
    } finally {
      setMemberMutation(null);
    }
  }

  return (
    <div className="canvas-shell">
      <header className="canvas-topbar">
        <button className="canvas-brand" type="button" onClick={onOpenExplorer} aria-label="Open Data Fusion Explorer"><BrandLogo aria-hidden="true" /></button>
        <CanvasNavigationMenu onNavigate={onNavigate} />
        <ProjectSwitcher variant="canvas" context={platformContext} tenants={tenants} projects={projects} selectedTenantId={selectedTenantId} state={platformState} onTenantChange={onTenantChange} onProjectChange={onProjectChange} onRetry={onRetryProjectDiscovery} />
        <div className="canvas-workspace-name"><span>Workspace</span><span className="canvas-slash">/</span><span>{workspace?.name ?? "No workspace selected"}</span></div>
        <button className="canvas-save-state" type="button" disabled={!workspace || !canEdit} onClick={saveRevision} title={canEdit ? "Save a new immutable revision" : "Your workspace role is read-only"}>Saved v{workspace?.version ?? "—"} <span>✓</span> <small>{workspace ? !membersLoaded ? "Checking access" : canEdit ? "Save revision" : "Read only" : "Connecting"}</small></button>
        <button className={`canvas-presence${collaborationConnected === false ? " is-disconnected" : ""}${membersOpen ? " is-open" : ""}`} type="button" aria-label={`Workspace members, ${presenceUsers.length} online`} aria-expanded={membersOpen} onClick={() => { setHistoryOpen(false); setInspectorOpen(false); setLayersOpen(false); setMembersOpen((open) => !open); }} title={`${members.length} workspace member${members.length === 1 ? "" : "s"}`}>
          <Users size={15} />
          <div className="presence-avatars" aria-hidden="true">
            {presenceUsers.slice(0, 3).map((user) => <span key={user.userId} title={`${user.displayName} · ${user.role}`}>{user.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span>)}
          </div>
          <span>{presenceUsers.length} online</span>
          <span className="sr-only" aria-live="polite">{presenceUsers.map((user) => `${user.displayName}, ${user.role}`).join("; ")}</span>
          <ChevronDown size={12} />
        </button>
        {membersLoaded && !canEdit ? <span className="canvas-readonly-badge">{currentMember?.role ?? "no access"} · read only</span> : null}
        <div className="canvas-top-actions"><button aria-label="Revision history" onClick={openHistory}><Clock3 size={18} /></button>{authSession.enabled ? <button className="canvas-signout-button" type="button" aria-label={`Sign out ${authSession.identity?.displayName ?? activeUserId}`} title={`Signed in as ${authSession.identity?.displayName ?? activeUserId}`} onClick={() => void authSession.signOut().catch((error: unknown) => onNotify(error instanceof Error ? error.message : "Sign out failed"))}><span>{(authSession.identity?.displayName ?? activeUserId).split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><LogOut size={15} /></button> : null}<MobileCanvasMenu hasSelection={selection !== null} onOpenHistory={() => void openHistory()} onOpenInspector={openInspector} onToggleMembers={() => { setHistoryOpen(false); setInspectorOpen(false); setLayersOpen(false); setMembersOpen((open) => !open); }} /><span id="new-canvas-unavailable" className="sr-only">Creating additional workspaces is not available in this increment.</span><button className="new-canvas-button" type="button" disabled aria-describedby="new-canvas-unavailable">New canvas <Plus size={17} /></button></div>
      </header>
      <aside className="canvas-tool-rail" role="toolbar" aria-label="Canvas tools">
        <div className="canvas-tool-group canvas-tool-group--modes">
          <CanvasToolButton active={tool === "select"} label="Select" icon={<MousePointer2 size={18} />} onClick={() => selectTool("select")} />
          <CanvasToolButton active={tool === "pan"} label="Pan" icon={<Hand size={18} />} onClick={() => selectTool("pan")} />
          <CanvasToolButton active={tool === "connect"} disabled={!canEdit} label="Connect" icon={<Link2 size={18} />} onClick={() => selectTool("connect")} />
        </div>
        <div className="canvas-tool-group canvas-tool-group--objects">
          <CanvasToolButton label="Find asset" icon={<Box size={18} />} onClick={() => selectFirstNode("asset")} />
          <CanvasToolButton label="Find series" icon={<Gauge size={18} />} onClick={() => selectFirstNode("series")} />
          <CanvasToolButton label="Find document" icon={<FileText size={18} />} onClick={() => selectFirstNode("document")} />
          <CanvasToolButton disabled={!canEdit} label="Note" icon={<StickyNote size={18} />} onClick={() => void addNote()} />
          <CanvasToolButton active={layersOpen} label="Layers" icon={<Layers3 size={18} />} onClick={openLayers} />
        </div>
        <div className="canvas-tool-spacer" />
        <div className="canvas-tool-group canvas-tool-group--history">
          <CanvasToolButton disabled={!canEdit || undoStack.length === 0} label="Undo" icon={<RotateCcw size={18} />} onClick={() => void undoLatest()} />
          <CanvasToolButton disabled={!canEdit || redoStack.length === 0} label="Redo" icon={<Redo2 size={18} />} onClick={() => void redoLatest()} />
        </div>
        <div className="canvas-zoom-label" aria-label={`Canvas zoom ${Math.round(scale * 100)} percent`}>{Math.round(scale * 100)}%</div>
      </aside>
      <main
        ref={stageRef}
        className={`canvas-stage tool-${tool}`}
        aria-label="Open Data Fusion industrial canvas"

        tabIndex={0}
        onKeyDown={onStageKeyDown}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
        onLostPointerCapture={onCanvasPointerUp}
      >
        {conflictMessage && <div className="canvas-conflict-banner" role="alert"><AlertTriangle size={17} /><span>{conflictMessage}</span><button type="button" aria-label="Dismiss conflict message" onClick={() => setConflictMessage("")}><X size={15} /></button></div>}
        {tool === "connect" && <div className="canvas-connect-hint" role="status">{connectSource ? "Select a target node" : "Select the source node"}</div>}
        <div className="canvas-dots" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} onClick={(event) => { if (event.target === event.currentTarget && tool === "select") { setSelection(null); setInspectorOpen(false); } }}>
          {nodes.filter((node) => node.type === "diagram").map((node) => {
            const geometry = geometryMap.get(node.id);
            return geometry ? <PidPanel key={node.id} geometry={geometry} /> : null;
          })}
          {snapshot?.telemetry.series[0] ? <div className="canvas-panel canvas-chart-panel"><div className="canvas-panel-header"><span><Gauge size={17} /> {snapshot.telemetry.series[0].name}</span><MoreDots /></div><div className="canvas-legend"><span className="legend-blue">●</span> {snapshot.telemetry.series[0].externalId} <em>{snapshot.telemetry.series[0].unit ?? "value"}</em></div><TelemetryChart snapshot={snapshot} /><div className="chart-window-summary">Latest loaded telemetry window</div><div className="chart-footer"><span>Historical snapshot</span><span>{snapshot.telemetry.series[0].points.length} points</span></div></div> : <div className="canvas-panel canvas-chart-panel"><div className="canvas-panel-header"><span><Gauge size={17} /> Telemetry</span><MoreDots /></div><div className="chart-window-summary">Select an asset with telemetry to populate this panel.</div></div>}
          <svg className="canvas-edges" viewBox="0 0 1400 1000" aria-label="Canvas connections">
            {edges.map((edge) => {
              const source = nodeMap.get(edge.source);
              const target = nodeMap.get(edge.target);
              const sourceGeometry = geometryMap.get(edge.source);
              const targetGeometry = geometryMap.get(edge.target);
              if (!source || !target || !sourceGeometry || !targetGeometry) return null;
              const path = edgePath(sourceGeometry, targetGeometry);
              const label = `Relationship ${edgeLabel(edge, nodeMap)}`;
              const isSelected = selection?.kind === "edge" && selection.id === edge.id;
              return (
                <g
                  key={edge.id}
                  className={`canvas-edge-group${isSelected ? " is-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  aria-pressed={isSelected}
                  onClick={(event) => { event.stopPropagation(); setSelection({ kind: "edge", id: edge.id }); setLayersOpen(false); setInspectorOpen(true); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelection({ kind: "edge", id: edge.id });
                      setLayersOpen(false);
                      setInspectorOpen(true);
                    }
                  }}
                >
                  <path className="canvas-edge-hit" d={path} />
                  <path className="canvas-edge-line" data-edge-id={edge.id} d={path} />
                </g>
              );
            })}
          </svg>
          {nodes.map((node) => {
            const kind = nodeKind(node);
            const geometry = geometryMap.get(node.id);
            if (!kind || !geometry) return null;
            return (
              <CanvasNode
                key={node.id}
                node={node}
                geometry={geometry}
                kind={kind}
                selected={selection?.kind === "node" && selection.id === node.id}
                connecting={connectSource === node.id}
                previewing={geometryPreview !== null && geometryPreview.baseVersion === workspace?.version && geometryPreview.nodeId === node.id}
                canResize={canEdit}
                onClick={() => void activateNode(node)}
                onPointerDown={(event) => onNodePointerDown(event, node)}
                onPointerMove={onNodePointerMove}
                onPointerUp={onNodePointerUp}
                onPointerCancel={cancelNodeDrag}
                onLostPointerCapture={cancelNodeDrag}
                onResizePointerDown={(event) => onResizePointerDown(event, node)}
                onResizePointerMove={onResizePointerMove}
                onResizePointerUp={onResizePointerUp}
                onResizePointerCancel={cancelNodeResize}
                onResizeLostPointerCapture={cancelNodeResize}
              />
            );
          })}
        </div>
        <div className="canvas-stage-actions"><button aria-label="Fit canvas" onClick={fitCanvas}><Maximize2 size={17} /></button></div>
        <div className="canvas-minimap"><span className="minimap-selection" /><i /><i /><i /><i /></div>
        <div className="canvas-zoom-controls"><button aria-label="Zoom out" onClick={() => updateZoom(-0.1)}><ZoomOut size={16} /></button><button aria-label="Zoom in" onClick={() => updateZoom(0.1)}><ZoomIn size={16} /></button><button aria-label="Reset canvas" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}><Maximize2 size={16} /></button></div>
        {selection ? <button className="canvas-inspector-trigger" type="button" aria-label="Open selection inspector" aria-expanded={inspectorOpen} onClick={openInspector}><PanelRightOpen size={17} /> Inspect selection</button> : null}
        {showIntro && <div className="canvas-intro"><button className="canvas-intro-close" aria-label="Close introduction" onClick={() => setShowIntro(false)}><X size={16} /></button><div className="intro-illustration"><Cable size={36} /><span>◯</span><span>□</span></div><div><h1>Explore this industrial view</h1><p>This workspace already connects assets, time series, documents, and governed relations.</p><div><button className="intro-primary" onClick={() => setShowIntro(false)}>Explore workspace</button><button className="intro-secondary" onClick={onOpenExplorer}>Open Explorer</button></div></div></div>}
      </main>
      {inspectorOpen ? <button className="canvas-inspector-backdrop" type="button" aria-label="Close selection inspector" onClick={() => setInspectorOpen(false)} /> : null}
      <aside className={`canvas-inspector${inspectorOpen ? " is-open" : ""}`} aria-label="Selection inspector">
        <div className="inspector-header">
          <div><strong>Selection</strong>{!canEdit && membersLoaded ? <span>Read only</span> : null}</div>
          <button aria-label="Clear selection and close inspector" onClick={() => { setSelection(null); setInspectorOpen(false); }}><X size={17} /></button>
        </div>
        {selectedNode && selectedKind ? (
          <NodeInspector
            key={`${selectedNode.id}-${workspace?.version ?? 0}`}
            node={selectedNode}
            kind={selectedKind}
            canEdit={canEdit}
            onSave={(patch) => void saveNodePatch(selectedNode, patch, workspace?.version)}
            onDelete={() => void deleteNode(selectedNode, workspace?.version)}
          />
        ) : selectedEdge ? (
          <EdgeInspector
            key={`${selectedEdge.id}-${workspace?.version ?? 0}`}
            edge={selectedEdge}
            sourceLabel={nodeMap.get(selectedEdge.source) ? nodeLabel(nodeMap.get(selectedEdge.source) as CanvasNodeRecord) : selectedEdge.source}
            targetLabel={nodeMap.get(selectedEdge.target) ? nodeLabel(nodeMap.get(selectedEdge.target) as CanvasNodeRecord) : selectedEdge.target}
            canEdit={canEdit}
            onSave={(patch) => void saveEdgePatch(selectedEdge, patch, workspace?.version)}
            onDelete={() => void deleteEdge(selectedEdge, workspace?.version)}
          />
        ) : (
          <div className="inspector-empty"><MousePointer2 size={24} /><strong>Select a node or relationship</strong><span>Choose an item on the canvas to edit its details.</span></div>
        )}
      </aside>
      {layersOpen ? (
        <section className="canvas-layers-panel" aria-label="Canvas layers">
          <div className="layers-panel-header"><div><strong>Canvas layers</strong><span>{nodes.length} nodes · {edges.length} relationships</span></div><button type="button" aria-label="Close canvas layers" onClick={() => setLayersOpen(false)}><X size={17} /></button></div>
          <ol className="canvas-layer-list">
            {nodes.map((node) => {
              const kind = nodeKind(node);
              const selected = selection?.kind === "node" && selection.id === node.id;
              return <li key={node.id}><button type="button" className={selected ? "is-selected" : ""} aria-pressed={selected} onClick={() => { if (!kind) { fitCanvas(); return; } setSelection({ kind: "node", id: node.id }); setLayersOpen(false); setInspectorOpen(true); }}><span>{kind ? <NodeIcon kind={kind} /> : <Layers3 size={18} />}</span><strong>{nodeLabel(node)}</strong><small>{kind ? nodeTypeLabel(kind) : "Diagram"}</small></button></li>;
            })}
          </ol>
        </section>
      ) : null}
      {membersOpen ? (
        <WorkspaceMembersPanel
          members={members}
          onlineUserIds={onlineUserIds}
          currentUserId={activeUserId}
          canManage={canManageMembers}
          loading={!membersLoaded || membersRefreshing}
          mutation={memberMutation}
          error={memberError}
          onClose={() => setMembersOpen(false)}
          onRetry={() => { if (workspace) void refreshMembers(workspace.id); }}
          onUpsert={upsertMember}
          onRemove={(member) => void removeMember(member)}
        />
      ) : null}
      {historyOpen ? (
        <section className="canvas-history-panel" aria-label="Revision history">
          <div className="history-panel-header"><div><strong>Revision history</strong><span>{revisions.length} loaded · {revisionTotal} total · rollback creates a new revision</span></div><button aria-label="Close revision history" onClick={() => setHistoryOpen(false)}><X size={17} /></button></div>
          {historyLoading ? <p className="history-status">Loading revisions…</p> : null}
          {historyError ? <p className="history-error" role="alert">{historyError}</p> : null}
          {!historyLoading && revisions.length === 0 && !historyError ? <p className="history-status">No revisions are available.</p> : null}
          {!historyLoading && revisions.length > 0 ? <ol className="revision-list">{revisions.map((revision) => <li key={revision.version}><div><strong>v{revision.version}</strong><span>{revision.changeSummary}</span><small>{revision.actor} · {new Date(revision.createdAt).toLocaleString()}</small></div><button type="button" disabled={!canEdit || revision.version === workspace?.version} title={!canEdit ? "Read-only role" : undefined} onClick={() => void restoreRevision(revision.version)}>{revision.version === workspace?.version ? "Current" : "Restore"}</button></li>)}</ol> : null}
          {revisions.length < revisionTotal ? <button className="history-load-more" type="button" disabled={historyLoadingMore} onClick={() => void loadMoreHistory()}>{historyLoadingMore ? "Loading…" : `Load more (${revisionTotal - revisions.length})`}</button> : null}
        </section>
      ) : null}
    </div>
  );
}

function WorkspaceMembersPanel({
  members,
  onlineUserIds,
  currentUserId,
  canManage,
  loading,
  mutation,
  error,
  onClose,
  onRetry,
  onUpsert,
  onRemove,
}: {
  members: WorkspaceMember[];
  onlineUserIds: Set<string>;
  currentUserId: string;
  canManage: boolean;
  loading: boolean;
  mutation: string | null;
  error: string;
  onClose: () => void;
  onRetry: () => void;
  onUpsert: (userId: string, update: WorkspaceMemberUpsert) => Promise<boolean>;
  onRemove: (member: WorkspaceMember) => void;
}) {
  const [userId, setUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("viewer");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedUserId = userId.trim();
    const normalizedDisplayName = displayName.trim();
    if (!normalizedUserId || !normalizedDisplayName) return;
    const saved = await onUpsert(normalizedUserId, { displayName: normalizedDisplayName, role });
    if (saved) {
      setUserId("");
      setDisplayName("");
      setRole("viewer");
    }
  }

  return (
    <section className="workspace-members-panel" aria-label="Workspace members">
      <div className="members-panel-header">
        <div><strong>Workspace members</strong><span>{members.length} people · {onlineUserIds.size} online</span></div>
        <button type="button" aria-label="Close workspace members" onClick={onClose}><X size={17} /></button>
      </div>
      {error ? <div className="members-error" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></div> : null}
      {canManage ? (
        <form className="member-upsert-form" aria-label="Add or update member" onSubmit={(event) => void submit(event)}>
          <strong><UserPlus size={15} /> Add or update member</strong>
          <label>User ID<input aria-label="Member user ID" required value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="jordan.kim" /></label>
          <label>Display name<input aria-label="Member display name" required value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Jordan Kim" /></label>
          <label>Role<select aria-label="New member role" value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>{WORKSPACE_ROLES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <button type="submit" disabled={loading || mutation !== null}>{mutation?.startsWith("upsert:") ? "Saving…" : "Add or update"}</button>
          <small>Permissions are always rechecked by the server.</small>
        </form>
      ) : <p className="members-readonly-note">You can view workspace access. Only an owner can manage members.</p>}
      <div className="workspace-member-list" aria-live="polite">
        {loading && members.length === 0 ? <p className="members-loading">Loading members…</p> : null}
        {!loading && members.length === 0 ? <p className="members-loading">No workspace members found.</p> : null}
        {members.map((member) => {
          const initials = member.displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
          const isOnline = onlineUserIds.has(member.userId);
          const rowBusy = mutation === `upsert:${member.userId}` || mutation === `remove:${member.userId}`;
          return (
            <div className="workspace-member-row" key={member.userId}>
              <span className="member-avatar" aria-hidden="true">{initials}</span>
              <div className="member-identity"><strong>{member.displayName}{member.userId === currentUserId ? <small> You</small> : null}</strong><span>{member.userId}</span><em className={isOnline ? "is-online" : ""}>{isOnline ? "Online" : "Offline"}</em></div>
              {canManage ? (
                <div className="member-controls">
                  <select aria-label={`Role for ${member.displayName}`} value={member.role} disabled={loading || mutation !== null} onChange={(event) => void onUpsert(member.userId, { displayName: member.displayName, role: event.target.value as WorkspaceRole })}>{WORKSPACE_ROLES.map((item) => <option key={item} value={item}>{item}</option>)}</select>
                  <button type="button" aria-label={`Remove ${member.displayName}`} title="Remove member" disabled={loading || mutation !== null} onClick={() => onRemove(member)}>{rowBusy && mutation?.startsWith("remove:") ? "…" : <Trash2 size={14} />}</button>
                </div>
              ) : <span className="member-role-badge">{member.role}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CanvasToolButton({ active, disabled, label, icon, onClick }: { active?: boolean; disabled?: boolean; label: string; icon: React.ReactNode; onClick: () => void }) {
  return <button className={`canvas-tool${active ? " is-active" : ""}`} type="button" disabled={disabled} aria-label={label} aria-pressed={active === undefined ? undefined : active} onClick={onClick}>{icon}<span>{label}</span></button>;
}

function NodeIcon({ kind }: { kind: NodeKind }) {
  if (kind === "series") return <Gauge size={28} />;
  if (kind === "system") return <Cable size={28} />;
  if (kind === "document") return <FileText size={28} />;
  if (kind === "note") return <StickyNote size={28} />;
  return <Box size={28} />;
}

function CanvasNode({
  node,
  geometry,
  kind,
  selected,
  connecting,
  previewing,
  canResize,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  onResizePointerDown,
  onResizePointerMove,
  onResizePointerUp,
  onResizePointerCancel,
  onResizeLostPointerCapture,
}: {
  node: CanvasNodeRecord;
  geometry: CanvasNodeGeometry;
  kind: NodeKind;
  selected: boolean;
  connecting: boolean;
  previewing: boolean;
  canResize: boolean;
  onClick: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onResizePointerDown: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onResizePointerMove: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onResizePointerUp: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onResizePointerCancel: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onResizeLostPointerCapture: (event: React.PointerEvent<HTMLSpanElement>) => void;
}) {
  const label = nodeLabel(node);
  return (
    <button
      className={`canvas-node canvas-node-${kind}${selected ? " is-selected" : ""}${connecting ? " is-connecting" : ""}${previewing ? " is-previewing" : ""}`}
      style={{
        left: 0,
        top: 0,
        width: geometry.width,
        height: geometry.height,
        transform: `translate3d(${geometry.x}px, ${geometry.y}px, 0)`,
      }}
      data-canvas-x={geometry.x}
      data-canvas-y={geometry.y}
      type="button"
      aria-label={`${label} canvas node`}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      <span className="canvas-node-icon"><NodeIcon kind={kind} /></span>
      <span className="canvas-node-copy"><strong>{label}</strong><span><i /> {nodeSubtitle(node, kind)}</span><em>{nodeTypeLabel(kind)}</em></span>
      <MoreDots />
      {selected && canResize ? <span className="canvas-node-resize-handle" aria-hidden="true" onPointerDown={onResizePointerDown} onPointerMove={onResizePointerMove} onPointerUp={onResizePointerUp} onPointerCancel={onResizePointerCancel} onLostPointerCapture={onResizeLostPointerCapture} /> : null}
    </button>
  );
}

function NodeInspector({
  node,
  kind,
  canEdit,
  onSave,
  onDelete,
}: {
  node: CanvasNodeRecord;
  kind: NodeKind;
  canEdit: boolean;
  onSave: (patch: EditableNodePatch) => void;
  onDelete: () => void;
}) {
  const dimensions = nodeDimensions(node);
  const initialLabel = nodeLabel(node);
  const initialStatus = dataString(node, "status") ?? nodeSubtitle(node, kind);
  const initialText = dataString(node, "text") ?? "";
  const initialDescription = dataString(node, "description") ?? "";
  const initialUnit = dataString(node, "unit") ?? "";
  const initialUri = dataString(node, "uri") ?? "";
  const [label, setLabel] = useState(initialLabel);
  const [status, setStatus] = useState(initialStatus);
  const [text, setText] = useState(initialText);
  const [description, setDescription] = useState(initialDescription);
  const [unit, setUnit] = useState(initialUnit);
  const [uri, setUri] = useState(initialUri);
  const [positionX, setPositionX] = useState(node.position.x);
  const [positionY, setPositionY] = useState(node.position.y);
  const [width, setWidth] = useState(dimensions.width);
  const [height, setHeight] = useState(dimensions.height);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data: Record<string, unknown> = {};
    const nextLabel = label.trim();
    if (nextLabel !== initialLabel) data.label = nextLabel;
    if (width !== dimensions.width) data.width = clampDimension(width, MIN_NODE_WIDTH, MAX_NODE_WIDTH);
    if (height !== dimensions.height) data.height = clampDimension(height, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT);
    if (kind === "note" && text !== initialText) data.text = text;
    if ((kind === "asset" || kind === "system" || kind === "series") && status.trim() !== initialStatus) data.status = status.trim();
    if ((kind === "asset" || kind === "system" || kind === "document") && description !== initialDescription) data.description = description;
    if (kind === "series" && unit.trim() !== initialUnit) data.unit = unit.trim();
    if (kind === "document" && uri.trim() !== initialUri) data.uri = uri.trim();
    const nextX = Number.isFinite(positionX) ? Math.round(positionX) : node.position.x;
    const nextY = Number.isFinite(positionY) ? Math.round(positionY) : node.position.y;
    const positionChanged = nextX !== node.position.x || nextY !== node.position.y;
    onSave({
      ...(Object.keys(data).length > 0 ? { data } : {}),
      ...(positionChanged ? { position: { x: nextX, y: nextY } } : {}),
    });
  }

  return (
    <>
      <div className="inspector-identity"><div className="inspector-icon"><NodeIcon kind={kind} /></div><div><strong>{initialLabel}</strong><span><i /> {nodeSubtitle(node, kind)}</span></div></div>
      <InspectorField label="Type" value={nodeTypeLabel(kind)} />
      {dataString(node, "externalId") ? <InspectorField label="External ID" value={dataString(node, "externalId") as string} /> : null}
      {!canEdit ? <p className="inspector-readonly-message">Your workspace role can inspect this node but cannot change it.</p> : null}
      <form className="inspector-edit-form" onSubmit={submit}>
        <fieldset disabled={!canEdit}>
          <label>Label<input aria-label="Node label" required value={label} onChange={(event) => setLabel(event.target.value)} /></label>
          {kind === "note" ? <label>Note content<textarea aria-label="Note content" rows={5} value={text} onChange={(event) => setText(event.target.value)} /></label> : null}
          {kind === "asset" || kind === "system" || kind === "series" ? <label>Status<input aria-label="Node status" value={status} onChange={(event) => setStatus(event.target.value)} /></label> : null}
          {kind === "series" ? <label>Unit<input aria-label="Time series unit" value={unit} onChange={(event) => setUnit(event.target.value)} /></label> : null}
          {kind === "document" ? <label>Document URI<input aria-label="Document URI" value={uri} onChange={(event) => setUri(event.target.value)} /></label> : null}
          {kind === "asset" || kind === "system" || kind === "document" ? <label>Description<textarea aria-label="Node description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label> : null}
          <div className="inspector-position-grid">
            <label>X position<input aria-label="Node X position" type="number" value={positionX} onChange={(event) => setPositionX(Number(event.target.value))} /></label>
            <label>Y position<input aria-label="Node Y position" type="number" value={positionY} onChange={(event) => setPositionY(Number(event.target.value))} /></label>
          </div>
          <div className="inspector-size-grid">
            <label>Width<input aria-label="Node width" type="number" min={MIN_NODE_WIDTH} max={MAX_NODE_WIDTH} value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
            <label>Height<input aria-label="Node height" type="number" min={MIN_NODE_HEIGHT} max={MAX_NODE_HEIGHT} value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
          </div>
          <button className="inspector-save-button" type="submit"><Save size={14} /> Save changes</button>
          <button className="inspector-delete-button" type="button" onClick={onDelete}><Trash2 size={14} /> Delete node</button>
        </fieldset>
      </form>
    </>
  );
}

function EdgeInspector({
  edge,
  sourceLabel,
  targetLabel,
  canEdit,
  onSave,
  onDelete,
}: {
  edge: CanvasEdgeRecord;
  sourceLabel: string;
  targetLabel: string;
  canEdit: boolean;
  onSave: (patch: { type?: string; data?: Record<string, unknown> }) => void;
  onDelete: () => void;
}) {
  const initialLabel = typeof edge.data.label === "string" ? edge.data.label : "";
  const initialDescription = typeof edge.data.description === "string" ? edge.data.description : "";
  const [relationshipType, setRelationshipType] = useState(edge.type);
  const [label, setLabel] = useState(initialLabel);
  const [description, setDescription] = useState(initialDescription);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch: { type?: string; data?: Record<string, unknown> } = {};
    const nextType = relationshipType.trim();
    if (nextType !== edge.type) patch.type = nextType;
    const data: Record<string, unknown> = {};
    if (label !== initialLabel) data.label = label;
    if (description !== initialDescription) data.description = description;
    if (Object.keys(data).length) patch.data = data;
    onSave(patch);
  }

  return (
    <>
      <div className="inspector-identity"><div className="inspector-icon"><Link2 size={27} /></div><div><strong>{initialLabel || edge.type}</strong><span><i /> Relationship</span></div></div>
      <InspectorField label="Source" value={sourceLabel} />
      <InspectorField label="Target" value={targetLabel} />
      {!canEdit ? <p className="inspector-readonly-message">Your workspace role can inspect this relationship but cannot change it.</p> : null}
      <form className="inspector-edit-form" onSubmit={submit}>
        <fieldset disabled={!canEdit}>
          <label>Relationship type<input aria-label="Relationship type" required value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} /></label>
          <label>Label<input aria-label="Relationship label" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
          <label>Description<textarea aria-label="Relationship description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <button className="inspector-save-button" type="submit"><Save size={14} /> Save relationship</button>
          <button className="inspector-delete-button" type="button" onClick={onDelete}><Trash2 size={14} /> Delete relationship</button>
        </fieldset>
      </form>
    </>
  );
}

function InspectorField({ label, value, link }: { label: string; value: string; link?: boolean }) {
  return <div className="inspector-field"><label>{label}</label><div className={link ? "inspector-value is-link" : "inspector-value"}>{value}{link && <span>›</span>}</div></div>;
}
