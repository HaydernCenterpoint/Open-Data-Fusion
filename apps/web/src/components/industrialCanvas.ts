export const CANVAS_STORAGE_KEY = "open-data-fusion:industrial-canvas:v2";
export const CANVAS_GRID = 4;
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 2.4;

export type CanvasWidgetKind =
  | "text"
  | "note"
  | "image"
  | "document"
  | "chart"
  | "timeSeries"
  | "model3d"
  | "asset"
  | "ai"
  | "comment"
  | "frame";

export type CanvasTool = "select" | "hand" | "connector" | "comment";
export type ChartMode = "line" | "area" | "multi";
export type AiScope = "Selected asset" | "Selected documents" | "Entire canvas";

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasWidgetData {
  text?: string;
  description?: string;
  connected?: boolean;
  sourceLabel?: string;
  sources?: string[];
  fileName?: string;
  fileType?: string;
  fileUrl?: string;
  page?: number;
  viewerZoom?: number;
  chartMode?: ChartMode;
  timeRange?: string;
  hiddenSeries?: string[];
  seriesZoom?: number;
  objectTreeOpen?: boolean;
  modelTool?: "orbit" | "pan";
  modelZoom?: number;
  highlighted?: boolean;
  aiScope?: AiScope;
  aiQuestion?: string;
  aiAnswer?: string;
  aiStatus?: "idle" | "loading" | "ready";
}

export interface CanvasWidget {
  id: string;
  kind: CanvasWidgetKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  locked: boolean;
  collapsed: boolean;
  background: string;
  borderColor: string;
  opacity: number;
  data: CanvasWidgetData;
}

export interface CanvasReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface CanvasComment {
  id: string;
  widgetId?: string;
  x: number;
  y: number;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  reactions: number;
  replies: CanvasReply[];
}

export interface CanvasConnection {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface IndustrialCanvasState {
  version: 1;
  title: string;
  viewport: CanvasViewport;
  widgets: CanvasWidget[];
  connections: CanvasConnection[];
  comments: CanvasComment[];
  updatedAt: string;
}

export interface CanvasPoint {
  x: number;
  y: number;
}

const widgetDefaults: Record<CanvasWidgetKind, Pick<CanvasWidget, "title" | "width" | "height" | "background"> & { data: CanvasWidgetData }> = {
  text: { title: "Text", width: 300, height: 132, background: "#ffffff", data: { text: "" } },
  note: { title: "Note", width: 280, height: 190, background: "#fff8d9", data: { text: "" } },
  image: { title: "Image", width: 420, height: 300, background: "#ffffff", data: { viewerZoom: 1 } },
  document: { title: "Document", width: 430, height: 340, background: "#ffffff", data: { page: 1, viewerZoom: 1 } },
  chart: { title: "Chart", width: 470, height: 310, background: "#ffffff", data: { chartMode: "line", timeRange: "24h", seriesZoom: 1 } },
  timeSeries: { title: "Time series", width: 470, height: 310, background: "#ffffff", data: { chartMode: "multi", timeRange: "24h", seriesZoom: 1 } },
  model3d: { title: "3D viewer", width: 500, height: 340, background: "#ffffff", data: { objectTreeOpen: true, modelTool: "orbit", modelZoom: 1 } },
  asset: { title: "Asset", width: 300, height: 220, background: "#ffffff", data: {} },
  ai: { title: "Ask the canvas", width: 370, height: 300, background: "#ffffff", data: { aiScope: "Entire canvas", aiStatus: "idle" } },
  comment: { title: "Comment", width: 280, height: 170, background: "#ffffff", data: { text: "Start a discussion" } },
  frame: { title: "Section", width: 620, height: 420, background: "#f7f9fc", data: {} },
};

function id(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export function snapToGrid(value: number): number {
  return Math.round(value / CANVAS_GRID) * CANVAS_GRID;
}

export function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

export function createEmptyCanvas(): IndustrialCanvasState {
  return {
    version: 1,
    title: "Untitled canvas",
    viewport: { x: 0, y: 0, zoom: 1 },
    widgets: [],
    connections: [],
    comments: [],
    updatedAt: new Date().toISOString(),
  };
}

export function createWidget(kind: CanvasWidgetKind, point: CanvasPoint, z: number): CanvasWidget {
  const defaults = widgetDefaults[kind];
  return {
    id: id(kind),
    kind,
    title: defaults.title,
    x: snapToGrid(point.x),
    y: snapToGrid(point.y),
    width: defaults.width,
    height: defaults.height,
    z,
    locked: false,
    collapsed: false,
    background: defaults.background,
    borderColor: "#cfd7df",
    opacity: 1,
    data: { ...defaults.data },
  };
}

export function duplicateWidget(widget: CanvasWidget, z: number): CanvasWidget {
  return {
    ...structuredClone(widget),
    id: id(widget.kind),
    title: `${widget.title} copy`,
    x: widget.x + 24,
    y: widget.y + 24,
    z,
    locked: false,
  };
}

export function bringWidgetForward(widget: CanvasWidget, highestZ: number): CanvasWidget {
  return { ...widget, z: Math.max(widget.z + 1, highestZ + 1) };
}

export function sendWidgetBackward(widget: CanvasWidget, lowestZ: number): CanvasWidget {
  return { ...widget, z: Math.max(1, Math.min(widget.z - 1, lowestZ)) };
}

export function zoomAroundPoint(viewport: CanvasViewport, screenPoint: CanvasPoint, nextZoom: number): CanvasViewport {
  const zoom = clampZoom(nextZoom);
  const worldX = (screenPoint.x - viewport.x) / viewport.zoom;
  const worldY = (screenPoint.y - viewport.y) / viewport.zoom;
  return {
    x: Math.round(screenPoint.x - worldX * zoom),
    y: Math.round(screenPoint.y - worldY * zoom),
    zoom,
  };
}

function isCanvasState(value: unknown): value is IndustrialCanvasState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IndustrialCanvasState>;
  return candidate.version === 1
    && typeof candidate.title === "string"
    && Array.isArray(candidate.widgets)
    && Array.isArray(candidate.connections)
    && Array.isArray(candidate.comments)
    && Boolean(candidate.viewport)
    && typeof candidate.viewport?.x === "number"
    && typeof candidate.viewport?.y === "number"
    && typeof candidate.viewport?.zoom === "number";
}

export function loadCanvas(): IndustrialCanvasState {
  if (typeof localStorage === "undefined") return createEmptyCanvas();
  try {
    const stored = localStorage.getItem(CANVAS_STORAGE_KEY);
    if (!stored) return createEmptyCanvas();
    const parsed: unknown = JSON.parse(stored);
    return isCanvasState(parsed) ? parsed : createEmptyCanvas();
  } catch {
    return createEmptyCanvas();
  }
}

export function saveCanvas(canvas: IndustrialCanvasState): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...canvas, updatedAt: new Date().toISOString() }));
}

export function clearSavedCanvas(): IndustrialCanvasState {
  if (typeof localStorage !== "undefined") localStorage.removeItem(CANVAS_STORAGE_KEY);
  return createEmptyCanvas();
}
