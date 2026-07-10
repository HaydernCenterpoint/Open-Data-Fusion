import {
  Activity,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  GitBranch,
  Layers3,
  LockKeyhole,
  Play,
  RefreshCw,
  Search,
  ServerCog,
  ShieldAlert,
  Tags,
  Workflow,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ApiRequestError,
  listPlatformCandidates,
  listPlatformConnectors,
  listPlatformDataModels,
  listPlatformDatasets,
  listPlatformPipelineRuns,
  listPlatformPipelines,
  listPlatformQualityResults,
  listPlatformSources,
  listRelations,
  reviewPlatformCandidate,
  triggerPlatformPipelineRun,
} from "../lib/api";
import type {
  ApiRelation,
  CursorPage,
  PlatformConnector,
  PlatformContext,
  PlatformContextCandidate,
  PlatformDataModel,
  PlatformDataset,
  PlatformPipeline,
  PlatformPipelineRun,
  PlatformProject,
  PlatformQualityResult,
  PlatformSource,
  PlatformTenant,
} from "../types";
import { formatDate, LoadState, SectionHeading } from "./SectionWorkspaces";

const PLATFORM_PAGE_SIZE = 30;

export type PlatformIssueKind = "unauthorized" | "forbidden" | "degraded";

export interface PlatformIssue {
  kind: PlatformIssueKind;
  message: string;
}

export type PlatformBootstrapState =
  | { status: "loading"; message: string }
  | { status: "ready"; message: string }
  | { status: "empty"; message: string }
  | { status: PlatformIssueKind; message: string };

interface PageState<T> {
  items: T[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  issue: PlatformIssue | null;
}

type Captured<T> = { ok: true; value: T } | { ok: false; error: unknown };

function emptyPage<T>(): PageState<T> {
  return { items: [], nextCursor: null, loading: true, loadingMore: false, issue: null };
}

async function capture<T>(promise: Promise<T>): Promise<Captured<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

export function platformIssue(error: unknown, fallback: string): PlatformIssue {
  if (error instanceof ApiRequestError && error.status === 401) return { kind: "unauthorized", message: "Your sign-in session is not authorized for this platform request. Sign in again and retry." };
  if (error instanceof ApiRequestError && error.status === 403) return { kind: "forbidden", message: error.message || "Your project role does not allow this operation." };
  return { kind: "degraded", message: error instanceof Error ? error.message : fallback };
}

function stateFromResult<T>(result: Captured<CursorPage<T>>, fallback: string): PageState<T> {
  return result.ok
    ? { items: result.value.items, nextCursor: result.value.nextCursor, loading: false, loadingMore: false, issue: null }
    : { items: [], nextCursor: null, loading: false, loadingMore: false, issue: platformIssue(result.error, fallback) };
}

function mergePage<T extends { id: string | number }>(current: T[], incoming: T[]): T[] {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

function mergeModels(current: PlatformDataModel[], incoming: PlatformDataModel[]): PlatformDataModel[] {
  const known = new Set(current.map((model) => `${model.id}@${model.version}`));
  return [...current, ...incoming.filter((model) => !known.has(`${model.id}@${model.version}`))];
}

function IssueNotice({ issue, onRetry }: { issue: PlatformIssue; onRetry?: () => void }) {
  const Icon = issue.kind === "unauthorized" ? LockKeyhole : issue.kind === "forbidden" ? ShieldAlert : CircleAlert;
  return (
    <div className={`platform-issue is-${issue.kind}`} role="alert">
      <Icon size={19} />
      <span>{issue.message}</span>
      {onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button> : null}
    </div>
  );
}

function ResourceHeader({ icon, title, count }: { icon: React.ReactNode; title: string; count: number }) {
  return <header className="resource-section-header"><span aria-hidden="true">{icon}</span><h2>{title}</h2><small>{count} loaded</small></header>;
}

function CursorLoadMore({ cursor, loading, onLoad }: { cursor: string | null; loading: boolean; onLoad: () => void }) {
  return cursor ? <button className="section-load-more" type="button" disabled={loading} onClick={onLoad}>{loading ? "Loading…" : "Load more"}</button> : null;
}

function PageEmpty({ children }: { children: React.ReactNode }) {
  return <p className="resource-empty">{children}</p>;
}

export function PlatformContextBar({
  tenants,
  projects,
  selectedTenantId,
  context,
  state,
  onTenantChange,
  onProjectChange,
  onRetry,
}: {
  tenants: PlatformTenant[];
  projects: PlatformProject[];
  selectedTenantId: string;
  context: PlatformContext | null;
  state: PlatformBootstrapState;
  onTenantChange: (tenantId: string) => void;
  onProjectChange: (projectId: string) => void;
  onRetry: () => void;
}) {
  return (
    <div className="platform-context-bar" aria-label="Platform context">
      <span className="platform-context-label"><Layers3 size={15} /> Project context</span>
      <label>Tenant<select aria-label="Platform tenant" value={selectedTenantId} disabled={state.status === "loading" || tenants.length === 0} onChange={(event) => onTenantChange(event.target.value)}>{tenants.length === 0 ? <option value="">No tenant</option> : tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select></label>
      <ChevronRight size={14} aria-hidden="true" />
      <label>Project<select aria-label="Platform project" value={context?.projectId ?? ""} disabled={state.status === "loading" || projects.length === 0} onChange={(event) => onProjectChange(event.target.value)}>{projects.length === 0 ? <option value="">No project</option> : projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <span className={`platform-context-status is-${state.status}`} role={["unauthorized", "forbidden", "degraded"].includes(state.status) ? "alert" : "status"}>{state.status === "loading" ? <Activity className="spin" size={13} /> : null}{state.message}</span>
      {state.status !== "ready" && state.status !== "loading" ? <button className="platform-context-retry" type="button" onClick={onRetry}><RefreshCw size={14} /> Retry</button> : null}
    </div>
  );
}

function ContextRequired() {
  return <LoadState message="Select an accessible tenant and project to load this platform surface." />;
}

export function SourcesWorkspace({ context }: { context: PlatformContext | null }) {
  const [sources, setSources] = useState<PageState<PlatformSource>>(() => emptyPage());
  const [connectors, setConnectors] = useState<PageState<PlatformConnector>>(() => emptyPage());
  const [datasets, setDatasets] = useState<PageState<PlatformDataset>>(() => emptyPage());
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!context) {
      setSources({ ...emptyPage<PlatformSource>(), loading: false });
      setConnectors({ ...emptyPage<PlatformConnector>(), loading: false });
      setDatasets({ ...emptyPage<PlatformDataset>(), loading: false });
      return undefined;
    }
    const controller = new AbortController();
    setSources(emptyPage());
    setConnectors(emptyPage());
    setDatasets(emptyPage());
    void Promise.all([
      capture(listPlatformSources(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformConnectors(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformDatasets(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
    ]).then(([sourceResult, connectorResult, datasetResult]) => {
      if (controller.signal.aborted) return;
      setSources(stateFromResult(sourceResult, "Sources could not be loaded"));
      setConnectors(stateFromResult(connectorResult, "Connectors could not be loaded"));
      setDatasets(stateFromResult(datasetResult, "Datasets could not be loaded"));
    });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  async function loadMoreSources() {
    if (!context || !sources.nextCursor || sources.loadingMore) return;
    setSources((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformSources(context, { limit: PLATFORM_PAGE_SIZE, cursor: sources.nextCursor });
      setSources((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      setSources((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More sources could not be loaded") }));
    }
  }

  async function loadMoreConnectors() {
    if (!context || !connectors.nextCursor || connectors.loadingMore) return;
    setConnectors((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformConnectors(context, { limit: PLATFORM_PAGE_SIZE, cursor: connectors.nextCursor });
      setConnectors((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      setConnectors((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More connectors could not be loaded") }));
    }
  }

  async function loadMoreDatasets() {
    if (!context || !datasets.nextCursor || datasets.loadingMore) return;
    setDatasets((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformDatasets(context, { limit: PLATFORM_PAGE_SIZE, cursor: datasets.nextCursor });
      setDatasets((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      setDatasets((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More datasets could not be loaded") }));
    }
  }

  const retry = () => setReloadToken((value) => value + 1);

  return (
    <main className="section-workspace platform-workspace">
      <SectionHeading eyebrow="Connected data" title="Sources" description="Read project-scoped sources, connector configuration references, and governed datasets from the platform catalog." icon={<Database size={24} />} />
      {!context ? <ContextRequired /> : (
        <div className="resource-grid">
          <section className="resource-section"><ResourceHeader icon={<Database size={18} />} title="Sources" count={sources.items.length} />{sources.loading ? <LoadState message="Loading sources…" /> : null}{sources.issue ? <IssueNotice issue={sources.issue} onRetry={retry} /> : null}{!sources.loading && !sources.issue && sources.items.length === 0 ? <PageEmpty>No sources exist in this project.</PageEmpty> : null}<ol className="resource-list">{sources.items.map((source) => <li key={source.id}><strong>{source.name}</strong><span>{source.type} · {source.id}</span><small>{source.description || "No description"}</small></li>)}</ol><CursorLoadMore cursor={sources.nextCursor} loading={sources.loadingMore} onLoad={() => void loadMoreSources()} /></section>
          <section className="resource-section"><ResourceHeader icon={<ServerCog size={18} />} title="Connectors" count={connectors.items.length} />{connectors.loading ? <LoadState message="Loading connectors…" /> : null}{connectors.issue ? <IssueNotice issue={connectors.issue} onRetry={retry} /> : null}{!connectors.loading && !connectors.issue && connectors.items.length === 0 ? <PageEmpty>No connectors exist in this project.</PageEmpty> : null}<ol className="resource-list">{connectors.items.map((connector) => <li key={connector.id}><strong>{connector.name}</strong><span>{connector.type} · source {connector.sourceId}</span><small><i className={connector.enabled ? "is-on" : ""} />{connector.enabled ? "Enabled" : "Disabled"} · {Object.keys(connector.configuration).length} configuration reference{Object.keys(connector.configuration).length === 1 ? "" : "s"}</small></li>)}</ol><CursorLoadMore cursor={connectors.nextCursor} loading={connectors.loadingMore} onLoad={() => void loadMoreConnectors()} /></section>
          <section className="resource-section"><ResourceHeader icon={<Boxes size={18} />} title="Datasets" count={datasets.items.length} />{datasets.loading ? <LoadState message="Loading datasets…" /> : null}{datasets.issue ? <IssueNotice issue={datasets.issue} onRetry={retry} /> : null}{!datasets.loading && !datasets.issue && datasets.items.length === 0 ? <PageEmpty>No datasets exist in this project.</PageEmpty> : null}<ol className="resource-list">{datasets.items.map((dataset) => <li key={dataset.id}><strong>{dataset.name}</strong><span>{dataset.id}</span><small>{dataset.description || "No description"}</small></li>)}</ol><CursorLoadMore cursor={datasets.nextCursor} loading={datasets.loadingMore} onLoad={() => void loadMoreDatasets()} /></section>
        </div>
      )}
    </main>
  );
}

function createRunKey(): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 12) : Date.now().toString(36);
  return `manual-${suffix}`;
}

function PipelineRow({ pipeline, busy, onRun }: { pipeline: PlatformPipeline; busy: boolean; onRun: (pipeline: PlatformPipeline, key: string, input: Record<string, unknown>) => Promise<void> }) {
  const [idempotencyKey, setIdempotencyKey] = useState(createRunKey);
  const [inputText, setInputText] = useState("{}");
  const [inputError, setInputError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInputError("");
    let input: unknown;
    try {
      input = JSON.parse(inputText) as unknown;
    } catch {
      setInputError("Input must be valid JSON.");
      return;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      setInputError("Input must be a JSON object.");
      return;
    }
    await onRun(pipeline, idempotencyKey.trim(), input as Record<string, unknown>);
  }

  return (
    <li className="pipeline-row">
      <div className="pipeline-row-heading"><div><strong>{pipeline.name}</strong><span>{pipeline.id} · v{pipeline.version}</span></div><span className={`status-chip ${pipeline.enabled ? "status-accepted" : "status-superseded"}`}>{pipeline.enabled ? "enabled" : "disabled"}</span></div>
      <small>Source {pipeline.sourceId || "—"} · Dataset {pipeline.datasetId || "—"}</small>
      <form className="pipeline-run-form" onSubmit={(event) => void submit(event)}>
        <label>Idempotency key<input aria-label={`Idempotency key for ${pipeline.name}`} required value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} /></label>
        <label>Run input<textarea aria-label={`Run input for ${pipeline.name}`} rows={2} value={inputText} onChange={(event) => setInputText(event.target.value)} /></label>
        {inputError ? <span className="pipeline-input-error" role="alert">{inputError}</span> : null}
        <button type="submit" disabled={busy || !pipeline.enabled || !idempotencyKey.trim()}><Play size={14} /> {busy ? "Running…" : "Run pipeline"}</button>
      </form>
    </li>
  );
}

export function PipelinesWorkspace({ context }: { context: PlatformContext | null }) {
  const [pipelines, setPipelines] = useState<PageState<PlatformPipeline>>(() => emptyPage());
  const [runs, setRuns] = useState<PageState<PlatformPipelineRun>>(() => emptyPage());
  const [quality, setQuality] = useState<PageState<PlatformQualityResult>>(() => emptyPage());
  const [reloadToken, setReloadToken] = useState(0);
  const [runningPipeline, setRunningPipeline] = useState<string | null>(null);
  const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    if (!context) {
      setPipelines({ ...emptyPage<PlatformPipeline>(), loading: false });
      setRuns({ ...emptyPage<PlatformPipelineRun>(), loading: false });
      setQuality({ ...emptyPage<PlatformQualityResult>(), loading: false });
      return undefined;
    }
    const controller = new AbortController();
    setPipelines(emptyPage());
    setRuns(emptyPage());
    setQuality(emptyPage());
    setActionIssue(null);
    setActionMessage("");
    void Promise.all([
      capture(listPlatformPipelines(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformPipelineRuns(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformQualityResults(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
    ]).then(([pipelineResult, runResult, qualityResult]) => {
      if (controller.signal.aborted) return;
      setPipelines(stateFromResult(pipelineResult, "Pipelines could not be loaded"));
      setRuns(stateFromResult(runResult, "Pipeline runs could not be loaded"));
      setQuality(stateFromResult(qualityResult, "Quality results could not be loaded"));
    });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  async function runPipeline(pipeline: PlatformPipeline, key: string, input: Record<string, unknown>) {
    if (!context) return;
    setRunningPipeline(pipeline.id);
    setActionIssue(null);
    setActionMessage("");
    try {
      const run = await triggerPlatformPipelineRun(context, pipeline.id, { idempotencyKey: key, input });
      setActionMessage(run.replayed
        ? `Existing run ${run.id} replayed (${run.status})`
        : `New run ${run.id} is ${run.status}`);
      const [runResult, qualityResult] = await Promise.all([
        capture(listPlatformPipelineRuns(context, { limit: PLATFORM_PAGE_SIZE })),
        capture(listPlatformQualityResults(context, { limit: PLATFORM_PAGE_SIZE })),
      ]);
      if (runResult.ok) setRuns({ items: runResult.value.items, nextCursor: runResult.value.nextCursor, loading: false, loadingMore: false, issue: null });
      else setRuns((state) => ({ ...state, issue: platformIssue(runResult.error, "Run history could not be refreshed") }));
      if (qualityResult.ok) setQuality({ items: qualityResult.value.items, nextCursor: qualityResult.value.nextCursor, loading: false, loadingMore: false, issue: null });
      else setQuality((state) => ({ ...state, issue: platformIssue(qualityResult.error, "Quality results could not be refreshed") }));
    } catch (error) {
      setActionIssue(platformIssue(error, "Pipeline run could not be started"));
    } finally {
      setRunningPipeline(null);
    }
  }

  async function loadMorePipelines() {
    if (!context || !pipelines.nextCursor || pipelines.loadingMore) return;
    setPipelines((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformPipelines(context, { limit: PLATFORM_PAGE_SIZE, cursor: pipelines.nextCursor });
      setPipelines((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) { setPipelines((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More pipelines could not be loaded") })); }
  }

  async function loadMoreRuns() {
    if (!context || !runs.nextCursor || runs.loadingMore) return;
    setRuns((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformPipelineRuns(context, { limit: PLATFORM_PAGE_SIZE, cursor: runs.nextCursor });
      setRuns((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) { setRuns((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More runs could not be loaded") })); }
  }

  async function loadMoreQuality() {
    if (!context || !quality.nextCursor || quality.loadingMore) return;
    setQuality((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformQualityResults(context, { limit: PLATFORM_PAGE_SIZE, cursor: quality.nextCursor });
      setQuality((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) { setQuality((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More quality results could not be loaded") })); }
  }

  const retry = () => setReloadToken((value) => value + 1);

  return (
    <main className="section-workspace platform-workspace">
      <SectionHeading eyebrow="Operational processing" title="Pipelines" description="Run versioned project pipelines with explicit idempotency, then inspect immutable run and quality evidence." icon={<Workflow size={24} />} />
      {!context ? <ContextRequired /> : <div className="pipeline-layout">
        {actionIssue ? <IssueNotice issue={actionIssue} /> : null}
        {actionMessage ? <p className="pipeline-action-message" role="status"><Check size={15} /> {actionMessage}</p> : null}
        <section className="resource-section"><ResourceHeader icon={<Workflow size={18} />} title="Pipeline definitions" count={pipelines.items.length} />{pipelines.loading ? <LoadState message="Loading pipelines…" /> : null}{pipelines.issue ? <IssueNotice issue={pipelines.issue} onRetry={retry} /> : null}{!pipelines.loading && !pipelines.issue && pipelines.items.length === 0 ? <PageEmpty>No pipelines exist in this project.</PageEmpty> : null}<ol className="resource-list pipeline-list">{pipelines.items.map((pipeline) => <PipelineRow key={pipeline.id} pipeline={pipeline} busy={runningPipeline === pipeline.id} onRun={runPipeline} />)}</ol><CursorLoadMore cursor={pipelines.nextCursor} loading={pipelines.loadingMore} onLoad={() => void loadMorePipelines()} /></section>
        <section className="resource-section"><ResourceHeader icon={<Activity size={18} />} title="Run history" count={runs.items.length} />{runs.loading ? <LoadState message="Loading pipeline runs…" /> : null}{runs.issue ? <IssueNotice issue={runs.issue} onRetry={retry} /> : null}{!runs.loading && !runs.issue && runs.items.length === 0 ? <PageEmpty>No pipeline runs have been recorded.</PageEmpty> : null}<ol className="resource-list">{runs.items.map((run) => <li key={run.id}><strong>{run.pipelineId}</strong><span>{run.status} · {run.idempotencyKey}</span><small>{run.triggeredBy} · {formatDate(run.startedAt)}{run.replayed ? " · replayed" : ""}</small></li>)}</ol><CursorLoadMore cursor={runs.nextCursor} loading={runs.loadingMore} onLoad={() => void loadMoreRuns()} /></section>
        <section className="resource-section"><ResourceHeader icon={<ShieldAlert size={18} />} title="Quality results" count={quality.items.length} />{quality.loading ? <LoadState message="Loading quality results…" /> : null}{quality.issue ? <IssueNotice issue={quality.issue} onRetry={retry} /> : null}{!quality.loading && !quality.issue && quality.items.length === 0 ? <PageEmpty>No quality results have been recorded.</PageEmpty> : null}<ol className="resource-list">{quality.items.map((result) => <li key={result.id}><strong>{result.ruleId}</strong><span className={result.passed ? "quality-pass" : "quality-fail"}>{result.passed ? "Passed" : "Failed"} · run {result.runId}</span><small>{formatDate(result.evaluatedAt)}</small></li>)}</ol><CursorLoadMore cursor={quality.nextCursor} loading={quality.loadingMore} onLoad={() => void loadMoreQuality()} /></section>
      </div>}
    </main>
  );
}

export function ModelsWorkspace({ context }: { context: PlatformContext | null }) {
  const [models, setModels] = useState<PageState<PlatformDataModel>>(() => emptyPage());
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!context) { setModels({ ...emptyPage<PlatformDataModel>(), loading: false }); return undefined; }
    const controller = new AbortController();
    setModels(emptyPage());
    listPlatformDataModels(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)
      .then((page) => setModels({ items: page.items, nextCursor: page.nextCursor, loading: false, loadingMore: false, issue: null }))
      .catch((error: unknown) => { if (!controller.signal.aborted) setModels({ items: [], nextCursor: null, loading: false, loadingMore: false, issue: platformIssue(error, "Data models could not be loaded") }); });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  async function loadMore() {
    if (!context || !models.nextCursor || models.loadingMore) return;
    setModels((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformDataModels(context, { limit: PLATFORM_PAGE_SIZE, cursor: models.nextCursor });
      setModels((state) => ({ ...state, items: mergeModels(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) { setModels((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More model versions could not be loaded") })); }
  }

  return (
    <main className="section-workspace platform-workspace">
      <SectionHeading eyebrow="Canonical semantics" title="Models" description="Inspect append-only model versions and their immutable schemas in the selected project." icon={<Boxes size={24} />} />
      {!context ? <ContextRequired /> : <section className="resource-section models-section"><ResourceHeader icon={<Boxes size={18} />} title="Immutable model versions" count={models.items.length} />{models.loading ? <LoadState message="Loading model versions…" /> : null}{models.issue ? <IssueNotice issue={models.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!models.loading && !models.issue && models.items.length === 0 ? <PageEmpty>No model versions exist in this project.</PageEmpty> : null}<ol className="model-version-list">{models.items.map((model) => <li key={`${model.id}@${model.version}`}><div><strong>{model.name}</strong><span>{model.id} · version {model.version}</span></div><span className={`status-chip status-${model.status === "published" ? "accepted" : "proposed"}`}>{model.status}</span><small>Created by {model.createdBy} · {formatDate(model.createdAt)}</small><details><summary>Immutable schema</summary><pre>{JSON.stringify(model.schema, null, 2)}</pre></details></li>)}</ol><CursorLoadMore cursor={models.nextCursor} loading={models.loadingMore} onLoad={() => void loadMore()} /></section>}
    </main>
  );
}

function PlatformCandidateRow({ candidate, busy, onReview }: { candidate: PlatformContextCandidate; busy: boolean; onReview: (candidate: PlatformContextCandidate, decision: "accepted" | "rejected") => void }) {
  return (
    <li className="governance-list-row platform-candidate-row">
      <div className="relation-route"><strong>{candidate.source.id}</strong><span><GitBranch size={14} /> {candidate.relationType}</span><strong>{candidate.target.id}</strong></div>
      <div className="governance-row-meta"><span className={`status-chip status-${candidate.status}`}>{candidate.status}</span><span>{Math.round(candidate.confidence * 100)}% confidence</span><span>{candidate.source.type} → {candidate.target.type}</span><span>{candidate.reviewedBy ? `Reviewed by ${candidate.reviewedBy}` : `Proposed by ${candidate.createdBy}`}</span></div>
      {Object.keys(candidate.evidence).length > 0 ? <details><summary>Evidence</summary><pre>{JSON.stringify(candidate.evidence, null, 2)}</pre></details> : null}
      {candidate.status === "proposed" ? <div className="candidate-actions"><button type="button" disabled={busy} onClick={() => onReview(candidate, "accepted")}><Check size={14} /> Accept</button><button type="button" disabled={busy} onClick={() => onReview(candidate, "rejected")}><X size={14} /> Reject</button></div> : null}
    </li>
  );
}

function LegacyRelationRow({ relation, onOpenAsset }: { relation: ApiRelation; onOpenAsset: (externalId: string) => void }) {
  return <li className="governance-list-row"><div className="relation-route"><button type="button" onClick={() => onOpenAsset(relation.source.externalId)}>{relation.source.externalId}</button><span><GitBranch size={14} /> {relation.type}</span><button type="button" onClick={() => onOpenAsset(relation.target.externalId)}>{relation.target.externalId}</button></div><div className="governance-row-meta"><span className={`status-chip status-${relation.status}`}>{relation.status}</span><span>{relation.sourceSystem}</span><span>{relation.confidence === null ? "Not scored" : `${Math.round(relation.confidence * 100)}% confidence`}</span></div></li>;
}

export function PlatformContextWorkspace({ context, onOpenAsset }: { context: PlatformContext | null; onOpenAsset: (externalId: string) => void }) {
  const [candidates, setCandidates] = useState<PageState<PlatformContextCandidate>>(() => emptyPage());
  const [legacyRelations, setLegacyRelations] = useState<ApiRelation[]>([]);
  const [legacyIssue, setLegacyIssue] = useState<PlatformIssue | null>(null);
  const [query, setQuery] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewIssue, setReviewIssue] = useState<PlatformIssue | null>(null);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  useEffect(() => {
    const controller = new AbortController();
    setCandidates(context ? emptyPage() : { ...emptyPage<PlatformContextCandidate>(), loading: false });
    setLegacyIssue(null);
    setReviewIssue(null);
    void Promise.all([
      context ? capture(listPlatformCandidates(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)) : Promise.resolve<Captured<CursorPage<PlatformContextCandidate>> | null>(null),
      capture(listRelations({ limit: 200 }, controller.signal)),
    ]).then(([candidateResult, legacyResult]) => {
      if (controller.signal.aborted) return;
      if (candidateResult) setCandidates(stateFromResult(candidateResult, "Context candidates could not be loaded"));
      if (legacyResult.ok) setLegacyRelations(legacyResult.value.items);
      else { setLegacyRelations([]); setLegacyIssue(platformIssue(legacyResult.error, "Legacy relations could not be loaded")); }
    });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  const filteredCandidates = useMemo(() => !deferredQuery ? candidates.items : candidates.items.filter((candidate) => `${candidate.source.id} ${candidate.target.id} ${candidate.relationType} ${candidate.status}`.toLowerCase().includes(deferredQuery)), [candidates.items, deferredQuery]);
  const filteredLegacy = useMemo(() => !deferredQuery ? legacyRelations : legacyRelations.filter((relation) => `${relation.source.externalId} ${relation.target.externalId} ${relation.type} ${relation.status}`.toLowerCase().includes(deferredQuery)), [deferredQuery, legacyRelations]);

  async function review(candidate: PlatformContextCandidate, decision: "accepted" | "rejected") {
    if (!context) return;
    setReviewing(candidate.id);
    setReviewIssue(null);
    try {
      const updated = await reviewPlatformCandidate(context, candidate.id, { decision });
      setCandidates((state) => ({ ...state, items: state.items.map((item) => item.id === updated.id ? updated : item) }));
    } catch (error) {
      setReviewIssue(platformIssue(error, "Candidate review could not be saved"));
    } finally {
      setReviewing(null);
    }
  }

  async function loadMoreCandidates() {
    if (!context || !candidates.nextCursor || candidates.loadingMore) return;
    setCandidates((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformCandidates(context, { limit: PLATFORM_PAGE_SIZE, cursor: candidates.nextCursor });
      setCandidates((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) { setCandidates((state) => ({ ...state, loadingMore: false, issue: platformIssue(error, "More candidates could not be loaded") })); }
  }

  return (
    <main className="section-workspace platform-workspace">
      <SectionHeading eyebrow="Governed contextualization" title="Context" description="Review project-scoped contextualization candidates first, while retaining the legacy relation projection for comparison." icon={<Tags size={24} />} />
      <div className="section-toolbar"><label className="section-search"><Search size={16} /><span className="sr-only">Filter contextualization</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter candidates and legacy relations" /></label></div>
      {!context ? <ContextRequired /> : null}
      <section className="resource-section context-primary"><ResourceHeader icon={<Tags size={18} />} title="Platform candidates" count={filteredCandidates.length} />{candidates.loading ? <LoadState message="Loading contextualization candidates…" /> : null}{candidates.issue ? <IssueNotice issue={candidates.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{reviewIssue ? <IssueNotice issue={reviewIssue} /> : null}{!candidates.loading && !candidates.issue && filteredCandidates.length === 0 ? <PageEmpty>{query ? "No candidates match this filter." : "No platform candidates exist in this project."}</PageEmpty> : null}<ol className="governance-list">{filteredCandidates.map((candidate) => <PlatformCandidateRow key={candidate.id} candidate={candidate} busy={reviewing === candidate.id} onReview={(item, decision) => void review(item, decision)} />)}</ol><CursorLoadMore cursor={candidates.nextCursor} loading={candidates.loadingMore} onLoad={() => void loadMoreCandidates()} /></section>
      <section className="resource-section legacy-context-section"><ResourceHeader icon={<GitBranch size={18} />} title="Legacy relation projection" count={filteredLegacy.length} />{legacyIssue ? <IssueNotice issue={legacyIssue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!legacyIssue && filteredLegacy.length === 0 ? <PageEmpty>{query ? "No legacy relations match this filter." : "No legacy relations are available."}</PageEmpty> : null}<ol className="governance-list">{filteredLegacy.map((relation) => <LegacyRelationRow key={relation.id} relation={relation} onOpenAsset={onOpenAsset} />)}</ol></section>
    </main>
  );
}
