import {
  Bell,
  Bot,
  Box,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  Clock3,
  Cuboid,
  FileText,
  Files,
  Frame,
  Hand,
  History,
  Home,
  Image,
  Link2,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  MousePointer2,
  Network,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Redo2,
  Search,
  Settings,
  Share2,
  Sparkles,
  StickyNote,
  Type,
  Undo2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrandLogo } from "./BrandLogo";
import type { CanvasTool, CanvasWidgetKind } from "./industrialCanvas";

interface CanvasNavigationProps {
  collapsed: boolean;
  onToggle: () => void;
  onOpenExplorer: () => void;
  onOpenCommand: () => void;
  onAdd: (kind: CanvasWidgetKind) => void;
  onOpenInspector: (tab: "comments" | "properties") => void;
  onHelp: () => void;
  onNotify: (message: string) => void;
}

const navItems = [
  { label: "Home", icon: Home, action: "home" },
  { label: "Search", icon: Search, action: "search" },
  { label: "Data Explorer", icon: Network, action: "explorer" },
  { label: "Canvas", icon: PanelsTopLeft, action: "canvas" },
  { label: "Assets", icon: Box, action: "asset" },
  { label: "Documents", icon: Files, action: "document" },
  { label: "Settings", icon: Settings, action: "settings" },
  { label: "Help", icon: CircleHelp, action: "help" },
] as const;

export function CanvasNavigation({ collapsed, onToggle, onOpenExplorer, onOpenCommand, onAdd, onOpenInspector, onHelp, onNotify }: CanvasNavigationProps) {
  function activate(action: typeof navItems[number]["action"]) {
    if (action === "home" || action === "explorer") onOpenExplorer();
    else if (action === "search") onOpenCommand();
    else if (action === "asset") onAdd("asset");
    else if (action === "document") onAdd("document");
    else if (action === "settings") onOpenInspector("properties");
    else if (action === "help") onHelp();
    else onNotify("Canvas is already open");
  }
  return (
    <aside className={`industrial-nav${collapsed ? " is-collapsed" : ""}`} aria-label="Primary navigation">
      <div className="industrial-nav-brand"><BrandLogo variant={collapsed ? "icon" : "full"} /></div>
      <nav>{navItems.map(({ label, icon: Icon, action }) => <button key={label} type="button" className={action === "canvas" ? "is-active" : ""} aria-label={action === "explorer" ? "Open Data Fusion Explorer" : undefined} aria-current={action === "canvas" ? "page" : undefined} title={collapsed ? label : undefined} onClick={() => activate(action)}><Icon size={20} strokeWidth={1.7} /><span>{label}</span></button>)}</nav>
      <button className="industrial-nav-collapse" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={onToggle}>{collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}<span>{collapsed ? "" : "Collapse"}</span></button>
    </aside>
  );
}

export function CanvasHeader({ title, saveState, canUndo, canRedo, inspectorOpen, onRename, onUndo, onRedo, onOpenHistory, onOpenComments, onToggleInspector, onOpenCommand, onReset, onNotify }: {
  title: string;
  saveState: "saving" | "saved";
  canUndo: boolean;
  canRedo: boolean;
  inspectorOpen: boolean;
  onRename: (title: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenHistory: () => void;
  onOpenComments: () => void;
  onToggleInspector: () => void;
  onOpenCommand: () => void;
  onReset: () => void;
  onNotify: (message: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const close = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [moreOpen]);
  const shareCanvas = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      onNotify("Share link copied for this local canvas");
    } catch {
      onNotify("Copy the address bar URL to share this local canvas");
    }
  };
  return (
    <header className="industrial-header">
      <div className="industrial-breadcrumb"><span>Canvas</span><ChevronDown size={13} /><input aria-label="Canvas name" value={title} onChange={(event) => onRename(event.target.value)} onBlur={(event) => { if (!event.target.value.trim()) onRename("Untitled canvas"); }} /></div>
      <div className="industrial-header-history"><button type="button" aria-label="Undo" disabled={!canUndo} onClick={onUndo}><Undo2 size={17} /></button><button type="button" aria-label="Redo" disabled={!canRedo} onClick={onRedo}><Redo2 size={17} /></button><span className={`industrial-save-status is-${saveState}`}>{saveState === "saving" ? <LoaderCircle size={14} /> : <Check size={14} />}{saveState === "saving" ? "Saving…" : "Saved"}</span><button type="button" aria-label="History" onClick={onOpenHistory}><History size={17} /></button><div className="industrial-more" ref={moreRef}><button type="button" aria-label="More canvas actions" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={18} /></button>{moreOpen ? <div role="menu"><button type="button" role="menuitem" onClick={() => { onOpenCommand(); setMoreOpen(false); }}>Open command palette <kbd>Ctrl K</kbd></button><button type="button" role="menuitem" onClick={() => { onNotify("Canvas state is stored locally in this browser"); setMoreOpen(false); }}>Storage details</button><button type="button" role="menuitem" className="is-danger" onClick={() => { onReset(); setMoreOpen(false); }}>Reset canvas</button></div> : null}</div></div>
      <div className="industrial-header-collaboration"><div className="industrial-collaborators" aria-label="3 collaborators"><span>YO</span><span>AK</span><span>+1</span></div><button type="button" aria-label="Notifications" onClick={() => onNotify("You are all caught up")}><Bell size={17} /></button><button type="button" aria-label="Comments" onClick={onOpenComments}><MessageSquare size={17} /></button><button type="button" aria-label="Share canvas" onClick={() => { void shareCanvas(); }}><Share2 size={17} /></button><button type="button" aria-label={inspectorOpen ? "Close inspector" : "Open inspector"} aria-expanded={inspectorOpen} onClick={onToggleInspector}>{inspectorOpen ? <PanelRight size={17} /> : <PanelLeft size={17} />}</button></div>
    </header>
  );
}

const toolItems: Array<{ label: string; icon: LucideIcon; tool?: CanvasTool; kind?: CanvasWidgetKind }> = [
  { label: "Select", icon: MousePointer2, tool: "select" },
  { label: "Hand / Pan", icon: Hand, tool: "hand" },
  { label: "Add text", icon: Type, kind: "text" },
  { label: "Add note", icon: StickyNote, kind: "note" },
  { label: "Add image", icon: Image, kind: "image" },
  { label: "Add document", icon: FileText, kind: "document" },
  { label: "Add chart", icon: ChartNoAxesCombined, kind: "chart" },
  { label: "Add time series", icon: Clock3, kind: "timeSeries" },
  { label: "Add 3D viewer", icon: Cuboid, kind: "model3d" },
  { label: "Add asset card", icon: Box, kind: "asset" },
  { label: "AI question card", icon: Bot, kind: "ai" },
  { label: "Connector", icon: Link2, tool: "connector" },
  { label: "Frame / Section", icon: Frame, kind: "frame" },
  { label: "Comment", icon: MessageSquare, tool: "comment" },
];

export function CanvasToolRail({ activeTool, onTool, onAdd }: { activeTool: CanvasTool; onTool: (tool: CanvasTool) => void; onAdd: (kind: CanvasWidgetKind) => void }) {
  return (
    <div className="industrial-tool-rail" role="toolbar" aria-label="Canvas tools">
      {toolItems.map(({ label, icon: Icon, tool, kind }, index) => <button key={label} type="button" className={`${tool && activeTool === tool ? "is-active" : ""}${index === 2 || index === 11 ? " is-separated" : ""}`} aria-label={label} aria-pressed={tool ? activeTool === tool : undefined} title={label} onClick={() => tool ? onTool(tool) : kind ? onAdd(kind) : undefined}><Icon size={17} /></button>)}
    </div>
  );
}

export function CanvasHistoryPopover({ open, entries, onClose, onRestore }: { open: boolean; entries: Array<{ id: string; label: string; at: string }>; onClose: () => void; onRestore: (index: number) => void }) {
  if (!open) return null;
  return <section className="industrial-history-popover" aria-label="Canvas history"><header><div><strong>History</strong><span>Local changes in this session</span></div><button type="button" aria-label="Close history" onClick={onClose}><PanelRight size={16} /></button></header>{entries.length ? <ol>{entries.map((entry, index) => <li key={entry.id}><span><Clock3 size={14} /></span><div><strong>{entry.label}</strong><time>{entry.at}</time></div><button type="button" onClick={() => onRestore(index)}>Restore</button></li>)}</ol> : <p>No local changes yet.</p>}</section>;
}
