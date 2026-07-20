import {
  AtSign,
  Check,
  ChevronRight,
  Circle,
  Copy,
  CornerDownRight,
  Link2,
  Lock,
  MessageSquare,
  PanelRightClose,
  Plus,
  Reply,
  Search,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasComment, CanvasWidget, CanvasWidgetKind, IndustrialCanvasState } from "./industrialCanvas";

export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const filtered = useMemo(() => commands.filter((command) => `${command.label} ${command.description}`.toLowerCase().includes(query.trim().toLowerCase())), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;
  return (
    <div className="industrial-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="industrial-command-palette" role="dialog" aria-modal="true" aria-label="Canvas command palette" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
        if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => filtered.length ? (index + 1) % filtered.length : 0); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => filtered.length ? (index - 1 + filtered.length) % filtered.length : 0); }
        if (event.key === "Enter" && filtered[activeIndex]) { event.preventDefault(); filtered[activeIndex].run(); onClose(); }
      }}>
        <div><Search size={17} /><input ref={inputRef} aria-label="Search commands" placeholder="Add a widget or run an action…" value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} /><kbd>Esc</kbd></div>
        <ul role="listbox" aria-label="Canvas commands">
          {filtered.map((command, index) => <li key={command.id}><button type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "is-active" : ""} onMouseEnter={() => setActiveIndex(index)} onClick={() => { command.run(); onClose(); }}><span>{command.icon}</span><div><strong>{command.label}</strong><small>{command.description}</small></div><ChevronRight size={15} /></button></li>)}
          {!filtered.length ? <li className="industrial-command-empty">No matching commands</li> : null}
        </ul>
      </section>
    </div>
  );
}

function CommentsPanel({ comments, selectedCommentId, onAdd, onUpdate, onDelete, onNavigate }: { comments: CanvasComment[]; selectedCommentId: string | null; onAdd: (body: string) => void; onUpdate: (id: string, patch: Partial<CanvasComment>) => void; onDelete: (id: string) => void; onNavigate: (comment: CanvasComment) => void }) {
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [draft, setDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const visible = comments.filter((comment) => comment.resolved === (filter === "resolved"));

  function addReply(comment: CanvasComment) {
    const body = replyDraft[comment.id]?.trim();
    if (!body) return;
    onUpdate(comment.id, { replies: [...comment.replies, { id: `${comment.id}-${Date.now()}`, author: "You", body, createdAt: new Date().toISOString() }] });
    setReplyDraft((current) => ({ ...current, [comment.id]: "" }));
  }

  return (
    <div className="industrial-comments-panel">
      <div className="industrial-comment-filter" role="tablist" aria-label="Comment filter"><button type="button" role="tab" aria-selected={filter === "open"} onClick={() => setFilter("open")}>Open <span>{comments.filter((comment) => !comment.resolved).length}</span></button><button type="button" role="tab" aria-selected={filter === "resolved"} onClick={() => setFilter("resolved")}>Resolved <span>{comments.filter((comment) => comment.resolved).length}</span></button></div>
      <form className="industrial-new-comment" onSubmit={(event) => { event.preventDefault(); if (!draft.trim()) return; onAdd(draft.trim()); setDraft(""); }}><textarea aria-label="New canvas comment" rows={3} placeholder="Add a comment. Use @ to mention someone." value={draft} onChange={(event) => setDraft(event.target.value)} /><div><AtSign size={14} /><span>Comments are saved locally</span><button type="submit" disabled={!draft.trim()}><Plus size={14} /> Add</button></div></form>
      <div className="industrial-comment-list">
        {!visible.length ? <div className="industrial-panel-empty"><MessageSquare size={22} /><strong>No {filter} comments</strong><span>{filter === "open" ? "Place a pin on the canvas to start a thread." : "Resolved discussions will appear here."}</span></div> : null}
        {visible.map((comment) => <article key={comment.id} className={selectedCommentId === comment.id ? "is-selected" : ""}>
          <header><span className="industrial-comment-avatar">YO</span><div><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></div><button type="button" aria-label="Go to comment on canvas" onClick={() => onNavigate(comment)}><CornerDownRight size={14} /></button></header>
          {editingId === comment.id ? <form onSubmit={(event) => { event.preventDefault(); if (editingBody.trim()) onUpdate(comment.id, { body: editingBody.trim() }); setEditingId(null); }}><textarea autoFocus aria-label="Edit comment" value={editingBody} onChange={(event) => setEditingBody(event.target.value)} /><button type="submit">Save</button><button type="button" onClick={() => setEditingId(null)}>Cancel</button></form> : <p>{comment.body}</p>}
          {comment.replies.map((reply) => <div className="industrial-comment-reply" key={reply.id}><Reply size={13} /><div><strong>{reply.author}</strong><p>{reply.body}</p></div></div>)}
          <div className="industrial-comment-actions"><button type="button" onClick={() => onUpdate(comment.id, { reactions: comment.reactions + 1 })}><SmilePlus size={13} /> {comment.reactions || "React"}</button><button type="button" onClick={() => onUpdate(comment.id, { resolved: !comment.resolved })}><Check size={13} /> {comment.resolved ? "Reopen" : "Resolve"}</button><button type="button" onClick={() => { setEditingId(comment.id); setEditingBody(comment.body); }}>Edit</button><button type="button" aria-label="Delete comment" onClick={() => onDelete(comment.id)}><Trash2 size={13} /></button></div>
          <div className="industrial-reply-box"><input aria-label={`Reply to ${comment.author}`} placeholder="Reply or @mention" value={replyDraft[comment.id] ?? ""} onChange={(event) => setReplyDraft((current) => ({ ...current, [comment.id]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); addReply(comment); } }} /><button type="button" aria-label="Send reply" onClick={() => addReply(comment)}><Reply size={14} /></button></div>
        </article>)}
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" min={min} max={max} value={Math.round(value)} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function PropertiesPanel({ canvas, selected, onRenameCanvas, onUpdateSelected, onConnectData }: { canvas: IndustrialCanvasState; selected: CanvasWidget[]; onRenameCanvas: (title: string) => void; onUpdateSelected: (patch: Partial<CanvasWidget>) => void; onConnectData: () => void }) {
  if (!selected.length) {
    return (
      <div className="industrial-properties-panel">
        <section><h3>Canvas</h3><label><span>Name</span><input value={canvas.title} onChange={(event) => onRenameCanvas(event.target.value)} /></label><div className="industrial-property-grid"><NumberField label="X" value={canvas.viewport.x} onChange={() => undefined} /><NumberField label="Y" value={canvas.viewport.y} onChange={() => undefined} /></div><label><span>Zoom</span><input readOnly value={`${Math.round(canvas.viewport.zoom * 100)}%`} /></label></section>
        <section><h3>Appearance</h3><div className="industrial-canvas-swatch"><i /><div><strong>Infinite dotted grid</strong><span>Graphite shell · cobalt accent</span></div></div></section>
        <div className="industrial-panel-empty"><MousePointerHint /><strong>No widget selected</strong><span>Select a widget to edit its appearance and data source.</span></div>
      </div>
    );
  }
  const widget = selected[0];
  return (
    <div className="industrial-properties-panel">
      {selected.length > 1 ? <p className="industrial-selection-summary">{selected.length} widgets selected. Shared changes apply to all.</p> : null}
      <section><h3>Widget</h3><label><span>Name</span><input value={widget.title} onChange={(event) => onUpdateSelected({ title: event.target.value })} /></label><div className="industrial-property-grid"><NumberField label="X" value={widget.x} onChange={(x) => onUpdateSelected({ x })} /><NumberField label="Y" value={widget.y} onChange={(y) => onUpdateSelected({ y })} /><NumberField label="Width" min={160} value={widget.width} onChange={(width) => onUpdateSelected({ width: Math.max(160, width) })} /><NumberField label="Height" min={90} value={widget.height} onChange={(height) => onUpdateSelected({ height: Math.max(90, height) })} /></div></section>
      <section><h3>Appearance</h3><div className="industrial-color-fields"><label><span>Background</span><input type="color" value={widget.background} onChange={(event) => onUpdateSelected({ background: event.target.value })} /></label><label><span>Border</span><input type="color" value={widget.borderColor} onChange={(event) => onUpdateSelected({ borderColor: event.target.value })} /></label></div><label><span>Opacity · {Math.round(widget.opacity * 100)}%</span><input type="range" min="0.25" max="1" step="0.05" value={widget.opacity} onChange={(event) => onUpdateSelected({ opacity: Number(event.target.value) })} /></label><button type="button" className="industrial-property-toggle" aria-pressed={widget.locked} onClick={() => onUpdateSelected({ locked: !widget.locked })}><Lock size={14} />{widget.locked ? "Locked" : "Unlocked"}<span>{widget.locked ? "On" : "Off"}</span></button></section>
      <section><h3>Data source</h3><div className="industrial-data-source-field"><Link2 size={15} /><div><strong>{widget.data.connected ? widget.data.sourceLabel ?? "Connected source" : "Not connected"}</strong><span>{widget.data.connected ? "Governed project data" : "Select a project source"}</span></div><button type="button" onClick={onConnectData}>{widget.data.connected ? "Change" : "Connect"}</button></div></section>
    </div>
  );
}

function MousePointerHint() {
  return <Circle size={22} />;
}

export function CanvasInspector({ open, tab, canvas, selected, comments, selectedCommentId, onTabChange, onClose, onRenameCanvas, onUpdateSelected, onConnectData, onAddComment, onUpdateComment, onDeleteComment, onNavigateComment }: {
  open: boolean;
  tab: "comments" | "properties";
  canvas: IndustrialCanvasState;
  selected: CanvasWidget[];
  comments: CanvasComment[];
  selectedCommentId: string | null;
  onTabChange: (tab: "comments" | "properties") => void;
  onClose: () => void;
  onRenameCanvas: (title: string) => void;
  onUpdateSelected: (patch: Partial<CanvasWidget>) => void;
  onConnectData: () => void;
  onAddComment: (body: string) => void;
  onUpdateComment: (id: string, patch: Partial<CanvasComment>) => void;
  onDeleteComment: (id: string) => void;
  onNavigateComment: (comment: CanvasComment) => void;
}) {
  return (
    <aside className={`industrial-inspector${open ? " is-open" : ""}`} aria-label="Canvas inspector">
      <header><div role="tablist" aria-label="Inspector panels"><button type="button" role="tab" aria-selected={tab === "properties"} onClick={() => onTabChange("properties")}>Properties</button><button type="button" role="tab" aria-selected={tab === "comments"} onClick={() => onTabChange("comments")}>Comments <span>{comments.filter((comment) => !comment.resolved).length}</span></button></div><button type="button" aria-label="Close inspector" onClick={onClose}><PanelRightClose size={17} /></button></header>
      {tab === "properties" ? <PropertiesPanel canvas={canvas} selected={selected} onRenameCanvas={onRenameCanvas} onUpdateSelected={onUpdateSelected} onConnectData={onConnectData} /> : <CommentsPanel comments={comments} selectedCommentId={selectedCommentId} onAdd={onAddComment} onUpdate={onUpdateComment} onDelete={onDeleteComment} onNavigate={onNavigateComment} />}
    </aside>
  );
}

export function CanvasContextMenu({ x, y, canPaste, selectionCount, onAdd, onPaste, onDuplicate, onGroup, onForward, onBackward, onClose }: { x: number; y: number; canPaste: boolean; selectionCount: number; onAdd: (kind: CanvasWidgetKind) => void; onPaste: () => void; onDuplicate: () => void; onGroup: () => void; onForward: () => void; onBackward: () => void; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [onClose]);
  return <div className="industrial-context-menu" role="menu" style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => onAdd("note")}><Plus size={14} />Add note</button><button type="button" role="menuitem" onClick={() => onAdd("asset")}><Plus size={14} />Add asset</button><button type="button" role="menuitem" disabled={!canPaste} onClick={onPaste}><Copy size={14} />Paste</button><hr /><button type="button" role="menuitem" disabled={!selectionCount} onClick={onDuplicate}>Duplicate selection</button><button type="button" role="menuitem" disabled={selectionCount < 2} onClick={onGroup}>Group in frame</button><button type="button" role="menuitem" disabled={!selectionCount} onClick={onForward}>Bring forward</button><button type="button" role="menuitem" disabled={!selectionCount} onClick={onBackward}>Send backward</button></div>;
}

export function ConfirmResetDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  if (!open) return null;
  return <div className="industrial-modal-backdrop" role="presentation"><dialog open className="industrial-confirm-dialog" aria-labelledby="reset-title" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}><button type="button" aria-label="Close reset dialog" onClick={onCancel}><X size={16} /></button><span><Trash2 size={20} /></span><h2 id="reset-title">Reset this canvas?</h2><p>All local widgets, comments and layout changes will be removed. This cannot be undone.</p><footer><button type="button" onClick={onCancel}>Cancel</button><button type="button" onClick={onConfirm}>Reset canvas</button></footer></dialog></div>;
}
