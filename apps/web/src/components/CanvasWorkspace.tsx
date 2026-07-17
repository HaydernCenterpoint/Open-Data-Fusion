import {
  Bot,
  Box,
  ChartNoAxesCombined,
  ClipboardList,
  Cuboid,
  Expand,
  FileText,
  Frame,
  Image,
  LocateFixed,
  Map as MapIcon,
  MessageSquare,
  Minus,
  Plus,
  StickyNote,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiWorkspace, ExplorerSnapshot, PlatformContext, PlatformProject, PlatformTenant } from "../types";
import type { PlatformBootstrapState } from "./PlatformWorkspaces";
import type { NavigationLabel } from "./Sidebar";
import { CanvasHeader, CanvasHistoryPopover, CanvasNavigation, CanvasToolRail } from "./IndustrialCanvasChrome";
import { CanvasContextMenu, CanvasInspector, CommandPalette, ConfirmResetDialog, type PaletteCommand } from "./IndustrialCanvasPanels";
import { IndustrialCanvasWidget, type WidgetAction } from "./IndustrialCanvasWidget";
import {
  bringWidgetForward,
  clampZoom,
  clearSavedCanvas,
  createWidget,
  duplicateWidget,
  loadCanvas,
  saveCanvas,
  sendWidgetBackward,
  snapToGrid,
  zoomAroundPoint,
  type CanvasComment,
  type CanvasPoint,
  type CanvasTool,
  type CanvasWidget,
  type CanvasWidgetKind,
  type IndustrialCanvasState,
} from "./industrialCanvas";
import "./industrialCanvas.css";

interface CanvasWorkspaceProps {
  snapshot: ExplorerSnapshot | null;
  workspace: ApiWorkspace | null;
  platformContext: PlatformContext | null;
  tenants?: PlatformTenant[];
  projects?: PlatformProject[];
  selectedTenantId?: string;
  platformState?: PlatformBootstrapState;
  onTenantChange?: (tenantId: string) => void;
  onProjectChange?: (projectId: string) => void;
  onRetryProjectDiscovery?: () => void;
  onWorkspaceUpdated: (workspace: ApiWorkspace) => void;
  onOpenExplorer: () => void;
  onNavigate?: (label: NavigationLabel) => void;
  onNotify: (message: string) => void;
}

export interface CanvasNodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DragState {
  before: IndustrialCanvasState;
  pointerId: number;
  start: CanvasPoint;
  origins: Map<string, CanvasPoint>;
  moved: boolean;
}

interface ResizeState {
  before: IndustrialCanvasState;
  pointerId: number;
  start: CanvasPoint;
  widgetId: string;
  width: number;
  height: number;
  moved: boolean;
}

interface PanState {
  before: IndustrialCanvasState;
  pointerId: number;
  start: CanvasPoint;
  origin: CanvasPoint;
  moved: boolean;
}

interface CommentDragState {
  before: IndustrialCanvasState;
  pointerId: number;
  start: CanvasPoint;
  commentId: string;
  origin: CanvasPoint;
  moved: boolean;
}

interface MarqueeState {
  start: CanvasPoint;
  current: CanvasPoint;
  additive: boolean;
}

interface HistoryEntry {
  id: string;
  label: string;
  at: string;
  state: IndustrialCanvasState;
}

interface ContextMenuState {
  x: number;
  y: number;
  world: CanvasPoint;
}

export function edgePath(source: CanvasNodeGeometry, target: CanvasNodeGeometry): string {
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
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

function cloneCanvas(canvas: IndustrialCanvasState): IndustrialCanvasState {
  return structuredClone(canvas);
}

function createLocalId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function intersects(widget: CanvasWidget, left: number, top: number, right: number, bottom: number): boolean {
  return widget.x < right && widget.x + widget.width > left && widget.y < bottom && widget.y + widget.height > top;
}

function isInsideFrame(widget: CanvasWidget, frame: CanvasWidget): boolean {
  return widget.id !== frame.id
    && widget.x >= frame.x
    && widget.y >= frame.y
    && widget.x + widget.width <= frame.x + frame.width
    && widget.y + widget.height <= frame.y + frame.height;
}

export function CanvasWorkspace({ snapshot, onOpenExplorer, onNotify }: CanvasWorkspaceProps) {
  const [canvas, setCanvas] = useState<IndustrialCanvasState>(() => loadCanvas());
  const canvasRef = useRef(canvas);
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [connectSourceId, setConnectSourceId] = useState<string | null>(null);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1280px)").matches);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"comments" | "properties">("properties");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveState, setSaveState] = useState<"saving" | "saved">("saved");
  const [undoStack, setUndoStack] = useState<IndustrialCanvasState[]>([]);
  const [redoStack, setRedoStack] = useState<IndustrialCanvasState[]>([]);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const commentDragRef = useRef<CommentDragState | null>(null);
  const clipboardRef = useRef<CanvasWidget[]>([]);
  const suppressClickRef = useRef(false);

  canvasRef.current = canvas;
  const selectedWidgets = useMemo(() => selection.map((id) => canvas.widgets.find((widget) => widget.id === id)).filter((widget): widget is CanvasWidget => Boolean(widget)), [canvas.widgets, selection]);
  const connectedSourceTitles = useMemo(() => canvas.widgets.filter((widget) => widget.data.connected).map((widget) => widget.data.sourceLabel ?? widget.title), [canvas.widgets]);

  const setCanvasDirect = useCallback((next: IndustrialCanvasState) => {
    canvasRef.current = next;
    setCanvas(next);
  }, []);

  const recordChange = useCallback((before: IndustrialCanvasState, label: string) => {
    setUndoStack((stack) => [...stack, before].slice(-50));
    setRedoStack([]);
    const current = cloneCanvas(canvasRef.current);
    setHistoryEntries((entries) => [{ id: createLocalId("history"), label, at: new Date().toLocaleTimeString(), state: current }, ...entries].slice(0, 50));
  }, []);

  const replaceCanvas = useCallback((next: IndustrialCanvasState, label: string, before = canvasRef.current) => {
    const stamped = { ...next, updatedAt: new Date().toISOString() };
    setCanvasDirect(stamped);
    recordChange(cloneCanvas(before), label);
  }, [recordChange, setCanvasDirect]);

  const mutateCanvas = useCallback((label: string, mutate: (draft: IndustrialCanvasState) => void) => {
    const before = cloneCanvas(canvasRef.current);
    const next = cloneCanvas(before);
    mutate(next);
    replaceCanvas(next, label, before);
  }, [replaceCanvas]);

  useEffect(() => {
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      try {
        saveCanvas(canvasRef.current);
        setSaveState("saved");
      } catch {
        setSaveState("saved");
        onNotify("Canvas could not be saved in local browser storage");
      }
    }, 420);
    return () => window.clearTimeout(timer);
  }, [canvas, onNotify]);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      const previous = stack.at(-1);
      if (!previous) return stack;
      setRedoStack((redo) => [...redo, cloneCanvas(canvasRef.current)].slice(-50));
      setCanvasDirect(cloneCanvas(previous));
      setSelection([]);
      setSelectedConnectionId(null);
      return stack.slice(0, -1);
    });
  }, [setCanvasDirect]);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      const next = stack.at(-1);
      if (!next) return stack;
      setUndoStack((undoStates) => [...undoStates, cloneCanvas(canvasRef.current)].slice(-50));
      setCanvasDirect(cloneCanvas(next));
      setSelection([]);
      setSelectedConnectionId(null);
      return stack.slice(0, -1);
    });
  }, [setCanvasDirect]);

  const worldPoint = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    const localX = clientX - (rect?.left ?? 0);
    const localY = clientY - (rect?.top ?? 0);
    const viewport = canvasRef.current.viewport;
    return { x: (localX - viewport.x) / viewport.zoom, y: (localY - viewport.y) / viewport.zoom };
  }, []);

  const viewportCenter = useCallback((): CanvasPoint => {
    const stage = stageRef.current;
    const viewport = canvasRef.current.viewport;
    return {
      x: ((stage?.clientWidth ?? 980) / 2 - viewport.x) / viewport.zoom,
      y: ((stage?.clientHeight ?? 720) / 2 - viewport.y) / viewport.zoom,
    };
  }, []);

  const addWidget = useCallback((kind: CanvasWidgetKind, point?: CanvasPoint): CanvasWidget => {
    const before = cloneCanvas(canvasRef.current);
    const center = point ?? viewportCenter();
    const placement = point ? center : {
      x: center.x + (before.widgets.length % 5) * 32,
      y: center.y + (before.widgets.length % 5) * 32,
    };
    const highestZ = Math.max(0, ...before.widgets.map((widget) => widget.z));
    const widget = createWidget(kind, placement, highestZ + 1);
    widget.x = snapToGrid(placement.x - widget.width / 2);
    widget.y = snapToGrid(placement.y - widget.height / 2);
    const next = cloneCanvas(before);
    if (kind === "frame" && next.widgets.length) {
      next.widgets = next.widgets.map((item) => ({ ...item, z: item.z + 1 }));
      widget.z = 1;
    }
    next.widgets.push(widget);
    replaceCanvas(next, `Added ${widget.title}`, before);
    setSelection([widget.id]);
    setSelectedConnectionId(null);
    setTool("select");
    setInspectorTab("properties");
    return widget;
  }, [replaceCanvas, viewportCenter]);

  const updateWidget = useCallback((id: string, patch: Partial<CanvasWidget>, label = "Updated widget") => {
    mutateCanvas(label, (draft) => {
      draft.widgets = draft.widgets.map((widget) => widget.id === id ? { ...widget, ...patch, data: patch.data ? { ...widget.data, ...patch.data } : widget.data } : widget);
    });
  }, [mutateCanvas]);

  const updateSelected = useCallback((patch: Partial<CanvasWidget>) => {
    if (!selection.length) return;
    mutateCanvas(`Updated ${selection.length === 1 ? "widget" : `${selection.length} widgets`}`, (draft) => {
      draft.widgets = draft.widgets.map((widget) => selection.includes(widget.id) ? { ...widget, ...patch, data: patch.data ? { ...widget.data, ...patch.data } : widget.data } : widget);
    });
  }, [mutateCanvas, selection]);

  const connectData = useCallback((widgetId?: string) => {
    const targetId = widgetId ?? selection[0];
    if (!targetId) return;
    if (!snapshot) {
      onNotify("Connect a project data source in Explorer first");
      onOpenExplorer();
      return;
    }
    const target = canvasRef.current.widgets.find((widget) => widget.id === targetId);
    if (!target) return;
    const asset = snapshot.detail.asset;
    const relatedSources = [
      ...snapshot.telemetry.series.map((series) => series.name),
      ...snapshot.detail.documents.map((document) => document.title),
    ];
    updateWidget(targetId, {
      title: target.kind === "asset" ? asset.name : target.title,
      data: {
        ...target.data,
        connected: true,
        sourceLabel: asset.name,
        description: asset.description ?? undefined,
        sources: relatedSources,
      },
    }, `Connected ${asset.name}`);
    onNotify(`${asset.name} connected to ${target.title}`);
  }, [onNotify, onOpenExplorer, selection, snapshot, updateWidget]);

  const addComment = useCallback((body: string, point?: CanvasPoint, widgetId?: string) => {
    const target = widgetId ? canvasRef.current.widgets.find((widget) => widget.id === widgetId) : undefined;
    const location = point ?? (target ? { x: target.x + target.width - 12, y: target.y + 34 } : viewportCenter());
    const comment: CanvasComment = {
      id: createLocalId("comment"),
      ...(widgetId ? { widgetId } : {}),
      x: snapToGrid(location.x),
      y: snapToGrid(location.y),
      author: "You",
      body,
      createdAt: new Date().toISOString(),
      resolved: false,
      reactions: 0,
      replies: [],
    };
    mutateCanvas("Added comment", (draft) => { draft.comments.push(comment); });
    setSelectedCommentId(comment.id);
    setInspectorTab("comments");
    setInspectorOpen(true);
    setTool("select");
  }, [mutateCanvas, viewportCenter]);

  const removeSelection = useCallback(() => {
    if (selectedConnectionId) {
      mutateCanvas("Removed connector", (draft) => { draft.connections = draft.connections.filter((connection) => connection.id !== selectedConnectionId); });
      setSelectedConnectionId(null);
      return;
    }
    if (!selection.length) return;
    const selectedSet = new Set(selection);
    mutateCanvas(`Removed ${selection.length} widget${selection.length === 1 ? "" : "s"}`, (draft) => {
      draft.widgets = draft.widgets.filter((widget) => !selectedSet.has(widget.id));
      draft.connections = draft.connections.filter((connection) => !selectedSet.has(connection.sourceId) && !selectedSet.has(connection.targetId));
      draft.comments = draft.comments.filter((comment) => !comment.widgetId || !selectedSet.has(comment.widgetId));
    });
    setSelection([]);
  }, [mutateCanvas, selectedConnectionId, selection]);

  const copySelection = useCallback(() => {
    clipboardRef.current = selectedWidgets.map((widget) => structuredClone(widget));
    if (clipboardRef.current.length) onNotify(`${clipboardRef.current.length} widget${clipboardRef.current.length === 1 ? "" : "s"} copied`);
  }, [onNotify, selectedWidgets]);

  const pasteClipboard = useCallback((point?: CanvasPoint) => {
    if (!clipboardRef.current.length) return;
    const before = cloneCanvas(canvasRef.current);
    let highestZ = Math.max(0, ...before.widgets.map((widget) => widget.z));
    const copies = clipboardRef.current.map((widget, index) => {
      const copy = duplicateWidget(widget, ++highestZ);
      if (point) { copy.x = snapToGrid(point.x + index * 20); copy.y = snapToGrid(point.y + index * 20); }
      return copy;
    });
    const next = cloneCanvas(before);
    next.widgets.push(...copies);
    replaceCanvas(next, `Pasted ${copies.length} widget${copies.length === 1 ? "" : "s"}`, before);
    setSelection(copies.map((widget) => widget.id));
  }, [replaceCanvas]);

  const duplicateSelection = useCallback(() => {
    clipboardRef.current = selectedWidgets.map((widget) => structuredClone(widget));
    pasteClipboard();
  }, [pasteClipboard, selectedWidgets]);

  const groupSelection = useCallback(() => {
    if (selectedWidgets.length < 2) return;
    const left = Math.min(...selectedWidgets.map((widget) => widget.x));
    const top = Math.min(...selectedWidgets.map((widget) => widget.y));
    const right = Math.max(...selectedWidgets.map((widget) => widget.x + widget.width));
    const bottom = Math.max(...selectedWidgets.map((widget) => widget.y + widget.height));
    const frame = createWidget("frame", { x: left - 32, y: top - 56 }, Math.max(1, Math.min(...selectedWidgets.map((widget) => widget.z)) - 1));
    frame.width = right - left + 64;
    frame.height = bottom - top + 88;
    const before = cloneCanvas(canvasRef.current);
    const next = cloneCanvas(before);
    next.widgets.push(frame);
    replaceCanvas(next, "Grouped selection in a frame", before);
    setSelection([frame.id, ...selection]);
  }, [replaceCanvas, selectedWidgets, selection]);

  const layerSelection = useCallback((direction: "forward" | "backward") => {
    if (!selection.length) return;
    mutateCanvas(direction === "forward" ? "Brought selection forward" : "Sent selection backward", (draft) => {
      const high = Math.max(0, ...draft.widgets.map((widget) => widget.z));
      const low = Math.min(1, ...draft.widgets.map((widget) => widget.z));
      draft.widgets = draft.widgets.map((widget) => selection.includes(widget.id) ? direction === "forward" ? bringWidgetForward(widget, high) : sendWidgetBackward(widget, low) : widget);
    });
  }, [mutateCanvas, selection]);

  const widgetAction = useCallback((widget: CanvasWidget, action: WidgetAction) => {
    if (action === "duplicate") {
      clipboardRef.current = [structuredClone(widget)];
      pasteClipboard();
    } else if (action === "lock") updateWidget(widget.id, { locked: !widget.locked }, widget.locked ? "Unlocked widget" : "Locked widget");
    else if (action === "collapse") updateWidget(widget.id, { collapsed: !widget.collapsed }, widget.collapsed ? "Expanded widget" : "Collapsed widget");
    else if (action === "forward" || action === "backward") {
      mutateCanvas(action === "forward" ? "Brought widget forward" : "Sent widget backward", (draft) => {
        const high = Math.max(0, ...draft.widgets.map((item) => item.z));
        const low = Math.min(1, ...draft.widgets.map((item) => item.z));
        draft.widgets = draft.widgets.map((item) => item.id === widget.id
          ? action === "forward" ? bringWidgetForward(item, high) : sendWidgetBackward(item, low)
          : item);
      });
      setSelection([widget.id]);
    }
    else {
      mutateCanvas("Removed widget", (draft) => {
        draft.widgets = draft.widgets.filter((item) => item.id !== widget.id);
        draft.connections = draft.connections.filter((connection) => connection.sourceId !== widget.id && connection.targetId !== widget.id);
        draft.comments = draft.comments.filter((comment) => comment.widgetId !== widget.id);
      });
      setSelection([]);
    }
  }, [mutateCanvas, pasteClipboard, updateWidget]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const typing = target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']");
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); return; }
      if (typing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); copySelection(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") { event.preventDefault(); pasteClipboard(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelection(); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelection(); }
      else if (event.key === "Escape") { setPaletteOpen(false); setContextMenu(null); setConnectSourceId(null); setTool("select"); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelection, duplicateSelection, pasteClipboard, redo, removeSelection, undo]);

  function selectWidget(widget: CanvasWidget, additive: boolean) {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    if (tool === "comment") { addComment("New comment", undefined, widget.id); return; }
    if (tool === "connector") {
      if (!connectSourceId) { setConnectSourceId(widget.id); setSelection([widget.id]); onNotify("Select a target widget"); return; }
      if (connectSourceId === widget.id) { setConnectSourceId(null); onNotify("Connector cancelled"); return; }
      const exists = canvasRef.current.connections.some((connection) => connection.sourceId === connectSourceId && connection.targetId === widget.id);
      if (!exists) mutateCanvas("Connected widgets", (draft) => { draft.connections.push({ id: createLocalId("connection"), sourceId: connectSourceId, targetId: widget.id }); });
      setConnectSourceId(null);
      setTool("select");
      return;
    }
    setSelectedConnectionId(null);
    setSelection((current) => additive ? current.includes(widget.id) ? current.filter((id) => id !== widget.id) : [...current, widget.id] : [widget.id]);
  }

  function startWidgetDrag(event: React.PointerEvent<HTMLElement>, widget: CanvasWidget) {
    if (event.button !== 0 || tool !== "select" || widget.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = widget.kind === "frame"
      ? [...new Set([...(selection.includes(widget.id) ? selection : [widget.id]), ...canvasRef.current.widgets.filter((item) => isInsideFrame(item, widget)).map((item) => item.id)])]
      : selection.includes(widget.id) ? selection : [widget.id];
    setSelection(ids);
    const origins = new Map(canvasRef.current.widgets.filter((item) => ids.includes(item.id) && !item.locked).map((item) => [item.id, { x: item.x, y: item.y }]));
    if (!origins.size) return;
    dragRef.current = { before: cloneCanvas(canvasRef.current), pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origins, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function startResize(event: React.PointerEvent<HTMLSpanElement>, widget: CanvasWidget) {
    if (event.button !== 0 || widget.locked) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { before: cloneCanvas(canvasRef.current), pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, widgetId: widget.id, width: widget.width, height: widget.height, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function startCommentDrag(event: React.PointerEvent<HTMLButtonElement>, comment: CanvasComment) {
    if (event.button !== 0 || tool !== "select") return;
    event.preventDefault();
    event.stopPropagation();
    commentDragRef.current = { before: cloneCanvas(canvasRef.current), pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, commentId: comment.id, origin: { x: comment.x, y: comment.y }, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onStagePointerDown(event: React.PointerEvent<HTMLElement>) {
    setContextMenu(null);
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, [contenteditable='true']")) return;
    if (event.button === 1 || tool === "hand") {
      event.preventDefault();
      panRef.current = { before: cloneCanvas(canvasRef.current), pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { x: canvasRef.current.viewport.x, y: canvasRef.current.viewport.y }, moved: false };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (target.closest(".industrial-widget, .industrial-comment-pin, .industrial-connection")) return;
    const point = worldPoint(event.clientX, event.clientY);
    if (tool === "comment") { addComment("New comment", point); return; }
    if (tool !== "select" || event.button !== 0) return;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (!additive) { setSelection([]); setSelectedConnectionId(null); }
    setMarquee({ start: point, current: point, additive });
  }

  function updateAlignmentGuides(widget: CanvasWidget, movingIds: Set<string>) {
    let x: number | undefined;
    let y: number | undefined;
    const centers = { x: widget.x + widget.width / 2, y: widget.y + widget.height / 2 };
    for (const other of canvasRef.current.widgets) {
      if (movingIds.has(other.id)) continue;
      const otherCenters = { x: other.x + other.width / 2, y: other.y + other.height / 2 };
      if (Math.abs(centers.x - otherCenters.x) <= 5) x = otherCenters.x;
      if (Math.abs(centers.y - otherCenters.y) <= 5) y = otherCenters.y;
      if (x !== undefined && y !== undefined) break;
    }
    setGuides({ x, y });
  }

  function onStagePointerMove(event: React.PointerEvent<HTMLElement>) {
    const commentDrag = commentDragRef.current;
    if (commentDrag?.pointerId === event.pointerId) {
      const dx = (event.clientX - commentDrag.start.x) / commentDrag.before.viewport.zoom;
      const dy = (event.clientY - commentDrag.start.y) / commentDrag.before.viewport.zoom;
      commentDrag.moved ||= Math.abs(dx) > 1 || Math.abs(dy) > 1;
      const next = cloneCanvas(commentDrag.before);
      next.comments = next.comments.map((comment) => comment.id === commentDrag.commentId ? { ...comment, x: snapToGrid(commentDrag.origin.x + dx), y: snapToGrid(commentDrag.origin.y + dy) } : comment);
      setCanvasDirect(next);
      return;
    }
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      const dx = event.clientX - pan.start.x;
      const dy = event.clientY - pan.start.y;
      pan.moved ||= Math.abs(dx) > 1 || Math.abs(dy) > 1;
      const next = cloneCanvas(pan.before);
      next.viewport = { ...next.viewport, x: Math.round(pan.origin.x + dx), y: Math.round(pan.origin.y + dy) };
      setCanvasDirect(next);
      return;
    }
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const dx = (event.clientX - drag.start.x) / drag.before.viewport.zoom;
      const dy = (event.clientY - drag.start.y) / drag.before.viewport.zoom;
      drag.moved ||= Math.abs(dx) > 1 || Math.abs(dy) > 1;
      const next = cloneCanvas(drag.before);
      const movingIds = new Set(drag.origins.keys());
      next.widgets = next.widgets.map((widget) => {
        const origin = drag.origins.get(widget.id);
        return origin ? { ...widget, x: snapToGrid(origin.x + dx), y: snapToGrid(origin.y + dy) } : widget;
      });
      setCanvasDirect(next);
      const primary = next.widgets.find((widget) => movingIds.has(widget.id));
      if (primary) updateAlignmentGuides(primary, movingIds);
      return;
    }
    const resize = resizeRef.current;
    if (resize?.pointerId === event.pointerId) {
      const dx = (event.clientX - resize.start.x) / resize.before.viewport.zoom;
      const dy = (event.clientY - resize.start.y) / resize.before.viewport.zoom;
      resize.moved ||= Math.abs(dx) > 1 || Math.abs(dy) > 1;
      const next = cloneCanvas(resize.before);
      next.widgets = next.widgets.map((widget) => widget.id === resize.widgetId ? { ...widget, width: Math.max(160, snapToGrid(resize.width + dx)), height: Math.max(90, snapToGrid(resize.height + dy)) } : widget);
      setCanvasDirect(next);
      return;
    }
    if (marquee) setMarquee({ ...marquee, current: worldPoint(event.clientX, event.clientY) });
  }

  function onStagePointerUp(event: React.PointerEvent<HTMLElement>) {
    const commentDrag = commentDragRef.current;
    if (commentDrag?.pointerId === event.pointerId) {
      commentDragRef.current = null;
      if (commentDrag.moved) { suppressClickRef.current = true; recordChange(commentDrag.before, "Moved comment"); }
    }
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      panRef.current = null;
      if (pan.moved) recordChange(pan.before, "Panned canvas");
    }
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null;
      setGuides({});
      if (drag.moved) { suppressClickRef.current = true; recordChange(drag.before, `Moved ${drag.origins.size} widget${drag.origins.size === 1 ? "" : "s"}`); }
    }
    const resize = resizeRef.current;
    if (resize?.pointerId === event.pointerId) {
      resizeRef.current = null;
      if (resize.moved) { suppressClickRef.current = true; recordChange(resize.before, "Resized widget"); }
    }
    if (marquee) {
      const left = Math.min(marquee.start.x, marquee.current.x);
      const top = Math.min(marquee.start.y, marquee.current.y);
      const right = Math.max(marquee.start.x, marquee.current.x);
      const bottom = Math.max(marquee.start.y, marquee.current.y);
      const hits = canvasRef.current.widgets.filter((widget) => intersects(widget, left, top, right, bottom)).map((widget) => widget.id);
      setSelection((current) => marquee.additive ? [...new Set([...current, ...hits])] : hits);
      setMarquee(null);
    }
  }

  function onWheel(event: React.WheelEvent<HTMLElement>) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const next = cloneCanvas(canvasRef.current);
    next.viewport = zoomAroundPoint(next.viewport, point, next.viewport.zoom - event.deltaY * 0.0012);
    setCanvasDirect(next);
  }

  function changeZoom(delta: number) {
    const stage = stageRef.current;
    const next = cloneCanvas(canvasRef.current);
    next.viewport = zoomAroundPoint(next.viewport, { x: (stage?.clientWidth ?? 900) / 2, y: (stage?.clientHeight ?? 650) / 2 }, next.viewport.zoom + delta);
    setCanvasDirect(next);
  }

  function fitContent() {
    const stage = stageRef.current;
    if (!stage || !canvasRef.current.widgets.length) {
      const next = cloneCanvas(canvasRef.current);
      next.viewport = { x: 0, y: 0, zoom: 1 };
      setCanvasDirect(next);
      return;
    }
    const widgets = canvasRef.current.widgets;
    const left = Math.min(...widgets.map((widget) => widget.x));
    const top = Math.min(...widgets.map((widget) => widget.y));
    const right = Math.max(...widgets.map((widget) => widget.x + widget.width));
    const bottom = Math.max(...widgets.map((widget) => widget.y + widget.height));
    const padding = 72;
    const zoom = clampZoom(Math.min(1, (stage.clientWidth - padding * 2) / Math.max(1, right - left), (stage.clientHeight - padding * 2) / Math.max(1, bottom - top)));
    const next = cloneCanvas(canvasRef.current);
    next.viewport = { x: Math.round((stage.clientWidth - (right - left) * zoom) / 2 - left * zoom), y: Math.round((stage.clientHeight - (bottom - top) * zoom) / 2 - top * zoom), zoom };
    setCanvasDirect(next);
  }

  function dropFiles(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { onNotify("Choose a file smaller than 5 MB for local Canvas storage"); return; }
    const kind: CanvasWidgetKind | null = file.type.startsWith("image/") ? "image" : file.type === "application/pdf" ? "document" : null;
    if (!kind) { onNotify("Drop an image or PDF file onto the Canvas"); return; }
    const widget = addWidget(kind, worldPoint(event.clientX, event.clientY));
    const reader = new FileReader();
    reader.onload = () => updateWidget(widget.id, { data: { ...widget.data, fileName: file.name, fileType: file.type, fileUrl: String(reader.result), page: 1, viewerZoom: 1 } }, `Uploaded ${file.name}`);
    reader.readAsDataURL(file);
  }

  const paletteCommands: PaletteCommand[] = useMemo(() => [
    { id: "text", label: "Add text", description: "Place a simple text block", icon: <Type size={16} />, run: () => addWidget("text") },
    { id: "note", label: "Add note", description: "Capture shared context", icon: <StickyNote size={16} />, run: () => addWidget("note") },
    { id: "asset", label: "Add asset card", description: "Connect governed asset data", icon: <Box size={16} />, run: () => addWidget("asset") },
    { id: "document", label: "Add document", description: "Upload a PDF viewer", icon: <FileText size={16} />, run: () => addWidget("document") },
    { id: "image", label: "Add image", description: "Upload and annotate an image", icon: <Image size={16} />, run: () => addWidget("image") },
    { id: "chart", label: "Add chart", description: "Connect a line or area chart", icon: <ChartNoAxesCombined size={16} />, run: () => addWidget("chart") },
    { id: "series", label: "Add time series", description: "Compare multiple connected series", icon: <ChartNoAxesCombined size={16} />, run: () => addWidget("timeSeries") },
    { id: "3d", label: "Add 3D viewer", description: "Create an empty model viewer", icon: <Cuboid size={16} />, run: () => addWidget("model3d") },
    { id: "ai", label: "Add AI question card", description: "Ask grounded questions later", icon: <Bot size={16} />, run: () => addWidget("ai") },
    { id: "frame", label: "Add section frame", description: "Group related widgets", icon: <Frame size={16} />, run: () => addWidget("frame") },
  ], [addWidget]);

  const minimap = useMemo(() => {
    if (canvas.widgets.length < 3) return null;
    const left = Math.min(...canvas.widgets.map((widget) => widget.x));
    const top = Math.min(...canvas.widgets.map((widget) => widget.y));
    const right = Math.max(...canvas.widgets.map((widget) => widget.x + widget.width));
    const bottom = Math.max(...canvas.widgets.map((widget) => widget.y + widget.height));
    const scale = Math.min(0.18, 148 / Math.max(1, right - left), 86 / Math.max(1, bottom - top));
    return { left, top, scale };
  }, [canvas.widgets]);

  const marqueeRect = marquee ? { left: Math.min(marquee.start.x, marquee.current.x), top: Math.min(marquee.start.y, marquee.current.y), width: Math.abs(marquee.current.x - marquee.start.x), height: Math.abs(marquee.current.y - marquee.start.y) } : null;

  return (
    <div className={`industrial-canvas-shell${navigationCollapsed ? " nav-collapsed" : ""}${inspectorOpen ? " inspector-open" : ""}`} ref={shellRef}>
      <a className="industrial-skip-link" href="#industrial-canvas-stage">Skip to canvas</a>
      <CanvasNavigation collapsed={navigationCollapsed} onToggle={() => setNavigationCollapsed((collapsed) => !collapsed)} onOpenExplorer={onOpenExplorer} onOpenCommand={() => setPaletteOpen(true)} onAdd={addWidget} onOpenInspector={(tab) => { setInspectorTab(tab); setInspectorOpen(true); }} onHelp={() => onNotify("Add a widget from the floating toolbar or press Ctrl/Cmd + K")} onNotify={onNotify} />
      <CanvasHeader title={canvas.title} saveState={saveState} canUndo={undoStack.length > 0} canRedo={redoStack.length > 0} inspectorOpen={inspectorOpen} onRename={(title) => mutateCanvas("Renamed canvas", (draft) => { draft.title = title; })} onUndo={undo} onRedo={redo} onOpenHistory={() => setHistoryOpen((open) => !open)} onOpenComments={() => { setInspectorTab("comments"); setInspectorOpen(true); }} onToggleInspector={() => setInspectorOpen((open) => !open)} onOpenCommand={() => setPaletteOpen(true)} onReset={() => setResetOpen(true)} onNotify={onNotify} />
      <main
        id="industrial-canvas-stage"
        ref={stageRef}
        className={`industrial-canvas-stage tool-${tool}`}
        aria-label="Open Data Fusion industrial canvas"
        tabIndex={0}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerUp}
        onWheel={onWheel}
        onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, world: worldPoint(event.clientX, event.clientY) }); }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropFiles}
      >
        <div className="industrial-world" style={{ transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})` }}>
          <svg className="industrial-connections" viewBox="-3000 -3000 9000 9000" aria-label="Canvas connectors">
            {canvas.connections.map((connection) => {
              const source = canvas.widgets.find((widget) => widget.id === connection.sourceId);
              const target = canvas.widgets.find((widget) => widget.id === connection.targetId);
              if (!source || !target) return null;
              return <g key={connection.id} className={`industrial-connection${selectedConnectionId === connection.id ? " is-selected" : ""}`} role="button" tabIndex={0} aria-label={`Connector from ${source.title} to ${target.title}`} onClick={(event) => { event.stopPropagation(); setSelection([]); setSelectedConnectionId(connection.id); }}><path className="industrial-connection-hit" d={edgePath(source, target)} /><path className="industrial-connection-line" d={edgePath(source, target)} /></g>;
            })}
          </svg>
          {guides.x !== undefined ? <i className="industrial-guide is-vertical" style={{ left: guides.x }} /> : null}
          {guides.y !== undefined ? <i className="industrial-guide is-horizontal" style={{ top: guides.y }} /> : null}
          {canvas.widgets.map((widget) => <IndustrialCanvasWidget key={widget.id} widget={widget} selected={selection.includes(widget.id)} telemetry={snapshot?.telemetry ?? null} connectedSourceTitles={connectedSourceTitles} onSelect={(additive) => selectWidget(widget, additive)} onPointerDown={(event) => startWidgetDrag(event, widget)} onResizePointerDown={(event) => startResize(event, widget)} onUpdate={(patch) => updateWidget(widget.id, patch)} onAction={(action) => widgetAction(widget, action)} onConnectData={() => connectData(widget.id)} onAddWidget={(kind) => addWidget(kind, { x: widget.x + 36, y: widget.y + 36 })} onAddComment={() => addComment(`Comment on ${widget.title}`, undefined, widget.id)} onOpenExplorer={onOpenExplorer} onNotify={onNotify} />)}
          {canvas.comments.map((comment, index) => <button key={comment.id} type="button" className={`industrial-comment-pin${comment.resolved ? " is-resolved" : ""}${selectedCommentId === comment.id ? " is-selected" : ""}`} style={{ transform: `translate(${comment.x}px, ${comment.y}px)` }} aria-label={`Comment ${index + 1}: ${comment.body}`} onPointerDown={(event) => startCommentDrag(event, comment)} onClick={(event) => { event.stopPropagation(); if (suppressClickRef.current) { suppressClickRef.current = false; return; } setSelectedCommentId(comment.id); setInspectorTab("comments"); setInspectorOpen(true); }}><MessageSquare size={13} /><span>{index + 1}</span></button>)}
          {marqueeRect ? <div className="industrial-marquee" style={marqueeRect} /> : null}
        </div>
        <CanvasToolRail activeTool={tool} onTool={(next) => { setTool(next); if (next !== "connector") setConnectSourceId(null); }} onAdd={addWidget} />
        {tool === "connector" ? <div className="industrial-tool-hint">{connectSourceId ? "Select a target widget" : "Select a source widget"}</div> : null}
        {canvas.widgets.length === 0 ? <section className="industrial-canvas-empty"><span><Plus size={18} /></span><h1>Add your first widget</h1><p>Build a shared view from assets, documents, charts and notes. No data is added until you connect it.</p><div><button type="button" onClick={() => addWidget("asset")}><Box size={15} />Asset card</button><button type="button" onClick={() => addWidget("document")}><FileText size={15} />Document</button><button type="button" onClick={() => setPaletteOpen(true)}>Browse all</button></div><small>Tip: press Ctrl/Cmd + K</small></section> : null}
        <div className="industrial-zoom-controls" aria-label="Canvas zoom controls"><button type="button" aria-label="Zoom out" onClick={() => changeZoom(-0.1)}><Minus size={15} /></button><span>{Math.round(canvas.viewport.zoom * 100)}%</span><button type="button" aria-label="Zoom in" onClick={() => changeZoom(0.1)}><Plus size={15} /></button><button type="button" aria-label="Fit to content" onClick={fitContent}><LocateFixed size={15} /></button><button type="button" aria-label="Full screen" onClick={() => void shellRef.current?.requestFullscreen?.()}><Expand size={15} /></button></div>
        {minimap ? <button type="button" className="industrial-minimap" aria-label="Fit canvas from minimap" onClick={fitContent}><MapIcon size={14} />{canvas.widgets.map((widget) => <i key={widget.id} style={{ left: (widget.x - minimap.left) * minimap.scale + 6, top: (widget.y - minimap.top) * minimap.scale + 22, width: Math.max(4, widget.width * minimap.scale), height: Math.max(3, widget.height * minimap.scale) }} />)}</button> : null}
      </main>
      <CanvasInspector open={inspectorOpen} tab={inspectorTab} canvas={canvas} selected={selectedWidgets} comments={canvas.comments} selectedCommentId={selectedCommentId} onTabChange={setInspectorTab} onClose={() => setInspectorOpen(false)} onRenameCanvas={(title) => mutateCanvas("Renamed canvas", (draft) => { draft.title = title; })} onUpdateSelected={updateSelected} onConnectData={() => connectData()} onAddComment={(body) => addComment(body)} onUpdateComment={(id, patch) => mutateCanvas("Updated comment", (draft) => { draft.comments = draft.comments.map((comment) => comment.id === id ? { ...comment, ...patch } : comment); })} onDeleteComment={(id) => mutateCanvas("Deleted comment", (draft) => { draft.comments = draft.comments.filter((comment) => comment.id !== id); })} onNavigateComment={(comment) => { setSelectedCommentId(comment.id); const next = cloneCanvas(canvasRef.current); const stage = stageRef.current; next.viewport.x = Math.round((stage?.clientWidth ?? 800) / 2 - comment.x * next.viewport.zoom); next.viewport.y = Math.round((stage?.clientHeight ?? 600) / 2 - comment.y * next.viewport.zoom); setCanvasDirect(next); }} />
      <CanvasHistoryPopover open={historyOpen} entries={historyEntries} onClose={() => setHistoryOpen(false)} onRestore={(index) => { const entry = historyEntries[index]; if (entry) replaceCanvas(cloneCanvas(entry.state), `Restored ${entry.label}`); setHistoryOpen(false); }} />
      <CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      {contextMenu ? <CanvasContextMenu x={contextMenu.x} y={contextMenu.y} canPaste={clipboardRef.current.length > 0} selectionCount={selection.length} onAdd={(kind) => { addWidget(kind, contextMenu.world); setContextMenu(null); }} onPaste={() => { pasteClipboard(contextMenu.world); setContextMenu(null); }} onDuplicate={() => { duplicateSelection(); setContextMenu(null); }} onGroup={() => { groupSelection(); setContextMenu(null); }} onForward={() => { layerSelection("forward"); setContextMenu(null); }} onBackward={() => { layerSelection("backward"); setContextMenu(null); }} onClose={() => setContextMenu(null)} /> : null}
      <ConfirmResetDialog open={resetOpen} onCancel={() => setResetOpen(false)} onConfirm={() => { const next = clearSavedCanvas(); setCanvasDirect(next); setUndoStack([]); setRedoStack([]); setHistoryEntries([]); setSelection([]); setSelectedConnectionId(null); setResetOpen(false); onNotify("Canvas reset"); }} />
    </div>
  );
}
