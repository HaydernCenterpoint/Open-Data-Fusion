import {
  Activity,
  Ban,
  Check,
  CircleAlert,
  Cuboid,
  FileSearch,
  Gauge,
  GitCompareArrows,
  Link2,
  LockKeyhole,
  Play,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  approvePlatformWritebackRequest,
  createPlatformDiagramExtraction,
  createPlatformMatchingEvaluation,
  createPlatformSpatialLink,
  createPlatformWritebackRequest,
  executePlatformWritebackRequest,
  listPlatformDiagramExtractions,
  listPlatformMatchingEvaluations,
  listPlatformSpatialLinks,
  listPlatformWritebackRequests,
  reviewPlatformSpatialLink,
} from "../lib/api";
import type {
  CursorPage,
  PlatformContext,
  PlatformDiagramExtraction,
  PlatformMatchGroundTruth,
  PlatformMatchingEvaluation,
  PlatformMatchPrediction,
  PlatformSpatialLink,
  PlatformWritebackRequest,
  PlatformWritebackRisk,
} from "../types";
import { platformIssue, type PlatformIssue } from "./PlatformWorkspaces";
import { formatDate, LoadState, SectionHeading } from "./SectionWorkspaces";

const ADVANCED_PAGE_SIZE = 20;
const IDENTITY_TRANSFORM = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

interface PageState<T> {
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  issue: PlatformIssue | null;
}

function emptyPage<T>(): PageState<T> {
  return { items: [], nextCursor: null, loading: true, loadingMore: false, issue: null };
}

function readyPage<T>(page: CursorPage<T>): PageState<T> {
  return { items: page.items, nextCursor: page.nextCursor, loading: false, loadingMore: false, issue: null };
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

function upsertFirst<T extends { id: string }>(current: T[], item: T): T[] {
  return [item, ...current.filter((existing) => existing.id !== item.id)];
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function parseObject(text: string, label: string): Record<string, unknown> {
  const parsed = parseJson(text, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function AdvancedIssueNotice({ issue, onRetry }: { issue: PlatformIssue; onRetry?: () => void }) {
  const Icon = issue.kind === "unauthorized" ? LockKeyhole : issue.kind === "forbidden" ? ShieldAlert : CircleAlert;
  return (
    <div className={`platform-issue is-${issue.kind}`} role="alert">
      <Icon size={19} />
      <span>{issue.message}</span>
      {onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button> : null}
    </div>
  );
}

function AdvancedLoadMore({ cursor, loading, onLoad }: { cursor: string | null; loading: boolean; onLoad: () => void }) {
  return cursor ? <button className="section-load-more" type="button" disabled={loading} onClick={onLoad}>{loading ? "Loading…" : "Load more"}</button> : null;
}

function AdvancedEmpty({ children }: { children: React.ReactNode }) {
  return <p className="advanced-empty">{children}</p>;
}

function ContextRequired() {
  return <LoadState message="Select an accessible tenant and project to load this governed surface." />;
}

function ActionStatus({ message }: { message: string }) {
  return message ? <p className="advanced-action-status" role="status"><Check size={15} /> {message}</p> : null;
}

function WritebackActionStatus({ message, tone }: { message: string; tone: "neutral" | "blocked" | "confirmed" }) {
  if (!message) return null;
  const Icon = tone === "confirmed" ? ShieldCheck : tone === "blocked" ? Ban : Activity;
  return <p className={`advanced-action-status writeback-action-status is-${tone}`} role="status"><Icon size={15} /> {message}</p>;
}

function ExtractionCard({ extraction }: { extraction: PlatformDiagramExtraction }) {
  return (
    <li className="advanced-record-card extraction-card">
      <header><div><strong>{extraction.documentExternalId}</strong><span>{extraction.id}</span></div><span>{extraction.tags.length} tags</span></header>
      <div className="tag-cloud" aria-label={`Extracted tags for ${extraction.documentExternalId}`}>
        {extraction.tags.map((tag) => <span className={`diagram-tag is-${tag.kind}`} key={`${tag.tag}:${tag.page ?? 0}`}><strong>{tag.tag}</strong><small>{tag.kind} · {Math.round(tag.confidence * 100)}%{tag.page ? ` · p${tag.page}` : ""}</small></span>)}
      </div>
      {extraction.tags.length === 0 ? <AdvancedEmpty>No recognized equipment, instrument, or line tags.</AdvancedEmpty> : null}
      <footer><span>SHA-256 <code title={extraction.textSha256}>{extraction.textSha256.slice(0, 16)}…</code></span><span>{extraction.createdBy} · {formatDate(extraction.createdAt)}</span></footer>
    </li>
  );
}

export function DiagramsWorkspace({ context }: { context: PlatformContext | null }) {
  const [records, setRecords] = useState<PageState<PlatformDiagramExtraction>>(() => emptyPage());
  const [reloadToken, setReloadToken] = useState(0);
  const [documentExternalId, setDocumentExternalId] = useState("");
  const [page, setPage] = useState("");
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    if (!context) { setRecords({ ...emptyPage<PlatformDiagramExtraction>(), loading: false }); return undefined; }
    const controller = new AbortController();
    setRecords(emptyPage());
    listPlatformDiagramExtractions(context, { limit: ADVANCED_PAGE_SIZE }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setRecords(readyPage(result)); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setRecords({ items: [], nextCursor: null, loading: false, loadingMore: false, issue: platformIssue(error, "Diagram extractions could not be loaded") }); });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context) return;
    setFormError(""); setActionIssue(null); setActionMessage("");
    const pageNumber = page ? Number(page) : undefined;
    if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1)) { setFormError("Page must be a positive whole number."); return; }
    setSubmitting(true);
    try {
      const extraction = await createPlatformDiagramExtraction(context, { documentExternalId: documentExternalId.trim(), text, ...(pageNumber ? { page: pageNumber } : {}) });
      setRecords((state) => ({ ...state, items: upsertFirst(state.items, extraction) }));
      setActionMessage(`Extraction ${extraction.id} recorded with ${extraction.tags.length} tag${extraction.tags.length === 1 ? "" : "s"}.`);
      setText("");
    } catch (error) { setActionIssue(platformIssue(error, "Diagram text could not be extracted")); }
    finally { setSubmitting(false); }
  }

  async function loadMore() {
    if (!context || !records.nextCursor || records.loadingMore) return;
    setRecords((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const next = await listPlatformDiagramExtractions(context, { limit: ADVANCED_PAGE_SIZE, cursor: records.nextCursor });
      setRecords((state) => ({ ...state, items: mergeById(state.items, next.items), nextCursor: next.nextCursor, loadingMore: false }));
    } catch (error) { setRecords((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More diagram extractions could not be loaded") })); }
  }

  return (
    <main className="section-workspace platform-workspace advanced-workspace">
      <SectionHeading eyebrow="Diagram intelligence" title="Diagrams" description="Extract governed equipment, instrument, and line tags from P&ID text without persisting the raw drawing text." icon={<FileSearch size={24} />} />
      {!context ? <ContextRequired /> : <div className="advanced-two-column">
        <section className="advanced-form-panel">
          <header><ScanLine size={18} /><div><h2>Extract P&ID tags</h2><p>The API stores derived tags and a SHA-256 fingerprint, not the submitted text.</p></div></header>
          <form className="advanced-form" onSubmit={(event) => void submit(event)}>
            <label>Document external ID<input required value={documentExternalId} onChange={(event) => setDocumentExternalId(event.target.value)} placeholder="PID-001" /></label>
            <label>Page (optional)<input type="number" min="1" step="1" value={page} onChange={(event) => setPage(event.target.value)} placeholder="2" /></label>
            <label className="form-span">P&ID text<textarea required rows={8} value={text} onChange={(event) => setText(event.target.value)} placeholder={'Pump P-201 discharge is measured by PT-2001 on line 6"-CW-201.'} /></label>
            {formError ? <p className="advanced-form-error" role="alert">{formError}</p> : null}
            <button className="advanced-primary-action" type="submit" disabled={submitting || !documentExternalId.trim() || !text.trim()}><ScanLine size={15} /> {submitting ? "Extracting…" : "Extract tags"}</button>
          </form>
          {actionIssue ? <AdvancedIssueNotice issue={actionIssue} /> : null}<ActionStatus message={actionMessage} />
        </section>
        <section className="advanced-list-panel"><header><div><h2>Extraction history</h2><p>{records.items.length} loaded</p></div><RefreshCw size={17} /></header>{records.loading ? <LoadState message="Loading diagram extractions…" /> : null}{records.issue ? <AdvancedIssueNotice issue={records.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!records.loading && !records.issue && records.items.length === 0 ? <AdvancedEmpty>No diagram extractions exist in this project.</AdvancedEmpty> : null}<ol className="advanced-record-list">{records.items.map((record) => <ExtractionCard key={record.id} extraction={record} />)}</ol><AdvancedLoadMore cursor={records.nextCursor} loading={records.loadingMore} onLoad={() => void loadMore()} /></section>
      </div>}
    </main>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="matching-metric"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>;
}

function MatchingDetails({ evaluation }: { evaluation: PlatformMatchingEvaluation }) {
  const metrics = evaluation.evaluation;
  return (
    <section className="matching-details" aria-label={`Matching evaluation ${evaluation.id}`}>
      <header><div><h2>Evaluation dashboard</h2><p>{evaluation.id} · threshold {evaluation.threshold.toFixed(2)} · {formatDate(evaluation.createdAt)}</p></div><span className="proposal-policy"><ShieldCheck size={14} /> Outputs remain proposed</span></header>
      <div className="matching-metrics">
        <MetricCard label="Precision" value={`${Math.round(metrics.precision * 100)}%`} detail={`${metrics.truePositives} TP · ${metrics.falsePositives} FP`} />
        <MetricCard label="Recall" value={`${Math.round(metrics.recall * 100)}%`} detail={`${metrics.truePositives} TP · ${metrics.falseNegatives} FN`} />
        <MetricCard label="F1 score" value={`${Math.round(metrics.f1 * 100)}%`} detail={`${metrics.evaluatedPairs} evaluated pairs`} />
      </div>
      <div className="confusion-strip"><span><strong>{metrics.truePositives}</strong> true positive</span><span><strong>{metrics.falsePositives}</strong> false positive</span><span><strong>{metrics.falseNegatives}</strong> false negative</span></div>
      <div className="proposal-table-wrap"><table className="proposal-table"><caption>{evaluation.proposals.length} ranked outputs; none are automatically accepted</caption><thead><tr><th>Source</th><th>Target</th><th>Score</th><th>Governance state</th></tr></thead><tbody>{evaluation.proposals.map((proposal, index) => <tr key={`${proposal.sourceExternalId}:${proposal.targetExternalId}:${index}`}><td>{proposal.sourceExternalId}</td><td>{proposal.targetExternalId}</td><td>{Math.round(proposal.score * 100)}%</td><td><span className="status-chip status-proposed">{proposal.state}</span></td></tr>)}</tbody></table></div>
      {evaluation.proposals.length === 0 ? <AdvancedEmpty>No predictions were submitted for this evaluation.</AdvancedEmpty> : null}
    </section>
  );
}

export function MatchingWorkspace({ context }: { context: PlatformContext | null }) {
  const [records, setRecords] = useState<PageState<PlatformMatchingEvaluation>>(() => emptyPage());
  const [selectedId, setSelectedId] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [threshold, setThreshold] = useState("0.8");
  const [predictionsText, setPredictionsText] = useState('[]');
  const [truthText, setTruthText] = useState('[]');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    setSelectedId("");
    if (!context) { setRecords({ ...emptyPage<PlatformMatchingEvaluation>(), loading: false }); return undefined; }
    const controller = new AbortController(); setRecords(emptyPage());
    listPlatformMatchingEvaluations(context, { limit: ADVANCED_PAGE_SIZE }, controller.signal)
      .then((result) => { if (controller.signal.aborted) return; setRecords(readyPage(result)); setSelectedId(result.items[0]?.id ?? ""); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setRecords({ items: [], nextCursor: null, loading: false, loadingMore: false, issue: platformIssue(error, "Matching evaluations could not be loaded") }); });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  const selected = records.items.find((record) => record.id === selectedId) ?? null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!context) return;
    setFormError(""); setActionIssue(null); setActionMessage("");
    try {
      const parsedPredictions = parseJson(predictionsText, "Predictions");
      const parsedTruth = parseJson(truthText, "Ground truth");
      if (!Array.isArray(parsedPredictions)) throw new Error("Predictions must be a JSON array.");
      if (!Array.isArray(parsedTruth)) throw new Error("Ground truth must be a JSON array.");
      const thresholdNumber = Number(threshold);
      if (!Number.isFinite(thresholdNumber) || thresholdNumber < 0 || thresholdNumber > 1) throw new Error("Threshold must be between 0 and 1.");
      setSubmitting(true);
      const evaluation = await createPlatformMatchingEvaluation(context, { threshold: thresholdNumber, predictions: parsedPredictions as PlatformMatchPrediction[], truth: parsedTruth as PlatformMatchGroundTruth[] });
      setRecords((state) => ({ ...state, items: upsertFirst(state.items, evaluation) }));
      setSelectedId(evaluation.id);
      setActionMessage(`Evaluation ${evaluation.id} recorded; all ${evaluation.proposals.length} outputs remain proposed.`);
    } catch (error) {
      if (error instanceof Error && !("status" in error)) setFormError(error.message);
      else setActionIssue(platformIssue(error, "Matching evaluation could not be created"));
    } finally { setSubmitting(false); }
  }

  async function loadMore() {
    if (!context || !records.nextCursor || records.loadingMore) return;
    setRecords((state) => ({ ...state, loadingMore: true, issue: null }));
    try { const next = await listPlatformMatchingEvaluations(context, { limit: ADVANCED_PAGE_SIZE, cursor: records.nextCursor }); setRecords((state) => ({ ...state, items: mergeById(state.items, next.items), nextCursor: next.nextCursor, loadingMore: false })); }
    catch (error) { setRecords((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More matching evaluations could not be loaded") })); }
  }

  return (
    <main className="section-workspace platform-workspace advanced-workspace">
      <SectionHeading eyebrow="Measured contextualization" title="Matching" description="Evaluate prediction quality with precision, recall, and F1 while keeping every ranked output in a governed proposed state." icon={<GitCompareArrows size={24} />} />
      {!context ? <ContextRequired /> : <>
        <section className="advanced-form-panel matching-form-panel"><header><Gauge size={18} /><div><h2>Run evaluation</h2><p>Predictions and ground truth are evaluated server-side. No result is auto-accepted.</p></div></header><form className="advanced-form matching-form" onSubmit={(event) => void submit(event)}><label>Decision threshold<input type="number" min="0" max="1" step="0.01" required value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label><label className="form-span">Predictions JSON<textarea rows={4} required value={predictionsText} onChange={(event) => setPredictionsText(event.target.value)} /></label><label className="form-span">Ground truth JSON<textarea rows={4} required value={truthText} onChange={(event) => setTruthText(event.target.value)} /></label>{formError ? <p className="advanced-form-error" role="alert">{formError}</p> : null}<button className="advanced-primary-action" type="submit" disabled={submitting}><GitCompareArrows size={15} /> {submitting ? "Evaluating…" : "Evaluate matches"}</button></form>{actionIssue ? <AdvancedIssueNotice issue={actionIssue} /> : null}<ActionStatus message={actionMessage} /></section>
        <div className="matching-layout"><section className="evaluation-index"><header><h2>Evaluations</h2><span>{records.items.length} loaded</span></header>{records.loading ? <LoadState message="Loading evaluations…" /> : null}{records.issue ? <AdvancedIssueNotice issue={records.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!records.loading && !records.issue && records.items.length === 0 ? <AdvancedEmpty>No matching evaluations exist in this project.</AdvancedEmpty> : null}<ol>{records.items.map((record) => <li key={record.id}><button type="button" className={record.id === selectedId ? "is-selected" : ""} aria-pressed={record.id === selectedId} onClick={() => setSelectedId(record.id)}><strong>{record.id}</strong><span>F1 {Math.round(record.evaluation.f1 * 100)}% · {record.proposals.length} proposed</span><small>{formatDate(record.createdAt)}</small></button></li>)}</ol><AdvancedLoadMore cursor={records.nextCursor} loading={records.loadingMore} onLoad={() => void loadMore()} /></section>{selected ? <MatchingDetails evaluation={selected} /> : <section className="matching-details"><AdvancedEmpty>Select an evaluation to inspect its governed output.</AdvancedEmpty></section>}</div>
      </>}
    </main>
  );
}

function scenePoint(link: PlatformSpatialLink, index: number): { x: number; y: number } {
  const tx = Number(link.transform[12] ?? 0); const ty = Number(link.transform[13] ?? 0); const tz = Number(link.transform[14] ?? 0);
  if (Math.abs(tx) + Math.abs(ty) + Math.abs(tz) > 0.001) return { x: Math.max(70, Math.min(510, 290 + tx * 8 - ty * 5)), y: Math.max(55, Math.min(275, 165 + tx * 2 + ty * 3 - tz * 7)) };
  const seed = [...link.assetExternalId].reduce((total, character) => total + character.charCodeAt(0), 0);
  return { x: 110 + ((seed * 37 + index * 89) % 380), y: 92 + ((seed * 19 + index * 61) % 145) };
}

function IsometricPlantScene({ links, selectedId, onSelect }: { links: PlatformSpatialLink[]; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <svg className="spatial-scene" viewBox="0 0 580 330" role="img" aria-labelledby="spatial-scene-title spatial-scene-desc">
      <title id="spatial-scene-title">Isometric plant spatial-link review scene</title><desc id="spatial-scene-desc">A lightweight schematic with selectable markers for project asset links.</desc>
      <defs><linearGradient id="deck-fill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#e8f0f7" /><stop offset="1" stopColor="#cbd9e4" /></linearGradient></defs>
      <polygon points="55,235 270,110 530,215 310,315" fill="url(#deck-fill)" stroke="#8ca2b3" strokeWidth="2" />
      <polygon points="88,217 267,126 490,216 309,292" fill="#f9fbfd" stroke="#b6c6d2" strokeWidth="1.5" />
      <g fill="none" stroke="#758b9b" strokeWidth="6" strokeLinecap="round"><path d="M125 215 L245 150 L402 213" /><path d="M221 255 L345 190 L465 239" /></g>
      <g><ellipse cx="190" cy="191" rx="34" ry="16" fill="#d7e4ed" stroke="#6e8798" /><path d="M156 191v-52c0-9 15-16 34-16s34 7 34 16v52" fill="#e8f1f6" stroke="#6e8798" /><ellipse cx="190" cy="139" rx="34" ry="16" fill="#f6fafc" stroke="#6e8798" /></g>
      <g><rect x="337" y="135" width="75" height="76" rx="7" fill="#dde9f1" stroke="#6e8798" /><path d="M337 155h75M354 135v76M394 135v76" stroke="#9aafbd" /></g>
      <g><ellipse cx="430" cy="174" rx="24" ry="11" fill="#cfe0ea" stroke="#6e8798" /><path d="M406 174v-42c0-7 11-11 24-11s24 4 24 11v42" fill="#e6eff5" stroke="#6e8798" /><ellipse cx="430" cy="132" rx="24" ry="11" fill="#f5f9fb" stroke="#6e8798" /></g>
      {links.map((link, index) => { const point = scenePoint(link, index); const selected = link.id === selectedId; return <g aria-hidden="true" className={`spatial-scene-marker is-${link.reviewState}${selected ? " is-selected" : ""}`} key={link.id} onClick={() => onSelect(link.id)}><circle cx={point.x} cy={point.y} r={selected ? 15 : 12} /><path d={`M${point.x} ${point.y + 12}v18`} /><text x={point.x + 18} y={point.y + 4}>{link.assetExternalId}</text></g>; })}
    </svg>
  );
}

function TransformMatrix({ values }: { values: number[] }) {
  return <div className="transform-matrix" aria-label="4 by 4 spatial transform">{Array.from({ length: 16 }, (_, index) => <code key={index}>{Number(values[index] ?? 0).toFixed(2)}</code>)}</div>;
}

export function SpatialWorkspace({ context }: { context: PlatformContext | null }) {
  const [links, setLinks] = useState<PageState<PlatformSpatialLink>>(() => emptyPage());
  const [selectedId, setSelectedId] = useState(""); const [reloadToken, setReloadToken] = useState(0);
  const [assetId, setAssetId] = useState(""); const [sceneId, setSceneId] = useState(""); const [nodeId, setNodeId] = useState("");
  const [confidence, setConfidence] = useState("0.9"); const [transformText, setTransformText] = useState(JSON.stringify(IDENTITY_TRANSFORM));
  const [reviewComment, setReviewComment] = useState(""); const [busy, setBusy] = useState("");
  const [formError, setFormError] = useState(""); const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null); const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    setSelectedId(""); if (!context) { setLinks({ ...emptyPage<PlatformSpatialLink>(), loading: false }); return undefined; }
    const controller = new AbortController(); setLinks(emptyPage());
    listPlatformSpatialLinks(context, { limit: ADVANCED_PAGE_SIZE }, controller.signal)
      .then((result) => { if (controller.signal.aborted) return; setLinks(readyPage(result)); setSelectedId(result.items[0]?.id ?? ""); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setLinks({ items: [], nextCursor: null, loading: false, loadingMore: false, issue: platformIssue(error, "Spatial links could not be loaded") }); });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  const selected = links.items.find((link) => link.id === selectedId) ?? null;

  async function propose(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!context) return; setFormError(""); setActionIssue(null); setActionMessage("");
    try {
      const parsed = parseJson(transformText, "Transform");
      if (!Array.isArray(parsed) || parsed.length !== 16 || parsed.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("Transform must be a JSON array of 16 finite numbers.");
      const confidenceNumber = Number(confidence); if (!Number.isFinite(confidenceNumber) || confidenceNumber < 0 || confidenceNumber > 1) throw new Error("Confidence must be between 0 and 1.");
      setBusy("create"); const created = await createPlatformSpatialLink(context, { assetExternalId: assetId.trim(), sceneExternalId: sceneId.trim(), nodeExternalId: nodeId.trim(), transform: parsed as number[], confidence: confidenceNumber });
      setLinks((state) => ({ ...state, items: upsertFirst(state.items, created) })); setSelectedId(created.id); setActionMessage(`Spatial link ${created.id} recorded as proposed.`);
    } catch (error) { if (error instanceof Error && !("status" in error)) setFormError(error.message); else setActionIssue(platformIssue(error, "Spatial link could not be proposed")); }
    finally { setBusy(""); }
  }

  async function review(decision: "accepted" | "rejected") {
    if (!context || !selected) return; setBusy(`review:${selected.id}`); setActionIssue(null); setActionMessage("");
    try { const updated = await reviewPlatformSpatialLink(context, selected.id, { decision, ...(reviewComment.trim() ? { comment: reviewComment.trim() } : {}) }); setLinks((state) => ({ ...state, items: state.items.map((item) => item.id === updated.id ? updated : item) })); setReviewComment(""); setActionMessage(`Spatial link ${updated.id} is ${updated.reviewState}.`); }
    catch (error) { setActionIssue(platformIssue(error, "Spatial-link review could not be saved")); }
    finally { setBusy(""); }
  }

  async function loadMore() {
    if (!context || !links.nextCursor || links.loadingMore) return; setLinks((state) => ({ ...state, loadingMore: true, issue: null }));
    try { const next = await listPlatformSpatialLinks(context, { limit: ADVANCED_PAGE_SIZE, cursor: links.nextCursor }); setLinks((state) => ({ ...state, items: mergeById(state.items, next.items), nextCursor: next.nextCursor, loadingMore: false })); }
    catch (error) { setLinks((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More spatial links could not be loaded") })); }
  }

  return (
    <main className="section-workspace platform-workspace advanced-workspace">
      <SectionHeading eyebrow="Spatial contextualization" title="Spatial" description="Review asset-to-scene links against a responsive isometric plant schematic; every new link starts proposed." icon={<Cuboid size={24} />} />
      {!context ? <ContextRequired /> : <>
        <section className="spatial-stage"><header><div><h2>North Plant scene review</h2><p>{links.items.length} governed asset link{links.items.length === 1 ? "" : "s"}</p></div><span><Cuboid size={15} /> Lightweight schematic · no 3D plugin</span></header>{links.loading ? <LoadState message="Loading spatial links…" /> : <IsometricPlantScene links={links.items} selectedId={selectedId} onSelect={setSelectedId} />}{!links.loading && links.items.length > 0 ? <div className="spatial-link-selector" aria-label="Spatial scene markers"><span>Scene markers</span><div>{links.items.map((link) => <button type="button" key={link.id} className={link.id === selectedId ? "is-selected" : ""} aria-pressed={link.id === selectedId} onClick={() => setSelectedId(link.id)}><strong>{link.assetExternalId}</strong><small>{link.reviewState} · {Math.round(link.confidence * 100)}%</small></button>)}</div></div> : null}{links.issue ? <AdvancedIssueNotice issue={links.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!links.loading && !links.issue && links.items.length === 0 ? <AdvancedEmpty>No spatial links exist. Propose one below to begin review.</AdvancedEmpty> : null}<AdvancedLoadMore cursor={links.nextCursor} loading={links.loadingMore} onLoad={() => void loadMore()} /></section>
        <div className="spatial-controls"><section className="advanced-form-panel"><header><Link2 size={18} /><div><h2>Propose asset link</h2><p>The server validates a complete 4×4 transform and always creates a proposed link.</p></div></header><form className="advanced-form" onSubmit={(event) => void propose(event)}><label>Asset external ID<input required value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="P-201" /></label><label>Scene external ID<input required value={sceneId} onChange={(event) => setSceneId(event.target.value)} placeholder="plant-area-3d" /></label><label>Node external ID<input required value={nodeId} onChange={(event) => setNodeId(event.target.value)} placeholder="node-p201" /></label><label>Confidence<input type="number" min="0" max="1" step="0.01" required value={confidence} onChange={(event) => setConfidence(event.target.value)} /></label><label className="form-span">4×4 transform JSON<textarea rows={4} required value={transformText} onChange={(event) => setTransformText(event.target.value)} /></label>{formError ? <p className="advanced-form-error" role="alert">{formError}</p> : null}<button className="advanced-primary-action" type="submit" disabled={busy === "create"}><Link2 size={15} /> {busy === "create" ? "Proposing…" : "Propose link"}</button></form></section>
          <section className="spatial-review-panel"><header><h2>Selected link</h2>{selected ? <span className={`status-chip status-${selected.reviewState}`}>{selected.reviewState}</span> : null}</header>{selected ? <><div className="spatial-link-route"><strong>{selected.assetExternalId}</strong><Link2 size={16} /><span>{selected.sceneExternalId} / {selected.nodeExternalId}</span></div><dl><div><dt>Confidence</dt><dd>{Math.round(selected.confidence * 100)}%</dd></div><div><dt>Created by</dt><dd>{selected.createdBy}</dd></div><div><dt>Reviewed by</dt><dd>{selected.reviewedBy ?? "Not reviewed"}</dd></div></dl><TransformMatrix values={selected.transform} />{selected.reviewState === "proposed" ? <div className="spatial-review-actions"><label>Review comment<textarea rows={3} value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} placeholder="Optional review evidence" /></label><div><button type="button" disabled={busy === `review:${selected.id}`} onClick={() => void review("accepted")}><Check size={14} /> Accept link</button><button type="button" disabled={busy === `review:${selected.id}`} onClick={() => void review("rejected")}><X size={14} /> Reject link</button></div></div> : <p className="review-complete"><ShieldCheck size={15} /> Review is immutable: {selected.reviewState}{selected.reviewComment ? ` · ${selected.reviewComment}` : ""}</p>}</> : <AdvancedEmpty>Select a scene marker or propose a link.</AdvancedEmpty>}{actionIssue ? <AdvancedIssueNotice issue={actionIssue} /> : null}<ActionStatus message={actionMessage} /></section>
        </div>
      </>}
    </main>
  );
}

function WritebackGate({ request }: { request: PlatformWritebackRequest }) {
  const dryRunSafe = request.dryRunResult?.safe === true;
  const approvalComplete = request.safety.validApprovals >= request.safety.requiredApprovals;
  const executionLabel = request.state === "succeeded" ? "confirmed" : request.state === "executing" ? "in progress" : request.state === "failed" ? "failed" : request.state === "approved" && request.safety.allowed ? "eligible" : "blocked";
  const executionPassed = request.state === "succeeded" || (request.state === "approved" && request.safety.allowed);
  return <div className="writeback-gates" aria-label={`Safety gates for ${request.id}`}><span className={dryRunSafe ? "is-pass" : "is-blocked"}>{dryRunSafe ? <Check size={13} /> : <Ban size={13} />} Dry-run {dryRunSafe ? "safe" : "blocked"}</span><span className={approvalComplete ? "is-pass" : "is-waiting"}><ShieldCheck size={13} /> Approvals {request.safety.validApprovals}/{request.safety.requiredApprovals}</span><span className={executionPassed ? "is-pass" : request.state === "executing" ? "is-waiting" : "is-blocked"}>{executionPassed ? <Check size={13} /> : request.state === "executing" ? <Activity size={13} /> : <LockKeyhole size={13} />} Execution {executionLabel}</span></div>;
}

function WritebackCard({ request, busy, onReview, onExecute }: { request: PlatformWritebackRequest; busy: boolean; onReview: (request: PlatformWritebackRequest, decision: "approved" | "rejected", comment: string) => void; onExecute: (request: PlatformWritebackRequest) => void }) {
  const [comment, setComment] = useState(""); const [confirmExecution, setConfirmExecution] = useState(false);
  const criticalBlocked = request.risk === "critical";
  const canExecute = request.state === "approved" && request.safety.allowed && !criticalBlocked;
  const safetyReasons = ["executing", "succeeded", "failed"].includes(request.state) ? request.blockedReasons : [...new Set([...request.blockedReasons, ...request.safety.reasons])];
  return (
    <li className={`writeback-card risk-${request.risk}`}>
      <header><div><strong>{request.operation}</strong><span>{request.targetExternalId} · {request.id}</span></div><div><span className={`risk-badge risk-${request.risk}`}>{request.risk} risk</span><span className={`writeback-state state-${request.state}`}>{request.state.replaceAll("_", " ")}</span></div></header>
      <WritebackGate request={request} />
      {criticalBlocked ? <div className="critical-block"><Ban size={17} /><strong>Critical execution blocked</strong><span>An external safety case is required; this UI never enables execution for critical risk.</span></div> : null}
      {safetyReasons.length > 0 ? <details className="writeback-reasons" open={request.state === "cancelled"}><summary>Safety gate reasons ({safetyReasons.length})</summary><ul>{safetyReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></details> : null}
      <div className="writeback-evidence"><div><small>Requested by</small><strong>{request.requestedBy}</strong><span>{formatDate(request.requestedAt)}</span></div><div><small>Dry-run evidence</small><code>{JSON.stringify(request.dryRunResult?.evidence ?? {})}</code></div><div><small>Payload</small><code>{JSON.stringify(request.payload)}</code></div></div>
      {request.approvals.length > 0 ? <ol className="approval-ledger" aria-label={`Immutable approvals for ${request.id}`}>{request.approvals.map((approval) => <li key={`${approval.actor}:${approval.occurredAt}`}><span className={approval.decision === "approved" ? "is-approved" : "is-rejected"}>{approval.decision}</span><strong>{approval.actor}</strong><small>{approval.comment || "No comment"} · {formatDate(approval.occurredAt)}</small></li>)}</ol> : <p className="approval-empty">No independent approval has been recorded.</p>}
      {request.state === "pending_approval" ? <div className="writeback-review"><label>Approval comment<textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Record review evidence" /></label><div><button type="button" aria-label={`Approve write-back ${request.id}`} disabled={busy} onClick={() => onReview(request, "approved", comment)}><Check size={14} /> Approve</button><button type="button" aria-label={`Reject write-back ${request.id}`} disabled={busy} onClick={() => onReview(request, "rejected", comment)}><X size={14} /> Reject</button></div></div> : null}
      {canExecute ? <div className="execution-confirm"><label><input type="checkbox" checked={confirmExecution} onChange={(event) => setConfirmExecution(event.target.checked)} /> I understand this sends a real industrial command through the configured executor.</label><button type="button" aria-label={`Execute industrial write-back ${request.id}`} disabled={busy || !confirmExecution} onClick={() => onExecute(request)}><Play size={14} /> Execute industrial write-back</button></div> : null}
      {request.state === "approved" && !canExecute ? <p className="execution-blocked"><LockKeyhole size={14} /> Execution remains disabled until every backend safety gate passes.</p> : null}
      {request.state === "executing" ? <p className="execution-running"><Activity size={14} /> Executor reported in progress; no success is assumed.</p> : null}
      {request.state === "succeeded" ? <div className="execution-result is-success"><ShieldCheck size={16} /><div><strong>API confirmed execution succeeded</strong><code>{JSON.stringify(request.executionResult ?? {})}</code></div></div> : null}
      {request.state === "failed" ? <div className="execution-result is-failed"><ShieldAlert size={16} /><div><strong>API reported execution failed</strong><code>{JSON.stringify(request.executionResult ?? {})}</code></div></div> : null}
    </li>
  );
}

export function WritebackWorkspace({ context }: { context: PlatformContext | null }) {
  const [requests, setRequests] = useState<PageState<PlatformWritebackRequest>>(() => emptyPage()); const [reloadToken, setReloadToken] = useState(0);
  const [sourceId, setSourceId] = useState(""); const [targetId, setTargetId] = useState(""); const [operation, setOperation] = useState(""); const [risk, setRisk] = useState<PlatformWritebackRisk>("low");
  const [payloadText, setPayloadText] = useState("{}"); const [dryRunSafe, setDryRunSafe] = useState(true); const [evidenceText, setEvidenceText] = useState('{"simulator":"passed"}'); const [summary, setSummary] = useState("");
  const [formError, setFormError] = useState(""); const [busy, setBusy] = useState(""); const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null); const [actionMessage, setActionMessage] = useState(""); const [actionTone, setActionTone] = useState<"neutral" | "blocked" | "confirmed">("neutral");

  useEffect(() => {
    if (!context) { setRequests({ ...emptyPage<PlatformWritebackRequest>(), loading: false }); return undefined; }
    const controller = new AbortController(); setRequests(emptyPage());
    listPlatformWritebackRequests(context, { limit: ADVANCED_PAGE_SIZE }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setRequests(readyPage(result)); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setRequests({ items: [], nextCursor: null, loading: false, loadingMore: false, issue: platformIssue(error, "Write-back requests could not be loaded") }); });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  const queueCounts = useMemo(() => requests.items.reduce((counts, request) => { counts[request.state] = (counts[request.state] ?? 0) + 1; return counts; }, {} as Record<string, number>), [requests.items]);

  async function createRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!context) return; setFormError(""); setActionIssue(null); setActionMessage("");
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(operation.trim())) throw new Error("Operation may contain letters, numbers, dots, underscores, colons, slashes, and hyphens.");
      const payload = parseObject(payloadText, "Payload"); const evidence = parseJson(evidenceText, "Dry-run evidence");
      const evidenceIsEmpty = Array.isArray(evidence) ? evidence.length === 0 : !evidence || typeof evidence !== "object" || Object.keys(evidence as Record<string, unknown>).length === 0;
      if (evidenceIsEmpty) throw new Error("Dry-run evidence must be a non-empty JSON object or array.");
      setBusy("create"); const created = await createPlatformWritebackRequest(context, { sourceId: sourceId.trim(), targetExternalId: targetId.trim(), operation: operation.trim(), payload, risk, dryRunResult: { safe: dryRunSafe, evidence, ...(summary.trim() ? { summary: summary.trim() } : {}) } });
      setRequests((state) => ({ ...state, items: upsertFirst(state.items, created) })); setActionTone(created.state === "cancelled" ? "blocked" : "neutral"); setActionMessage(`Request ${created.id} recorded in ${created.state.replaceAll("_", " ")} state.`);
    } catch (error) { if (error instanceof Error && !("status" in error)) setFormError(error.message); else setActionIssue(platformIssue(error, "Write-back request could not be created")); }
    finally { setBusy(""); }
  }

  async function review(request: PlatformWritebackRequest, decision: "approved" | "rejected", comment: string) {
    if (!context) return; setBusy(`review:${request.id}`); setActionIssue(null); setActionMessage("");
    try { const updated = await approvePlatformWritebackRequest(context, request.id, { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) }); setRequests((state) => ({ ...state, items: state.items.map((item) => item.id === updated.id ? updated : item) })); setActionTone(updated.state === "cancelled" ? "blocked" : "neutral"); setActionMessage(`Request ${updated.id} is ${updated.state.replaceAll("_", " ")}; approvals ${updated.safety.validApprovals}/${updated.safety.requiredApprovals}.`); }
    catch (error) { setActionIssue(platformIssue(error, "Write-back approval could not be recorded")); }
    finally { setBusy(""); }
  }

  async function execute(request: PlatformWritebackRequest) {
    if (!context || request.risk === "critical" || !request.safety.allowed || request.state !== "approved") return;
    setBusy(`execute:${request.id}`); setActionIssue(null); setActionMessage("");
    try { const updated = await executePlatformWritebackRequest(context, request.id); setRequests((state) => ({ ...state, items: state.items.map((item) => item.id === updated.id ? updated : item) })); setActionTone(updated.state === "succeeded" ? "confirmed" : "blocked"); setActionMessage(updated.state === "succeeded" ? `API confirmed successful execution for ${updated.id}.` : `API returned ${updated.state.replaceAll("_", " ")} for ${updated.id}; execution is not marked successful.`); }
    catch (error) {
      setActionIssue(platformIssue(error, "Industrial write-back was not executed"));
      try { const authoritative = await listPlatformWritebackRequests(context, { limit: ADVANCED_PAGE_SIZE }); setRequests(readyPage(authoritative)); }
      catch { /* Preserve the explicit execution error if the follow-up read is also unavailable. */ }
    }
    finally { setBusy(""); }
  }

  async function loadMore() {
    if (!context || !requests.nextCursor || requests.loadingMore) return; setRequests((state) => ({ ...state, loadingMore: true, issue: null }));
    try { const next = await listPlatformWritebackRequests(context, { limit: ADVANCED_PAGE_SIZE, cursor: requests.nextCursor }); setRequests((state) => ({ ...state, items: mergeById(state.items, next.items), nextCursor: next.nextCursor, loadingMore: false })); }
    catch (error) { setRequests((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More write-back requests could not be loaded") })); }
  }

  return (
    <main className="section-workspace platform-workspace advanced-workspace writeback-workspace">
      <SectionHeading eyebrow="Industrial safety boundary" title="Write-back" description="Request, independently approve, and execute industrial changes through explicit dry-run, risk, policy, and two-person safety gates." icon={<ShieldAlert size={24} />} />
      {!context ? <ContextRequired /> : <>
        <div className="writeback-warning" role="note"><ShieldAlert size={20} /><div><strong>Fail-closed industrial control</strong><span>No UI action bypasses backend policy. Critical requests remain blocked, and execution is never shown as successful without an API-confirmed succeeded state.</span></div></div>
        <section className="writeback-create advanced-form-panel"><header><ShieldCheck size={18} /><div><h2>New governed request</h2><p>This submits a request only. It does not execute an industrial command.</p></div></header><form className="advanced-form" onSubmit={(event) => void createRequest(event)}><label>Source ID<input required value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="control-system" /></label><label>Target external ID<input required value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="P-101" /></label><label>Operation<input required value={operation} onChange={(event) => setOperation(event.target.value)} placeholder="set.control_mode" /></label><label>Risk<select value={risk} onChange={(event) => setRisk(event.target.value as PlatformWritebackRisk)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High · two-person approval</option><option value="critical">Critical · execution blocked</option></select></label><label className="form-span">Payload JSON<textarea rows={3} required value={payloadText} onChange={(event) => setPayloadText(event.target.value)} /></label><label className="form-span">Dry-run evidence JSON<textarea rows={3} required value={evidenceText} onChange={(event) => setEvidenceText(event.target.value)} /></label><label className="dry-run-toggle"><input type="checkbox" checked={dryRunSafe} onChange={(event) => setDryRunSafe(event.target.checked)} /> Dry-run reported safe</label><label>Dry-run summary<input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Optional" /></label>{risk === "high" ? <p className="risk-inline-warning"><ShieldAlert size={14} /> High risk requires two distinct non-requester approvals.</p> : null}{risk === "critical" ? <p className="critical-inline-warning"><Ban size={14} /> Critical requests are recorded for audit but execution remains blocked.</p> : null}{!dryRunSafe ? <p className="critical-inline-warning"><Ban size={14} /> An unsafe dry-run will cause the backend to block this request.</p> : null}{formError ? <p className="advanced-form-error" role="alert">{formError}</p> : null}<button className="advanced-primary-action" type="submit" disabled={busy === "create"}><ShieldCheck size={15} /> {busy === "create" ? "Submitting…" : "Submit request — do not execute"}</button></form></section>
        {actionIssue ? <AdvancedIssueNotice issue={actionIssue} /> : null}<WritebackActionStatus message={actionMessage} tone={actionTone} />
        <section className="writeback-queue"><header><div><h2>Approval and execution queue</h2><p>{requests.items.length} loaded · {queueCounts.pending_approval ?? 0} awaiting approval · {queueCounts.approved ?? 0} eligible states</p></div><RefreshCw size={18} /></header>{requests.loading ? <LoadState message="Loading write-back queue…" /> : null}{requests.issue ? <AdvancedIssueNotice issue={requests.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!requests.loading && !requests.issue && requests.items.length === 0 ? <AdvancedEmpty>No industrial write-back requests exist in this project.</AdvancedEmpty> : null}<ol className="writeback-list">{requests.items.map((request) => <WritebackCard key={request.id} request={request} busy={busy.endsWith(`:${request.id}`)} onReview={(item, decision, comment) => void review(item, decision, comment)} onExecute={(item) => void execute(item)} />)}</ol><AdvancedLoadMore cursor={requests.nextCursor} loading={requests.loadingMore} onLoad={() => void loadMore()} /></section>
      </>}
    </main>
  );
}
