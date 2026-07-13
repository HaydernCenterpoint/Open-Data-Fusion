import {
  Activity,
  ArrowRight,
  Database,
  FileClock,
  Layers3,
  RefreshCw,
  ShieldAlert,
  Tags,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  listAssets,
  listAudit,
  listPlatformCandidates,
  listPlatformPipelineRuns,
  listPlatformPipelines,
  listPlatformSources,
  listPlatformWritebackRequests,
} from "../lib/api";
import type {
  ApiAuditEvent,
  AssetListResponse,
  CursorPage,
  PlatformContext,
  PlatformContextCandidate,
  PlatformPipeline,
  PlatformPipelineRun,
  PlatformSource,
  PlatformWritebackRequest,
} from "../types";
import { formatDate, LoadState, SectionHeading } from "./SectionWorkspaces";
import { platformIssue, type PlatformIssue } from "./PlatformWorkspaces";
import type { NavigationLabel } from "./Sidebar";

const CURSOR_PAGE_SIZE = 100;
const AUDIT_EVENT_LIMIT = 8;

type Resource<T> =
  | { status: "idle" | "loading"; value: null; issue: null }
  | { status: "ready"; value: T; issue: null }
  | { status: "error"; value: null; issue: PlatformIssue };

interface OverviewResources {
  assets: Resource<AssetListResponse>;
  sources: Resource<PlatformSource[]>;
  pipelines: Resource<PlatformPipeline[]>;
  runs: Resource<PlatformPipelineRun[]>;
  candidates: Resource<PlatformContextCandidate[]>;
  writebacks: Resource<PlatformWritebackRequest[]>;
  audit: Resource<{ events: ApiAuditEvent[]; total: number }>;
}

type CursorPageLoader<T> = (
  context: PlatformContext,
  query: { limit?: number; cursor?: string },
  signal?: AbortSignal,
) => Promise<CursorPage<T>>;

function pendingResource<T>(status: "idle" | "loading"): Resource<T> {
  return { status, value: null, issue: null };
}

function readyResource<T>(value: T): Resource<T> {
  return { status: "ready", value, issue: null };
}

function failedResource<T>(error: unknown, fallback: string): Resource<T> {
  return { status: "error", value: null, issue: platformIssue(error, fallback) };
}

function createResources(status: "idle" | "loading"): OverviewResources {
  return {
    assets: pendingResource<AssetListResponse>(status),
    sources: pendingResource<PlatformSource[]>(status),
    pipelines: pendingResource<PlatformPipeline[]>(status),
    runs: pendingResource<PlatformPipelineRun[]>(status),
    candidates: pendingResource<PlatformContextCandidate[]>(status),
    writebacks: pendingResource<PlatformWritebackRequest[]>(status),
    audit: pendingResource<{ events: ApiAuditEvent[]; total: number }>(status),
  };
}

async function collectCursorItems<T>(
  list: CursorPageLoader<T>,
  context: PlatformContext,
  signal: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await list(context, { limit: CURSOR_PAGE_SIZE, ...(cursor ? { cursor } : {}) }, signal);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seenCursors.has(page.nextCursor)) throw new Error("The platform returned a repeated pagination cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function OverviewMetricCard<T>({
  title,
  icon,
  resource,
  value,
  metricLabel,
  detail,
  destination,
  onNavigate,
  onRetry,
  tone = "neutral",
}: {
  title: string;
  icon: React.ReactNode;
  resource: Resource<T>;
  value: number | null;
  metricLabel: string;
  detail: string | null;
  destination: NavigationLabel;
  onNavigate: (destination: NavigationLabel) => void;
  onRetry: () => void;
  tone?: "neutral" | "attention" | "safety";
}) {
  return (
    <section className={`overview-metric-card is-${tone}`} aria-label={`${title} overview`}>
      <header>
        <span className="overview-metric-card__icon" aria-hidden="true">{icon}</span>
        <div><h2>{title}</h2><p>{metricLabel}</p></div>
      </header>
      {resource.status === "loading" ? <p className="overview-card-loading" role="status"><Activity className="spin" size={16} /> Loading project data…</p> : null}
      {resource.status === "idle" ? <p className="overview-card-empty">Select a project to load this measure.</p> : null}
      {resource.status === "error" ? <div className="overview-card-error" role="alert"><span>{resource.issue.message}</span><button type="button" onClick={onRetry}><RefreshCw size={13} /> Retry</button></div> : null}
      {resource.status === "ready" ? <div className="overview-metric-card__value"><strong>{value ?? 0}</strong><span>{metricLabel}</span>{detail ? <small>{detail}</small> : null}</div> : null}
      <footer><button type="button" onClick={() => onNavigate(destination)}>Open {destination}<ArrowRight size={14} /></button></footer>
    </section>
  );
}

function ResourceError({ issue, onRetry }: { issue: PlatformIssue; onRetry: () => void }) {
  return <div className="overview-card-error" role="alert"><span>{issue.message}</span><button type="button" onClick={onRetry}><RefreshCw size={13} /> Retry</button></div>;
}

function latestRun(runs: PlatformPipelineRun[]): PlatformPipelineRun | null {
  if (runs.length === 0) return null;
  return [...runs].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0] ?? null;
}

export function ProjectOverviewWorkspace({ context, onNavigate }: { context: PlatformContext | null; onNavigate: (destination: NavigationLabel) => void }) {
  const [resources, setResources] = useState<OverviewResources>(() => createResources("idle"));
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!context) {
      setResources(createResources("idle"));
      return undefined;
    }

    const controller = new AbortController();
    setResources(createResources("loading"));

    void listAssets(context, { limit: CURSOR_PAGE_SIZE, offset: 0 }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, assets: readyResource(value) })); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, assets: failedResource(error, "Assets could not be loaded") })); });
    void collectCursorItems(listPlatformSources, context, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, sources: readyResource(value) })); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, sources: failedResource(error, "Sources could not be loaded") })); });
    void collectCursorItems(listPlatformPipelines, context, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, pipelines: readyResource(value) })); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, pipelines: failedResource(error, "Pipelines could not be loaded") })); });
    void collectCursorItems(listPlatformPipelineRuns, context, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, runs: readyResource(value) })); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, runs: failedResource(error, "Pipeline run evidence could not be loaded") })); });
    void collectCursorItems(listPlatformCandidates, context, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, candidates: readyResource(value) })); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, candidates: failedResource(error, "Contextualization candidates could not be loaded") })); });
    void collectCursorItems(listPlatformWritebackRequests, context, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, writebacks: readyResource(value) })); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, writebacks: failedResource(error, "Write-back requests could not be loaded") })); });
    void listAudit(context, { limit: AUDIT_EVENT_LIMIT, offset: 0 }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, audit: readyResource({ events: value.items, total: value.total }) })); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResources((current) => ({ ...current, audit: failedResource(error, "Recent audit events could not be loaded") })); });

    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  const pipelineSummary = useMemo(() => {
    if (resources.pipelines.status !== "ready") return null;
    const enabled = resources.pipelines.value.filter((pipeline) => pipeline.enabled).length;
    return { total: resources.pipelines.value.length, enabled, disabled: resources.pipelines.value.length - enabled };
  }, [resources.pipelines]);
  const candidateSummary = useMemo(() => {
    if (resources.candidates.status !== "ready") return null;
    const proposed = resources.candidates.value.filter((candidate) => candidate.status === "proposed").length;
    const accepted = resources.candidates.value.filter((candidate) => candidate.status === "accepted").length;
    return { proposed, accepted };
  }, [resources.candidates]);
  const writebackSummary = useMemo(() => {
    if (resources.writebacks.status !== "ready") return null;
    const awaitingApproval = resources.writebacks.value.filter((request) => request.state === "pending_approval").length;
    const succeeded = resources.writebacks.value.filter((request) => request.state === "succeeded").length;
    const failed = resources.writebacks.value.filter((request) => request.state === "failed").length;
    return { awaitingApproval, succeeded, failed };
  }, [resources.writebacks]);
  const runSummary = useMemo(() => {
    if (resources.runs.status !== "ready") return null;
    const completed = resources.runs.value.filter((run) => run.status === "completed").length;
    const processing = resources.runs.value.filter((run) => run.status === "processing").length;
    const failed = resources.runs.value.filter((run) => run.status === "failed").length;
    return { completed, processing, failed, latest: latestRun(resources.runs.value) };
  }, [resources.runs]);
  const retry = () => setReloadToken((value) => value + 1);

  return (
    <main className="section-workspace platform-workspace project-overview-workspace">
      <SectionHeading
        eyebrow="Project workspace"
        title="Overview"
        description="Read-only operational counts and governed work queues from the selected project. Cards are independently refreshed from their project-scoped APIs."
        icon={<Layers3 size={24} />}
      />
      {!context ? <LoadState message="Select an accessible tenant and project to load the project overview." /> : null}
      {context ? <>
        <div className="overview-meta" role="note"><FileClock size={15} /><span>Catalog cards read all available cursor pages, but are not one point-in-time snapshot. Recent audit events are the available project audit ledger, not a claim of complete cross-surface activity.</span></div>
        <div className="overview-metric-grid">
          <OverviewMetricCard title="Assets" icon={<Database size={19} />} resource={resources.assets} value={resources.assets.status === "ready" ? resources.assets.value.total : null} metricLabel="project assets" detail="API-reported total" destination="Explorer" onNavigate={onNavigate} onRetry={retry} />
          <OverviewMetricCard title="Sources" icon={<Database size={19} />} resource={resources.sources} value={resources.sources.status === "ready" ? resources.sources.value.length : null} metricLabel="configured sources" detail="All cursor pages read" destination="Sources" onNavigate={onNavigate} onRetry={retry} />
          <OverviewMetricCard title="Pipelines" icon={<Workflow size={19} />} resource={resources.pipelines} value={pipelineSummary?.total ?? null} metricLabel="pipeline definitions" detail={pipelineSummary ? `${pipelineSummary.enabled} enabled · ${pipelineSummary.disabled} disabled` : null} destination="Pipelines" onNavigate={onNavigate} onRetry={retry} />
          <OverviewMetricCard title="Review queue" icon={<Tags size={19} />} resource={resources.candidates} value={candidateSummary?.proposed ?? null} metricLabel="candidates awaiting review" detail={candidateSummary ? `${candidateSummary.accepted} accepted candidates` : null} destination="Context" onNavigate={onNavigate} onRetry={retry} tone={candidateSummary?.proposed ? "attention" : "neutral"} />
          <OverviewMetricCard title="Write-back queue" icon={<ShieldAlert size={19} />} resource={resources.writebacks} value={writebackSummary?.awaitingApproval ?? null} metricLabel="awaiting approval" detail={writebackSummary ? `${writebackSummary.succeeded} confirmed succeeded · ${writebackSummary.failed} failed` : null} destination="Write-back" onNavigate={onNavigate} onRetry={retry} tone="safety" />
        </div>
        <div className="overview-evidence-grid">
          <section className="overview-evidence-card" aria-label="Pipeline run evidence overview">
            <header><div><span className="overview-evidence-card__icon" aria-hidden="true"><Activity size={19} /></span><div><h2>Pipeline run evidence</h2><p>Recorded status, not inferred system health</p></div></div><button type="button" onClick={() => onNavigate("Pipelines")}>Open Pipelines<ArrowRight size={14} /></button></header>
            {resources.runs.status === "loading" ? <p className="overview-card-loading" role="status"><Activity className="spin" size={16} /> Loading run evidence…</p> : null}
            {resources.runs.status === "error" ? <ResourceError issue={resources.runs.issue} onRetry={retry} /> : null}
            {resources.runs.status === "ready" && resources.runs.value.length === 0 ? <p className="overview-card-empty">No pipeline runs have been recorded for this project.</p> : null}
            {resources.runs.status === "ready" && runSummary && resources.runs.value.length > 0 ? <><dl className="overview-run-counts"><div><dt>Completed</dt><dd>{runSummary.completed}</dd></div><div><dt>Processing</dt><dd>{runSummary.processing}</dd></div><div className={runSummary.failed > 0 ? "is-failed" : ""}><dt>Failed</dt><dd>{runSummary.failed}</dd></div></dl>{runSummary.latest ? <p className="overview-latest-run"><strong>{runSummary.latest.pipelineId}</strong><span>Most recent recorded start: {formatDate(runSummary.latest.startedAt)}</span></p> : null}</> : null}
          </section>
          <section className="overview-evidence-card" aria-label="Recent audit events overview">
            <header><div><span className="overview-evidence-card__icon" aria-hidden="true"><FileClock size={19} /></span><div><h2>Recent audit events</h2><p>Available industrial audit ledger</p></div></div><button type="button" onClick={() => onNavigate("Audit")}>Open Audit<ArrowRight size={14} /></button></header>
            {resources.audit.status === "loading" ? <p className="overview-card-loading" role="status"><Activity className="spin" size={16} /> Loading audit events…</p> : null}
            {resources.audit.status === "error" ? <ResourceError issue={resources.audit.issue} onRetry={retry} /> : null}
            {resources.audit.status === "ready" && resources.audit.value.events.length === 0 ? <p className="overview-card-empty">No audit events are available in this ledger.</p> : null}
            {resources.audit.status === "ready" && resources.audit.value.events.length > 0 ? <><ol className="overview-audit-list">{resources.audit.value.events.map((event) => <li key={event.id}><div><strong>{event.action}</strong><span>{event.actor} · {event.entityType}{event.entityId ? ` · ${event.entityId}` : ""}</span></div><time dateTime={event.timestamp}>{formatDate(event.timestamp)}</time></li>)}</ol><p className="overview-audit-total">{resources.audit.value.total} total event{resources.audit.value.total === 1 ? "" : "s"} in this ledger</p></> : null}
          </section>
        </div>
      </> : null}
    </main>
  );
}
