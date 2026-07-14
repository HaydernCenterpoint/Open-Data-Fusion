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
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  ShieldAlert,
  Tags,
  Workflow,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiRequestError,
  createPlatformConnector,
  createPlatformDataModelVersion,
  createPlatformDataset,
  createPlatformPipeline,
  createPlatformQualityRule,
  createPlatformSource,
  listPlatformCandidates,
  listPlatformConnectors,
  listPlatformDataModels,
  listPlatformDatasets,
  listPlatformPipelineRuns,
  listPlatformPipelines,
  listPlatformQualityResults,
  listPlatformQualityRules,
  listPlatformRawIngestion,
  listPlatformSources,
  listRelations,
  replayPlatformRawIngestion,
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
  PlatformQualityCheck,
  PlatformQualityResult,
  PlatformQualityRule,
  PlatformRawIngestionRecord,
  PlatformSource,
  PlatformTenant,
  RelationListResponse,
} from "../types";
import { formatDate, LoadState, SectionHeading } from "./SectionWorkspaces";

const PLATFORM_PAGE_SIZE = 30;

function platformContextKey(context: PlatformContext | null): string {
  return context ? `${context.tenantId}\u0000${context.projectId}` : "";
}

export type PlatformIssueKind = "unauthorized" | "forbidden" | "degraded";

export interface PlatformIssue {
  kind: PlatformIssueKind;
  message: string;
  retry?: () => void;
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
  const retry = issue.retry ?? onRetry;
  return (
    <div className={`platform-issue is-${issue.kind}`} role="alert">
      <Icon size={19} />
      <span>{issue.message}</span>
      {retry ? <button type="button" onClick={retry}><RefreshCw size={14} /> Retry</button> : null}
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

const platformIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const connectorTypes = ["opcua", "jdbc", "csv", "http"] as const;

type CatalogRegistrationAction = "dataset" | "source" | "connector" | "replay" | null;

type DatasetRegistration = { id: string; name: string; description?: string };
type SourceRegistration = { id: string; name: string; type: string; description?: string };
type ConnectorRegistration = { id: string; name: string; sourceId: string; type: string; configuration: Record<string, unknown>; enabled: boolean };

function registrationError(id: string, name: string): string | null {
  if (!platformIdPattern.test(id)) return "Use an identifier beginning with a letter or number; dots, colons, slashes, underscores, and dashes are allowed.";
  if (!name) return "A display name is required.";
  return null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function containsInlineCredential(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsInlineCredential);
  return Object.entries(value).some(([key, nested]) => {
    const isReference = /(?:ref|reference)$/i.test(key);
    return (!isReference && /password|secret|token|api[-_]?key|private[-_]?key|authorization|credential|cookie|session/i.test(key)) || containsInlineCredential(nested);
  });
}

function DatasetRegistrationForm({ busy, onCreate }: { busy: boolean; onCreate: (registration: DatasetRegistration) => Promise<boolean> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedDescription = description.trim();
    const error = registrationError(normalizedId, normalizedName);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    const created = await onCreate({
      id: normalizedId,
      name: normalizedName,
      ...(normalizedDescription ? { description: normalizedDescription } : {}),
    });
    if (created) {
      setId("");
      setName("");
      setDescription("");
    }
  }

  return (
    <form className="source-onboarding__form" aria-label="Register a dataset" onSubmit={(event) => void submit(event)}>
      <div className="source-onboarding__step-number" aria-hidden="true">1</div>
      <div className="source-onboarding__step-copy"><strong>Register a dataset</strong><span>Define the governed destination for curated records.</span></div>
      <label>Dataset ID<input aria-label="Dataset ID" required disabled={busy} value={id} onChange={(event) => setId(event.target.value)} placeholder="operations" /></label>
      <label>Dataset name<input aria-label="Dataset name" required disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="Operations" /></label>
      <label className="source-onboarding__span">Dataset description<textarea aria-label="Dataset description" disabled={busy} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional governed data purpose" /></label>
      {formError ? <p className="source-onboarding__form-error" role="alert">{formError}</p> : null}
      <button type="submit" className="advanced-primary-action" disabled={busy}><Plus size={14} /> {busy ? "Registering…" : "Create dataset"}</button>
    </form>
  );
}

function SourceRegistrationForm({ busy, onCreate }: { busy: boolean; onCreate: (registration: SourceRegistration) => Promise<boolean> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof connectorTypes)[number]>("opcua");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedDescription = description.trim();
    const error = registrationError(normalizedId, normalizedName);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    const created = await onCreate({
      id: normalizedId,
      name: normalizedName,
      type,
      ...(normalizedDescription ? { description: normalizedDescription } : {}),
    });
    if (created) {
      setId("");
      setName("");
      setDescription("");
    }
  }

  return (
    <form className="source-onboarding__form" aria-label="Register a source" onSubmit={(event) => void submit(event)}>
      <div className="source-onboarding__step-number" aria-hidden="true">2</div>
      <div className="source-onboarding__step-copy"><strong>Register a source</strong><span>Describe a read-only industrial system in this project.</span></div>
      <label>Source ID<input aria-label="Source ID" required disabled={busy} value={id} onChange={(event) => setId(event.target.value)} placeholder="opcua-north" /></label>
      <label>Source name<input aria-label="Source name" required disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="North OPC UA" /></label>
      <label>Source type<select aria-label="Source type" disabled={busy} value={type} onChange={(event) => setType(event.target.value as (typeof connectorTypes)[number])}>{connectorTypes.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
      <label className="source-onboarding__span">Source description<textarea aria-label="Source description" disabled={busy} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional source boundary and ownership" /></label>
      {formError ? <p className="source-onboarding__form-error" role="alert">{formError}</p> : null}
      <button type="submit" className="advanced-primary-action" disabled={busy}><Plus size={14} /> {busy ? "Registering…" : "Create source"}</button>
    </form>
  );
}

function ConnectorRegistrationForm({ sources, busy, onCreate }: { sources: PlatformSource[]; busy: boolean; onCreate: (registration: ConnectorRegistration) => Promise<boolean> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [type, setType] = useState<(typeof connectorTypes)[number]>("opcua");
  const [configuration, setConfiguration] = useState("{}");
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (sourceId && sources.some((source) => source.id === sourceId)) return;
    setSourceId(sources[0]?.id ?? "");
  }, [sourceId, sources]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const error = registrationError(normalizedId, normalizedName);
    if (error) {
      setFormError(error);
      return;
    }
    if (!sourceId) {
      setFormError("Register or select a source before adding its connector.");
      return;
    }
    let parsedConfiguration: unknown;
    try {
      parsedConfiguration = JSON.parse(configuration) as unknown;
    } catch {
      setFormError("Connector configuration must be valid JSON.");
      return;
    }
    if (!isJsonObject(parsedConfiguration)) {
      setFormError("Connector configuration must be a JSON object.");
      return;
    }
    if (containsInlineCredential(parsedConfiguration)) {
      setFormError("Use a secretRef or secretReference instead of inline credentials.");
      return;
    }
    setFormError("");
    const created = await onCreate({ id: normalizedId, name: normalizedName, sourceId, type, configuration: parsedConfiguration, enabled });
    if (created) {
      setId("");
      setName("");
      setConfiguration("{}");
      setEnabled(true);
    }
  }

  return (
    <form className="source-onboarding__form" aria-label="Register a connector" onSubmit={(event) => void submit(event)}>
      <div className="source-onboarding__step-number" aria-hidden="true">3</div>
      <div className="source-onboarding__step-copy"><strong>Register a connector</strong><span>Store configuration references; deployment remains external.</span></div>
      <label>Connector ID<input aria-label="Connector ID" required disabled={busy || sources.length === 0} value={id} onChange={(event) => setId(event.target.value)} placeholder="opcua-north-reader" /></label>
      <label>Connector name<input aria-label="Connector name" required disabled={busy || sources.length === 0} value={name} onChange={(event) => setName(event.target.value)} placeholder="North OPC UA reader" /></label>
      <label>Connector source<select aria-label="Connector source" required disabled={busy || sources.length === 0} value={sourceId} onChange={(event) => setSourceId(event.target.value)}><option value="">Select a registered source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.id}</option>)}</select></label>
      <label>Connector type<select aria-label="Connector type" disabled={busy || sources.length === 0} value={type} onChange={(event) => setType(event.target.value as (typeof connectorTypes)[number])}>{connectorTypes.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
      <label className="source-onboarding__span">Connector configuration<textarea aria-label="Connector configuration" disabled={busy || sources.length === 0} rows={4} value={configuration} onChange={(event) => setConfiguration(event.target.value)} placeholder={'{ "endpoint": "...", "secretRef": "vault://..." }'} /></label>
      <label className="source-onboarding__checkbox"><input aria-label="Connector enabled" type="checkbox" disabled={busy || sources.length === 0} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Connector enabled</label>
      {sources.length === 0 ? <p className="source-onboarding__form-error">Register a source before registering its connector.</p> : null}
      {formError ? <p className="source-onboarding__form-error" role="alert">{formError}</p> : null}
      <button type="submit" className="advanced-primary-action" disabled={busy || sources.length === 0}><Plus size={14} /> {busy ? "Registering…" : "Create connector"}</button>
    </form>
  );
}

function SourceOnboarding({
  sources,
  action,
  onCreateDataset,
  onCreateSource,
  onCreateConnector,
}: {
  sources: PlatformSource[];
  action: CatalogRegistrationAction;
  onCreateDataset: (registration: DatasetRegistration) => Promise<boolean>;
  onCreateSource: (registration: SourceRegistration) => Promise<boolean>;
  onCreateConnector: (registration: ConnectorRegistration) => Promise<boolean>;
}) {
  return (
    <section className="source-onboarding" aria-labelledby="source-onboarding-heading">
      <header className="source-onboarding__header">
        <span aria-hidden="true"><Plus size={19} /></span>
        <div><p>Data engineering</p><h2 id="source-onboarding-heading">Register source data</h2><small>Register governed catalog metadata in dependency order: dataset, source, then connector.</small></div>
      </header>
      <div className="source-onboarding__grid">
        <DatasetRegistrationForm busy={action !== null} onCreate={onCreateDataset} />
        <SourceRegistrationForm busy={action !== null} onCreate={onCreateSource} />
        <ConnectorRegistrationForm sources={sources} busy={action !== null} onCreate={onCreateConnector} />
      </div>
      <p className="source-onboarding__notice">Connector registration never deploys an edge agent or tests live connectivity. Use non-secret configuration metadata and secret references only.</p>
    </section>
  );
}

function rawStateClass(state: PlatformRawIngestionRecord["state"]): string {
  if (state === "accepted") return "status-accepted";
  if (state === "failed" || state === "quarantined") return "status-rejected";
  return "status-proposed";
}

function formatByteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function RawIngestionEvidenceRow({
  record,
  replaying,
  confirmationPending,
  onRequestReplay,
  onCancelReplay,
  onConfirmReplay,
}: {
  record: PlatformRawIngestionRecord;
  replaying: boolean;
  confirmationPending: boolean;
  onRequestReplay: () => void;
  onCancelReplay: () => void;
  onConfirmReplay: () => void;
}) {
  return (
    <li className="ingestion-evidence-row">
      <div className="ingestion-evidence-row__summary">
        <div><strong>{record.sourceSystem}</strong><span>{record.runId}</span></div><span className={`status-chip ${rawStateClass(record.state)}`}>{record.state}</span>
      </div>
      <p>{record.rawObjectUri}</p>
      <small>SHA-256 {record.sha256.slice(0, 16)}… · {formatByteSize(record.byteSize)} · {formatDate(record.createdAt)}</small>
      {record.errorSummary ? <p className="ingestion-evidence-row__error">{record.errorSummary}</p> : null}
      {record.lastReplayRunId ? <small className="ingestion-evidence-row__replay">Last replay: {record.lastReplayRunId}{record.lastReplayedAt ? ` · ${formatDate(record.lastReplayedAt)}` : ""}</small> : null}
      <div className="ingestion-evidence-row__actions">
        {confirmationPending ? <div className="ingestion-evidence-row__confirm" role="status"><span>Replay creates a new server-side ingest run from this immutable evidence.</span><button type="button" onClick={onCancelReplay} disabled={replaying}>Cancel</button><button type="button" className="advanced-primary-action" aria-label={`Confirm replay ${record.id}`} onClick={onConfirmReplay} disabled={replaying}><RefreshCw size={14} /> {replaying ? "Replaying…" : `Confirm replay ${record.id}`}</button></div> : <button type="button" className="ingestion-evidence-row__replay-button" aria-label={`Replay raw evidence ${record.id}`} onClick={onRequestReplay}><RefreshCw size={14} /> Replay raw evidence {record.id}</button>}
      </div>
    </li>
  );
}

export function SourcesWorkspace({ context }: { context: PlatformContext | null }) {
  const [sources, setSources] = useState<PageState<PlatformSource>>(() => emptyPage());
  const [connectors, setConnectors] = useState<PageState<PlatformConnector>>(() => emptyPage());
  const [datasets, setDatasets] = useState<PageState<PlatformDataset>>(() => emptyPage());
  const [rawEvidence, setRawEvidence] = useState<PageState<PlatformRawIngestionRecord>>(() => emptyPage());
  const [reloadToken, setReloadToken] = useState(0);
  const [catalogAction, setCatalogAction] = useState<CatalogRegistrationAction>(null);
  const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [replayConfirmationId, setReplayConfirmationId] = useState<string | null>(null);
  const scopeKey = platformContextKey(context);
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const isCurrentScope = (candidate: PlatformContext) => scopeKeyRef.current === platformContextKey(candidate);

  useEffect(() => {
    if (!context) {
      setSources({ ...emptyPage<PlatformSource>(), loading: false });
      setConnectors({ ...emptyPage<PlatformConnector>(), loading: false });
      setDatasets({ ...emptyPage<PlatformDataset>(), loading: false });
      setRawEvidence({ ...emptyPage<PlatformRawIngestionRecord>(), loading: false });
      setCatalogAction(null);
      setActionIssue(null);
      setActionMessage("");
      setReplayConfirmationId(null);
      return undefined;
    }
    const controller = new AbortController();
    setSources(emptyPage());
    setConnectors(emptyPage());
    setDatasets(emptyPage());
    setRawEvidence(emptyPage());
    setCatalogAction(null);
    setActionIssue(null);
    setActionMessage("");
    setReplayConfirmationId(null);
    void Promise.all([
      capture(listPlatformSources(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformConnectors(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformDatasets(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformRawIngestion(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
    ]).then(([sourceResult, connectorResult, datasetResult, rawEvidenceResult]) => {
      if (controller.signal.aborted || !isCurrentScope(context)) return;
      setSources(stateFromResult(sourceResult, "Sources could not be loaded"));
      setConnectors(stateFromResult(connectorResult, "Connectors could not be loaded"));
      setDatasets(stateFromResult(datasetResult, "Datasets could not be loaded"));
      setRawEvidence(stateFromResult(rawEvidenceResult, "Ingestion evidence could not be loaded"));
    });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  async function loadMoreSources() {
    const cursor = sources.nextCursor;
    if (!context || !cursor || sources.loadingMore) return;
    const requestContext = context;
    setSources((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformSources(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setSources((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setSources((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More sources could not be loaded"), retry: () => void loadMoreSources() } }));
    }
  }

  async function loadMoreConnectors() {
    const cursor = connectors.nextCursor;
    if (!context || !cursor || connectors.loadingMore) return;
    const requestContext = context;
    setConnectors((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformConnectors(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setConnectors((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setConnectors((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More connectors could not be loaded"), retry: () => void loadMoreConnectors() } }));
    }
  }

  async function loadMoreDatasets() {
    const cursor = datasets.nextCursor;
    if (!context || !cursor || datasets.loadingMore) return;
    const requestContext = context;
    setDatasets((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformDatasets(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setDatasets((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setDatasets((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More datasets could not be loaded"), retry: () => void loadMoreDatasets() } }));
    }
  }

  async function loadMoreRawEvidence() {
    const cursor = rawEvidence.nextCursor;
    if (!context || !cursor || rawEvidence.loadingMore) return;
    const requestContext = context;
    setRawEvidence((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformRawIngestion(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setRawEvidence((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setRawEvidence((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More ingestion evidence could not be loaded"), retry: () => void loadMoreRawEvidence() } }));
    }
  }

  async function createDataset(registration: DatasetRegistration): Promise<boolean> {
    if (!context) return false;
    const requestContext = context;
    setCatalogAction("dataset");
    setActionIssue(null);
    setActionMessage("");
    try {
      const created = await createPlatformDataset(requestContext, registration);
      if (!isCurrentScope(requestContext)) return false;
      setDatasets((state) => ({ ...state, items: [created, ...state.items.filter((item) => item.id !== created.id)], loading: false, issue: null }));
      setActionMessage(`Dataset '${created.name}' was registered in this project.`);
      return true;
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Dataset could not be registered"));
      return false;
    } finally {
      if (isCurrentScope(requestContext)) setCatalogAction(null);
    }
  }

  async function createSource(registration: SourceRegistration): Promise<boolean> {
    if (!context) return false;
    const requestContext = context;
    setCatalogAction("source");
    setActionIssue(null);
    setActionMessage("");
    try {
      const created = await createPlatformSource(requestContext, registration);
      if (!isCurrentScope(requestContext)) return false;
      setSources((state) => ({ ...state, items: [created, ...state.items.filter((item) => item.id !== created.id)], loading: false, issue: null }));
      setActionMessage(`Source '${created.name}' was registered in this project.`);
      return true;
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Source could not be registered"));
      return false;
    } finally {
      if (isCurrentScope(requestContext)) setCatalogAction(null);
    }
  }

  async function createConnector(registration: ConnectorRegistration): Promise<boolean> {
    if (!context) return false;
    const requestContext = context;
    setCatalogAction("connector");
    setActionIssue(null);
    setActionMessage("");
    try {
      const created = await createPlatformConnector(requestContext, registration);
      if (!isCurrentScope(requestContext)) return false;
      setConnectors((state) => ({ ...state, items: [created, ...state.items.filter((item) => item.id !== created.id)], loading: false, issue: null }));
      setActionMessage(`Connector '${created.name}' was registered. Its runtime remains separately deployed and configured.`);
      return true;
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Connector could not be registered"));
      return false;
    } finally {
      if (isCurrentScope(requestContext)) setCatalogAction(null);
    }
  }

  async function replayRawEvidence(rawId: string) {
    if (!context) return;
    const requestContext = context;
    setCatalogAction("replay");
    setActionIssue(null);
    setActionMessage("");
    try {
      const result = await replayPlatformRawIngestion(requestContext, rawId);
      if (!isCurrentScope(requestContext)) return;
      setRawEvidence((state) => ({ ...state, items: state.items.map((record) => record.id === rawId ? result.rawObject : record), issue: null }));
      const runId = result.runId ?? result.rawObject.lastReplayRunId ?? "a new ingest run";
      setActionMessage(`Raw evidence '${rawId}' was replayed as ${runId}.`);
      setReplayConfirmationId(null);
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Raw ingestion evidence could not be replayed"));
    } finally {
      if (isCurrentScope(requestContext)) setCatalogAction(null);
    }
  }

  const retry = () => setReloadToken((value) => value + 1);

  return (
    <main className="section-workspace platform-workspace sources-workspace">
      <SectionHeading eyebrow="Connected data" title="Sources" description="Register governed source metadata, inspect project-scoped connector references, and recover immutable ingestion evidence." icon={<Database size={24} />} />
      {!context ? <ContextRequired /> : <>
        <SourceOnboarding key={scopeKey} sources={sources.items} action={catalogAction} onCreateDataset={createDataset} onCreateSource={createSource} onCreateConnector={createConnector} />
        {actionIssue ? <IssueNotice issue={actionIssue} /> : null}
        {actionMessage ? <p className="pipeline-action-message" role="status"><Check size={15} /> {actionMessage}</p> : null}
        <div className="resource-grid">
          <section className="resource-section"><ResourceHeader icon={<Database size={18} />} title="Sources" count={sources.items.length} />{sources.loading ? <LoadState message="Loading sources…" /> : null}{sources.issue ? <IssueNotice issue={sources.issue} onRetry={retry} /> : null}{!sources.loading && !sources.issue && sources.items.length === 0 ? <PageEmpty>No sources exist in this project.</PageEmpty> : null}<ol className="resource-list">{sources.items.map((source) => <li key={source.id}><strong>{source.name}</strong><span>{source.type} · {source.id}</span><small>{source.description || "No description"}</small></li>)}</ol><CursorLoadMore cursor={sources.nextCursor} loading={sources.loadingMore} onLoad={() => void loadMoreSources()} /></section>
          <section className="resource-section"><ResourceHeader icon={<ServerCog size={18} />} title="Connectors" count={connectors.items.length} />{connectors.loading ? <LoadState message="Loading connectors…" /> : null}{connectors.issue ? <IssueNotice issue={connectors.issue} onRetry={retry} /> : null}{!connectors.loading && !connectors.issue && connectors.items.length === 0 ? <PageEmpty>No connectors exist in this project.</PageEmpty> : null}<ol className="resource-list">{connectors.items.map((connector) => <li key={connector.id}><strong>{connector.name}</strong><span>{connector.type} · source {connector.sourceId}</span><small><i className={connector.enabled ? "is-on" : ""} />{connector.enabled ? "Enabled" : "Disabled"} · {Object.keys(connector.configuration).length} configuration reference{Object.keys(connector.configuration).length === 1 ? "" : "s"}</small></li>)}</ol><CursorLoadMore cursor={connectors.nextCursor} loading={connectors.loadingMore} onLoad={() => void loadMoreConnectors()} /></section>
          <section className="resource-section"><ResourceHeader icon={<Boxes size={18} />} title="Datasets" count={datasets.items.length} />{datasets.loading ? <LoadState message="Loading datasets…" /> : null}{datasets.issue ? <IssueNotice issue={datasets.issue} onRetry={retry} /> : null}{!datasets.loading && !datasets.issue && datasets.items.length === 0 ? <PageEmpty>No datasets exist in this project.</PageEmpty> : null}<ol className="resource-list">{datasets.items.map((dataset) => <li key={dataset.id}><strong>{dataset.name}</strong><span>{dataset.id}</span><small>{dataset.description || "No description"}</small></li>)}</ol><CursorLoadMore cursor={datasets.nextCursor} loading={datasets.loadingMore} onLoad={() => void loadMoreDatasets()} /></section>
        </div>
        <section className="resource-section ingestion-evidence-section"><ResourceHeader icon={<Activity size={18} />} title="Ingestion evidence" count={rawEvidence.items.length} />{rawEvidence.loading ? <LoadState message="Loading immutable ingestion evidence…" /> : null}{rawEvidence.issue ? <IssueNotice issue={rawEvidence.issue} onRetry={retry} /> : null}{!rawEvidence.loading && !rawEvidence.issue && rawEvidence.items.length === 0 ? <PageEmpty>No raw ingestion evidence is available for this project.</PageEmpty> : null}<ol className="ingestion-evidence-list">{rawEvidence.items.map((record) => <RawIngestionEvidenceRow key={record.id} record={record} replaying={catalogAction === "replay" && replayConfirmationId === record.id} confirmationPending={replayConfirmationId === record.id} onRequestReplay={() => { setActionIssue(null); setActionMessage(""); setReplayConfirmationId(record.id); }} onCancelReplay={() => setReplayConfirmationId(null)} onConfirmReplay={() => void replayRawEvidence(record.id)} />)}</ol><CursorLoadMore cursor={rawEvidence.nextCursor} loading={rawEvidence.loadingMore} onLoad={() => void loadMoreRawEvidence()} /></section>
      </>}
    </main>
  );
}

function createRunKey(): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 12) : Date.now().toString(36);
  return `manual-${suffix}`;
}

type ModelVersionRegistration = { modelId: string; name: string; schema: Record<string, unknown>; status: "draft" | "published" };
type PipelineRegistration = { id: string; name: string; sourceId?: string; datasetId?: string; definition: Record<string, unknown>; enabled: boolean };
type QualityRuleRegistration = { id: string; name: string; targetType: string; check: PlatformQualityCheck; severity: PlatformQualityRule["severity"]; enabled: boolean };
type ProcessingCatalogAction = "pipeline" | "quality-rule" | null;
type QualityOperator = PlatformQualityCheck["operator"];

function ModelVersionRegistrationForm({ busy, onCreate }: { busy: boolean; onCreate: (registration: ModelVersionRegistration) => Promise<boolean> }) {
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [schemaText, setSchemaText] = useState('{\n  "properties": {}\n}');
  const [status, setStatus] = useState<ModelVersionRegistration["status"]>("draft");
  const [formError, setFormError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedModelId = modelId.trim();
    const normalizedName = name.trim();
    const error = registrationError(normalizedModelId, normalizedName);
    if (error) {
      setFormError(error);
      return;
    }
    let schema: unknown;
    try {
      schema = JSON.parse(schemaText) as unknown;
    } catch {
      setFormError("Model schema must be valid JSON.");
      return;
    }
    if (!isJsonObject(schema)) {
      setFormError("Model schema must be a JSON object.");
      return;
    }
    setFormError("");
    const created = await onCreate({ modelId: normalizedModelId, name: normalizedName, schema, status });
    if (created) {
      setModelId("");
      setName("");
      setSchemaText('{\n  "properties": {}\n}');
      setStatus("draft");
    }
  }

  return (
    <form className="source-onboarding__form catalog-authoring__form" aria-label="Create immutable model version" onSubmit={(event) => void submit(event)}>
      <div className="source-onboarding__step-number" aria-hidden="true"><Boxes size={14} /></div>
      <div className="source-onboarding__step-copy"><strong>Create immutable model version</strong><span>Every successful submission appends a new server-assigned version.</span></div>
      <label>Model ID<input aria-label="Model ID" required disabled={busy} value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="equipment" /></label>
      <label>Model name<input aria-label="Model name" required disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="Equipment" /></label>
      <label>Model status<select aria-label="Model status" disabled={busy} value={status} onChange={(event) => setStatus(event.target.value as ModelVersionRegistration["status"])}><option value="draft">Draft</option><option value="published">Published</option></select></label>
      <label className="source-onboarding__span">Model schema<textarea aria-label="Model schema" disabled={busy} rows={7} value={schemaText} onChange={(event) => setSchemaText(event.target.value)} spellCheck="false" /></label>
      {formError ? <p className="source-onboarding__form-error" role="alert">{formError}</p> : null}
      <button type="submit" className="advanced-primary-action" disabled={busy}><Plus size={14} /> {busy ? "Creating…" : "Create immutable version"}</button>
    </form>
  );
}

function PipelineRegistrationForm({ busy, onCreate }: { busy: boolean; onCreate: (registration: PipelineRegistration) => Promise<boolean> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [definitionText, setDefinitionText] = useState('{\n  "transform": "validate"\n}');
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedSourceId = sourceId.trim();
    const normalizedDatasetId = datasetId.trim();
    const error = registrationError(normalizedId, normalizedName);
    if (error) {
      setFormError(error);
      return;
    }
    if (normalizedSourceId && !platformIdPattern.test(normalizedSourceId)) {
      setFormError("Source ID uses the same platform identifier format as the source catalog.");
      return;
    }
    if (normalizedDatasetId && !platformIdPattern.test(normalizedDatasetId)) {
      setFormError("Dataset ID uses the same platform identifier format as the dataset catalog.");
      return;
    }
    let definition: unknown;
    try {
      definition = JSON.parse(definitionText) as unknown;
    } catch {
      setFormError("Pipeline definition must be valid JSON.");
      return;
    }
    if (!isJsonObject(definition)) {
      setFormError("Pipeline definition must be a JSON object.");
      return;
    }
    if (containsInlineCredential(definition)) {
      setFormError("Use configuration references instead of inline credentials in pipeline definitions.");
      return;
    }
    setFormError("");
    const created = await onCreate({
      id: normalizedId,
      name: normalizedName,
      ...(normalizedSourceId ? { sourceId: normalizedSourceId } : {}),
      ...(normalizedDatasetId ? { datasetId: normalizedDatasetId } : {}),
      definition,
      enabled,
    });
    if (created) {
      setId("");
      setName("");
      setSourceId("");
      setDatasetId("");
      setDefinitionText('{\n  "transform": "validate"\n}');
      setEnabled(true);
    }
  }

  return (
    <form className="source-onboarding__form catalog-authoring__form" aria-label="Create pipeline" onSubmit={(event) => void submit(event)}>
      <div className="source-onboarding__step-number" aria-hidden="true"><Workflow size={14} /></div>
      <div className="source-onboarding__step-copy"><strong>Create pipeline v1</strong><span>References are checked in the selected project; definition remains governed catalog metadata.</span></div>
      <label>Pipeline ID<input aria-label="Pipeline ID" required disabled={busy} value={id} onChange={(event) => setId(event.target.value)} placeholder="normalize-telemetry" /></label>
      <label>Pipeline name<input aria-label="Pipeline name" required disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="Normalize telemetry" /></label>
      <label>Pipeline source ID<input aria-label="Pipeline source ID" disabled={busy} value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="Optional source ID" /></label>
      <label>Pipeline dataset ID<input aria-label="Pipeline dataset ID" disabled={busy} value={datasetId} onChange={(event) => setDatasetId(event.target.value)} placeholder="Optional dataset ID" /></label>
      <label className="source-onboarding__span">Pipeline definition<textarea aria-label="Pipeline definition" disabled={busy} rows={5} value={definitionText} onChange={(event) => setDefinitionText(event.target.value)} spellCheck="false" /></label>
      <label className="source-onboarding__checkbox"><input aria-label="Pipeline enabled" type="checkbox" disabled={busy} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Pipeline enabled</label>
      {formError ? <p className="source-onboarding__form-error" role="alert">{formError}</p> : null}
      <button type="submit" className="advanced-primary-action" disabled={busy}><Plus size={14} /> {busy ? "Creating…" : "Create pipeline"}</button>
    </form>
  );
}

function QualityRuleRegistrationForm({ busy, onCreate }: { busy: boolean; onCreate: (registration: QualityRuleRegistration) => Promise<boolean> }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState("pipeline");
  const [operator, setOperator] = useState<QualityOperator>("required");
  const [field, setField] = useState("");
  const [valueText, setValueText] = useState("");
  const [severity, setSeverity] = useState<PlatformQualityRule["severity"]>("error");
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedId = id.trim();
    const normalizedName = name.trim();
    const normalizedTargetType = targetType.trim();
    const normalizedField = field.trim();
    const error = registrationError(normalizedId, normalizedName);
    if (error) {
      setFormError(error);
      return;
    }
    if (!normalizedTargetType) {
      setFormError("A target type is required.");
      return;
    }
    if (!normalizedField) {
      setFormError("A field path is required.");
      return;
    }
    let check: PlatformQualityCheck;
    if (operator === "required") {
      check = { operator, field: normalizedField };
    } else if (operator === "equals") {
      let value: unknown;
      try {
        value = JSON.parse(valueText);
      } catch {
        setFormError("An equals check value must be valid JSON.");
        return;
      }
      check = { operator, field: normalizedField, value };
    } else {
      const value = Number(valueText);
      if (!Number.isFinite(value)) {
        setFormError("A gte or lte check requires a finite numeric value.");
        return;
      }
      check = { operator, field: normalizedField, value };
    }
    setFormError("");
    const created = await onCreate({ id: normalizedId, name: normalizedName, targetType: normalizedTargetType, check, severity, enabled });
    if (created) {
      setId("");
      setName("");
      setTargetType("pipeline");
      setOperator("required");
      setField("");
      setValueText("");
      setSeverity("error");
      setEnabled(true);
    }
  }

  return (
    <form className="source-onboarding__form catalog-authoring__form" aria-label="Create quality rule" onSubmit={(event) => void submit(event)}>
      <div className="source-onboarding__step-number" aria-hidden="true"><ShieldAlert size={14} /></div>
      <div className="source-onboarding__step-copy"><strong>Create quality rule</strong><span>Rules are create-once and the legacy contract evaluates enabled rules for project runs.</span></div>
      <label>Quality rule ID<input aria-label="Quality rule ID" required disabled={busy} value={id} onChange={(event) => setId(event.target.value)} placeholder="temperature-minimum" /></label>
      <label>Quality rule name<input aria-label="Quality rule name" required disabled={busy} value={name} onChange={(event) => setName(event.target.value)} placeholder="Minimum temperature" /></label>
      <label>Quality target type<input aria-label="Quality target type" required disabled={busy} value={targetType} onChange={(event) => setTargetType(event.target.value)} placeholder="pipeline" /></label>
      <label>Quality check operator<select aria-label="Quality check operator" disabled={busy} value={operator} onChange={(event) => setOperator(event.target.value as QualityOperator)}><option value="required">Required</option><option value="equals">Equals</option><option value="gte">Greater than or equal</option><option value="lte">Less than or equal</option></select></label>
      <label>Quality check field<input aria-label="Quality check field" required disabled={busy} value={field} onChange={(event) => setField(event.target.value)} placeholder="temperature" /></label>
      {operator !== "required" ? <label>Quality check value<input aria-label="Quality check value" required disabled={busy} value={valueText} onChange={(event) => setValueText(event.target.value)} placeholder={operator === "equals" ? '"expected value"' : "0"} /></label> : null}
      <label>Quality severity<select aria-label="Quality severity" disabled={busy} value={severity} onChange={(event) => setSeverity(event.target.value as PlatformQualityRule["severity"])}><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select></label>
      <label className="source-onboarding__checkbox"><input aria-label="Quality rule enabled" type="checkbox" disabled={busy} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Quality rule enabled</label>
      {formError ? <p className="source-onboarding__form-error" role="alert">{formError}</p> : null}
      <button type="submit" className="advanced-primary-action" disabled={busy}><Plus size={14} /> {busy ? "Creating…" : "Create quality rule"}</button>
    </form>
  );
}

function ProcessingConfiguration({
  action,
  onCreatePipeline,
  onCreateQualityRule,
}: {
  action: ProcessingCatalogAction;
  onCreatePipeline: (registration: PipelineRegistration) => Promise<boolean>;
  onCreateQualityRule: (registration: QualityRuleRegistration) => Promise<boolean>;
}) {
  return (
    <section className="source-onboarding catalog-authoring catalog-authoring--processing" aria-labelledby="processing-configuration-heading">
      <header className="source-onboarding__header">
        <span aria-hidden="true"><Workflow size={19} /></span>
        <div><p>Governed processing</p><h2 id="processing-configuration-heading">Configure processing</h2><small>Create project-scoped v1 pipelines and append-only quality rules. Runtime execution remains bounded by the configured server profile.</small></div>
      </header>
      <div className="source-onboarding__grid">
        <PipelineRegistrationForm busy={action !== null} onCreate={onCreatePipeline} />
        <QualityRuleRegistrationForm busy={action !== null} onCreate={onCreateQualityRule} />
      </div>
      <p className="source-onboarding__notice">Pipeline definitions are immutable catalog metadata, not browser-managed workflow runtimes. Quality target types document intent; they do not scope legacy rule execution. Do not place credentials in a pipeline definition.</p>
    </section>
  );
}

function qualityCheckDescription(check: PlatformQualityCheck): string {
  if (check.operator === "required") return `${check.field} is required`;
  if (check.operator === "equals") return `${check.field} equals ${JSON.stringify(check.value)}`;
  return `${check.field} ${check.operator} ${check.value}`;
}

function PipelineRow({ pipeline, busy, catalogBusy, onRun }: { pipeline: PlatformPipeline; busy: boolean; catalogBusy: boolean; onRun: (pipeline: PlatformPipeline, key: string, input: Record<string, unknown>) => Promise<void> }) {
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
      <small>Source {pipeline.sourceId || "—"} · Dataset {pipeline.datasetId || "—"} · Legacy runs use the configured server contract, not this catalog definition.</small>
      <form className="pipeline-run-form" onSubmit={(event) => void submit(event)}>
        <label>Idempotency key<input aria-label={`Idempotency key for ${pipeline.name}`} required value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} /></label>
        <label>Run input<textarea aria-label={`Run input for ${pipeline.name}`} rows={2} value={inputText} onChange={(event) => setInputText(event.target.value)} /></label>
        {inputError ? <span className="pipeline-input-error" role="alert">{inputError}</span> : null}
        <button type="submit" disabled={busy || catalogBusy || !pipeline.enabled || !idempotencyKey.trim()}><Play size={14} /> {busy ? "Running…" : "Trigger legacy run"}</button>
      </form>
    </li>
  );
}

export function PipelinesWorkspace({ context }: { context: PlatformContext | null }) {
  const [pipelines, setPipelines] = useState<PageState<PlatformPipeline>>(() => emptyPage());
  const [runs, setRuns] = useState<PageState<PlatformPipelineRun>>(() => emptyPage());
  const [quality, setQuality] = useState<PageState<PlatformQualityResult>>(() => emptyPage());
  const [qualityRules, setQualityRules] = useState<PageState<PlatformQualityRule>>(() => emptyPage());
  const [reloadToken, setReloadToken] = useState(0);
  const [runningPipeline, setRunningPipeline] = useState<string | null>(null);
  const [catalogAction, setCatalogAction] = useState<ProcessingCatalogAction>(null);
  const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const scopeKey = platformContextKey(context);
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const isCurrentScope = (candidate: PlatformContext) => scopeKeyRef.current === platformContextKey(candidate);

  useEffect(() => {
    if (!context) {
      setPipelines({ ...emptyPage<PlatformPipeline>(), loading: false });
      setRuns({ ...emptyPage<PlatformPipelineRun>(), loading: false });
      setQuality({ ...emptyPage<PlatformQualityResult>(), loading: false });
      setQualityRules({ ...emptyPage<PlatformQualityRule>(), loading: false });
      setRunningPipeline(null);
      setCatalogAction(null);
      setActionIssue(null);
      setActionMessage("");
      return undefined;
    }
    const controller = new AbortController();
    setPipelines(emptyPage());
    setRuns(emptyPage());
    setQuality(emptyPage());
    setQualityRules(emptyPage());
    setRunningPipeline(null);
    setCatalogAction(null);
    setActionIssue(null);
    setActionMessage("");
    void Promise.all([
      capture(listPlatformPipelines(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformPipelineRuns(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformQualityResults(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
      capture(listPlatformQualityRules(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)),
    ]).then(([pipelineResult, runResult, qualityResult, qualityRuleResult]) => {
      if (controller.signal.aborted || !isCurrentScope(context)) return;
      setPipelines(stateFromResult(pipelineResult, "Pipelines could not be loaded"));
      setRuns(stateFromResult(runResult, "Pipeline runs could not be loaded"));
      setQuality(stateFromResult(qualityResult, "Quality results could not be loaded"));
      setQualityRules(stateFromResult(qualityRuleResult, "Quality rules could not be loaded"));
    });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  async function createPipeline(registration: PipelineRegistration): Promise<boolean> {
    if (!context) return false;
    const requestContext = context;
    setCatalogAction("pipeline");
    setActionIssue(null);
    setActionMessage("");
    try {
      const created = await createPlatformPipeline(requestContext, registration);
      if (!isCurrentScope(requestContext)) return false;
      setPipelines((state) => ({
        ...state,
        items: [created, ...state.items.filter((pipeline) => pipeline.id !== created.id)],
        loading: false,
        issue: null,
      }));
      setActionMessage(`Pipeline '${created.name}' was created as a v1 catalog record. Its configured runtime determines whether and how it executes.`);
      return true;
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Pipeline could not be created"));
      return false;
    } finally {
      if (isCurrentScope(requestContext)) setCatalogAction(null);
    }
  }

  async function createQualityRule(registration: QualityRuleRegistration): Promise<boolean> {
    if (!context) return false;
    const requestContext = context;
    setCatalogAction("quality-rule");
    setActionIssue(null);
    setActionMessage("");
    try {
      const created = await createPlatformQualityRule(requestContext, registration);
      if (!isCurrentScope(requestContext)) return false;
      setQualityRules((state) => ({
        ...state,
        items: [created, ...state.items.filter((rule) => rule.id !== created.id)],
        loading: false,
        issue: null,
      }));
      setActionMessage(`Quality rule '${created.name}' was created as an append-only catalog rule. Its target type does not scope legacy rule execution.`);
      return true;
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Quality rule could not be created"));
      return false;
    } finally {
      if (isCurrentScope(requestContext)) setCatalogAction(null);
    }
  }

  async function runPipeline(pipeline: PlatformPipeline, key: string, input: Record<string, unknown>) {
    if (!context) return;
    const requestContext = context;
    setRunningPipeline(pipeline.id);
    setActionIssue(null);
    setActionMessage("");
    try {
      const run = await triggerPlatformPipelineRun(requestContext, pipeline.id, { idempotencyKey: key, input });
      if (!isCurrentScope(requestContext)) return;
      setActionMessage(run.replayed
        ? `Existing run ${run.id} replayed (${run.status})`
        : `New run ${run.id} is ${run.status}`);
      const [runResult, qualityResult] = await Promise.all([
        capture(listPlatformPipelineRuns(requestContext, { limit: PLATFORM_PAGE_SIZE })),
        capture(listPlatformQualityResults(requestContext, { limit: PLATFORM_PAGE_SIZE })),
      ]);
      if (!isCurrentScope(requestContext)) return;
      if (runResult.ok) setRuns({ items: runResult.value.items, nextCursor: runResult.value.nextCursor, loading: false, loadingMore: false, issue: null });
      else setRuns((state) => ({ ...state, issue: platformIssue(runResult.error, "Run history could not be refreshed") }));
      if (qualityResult.ok) setQuality({ items: qualityResult.value.items, nextCursor: qualityResult.value.nextCursor, loading: false, loadingMore: false, issue: null });
      else setQuality((state) => ({ ...state, issue: platformIssue(qualityResult.error, "Quality results could not be refreshed") }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Pipeline run could not be started"));
    } finally {
      if (isCurrentScope(requestContext)) setRunningPipeline(null);
    }
  }

  async function loadMorePipelines() {
    const cursor = pipelines.nextCursor;
    if (!context || !cursor || pipelines.loadingMore) return;
    const requestContext = context;
    setPipelines((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformPipelines(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setPipelines((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setPipelines((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More pipelines could not be loaded"), retry: () => void loadMorePipelines() } }));
    }
  }

  async function loadMoreRuns() {
    const cursor = runs.nextCursor;
    if (!context || !cursor || runs.loadingMore) return;
    const requestContext = context;
    setRuns((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformPipelineRuns(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setRuns((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setRuns((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More runs could not be loaded"), retry: () => void loadMoreRuns() } }));
    }
  }

  async function loadMoreQuality() {
    const cursor = quality.nextCursor;
    if (!context || !cursor || quality.loadingMore) return;
    const requestContext = context;
    setQuality((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformQualityResults(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setQuality((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setQuality((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More quality results could not be loaded"), retry: () => void loadMoreQuality() } }));
    }
  }

  async function loadMoreQualityRules() {
    const cursor = qualityRules.nextCursor;
    if (!context || !cursor || qualityRules.loadingMore) return;
    const requestContext = context;
    setQualityRules((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformQualityRules(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setQualityRules((state) => ({ ...state, items: mergePage(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setQualityRules((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More quality rules could not be loaded"), retry: () => void loadMoreQualityRules() } }));
    }
  }

  const retry = () => setReloadToken((value) => value + 1);

  return (
    <main className="section-workspace platform-workspace">
      <SectionHeading eyebrow="Operational processing" title="Pipelines" description="Register versioned pipeline catalog records, trigger configured legacy runs with explicit idempotency, and inspect immutable evidence." icon={<Workflow size={24} />} />
      {!context ? <ContextRequired /> : <div className="pipeline-layout">
        {actionIssue ? <IssueNotice issue={actionIssue} /> : null}
        {actionMessage ? <p className="pipeline-action-message" role="status"><Check size={15} /> {actionMessage}</p> : null}
        <ProcessingConfiguration key={scopeKey} action={catalogAction} onCreatePipeline={createPipeline} onCreateQualityRule={createQualityRule} />
        <section className="resource-section"><ResourceHeader icon={<Workflow size={18} />} title="Pipeline definitions" count={pipelines.items.length} />{pipelines.loading ? <LoadState message="Loading pipelines…" /> : null}{pipelines.issue ? <IssueNotice issue={pipelines.issue} onRetry={retry} /> : null}{!pipelines.loading && !pipelines.issue && pipelines.items.length === 0 ? <PageEmpty>No pipelines exist in this project.</PageEmpty> : null}<ol className="resource-list pipeline-list">{pipelines.items.map((pipeline) => <PipelineRow key={pipeline.id} pipeline={pipeline} busy={runningPipeline === pipeline.id} catalogBusy={catalogAction !== null} onRun={runPipeline} />)}</ol><CursorLoadMore cursor={pipelines.nextCursor} loading={pipelines.loadingMore} onLoad={() => void loadMorePipelines()} /></section>
        <section className="resource-section"><ResourceHeader icon={<ShieldAlert size={18} />} title="Quality rules" count={qualityRules.items.length} />{qualityRules.loading ? <LoadState message="Loading quality rules…" /> : null}{qualityRules.issue ? <IssueNotice issue={qualityRules.issue} onRetry={retry} /> : null}{!qualityRules.loading && !qualityRules.issue && qualityRules.items.length === 0 ? <PageEmpty>No quality rules exist in this project.</PageEmpty> : null}<ol className="resource-list quality-rule-list">{qualityRules.items.map((rule) => <li key={rule.id} className="quality-rule-row"><div><strong>{rule.name}</strong><span>{rule.id} · target {rule.targetType}</span></div><span className={`status-chip ${rule.enabled ? "status-accepted" : "status-superseded"}`}>{rule.enabled ? "enabled" : "disabled"}</span><small className="quality-rule-row__check">{qualityCheckDescription(rule.check)} · {rule.severity} severity</small><small>Created by {rule.createdBy} · {formatDate(rule.createdAt)}</small></li>)}</ol><CursorLoadMore cursor={qualityRules.nextCursor} loading={qualityRules.loadingMore} onLoad={() => void loadMoreQualityRules()} /></section>
        <section className="resource-section"><ResourceHeader icon={<Activity size={18} />} title="Run history" count={runs.items.length} />{runs.loading ? <LoadState message="Loading pipeline runs…" /> : null}{runs.issue ? <IssueNotice issue={runs.issue} onRetry={retry} /> : null}{!runs.loading && !runs.issue && runs.items.length === 0 ? <PageEmpty>No pipeline runs have been recorded.</PageEmpty> : null}<ol className="resource-list">{runs.items.map((run) => <li key={run.id}><strong>{run.pipelineId}</strong><span>{run.status} · {run.idempotencyKey}</span><small>{run.triggeredBy} · {formatDate(run.startedAt)}{run.replayed ? " · replayed" : ""}</small></li>)}</ol><CursorLoadMore cursor={runs.nextCursor} loading={runs.loadingMore} onLoad={() => void loadMoreRuns()} /></section>
        <section className="resource-section"><ResourceHeader icon={<ShieldAlert size={18} />} title="Quality results" count={quality.items.length} />{quality.loading ? <LoadState message="Loading quality results…" /> : null}{quality.issue ? <IssueNotice issue={quality.issue} onRetry={retry} /> : null}{!quality.loading && !quality.issue && quality.items.length === 0 ? <PageEmpty>No quality results have been recorded.</PageEmpty> : null}<ol className="resource-list">{quality.items.map((result) => <li key={result.id}><strong>{result.ruleId}</strong><span className={result.passed ? "quality-pass" : "quality-fail"}>{result.passed ? "Passed" : "Failed"} · run {result.runId}</span><small>{formatDate(result.evaluatedAt)}</small></li>)}</ol><CursorLoadMore cursor={quality.nextCursor} loading={quality.loadingMore} onLoad={() => void loadMoreQuality()} /></section>
      </div>}
    </main>
  );
}

export function ModelsWorkspace({ context }: { context: PlatformContext | null }) {
  const [models, setModels] = useState<PageState<PlatformDataModel>>(() => emptyPage());
  const [reloadToken, setReloadToken] = useState(0);
  const [creatingModel, setCreatingModel] = useState(false);
  const [actionIssue, setActionIssue] = useState<PlatformIssue | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const scopeKey = platformContextKey(context);
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const isCurrentScope = (candidate: PlatformContext) => scopeKeyRef.current === platformContextKey(candidate);

  useEffect(() => {
    if (!context) {
      setModels({ ...emptyPage<PlatformDataModel>(), loading: false });
      setCreatingModel(false);
      setActionIssue(null);
      setActionMessage("");
      return undefined;
    }
    const controller = new AbortController();
    setModels(emptyPage());
    setCreatingModel(false);
    setActionIssue(null);
    setActionMessage("");
    listPlatformDataModels(context, { limit: PLATFORM_PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted && isCurrentScope(context)) setModels({ items: page.items, nextCursor: page.nextCursor, loading: false, loadingMore: false, issue: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && isCurrentScope(context)) setModels({ items: [], nextCursor: null, loading: false, loadingMore: false, issue: platformIssue(error, "Data models could not be loaded") });
      });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  async function createModelVersion(registration: ModelVersionRegistration): Promise<boolean> {
    if (!context) return false;
    const requestContext = context;
    setCreatingModel(true);
    setActionIssue(null);
    setActionMessage("");
    try {
      const created = await createPlatformDataModelVersion(requestContext, registration.modelId, {
        name: registration.name,
        schema: registration.schema,
        status: registration.status,
      });
      if (!isCurrentScope(requestContext)) return false;
      setModels((state) => ({
        ...state,
        items: [created, ...state.items.filter((model) => `${model.id}@${model.version}` !== `${created.id}@${created.version}`)],
        loading: false,
        issue: null,
      }));
      setActionMessage(`Model '${created.name}' was created as immutable version ${created.version}.`);
      return true;
    } catch (error) {
      if (isCurrentScope(requestContext)) setActionIssue(platformIssue(error, "Model version could not be created"));
      return false;
    } finally {
      if (isCurrentScope(requestContext)) setCreatingModel(false);
    }
  }

  async function loadMore() {
    const cursor = models.nextCursor;
    if (!context || !cursor || models.loadingMore) return;
    const requestContext = context;
    setModels((state) => ({ ...state, loadingMore: true, issue: null }));
    try {
      const page = await listPlatformDataModels(requestContext, { limit: PLATFORM_PAGE_SIZE, cursor });
      if (!isCurrentScope(requestContext)) return;
      setModels((state) => ({ ...state, items: mergeModels(state.items, page.items), nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (isCurrentScope(requestContext)) setModels((state) => ({ ...state, loadingMore: false, issue: { ...platformIssue(error, "More model versions could not be loaded"), retry: () => void loadMore() } }));
    }
  }

  return (
    <main className="section-workspace platform-workspace">
      <SectionHeading eyebrow="Canonical semantics" title="Models" description="Inspect append-only model versions and their immutable schemas in the selected project." icon={<Boxes size={24} />} />
      {!context ? <ContextRequired /> : <>
        <section className="source-onboarding catalog-authoring catalog-authoring--model" aria-labelledby="model-version-registration-heading">
          <header className="source-onboarding__header">
            <span aria-hidden="true"><Boxes size={19} /></span>
            <div><p>Canonical semantics</p><h2 id="model-version-registration-heading">Create immutable model version</h2><small>Each accepted submission appends a server-assigned version. Existing versions are never edited, deleted, or transitioned from this workspace.</small></div>
          </header>
          <div className="source-onboarding__grid"><ModelVersionRegistrationForm key={scopeKey} busy={creatingModel} onCreate={createModelVersion} /></div>
          <p className="source-onboarding__notice">Review the schema and status before creating it: the submitted version remains immutable after creation.</p>
        </section>
        {actionIssue ? <IssueNotice issue={actionIssue} /> : null}
        {actionMessage ? <p className="pipeline-action-message" role="status"><Check size={15} /> {actionMessage}</p> : null}
        <section className="resource-section models-section"><ResourceHeader icon={<Boxes size={18} />} title="Immutable model versions" count={models.items.length} />{models.loading ? <LoadState message="Loading model versions…" /> : null}{models.issue ? <IssueNotice issue={models.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!models.loading && !models.issue && models.items.length === 0 ? <PageEmpty>No model versions exist in this project.</PageEmpty> : null}<ol className="model-version-list">{models.items.map((model) => <li key={`${model.id}@${model.version}`}><div><strong>{model.name}</strong><span>{model.id} · version {model.version}</span></div><span className={`status-chip status-${model.status === "published" ? "accepted" : "proposed"}`}>{model.status}</span><small>Created by {model.createdBy} · {formatDate(model.createdAt)}</small><details><summary>Immutable schema</summary><pre>{JSON.stringify(model.schema, null, 2)}</pre></details></li>)}</ol><CursorLoadMore cursor={models.nextCursor} loading={models.loadingMore} onLoad={() => void loadMore()} /></section>
      </>}
    </main>
  );
}

function PlatformCandidateRow({ candidate, busy, onReview }: { candidate: PlatformContextCandidate; busy: boolean; onReview: (candidate: PlatformContextCandidate, decision: "accepted" | "rejected", comment: string) => void }) {
  const [pendingDecision, setPendingDecision] = useState<"accepted" | "rejected" | null>(null);
  const [comment, setComment] = useState("");

  return (
    <li className="governance-list-row platform-candidate-row">
      <div className="relation-route"><strong>{candidate.source.id}</strong><span><GitBranch size={14} /> {candidate.relationType}</span><strong>{candidate.target.id}</strong></div>
      <div className="governance-row-meta"><span className={`status-chip status-${candidate.status}`}>{candidate.status}</span><span>{Math.round(candidate.confidence * 100)}% confidence</span><span>{candidate.source.type} → {candidate.target.type}</span><span>{candidate.reviewedBy ? `Reviewed by ${candidate.reviewedBy}` : `Proposed by ${candidate.createdBy}`}</span></div>
      {Object.keys(candidate.evidence).length > 0 ? <details><summary>Evidence</summary><pre>{JSON.stringify(candidate.evidence, null, 2)}</pre></details> : null}
      {candidate.status === "proposed" ? <div className="candidate-review"><div className="candidate-actions"><button type="button" disabled={busy} aria-pressed={pendingDecision === "accepted"} onClick={() => setPendingDecision("accepted")}><Check size={14} /> Accept</button><button type="button" disabled={busy} aria-pressed={pendingDecision === "rejected"} onClick={() => setPendingDecision("rejected")}><X size={14} /> Reject</button></div>{pendingDecision ? <div className="candidate-confirmation"><label>Review evidence<textarea rows={2} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Optional decision rationale" /></label><div><button type="button" disabled={busy} onClick={() => onReview(candidate, pendingDecision, comment)}>{busy ? "Saving…" : `Confirm ${pendingDecision === "accepted" ? "accept" : "reject"}`}</button><button type="button" disabled={busy} onClick={() => { setPendingDecision(null); setComment(""); }}>Cancel</button></div></div> : null}</div> : null}
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
      context ? capture(listRelations(context, { limit: 200 }, controller.signal)) : Promise.resolve<Captured<RelationListResponse> | null>(null),
    ]).then(([candidateResult, legacyResult]) => {
      if (controller.signal.aborted) return;
      if (candidateResult) setCandidates(stateFromResult(candidateResult, "Context candidates could not be loaded"));
      if (legacyResult?.ok) setLegacyRelations(legacyResult.value.items);
      else if (legacyResult) { setLegacyRelations([]); setLegacyIssue(platformIssue(legacyResult.error, "Legacy relations could not be loaded")); }
      else setLegacyRelations([]);
    });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, reloadToken]);

  const filteredCandidates = useMemo(() => !deferredQuery ? candidates.items : candidates.items.filter((candidate) => `${candidate.source.id} ${candidate.target.id} ${candidate.relationType} ${candidate.status}`.toLowerCase().includes(deferredQuery)), [candidates.items, deferredQuery]);
  const filteredLegacy = useMemo(() => !deferredQuery ? legacyRelations : legacyRelations.filter((relation) => `${relation.source.externalId} ${relation.target.externalId} ${relation.type} ${relation.status}`.toLowerCase().includes(deferredQuery)), [deferredQuery, legacyRelations]);

  async function review(candidate: PlatformContextCandidate, decision: "accepted" | "rejected", comment: string) {
    if (!context) return;
    setReviewing(candidate.id);
    setReviewIssue(null);
    try {
      const updated = await reviewPlatformCandidate(context, candidate.id, { decision, ...(comment.trim() ? { comment: comment.trim() } : {}) });
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
      <section className="resource-section context-primary"><ResourceHeader icon={<Tags size={18} />} title="Platform candidates" count={filteredCandidates.length} />{candidates.loading ? <LoadState message="Loading contextualization candidates…" /> : null}{candidates.issue ? <IssueNotice issue={candidates.issue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{reviewIssue ? <IssueNotice issue={reviewIssue} /> : null}{!candidates.loading && !candidates.issue && filteredCandidates.length === 0 ? <PageEmpty>{query ? "No candidates match this filter." : "No platform candidates exist in this project."}</PageEmpty> : null}<ol className="governance-list">{filteredCandidates.map((candidate) => <PlatformCandidateRow key={candidate.id} candidate={candidate} busy={reviewing === candidate.id} onReview={review} />)}</ol><CursorLoadMore cursor={candidates.nextCursor} loading={candidates.loadingMore} onLoad={() => void loadMoreCandidates()} /></section>
      <section className="resource-section legacy-context-section"><ResourceHeader icon={<GitBranch size={18} />} title="Legacy relation projection" count={filteredLegacy.length} />{legacyIssue ? <IssueNotice issue={legacyIssue} onRetry={() => setReloadToken((value) => value + 1)} /> : null}{!legacyIssue && filteredLegacy.length === 0 ? <PageEmpty>{query ? "No legacy relations match this filter." : "No legacy relations are available."}</PageEmpty> : null}<ol className="governance-list">{filteredLegacy.map((relation) => <LegacyRelationRow key={relation.id} relation={relation} onOpenAsset={onOpenAsset} />)}</ol></section>
    </main>
  );
}
