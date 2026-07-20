import {
  ArrowDownToLine,
  ArrowUpToLine,
  Bot,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  CircleHelp,
  ClipboardList,
  Copy,
  Cuboid,
  Download,
  Expand,
  Eye,
  FileChartColumn,
  FileText,
  Focus,
  Hand,
  Image,
  Layers2,
  Link2,
  Lock,
  MessageSquare,
  Minus,
  MoreHorizontal,
  MousePointer2,
  Orbit,
  PanelLeft,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  StickyNote,
  Trash2,
  Type,
  Unlock,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { ExplorerSnapshot } from "../types";
import type { CanvasWidget, CanvasWidgetKind, ChartMode } from "./industrialCanvas";

export type WidgetAction = "duplicate" | "lock" | "forward" | "backward" | "remove" | "collapse";

interface IndustrialCanvasWidgetProps {
  widget: CanvasWidget;
  selected: boolean;
  telemetry: ExplorerSnapshot["telemetry"] | null;
  connectedSourceTitles: string[];
  onSelect: (additive: boolean) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onResizePointerDown: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onUpdate: (patch: Partial<CanvasWidget>) => void;
  onAction: (action: WidgetAction) => void;
  onConnectData: () => void;
  onAddWidget: (kind: CanvasWidgetKind) => void;
  onAddComment: () => void;
  onOpenExplorer: () => void;
  onNotify: (message: string) => void;
}

const widgetIcons: Record<CanvasWidgetKind, LucideIcon> = {
  text: Type,
  note: StickyNote,
  image: Image,
  document: FileText,
  chart: FileChartColumn,
  timeSeries: Layers2,
  model3d: Cuboid,
  asset: Box,
  ai: Sparkles,
  comment: MessageSquare,
  frame: ClipboardList,
};

function EmptyState({ icon: Icon, title, body, action, onAction }: { icon: LucideIcon; title: string; body: string; action: string; onAction: () => void }) {
  return (
    <div className="industrial-widget-empty">
      <span><Icon size={22} /></span>
      <strong>{title}</strong>
      <p>{body}</p>
      <button type="button" onClick={onAction}>{action}</button>
    </div>
  );
}

function ViewerToolbar({ page, zoom, onUpdate, fileUrl, fileName, onComment }: { page?: number; zoom: number; onUpdate: (patch: Partial<CanvasWidget["data"]>) => void; fileUrl?: string; fileName?: string; onComment: () => void }) {
  function fullScreen(event: React.MouseEvent<HTMLButtonElement>) {
    void event.currentTarget.closest(".industrial-widget")?.requestFullscreen?.();
  }

  return (
    <div className="industrial-viewer-toolbar" aria-label="Viewer controls">
      {page ? <><button type="button" aria-label="Previous page" onClick={() => onUpdate({ page: Math.max(1, page - 1) })}><ChevronLeft size={14} /></button><span>Page {page}</span><button type="button" aria-label="Next page" onClick={() => onUpdate({ page: page + 1 })}><ChevronRight size={14} /></button></> : null}
      <button type="button" aria-label="Zoom out" onClick={() => onUpdate({ viewerZoom: Math.max(0.5, zoom - 0.15) })}><ZoomOut size={14} /></button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in" onClick={() => onUpdate({ viewerZoom: Math.min(2.5, zoom + 0.15) })}><ZoomIn size={14} /></button>
      <button type="button" aria-label="Fit width" onClick={() => onUpdate({ viewerZoom: 1 })}><Focus size={14} /></button>
      <button type="button" aria-label="Add annotation" onClick={onComment}><MessageSquare size={14} /></button>
      <button type="button" aria-label="Full screen" onClick={fullScreen}><Expand size={14} /></button>
      {fileUrl ? <a aria-label="Download file" download={fileName} href={fileUrl}><Download size={14} /></a> : null}
    </div>
  );
}

function FileViewer({ widget, onUpdate, onComment, onNotify }: { widget: CanvasWidget; onUpdate: (patch: Partial<CanvasWidget["data"]>) => void; onComment: () => void; onNotify: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isImage = widget.kind === "image";
  const accept = isImage ? "image/*" : "application/pdf";

  function loadFile(file?: File) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      onNotify("Choose a file smaller than 5 MB for local Canvas storage");
      return;
    }
    if (isImage ? !file.type.startsWith("image/") : file.type !== "application/pdf") {
      onNotify(isImage ? "Choose an image file" : "Choose a PDF document");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onUpdate({ fileName: file.name, fileType: file.type, fileUrl: String(reader.result), page: 1, viewerZoom: 1 });
    reader.readAsDataURL(file);
  }

  if (!widget.data.fileUrl) {
    return (
      <button
        type="button"
        className="industrial-drop-zone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); loadFile(event.dataTransfer.files[0]); }}
      >
        <UploadCloud size={28} />
        <strong>Drop {isImage ? "an image" : "a PDF"} here</strong>
        <span>or choose a file from your computer</span>
        <input ref={inputRef} hidden type="file" accept={accept} onChange={(event) => loadFile(event.target.files?.[0])} />
      </button>
    );
  }

  const zoom = widget.data.viewerZoom ?? 1;
  return (
    <div className="industrial-viewer">
      <ViewerToolbar page={isImage ? undefined : widget.data.page ?? 1} zoom={zoom} onUpdate={onUpdate} fileUrl={widget.data.fileUrl} fileName={widget.data.fileName} onComment={onComment} />
      <div className="industrial-viewer-surface">
        {isImage ? <img alt={widget.data.fileName ?? "Uploaded canvas image"} src={widget.data.fileUrl} style={{ transform: `scale(${zoom})` }} /> : <object aria-label={widget.data.fileName ?? "Uploaded PDF"} data={widget.data.fileUrl} type="application/pdf" style={{ transform: `scale(${zoom})` }}><p>PDF preview is unavailable. Use Download instead.</p></object>}
      </div>
      <span className="industrial-file-name">{widget.data.fileName}</span>
    </div>
  );
}

function ChartWidget({ widget, telemetry, onUpdate, onConnectData }: { widget: CanvasWidget; telemetry: ExplorerSnapshot["telemetry"] | null; onUpdate: (patch: Partial<CanvasWidget["data"]>) => void; onConnectData: () => void }) {
  const connectedSeries = widget.data.connected ? telemetry?.series ?? [] : [];
  const hidden = new Set(widget.data.hiddenSeries ?? []);
  const mode = widget.data.chartMode ?? (widget.kind === "timeSeries" ? "multi" : "line");
  const visibleSeries = connectedSeries.filter((series) => !hidden.has(series.externalId)).slice(0, 4);
  const paths = useMemo(() => visibleSeries.map((series) => {
    const points = series.points;
    if (!points.length) return { id: series.externalId, name: series.name, unit: series.unit, path: "", area: "" };
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = Math.max(max - min, 1);
    const coords = points.map((point, index) => ({
      x: 12 + (index / Math.max(points.length - 1, 1)) * 336,
      y: 142 - ((point.value - min) / spread) * 112,
      label: `${new Date(point.timestamp).toLocaleString()} · ${point.value}${series.unit ? ` ${series.unit}` : ""}`,
    }));
    const path = coords.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
    return { id: series.externalId, name: series.name, unit: series.unit, path, area: `${path} L348 154 L12 154 Z`, coords };
  }), [visibleSeries]);
  const colors = ["#0b6ffb", "#7c5ce7", "#159477", "#d07a18"];

  if (!connectedSeries.length) {
    return <EmptyState icon={FileChartColumn} title="No data source selected" body="Connect governed time-series data to draw this chart." action="Select data source" onAction={onConnectData} />;
  }

  function toggleSeries(externalId: string) {
    const next = new Set(widget.data.hiddenSeries ?? []);
    if (next.has(externalId)) next.delete(externalId); else next.add(externalId);
    onUpdate({ hiddenSeries: [...next] });
  }

  return (
    <div className="industrial-chart-widget">
      <div className="industrial-chart-controls">
        <label><span className="sr-only">Chart style</span><select value={mode} onChange={(event) => onUpdate({ chartMode: event.target.value as ChartMode })}><option value="line">Line</option><option value="area">Area</option><option value="multi">Multi-series</option></select></label>
        <label><span className="sr-only">Time range</span><select value={widget.data.timeRange ?? "24h"} onChange={(event) => onUpdate({ timeRange: event.target.value })}><option>1h</option><option>24h</option><option>7d</option><option>30d</option></select></label>
        <button type="button" aria-label="Zoom time range out" onClick={() => onUpdate({ seriesZoom: Math.max(0.5, (widget.data.seriesZoom ?? 1) - 0.1) })}><Minus size={13} /></button>
        <button type="button" aria-label="Zoom time range in" onClick={() => onUpdate({ seriesZoom: Math.min(2, (widget.data.seriesZoom ?? 1) + 0.1) })}><Plus size={13} /></button>
      </div>
      <div className="industrial-chart-legend">
        {connectedSeries.slice(0, 4).map((series, index) => <button key={series.externalId} type="button" className={hidden.has(series.externalId) ? "is-hidden" : ""} onClick={() => toggleSeries(series.externalId)}><i style={{ background: colors[index] }} />{series.name}</button>)}
      </div>
      <svg className="industrial-chart" viewBox="0 0 360 164" role="img" aria-label={`${mode} chart with ${visibleSeries.length} visible series`}>
        <g className="industrial-chart-grid">{[30, 58, 86, 114, 142].map((y) => <line key={y} x1="12" x2="348" y1={y} y2={y} />)}</g>
        {paths.map((series, index) => <g key={series.id}>{mode === "area" && index === 0 ? <path d={series.area} fill={`${colors[index]}22`} /> : null}<path d={series.path} fill="none" stroke={colors[index]} strokeWidth="2" />{series.coords?.map((point, pointIndex) => <circle key={pointIndex} cx={point.x} cy={point.y} r="2.5" fill={colors[index]}><title>{point.label}</title></circle>)}</g>)}
      </svg>
    </div>
  );
}

function AssetWidget({ widget, onUpdate, onConnectData, onAddWidget, onOpenExplorer, onAddComment, onNotify }: { widget: CanvasWidget; onUpdate: (patch: Partial<CanvasWidget["data"]>) => void; onConnectData: () => void; onAddWidget: (kind: CanvasWidgetKind) => void; onOpenExplorer: () => void; onAddComment: () => void; onNotify: (message: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  if (!widget.data.connected) return <EmptyState icon={Box} title="No asset connected" body="Connect a governed source to attach context and related data." action="Connect data source" onAction={onConnectData} />;
  return (
    <div className="industrial-asset-card">
      <div><span className="industrial-asset-icon"><Box size={24} /></span><div><strong>{widget.data.sourceLabel ?? widget.title}</strong><span>Connected asset</span></div><button type="button" aria-label="Asset context menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button></div>
      <p>{widget.data.description || "No description is available from the connected source."}</p>
      <div className="industrial-source-list"><span>Related data</span>{widget.data.sources?.length ? widget.data.sources.map((source) => <button type="button" key={source} onClick={() => onNotify(`${source} selected`)}><Link2 size={13} />{source}</button>) : <small>No related sources yet</small>}</div>
      {menuOpen ? <div className="industrial-asset-popover" role="menu"><strong>{widget.data.sourceLabel}</strong><span>Governed asset</span><button type="button" role="menuitem" onClick={onOpenExplorer}><Eye size={14} /> View details</button><button type="button" role="menuitem" onClick={onOpenExplorer}><ArrowUpToLine size={14} /> Open in Explorer</button><button type="button" role="menuitem" onClick={() => { onUpdate({ highlighted: true }); onNotify("3D viewer will highlight this asset when a model is connected"); }}><Cuboid size={14} /> Show in 3D</button><button type="button" role="menuitem" onClick={onOpenExplorer}><CircleHelp size={14} /> Find related data</button><button type="button" role="menuitem" onClick={() => onAddWidget("timeSeries")}><FileChartColumn size={14} /> Add time series</button><button type="button" role="menuitem" onClick={onAddComment}><MessageSquare size={14} /> Add comment</button></div> : null}
    </div>
  );
}

function ModelViewer({ widget, onUpdate, onConnectData }: { widget: CanvasWidget; onUpdate: (patch: Partial<CanvasWidget["data"]>) => void; onConnectData: () => void }) {
  if (!widget.data.connected) {
    return <EmptyState icon={Cuboid} title="No 3D model connected" body="Select a governed model source before using the viewer controls." action="Select model source" onAction={onConnectData} />;
  }
  const treeOpen = widget.data.objectTreeOpen !== false;
  const modelTool = widget.data.modelTool ?? "orbit";
  const modelZoom = widget.data.modelZoom ?? 1;
  return (
    <div className="industrial-model-viewer">
      <div className="industrial-model-toolbar" aria-label="3D viewer controls"><button type="button" aria-pressed={modelTool === "orbit"} onClick={() => onUpdate({ modelTool: "orbit" })}><Orbit size={14} />Orbit</button><button type="button" aria-pressed={modelTool === "pan"} onClick={() => onUpdate({ modelTool: "pan" })}><Hand size={14} />Pan</button><button type="button" aria-label="Zoom model in" onClick={() => onUpdate({ modelZoom: Math.min(2.5, modelZoom + 0.15) })}><ZoomIn size={14} />Zoom</button><button type="button" onClick={() => onUpdate({ modelTool: "orbit", modelZoom: 1 })}><RotateCcw size={14} />Reset</button><button type="button" onClick={() => onUpdate({ modelZoom: 1 })}><Focus size={14} />Fit</button><button type="button" aria-label="Toggle object tree" aria-pressed={treeOpen} onClick={() => onUpdate({ objectTreeOpen: !treeOpen })}><PanelLeft size={14} /></button></div>
      <div className="industrial-model-surface" data-model-tool={modelTool}>{treeOpen ? <aside><strong>Object tree</strong><span>No objects</span></aside> : null}<div style={{ transform: `scale(${modelZoom})` }}><Cuboid size={30} /><strong>{widget.data.sourceLabel ?? "Connected source"}</strong><span>No model nodes were returned by this source.</span></div></div>
    </div>
  );
}

function AiWidget({ widget, connectedSourceTitles, onUpdate, onConnectData }: { widget: CanvasWidget; connectedSourceTitles: string[]; onUpdate: (patch: Partial<CanvasWidget["data"]>) => void; onConnectData: () => void }) {
  const question = widget.data.aiQuestion ?? "";
  const status = widget.data.aiStatus ?? "idle";

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) return;
    if (!connectedSourceTitles.length) {
      onUpdate({ aiStatus: "ready", aiAnswer: "Connect a data source before asking questions about this canvas." });
      return;
    }
    onUpdate({ aiStatus: "loading", aiAnswer: "" });
    window.setTimeout(() => onUpdate({ aiStatus: "ready", aiAnswer: "The connected sources are ready. Configure an AI service to generate a grounded answer." }), 650);
  }

  return (
    <form className="industrial-ai-card" onSubmit={submit}>
      <label>Scope<select value={widget.data.aiScope ?? "Entire canvas"} onChange={(event) => onUpdate({ aiScope: event.target.value as CanvasWidget["data"]["aiScope"] })}><option>Selected asset</option><option>Selected documents</option><option>Entire canvas</option></select></label>
      {!connectedSourceTitles.length ? <button type="button" className="industrial-ai-connect" onClick={onConnectData}><Link2 size={14} />Connect data source</button> : null}
      <div><Bot size={18} /><textarea aria-label="Ask a question" rows={3} placeholder="Ask about connected canvas data" value={question} onChange={(event) => onUpdate({ aiQuestion: event.target.value })} /><button type="submit" aria-label="Send question" disabled={status === "loading" || !question.trim()}><Send size={15} /></button></div>
      {status === "loading" ? <p className="industrial-ai-status"><Sparkles size={14} /> Reviewing connected sources…</p> : null}
      {widget.data.aiAnswer ? <section><strong>Answer</strong><p>{widget.data.aiAnswer}</p><footer><span>Sources</span>{connectedSourceTitles.length ? connectedSourceTitles.map((source) => <button type="button" key={source}>{source}</button>) : <small>No sources</small>}</footer></section> : null}
    </form>
  );
}

function WidgetBody({ widget, telemetry, connectedSourceTitles, onUpdate, onConnectData, onAddWidget, onAddComment, onOpenExplorer, onNotify }: Pick<IndustrialCanvasWidgetProps, "widget" | "telemetry" | "connectedSourceTitles" | "onConnectData" | "onAddWidget" | "onAddComment" | "onOpenExplorer" | "onNotify"> & { onUpdate: (patch: Partial<CanvasWidget["data"]>) => void }) {
  if (widget.kind === "text" || widget.kind === "note") {
    const placeholder = widget.kind === "text" ? "Add text" : "Add a note";
    const value = widget.data.text === placeholder ? "" : widget.data.text ?? "";
    return <textarea className="industrial-text-widget" aria-label={`${widget.title} content`} placeholder={placeholder} value={value} onChange={(event) => onUpdate({ text: event.target.value })} />;
  }
  if (widget.kind === "image" || widget.kind === "document") return <FileViewer widget={widget} onUpdate={onUpdate} onComment={onAddComment} onNotify={onNotify} />;
  if (widget.kind === "chart" || widget.kind === "timeSeries") return <ChartWidget widget={widget} telemetry={telemetry} onUpdate={onUpdate} onConnectData={onConnectData} />;
  if (widget.kind === "model3d") return <ModelViewer widget={widget} onUpdate={onUpdate} onConnectData={onConnectData} />;
  if (widget.kind === "asset") return <AssetWidget widget={widget} onUpdate={onUpdate} onConnectData={onConnectData} onAddWidget={onAddWidget} onOpenExplorer={onOpenExplorer} onAddComment={onAddComment} onNotify={onNotify} />;
  if (widget.kind === "ai") return <AiWidget widget={widget} connectedSourceTitles={connectedSourceTitles} onUpdate={onUpdate} onConnectData={onConnectData} />;
  if (widget.kind === "comment") return <div className="industrial-comment-widget"><MessageSquare size={20} /><p>{widget.data.text}</p><button type="button" onClick={onAddComment}>Open thread</button></div>;
  if (widget.kind === "frame") return <div className="industrial-frame-label">Drop related widgets inside this section</div>;
  return null;
}

export function IndustrialCanvasWidget({ widget, selected, telemetry, connectedSourceTitles, onSelect, onPointerDown, onResizePointerDown, onUpdate, onAction, onConnectData, onAddWidget, onAddComment, onOpenExplorer, onNotify }: IndustrialCanvasWidgetProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const Icon = widgetIcons[widget.kind];
  return (
    <article
      className={`industrial-widget industrial-widget--${widget.kind}${selected ? " is-selected" : ""}${widget.locked ? " is-locked" : ""}`}
      style={{
        width: widget.width,
        height: widget.collapsed ? 43 : widget.height,
        transform: `translate3d(${widget.x}px, ${widget.y}px, 0)`,
        zIndex: widget.z,
        background: widget.background,
        borderColor: widget.borderColor,
        opacity: widget.opacity,
      }}
      data-widget-id={widget.id}
      tabIndex={0}
      aria-label={`${widget.title} ${widget.kind} widget`}
      aria-selected={selected}
      onClick={(event) => { event.stopPropagation(); onSelect(event.shiftKey || event.metaKey || event.ctrlKey); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(event.shiftKey || event.metaKey || event.ctrlKey);
        }
      }}
    >
      <header className="industrial-widget-header" onPointerDown={onPointerDown}>
        <span><Icon size={15} strokeWidth={1.8} /></span>
        <strong>{widget.title}</strong>
        {widget.locked ? <Lock size={13} aria-label="Locked" /> : null}
        <button type="button" aria-label={widget.collapsed ? "Expand widget" : "Collapse widget"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onAction("collapse"); }}><ChevronDown size={14} /></button>
        <button type="button" aria-label="Widget actions" aria-expanded={menuOpen} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setMenuOpen((open) => !open); }}><MoreHorizontal size={15} /></button>
      </header>
      {!widget.collapsed ? <div className="industrial-widget-body"><WidgetBody widget={widget} telemetry={telemetry} connectedSourceTitles={connectedSourceTitles} onUpdate={(data) => onUpdate({ data: { ...widget.data, ...data } })} onConnectData={onConnectData} onAddWidget={onAddWidget} onAddComment={onAddComment} onOpenExplorer={onOpenExplorer} onNotify={onNotify} /></div> : null}
      {menuOpen ? <div className="industrial-widget-menu" role="menu" onClick={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => { onAction("duplicate"); setMenuOpen(false); }}><Copy size={14} />Duplicate</button><button type="button" role="menuitem" onClick={() => { onAction("lock"); setMenuOpen(false); }}>{widget.locked ? <Unlock size={14} /> : <Lock size={14} />}{widget.locked ? "Unlock" : "Lock"}</button><button type="button" role="menuitem" onClick={() => { onAction("forward"); setMenuOpen(false); }}><ChevronsUp size={14} />Bring forward</button><button type="button" role="menuitem" onClick={() => { onAction("backward"); setMenuOpen(false); }}><ArrowDownToLine size={14} />Send backward</button><button type="button" role="menuitem" className="is-danger" onClick={() => { onAction("remove"); setMenuOpen(false); }}><Trash2 size={14} />Remove</button></div> : null}
      {selected && !widget.locked && !widget.collapsed ? <span className="industrial-widget-resize" aria-hidden="true" onPointerDown={onResizePointerDown} /> : null}
    </article>
  );
}
