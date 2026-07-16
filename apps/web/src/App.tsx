import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AssetTree } from "./components/AssetTree";
import { AssetWorkspace } from "./components/AssetWorkspace";
import { DiagramsWorkspace, MatchingWorkspace, SpatialWorkspace, WritebackWorkspace } from "./components/AdvancedPlatformWorkspaces";
import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { DataExplorerWorkspace } from "./components/DataExplorerWorkspace";
import { IngestModal } from "./components/IngestModal";
import { ProjectOverviewWorkspace } from "./components/ProjectOverviewWorkspace";
import { RelatedRail } from "./components/RelatedRail";
import {
  ModelsWorkspace,
  PipelinesWorkspace,
  PlatformContextBar,
  PlatformContextWorkspace,
  SourcesWorkspace,
  platformIssue,
  type PlatformBootstrapState,
} from "./components/PlatformWorkspaces";
import { AuditWorkspace } from "./components/SectionWorkspaces";
import { Sidebar, type NavigationLabel } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { getExplorerSnapshot, getHealth, getWorkspace, listAssets, listPlatformProjects, listPlatformTenants } from "./lib/api";
import { commitAppRoute, readAppRoute, type AppRoute, type AppRouteHistoryMode, type AppViewMode } from "./lib/appRoute";
import type { ApiAsset, ApiWorkspace, CursorPage, ExplorerSnapshot, PlatformContext, PlatformProject, PlatformSearchResult, PlatformTenant } from "./types";

type ViewMode = AppViewMode;

const ASSET_PAGE_SIZE = 100;
const CONFIGURED_WORKSPACE_ID = (
  import.meta.env.VITE_WORKSPACE_ID
  || (import.meta.env.MODE === "test" ? "cooling-water-system" : "")
).trim();

const viewByNavigation: Record<NavigationLabel, Exclude<ViewMode, "canvas">> = {
  Overview: "overview",
  Explorer: "explorer",
  Sources: "sources",
  Pipelines: "pipelines",
  Models: "models",
  Context: "context",
  Diagrams: "diagrams",
  Matching: "matching",
  Spatial: "spatial",
  "Write-back": "writeback",
  Audit: "audit",
};

const navigationByView: Record<Exclude<ViewMode, "canvas">, NavigationLabel> = {
  overview: "Overview",
  explorer: "Explorer",
  sources: "Sources",
  pipelines: "Pipelines",
  models: "Models",
  context: "Context",
  diagrams: "Diagrams",
  matching: "Matching",
  spatial: "Spatial",
  writeback: "Write-back",
  audit: "Audit",
};

type Captured<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function capture<T>(promise: Promise<T>): Promise<Captured<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type CursorPageRequest<T> = (
  query: { limit?: number; cursor?: string },
  signal?: AbortSignal,
) => Promise<CursorPage<T>>;

async function collectCursorPages<T>(requestPage: CursorPageRequest<T>, signal?: AbortSignal): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await requestPage({ limit: 100, ...(cursor ? { cursor } : {}) }, signal);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seenCursors.has(page.nextCursor)) throw new Error("The platform returned a repeated discovery cursor");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export default function App() {
  const initialRouteRef = useRef(readAppRoute());
  const routeRef = useRef<AppRoute>(initialRouteRef.current);
  const [route, setRoute] = useState<AppRoute>(initialRouteRef.current);
  const [query, setQuery] = useState(initialRouteRef.current.searchQuery ?? "");
  const [viewMode, setViewMode] = useState<ViewMode>(initialRouteRef.current.view);
  const [treeVisible, setTreeVisible] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 791px)").matches);
  const [relatedRailOpen, setRelatedRailOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1320px)").matches);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1320px)").matches);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [assets, setAssets] = useState<ApiAsset[]>([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetsLoadingMore, setAssetsLoadingMore] = useState(false);
  const [assetsError, setAssetsError] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState(initialRouteRef.current.assetId ?? "");
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot | null>(null);
  const [explorerLoading, setExplorerLoading] = useState(false);
  const [explorerError, setExplorerError] = useState("");
  const [workspace, setWorkspace] = useState<ApiWorkspace | null>(null);
  const [platformTenants, setPlatformTenants] = useState<PlatformTenant[]>([]);
  const [platformProjects, setPlatformProjects] = useState<PlatformProject[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState(initialRouteRef.current.tenantId ?? "");
  const [platformContext, setPlatformContext] = useState<PlatformContext | null>(null);
  const [platformBootstrap, setPlatformBootstrap] = useState<PlatformBootstrapState>({ status: "loading", message: "Discovering accessible projects…" });
  const [toast, setToast] = useState("");
  const explorerRequestRef = useRef<AbortController | null>(null);
  const projectRequestRef = useRef<AbortController | null>(null);
  const workspaceRequestRef = useRef<AbortController | null>(null);
  const workspaceTenantId = platformContext?.tenantId ?? "";
  const workspaceProjectId = platformContext?.projectId ?? "";

  const updateRoute = useCallback((patch: Partial<AppRoute>, mode: AppRouteHistoryMode = "push") => {
    const nextRoute: AppRoute = { ...routeRef.current, ...patch };
    if (nextRoute.view !== "explorer") {
      delete nextRoute.assetId;
      delete nextRoute.searchQuery;
      delete nextRoute.resultType;
      delete nextRoute.resultId;
    } else if (nextRoute.searchQuery) {
      delete nextRoute.assetId;
      if (!nextRoute.resultType || !nextRoute.resultId) {
        delete nextRoute.resultType;
        delete nextRoute.resultId;
      }
    } else {
      delete nextRoute.searchQuery;
      delete nextRoute.resultType;
      delete nextRoute.resultId;
    }
    if (!nextRoute.tenantId) delete nextRoute.projectId;
    routeRef.current = nextRoute;
    setRoute(nextRoute);
    commitAppRoute(nextRoute, mode);
  }, []);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }, []);

  const acceptWorkspace = useCallback((nextWorkspace: ApiWorkspace) => {
    setWorkspace((current) => !current || nextWorkspace.version >= current.version ? nextWorkspace : current);
  }, []);

  const invalidateScopedData = useCallback(() => {
    explorerRequestRef.current?.abort();
    workspaceRequestRef.current?.abort();
    setWorkspace(null);
    setAssets([]);
    setAssetTotal(0);
    setAssetsLoading(false);
    setAssetsLoadingMore(false);
    setAssetsError("");
    setSelectedAssetId("");
    setSnapshot(null);
    setExplorerLoading(false);
    setExplorerError("");
    setRelatedRailOpen(false);
  }, []);

  const loadExplorerAsset = useCallback(async (externalId: string) => {
    if (!workspaceTenantId || !workspaceProjectId) return;
    const context = { tenantId: workspaceTenantId, projectId: workspaceProjectId };
    explorerRequestRef.current?.abort();
    const controller = new AbortController();
    explorerRequestRef.current = controller;
    setSelectedAssetId(externalId);
    if (routeRef.current.view === "explorer" && !routeRef.current.searchQuery && routeRef.current.assetId !== externalId) {
      updateRoute({ view: "explorer", assetId: externalId }, "replace");
    }
    setExplorerLoading(true);
    setExplorerError("");
    try {
      const nextSnapshot = await getExplorerSnapshot(context, externalId, controller.signal);
      if (!controller.signal.aborted) setSnapshot(nextSnapshot);
    } catch (error) {
      if (!controller.signal.aborted) {
        setSnapshot(null);
        setExplorerError(errorMessage(error, `Asset '${externalId}' could not be loaded`));
      }
    } finally {
      if (!controller.signal.aborted) setExplorerLoading(false);
    }
  }, [updateRoute, workspaceProjectId, workspaceTenantId]);

  const openAsset = useCallback((externalId: string, historyMode: AppRouteHistoryMode = "push") => {
    setViewMode("explorer");
    setQuery("");
    setRelatedRailOpen(false);
    updateRoute({
      view: "explorer",
      assetId: externalId,
      searchQuery: undefined,
      resultType: undefined,
      resultId: undefined,
    }, historyMode);
    void loadExplorerAsset(externalId);
  }, [loadExplorerAsset, updateRoute]);

  const loadProjectsForTenant = useCallback(async (
    tenantId: string,
    preferredProjectId?: string,
    historyMode: AppRouteHistoryMode | null = "replace",
  ) => {
    projectRequestRef.current?.abort();
    const controller = new AbortController();
    projectRequestRef.current = controller;
    invalidateScopedData();
    setSelectedTenantId(tenantId);
    setPlatformContext(null);
    setPlatformProjects([]);
    setPlatformBootstrap({ status: "loading", message: `Loading projects for ${tenantId}…` });
    try {
      const projects = await collectCursorPages((query, signal) => listPlatformProjects(tenantId, query, signal), controller.signal);
      if (controller.signal.aborted) return;
      setPlatformProjects(projects);
      const requestedProjectId = preferredProjectId?.trim();
      const project = requestedProjectId
        ? projects.find((item) => item.id === requestedProjectId)
        : projects[0];
      if (!project) {
        setPlatformBootstrap({
          status: "empty",
          message: requestedProjectId
            ? `Project '${requestedProjectId}' is not accessible for this tenant.`
            : "No accessible projects were returned for this tenant.",
        });
        if (historyMode && !requestedProjectId) updateRoute({ tenantId, projectId: undefined }, historyMode);
        return;
      }
      setPlatformContext({ tenantId, projectId: project.id });
      setPlatformBootstrap({ status: "ready", message: `${tenantId} / ${project.id}` });
      if (historyMode) updateRoute({ tenantId, projectId: project.id }, historyMode);
    } catch (error) {
      if (controller.signal.aborted) return;
      const issue = platformIssue(error, "Projects could not be loaded");
      setPlatformBootstrap({ status: issue.kind, message: issue.message });
    }
  }, [invalidateScopedData, updateRoute]);

  const retryPlatformBootstrap = useCallback(async () => {
    setPlatformBootstrap({ status: "loading", message: "Discovering accessible projects…" });
    try {
      const tenants = await collectCursorPages((query, signal) => listPlatformTenants(query, signal));
      setPlatformTenants(tenants);
      if (tenants.length === 0) {
        invalidateScopedData();
        setSelectedTenantId("");
        setPlatformProjects([]);
        setPlatformContext(null);
        setPlatformBootstrap({ status: "empty", message: "No accessible tenants were returned for this identity." });
        return;
      }
      const requestedTenantId = selectedTenantId || routeRef.current.tenantId;
      const tenant = tenants.find((item) => item.id === requestedTenantId)
        ?? tenants[0];
      void loadProjectsForTenant(tenant.id, tenant.id === routeRef.current.tenantId ? routeRef.current.projectId : undefined, "replace");
    } catch (error) {
      const issue = platformIssue(error, "Tenants could not be loaded");
      setPlatformBootstrap({ status: issue.kind, message: issue.message });
    }
  }, [invalidateScopedData, loadProjectsForTenant, selectedTenantId]);

  useEffect(() => {
    workspaceRequestRef.current?.abort();
    if (!workspaceTenantId || !workspaceProjectId || !CONFIGURED_WORKSPACE_ID) {
      setWorkspace(null);
      return undefined;
    }

    const controller = new AbortController();
    workspaceRequestRef.current = controller;
    setWorkspace(null);
    void getWorkspace(
      CONFIGURED_WORKSPACE_ID,
      { tenantId: workspaceTenantId, projectId: workspaceProjectId },
      controller.signal,
    )
      .then((nextWorkspace) => {
        if (!controller.signal.aborted) setWorkspace(nextWorkspace);
      })
      .catch(() => {
        if (!controller.signal.aborted) setWorkspace(null);
      });

    return () => controller.abort();
  }, [workspaceProjectId, workspaceTenantId]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      getHealth(controller.signal),
      capture(collectCursorPages((query, signal) => listPlatformTenants(query, signal), controller.signal)),
    ]).then(([online, tenantResult]) => {
      if (controller.signal.aborted) return;
      setApiOnline(online);
      if (tenantResult.ok) {
        setPlatformTenants(tenantResult.value);
        if (tenantResult.value.length === 0) {
          setPlatformBootstrap({ status: "empty", message: "No accessible tenants were returned for this identity." });
        } else {
          const tenant = tenantResult.value.find((item) => item.id === routeRef.current.tenantId)
            ?? tenantResult.value[0];
          void loadProjectsForTenant(tenant.id, routeRef.current.projectId, "replace");
        }
      } else {
        const issue = platformIssue(tenantResult.error, "Tenants could not be loaded");
        setPlatformBootstrap({ status: issue.kind, message: issue.message });
      }
    });
    return () => {
      controller.abort();
      explorerRequestRef.current?.abort();
      projectRequestRef.current?.abort();
      workspaceRequestRef.current?.abort();
    };
  }, [loadProjectsForTenant]);

  useEffect(() => {
    explorerRequestRef.current?.abort();
    if (!workspaceTenantId || !workspaceProjectId) {
      setAssets([]);
      setAssetTotal(0);
      setAssetsLoading(false);
      setSnapshot(null);
      return undefined;
    }
    const context = { tenantId: workspaceTenantId, projectId: workspaceProjectId };
    const controller = new AbortController();
    setAssetsLoading(true);
    setAssetsError("");
    listAssets(context, { limit: ASSET_PAGE_SIZE, offset: 0 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setAssets(response.items);
        setAssetTotal(response.total);
        setAssetsLoading(false);
        if (routeRef.current.searchQuery) {
          setSelectedAssetId("");
          setSnapshot(null);
          setExplorerLoading(false);
          setExplorerError("");
          return;
        }
        const routedAssetId = routeRef.current.assetId;
        const initialAssetId = routedAssetId ?? response.items[0]?.externalId;
        if (initialAssetId) void loadExplorerAsset(initialAssetId);
        else {
          setSelectedAssetId("");
          setSnapshot(null);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAssets([]);
        setAssetTotal(0);
        setAssetsLoading(false);
        setAssetsError(errorMessage(error, "Assets could not be loaded"));
      });
    return () => controller.abort();
  }, [loadExplorerAsset, workspaceProjectId, workspaceTenantId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const desktopViewport = window.matchMedia("(min-width: 791px)");
    const syncTreeVisibility = (event: MediaQueryListEvent) => setTreeVisible(event.matches);
    desktopViewport.addEventListener("change", syncTreeVisibility);
    return () => desktopViewport.removeEventListener("change", syncTreeVisibility);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const compactViewport = window.matchMedia("(max-width: 1320px)");
    const syncNavigation = (event: MediaQueryListEvent) => {
      setCompactNavigation(event.matches);
      setNavigationCollapsed(event.matches);
    };
    compactViewport.addEventListener("change", syncNavigation);
    return () => compactViewport.removeEventListener("change", syncNavigation);
  }, []);

  useEffect(() => {
    if (!relatedRailOpen) return undefined;
    const closeRelatedData = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRelatedRailOpen(false);
    };
    window.addEventListener("keydown", closeRelatedData);
    return () => window.removeEventListener("keydown", closeRelatedData);
  }, [relatedRailOpen]);

  useEffect(() => {
    const restoreRoute = () => {
      const route = readAppRoute();
      routeRef.current = route;
      setRoute(route);
      setViewMode(route.view);
      setQuery(route.searchQuery ?? "");
      setRelatedRailOpen(false);
      setTreeVisible(route.view === "explorer" && !route.searchQuery && (typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 791px)").matches));
      if (route.searchQuery) {
        explorerRequestRef.current?.abort();
        setSelectedAssetId("");
        setSnapshot(null);
        setExplorerLoading(false);
        setExplorerError("");
      }
      if (route.assetId) void loadExplorerAsset(route.assetId);
      if (route.tenantId) void loadProjectsForTenant(route.tenantId, route.projectId, null);
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, [loadExplorerAsset, loadProjectsForTenant]);

  async function reloadAssets() {
    if (!platformContext) return;
    setAssetsLoading(true);
    setAssetsError("");
    try {
      const response = await listAssets(platformContext, { limit: ASSET_PAGE_SIZE, offset: 0 });
      setAssets(response.items);
      setAssetTotal(response.total);
      const preferred = response.items.find((asset) => asset.externalId === selectedAssetId) ?? response.items[0];
      if (preferred) void loadExplorerAsset(preferred.externalId);
    } catch (error) {
      setAssetsError(errorMessage(error, "Assets could not be loaded"));
    } finally {
      setAssetsLoading(false);
    }
  }

  async function loadMoreAssets() {
    if (!platformContext || assetsLoadingMore || assets.length >= assetTotal) return;
    setAssetsLoadingMore(true);
    setAssetsError("");
    try {
      const response = await listAssets(platformContext, { limit: ASSET_PAGE_SIZE, offset: assets.length });
      setAssets((current) => {
        const knownIds = new Set(current.map((asset) => asset.externalId));
        return [...current, ...response.items.filter((asset) => !knownIds.has(asset.externalId))];
      });
      setAssetTotal(response.total);
    } catch (error) {
      setAssetsError(errorMessage(error, "More assets could not be loaded"));
    } finally {
      setAssetsLoadingMore(false);
    }
  }

  function showView(nextView: ViewMode, historyMode: AppRouteHistoryMode = "push") {
    setViewMode(nextView);
    setQuery("");
    setRelatedRailOpen(false);
    if (nextView !== "explorer") setTreeVisible(false);
    updateRoute({
      view: nextView,
      assetId: nextView === "explorer" ? selectedAssetId || undefined : undefined,
      searchQuery: undefined,
      resultType: undefined,
      resultId: undefined,
    }, historyMode);
  }

  function navigate(label: NavigationLabel) {
    showView(viewByNavigation[label]);
  }

  function selectPlatformTenant(tenantId: string) {
    if (!tenantId || tenantId === selectedTenantId) return;
    void loadProjectsForTenant(tenantId, undefined, "push");
  }

  function selectPlatformProject(projectId: string) {
    if (!selectedTenantId || projectId === platformContext?.projectId) return;
    invalidateScopedData();
    setPlatformContext({ tenantId: selectedTenantId, projectId });
    setPlatformBootstrap({ status: "ready", message: `${selectedTenantId} / ${projectId}` });
    updateRoute({ tenantId: selectedTenantId, projectId });
  }

  function selectSearchResult(result: PlatformSearchResult) {
    setQuery("");
    if (result.entityType === "asset") {
      openAsset(result.entityId);
      return;
    }
    if (["pipeline", "pipelineRun", "qualityRule"].includes(result.entityType)) showView("pipelines");
    else if (result.entityType === "dataModel") showView("models");
    else if (["source", "connector", "dataset"].includes(result.entityType)) showView("sources");
    else if (result.entityType === "contextCandidate") showView("context");
    else if (result.entityType === "diagramExtraction") showView("diagrams");
    else if (result.entityType === "matchingEvaluation") showView("matching");
    else if (result.entityType === "spatialAssetLink") showView("spatial");
    else if (result.entityType === "writebackRequest") showView("writeback");
    else if (result.entityType === "audit") showView("audit");
    else notify(`${result.title} selected`);
  }

  function openDataExplorer(nextQuery: string, historyMode: AppRouteHistoryMode = "push") {
    const searchQuery = nextQuery.trim();
    if (!searchQuery) return;
    explorerRequestRef.current?.abort();
    setViewMode("explorer");
    setQuery(searchQuery);
    setTreeVisible(false);
    setRelatedRailOpen(false);
    setSelectedAssetId("");
    setSnapshot(null);
    setExplorerLoading(false);
    setExplorerError("");
    updateRoute({
      view: "explorer",
      assetId: undefined,
      searchQuery,
      resultType: undefined,
      resultId: undefined,
    }, historyMode);
  }

  function selectDataExplorerResult(result: PlatformSearchResult) {
    const searchQuery = routeRef.current.searchQuery;
    if (!searchQuery) return;
    updateRoute({
      view: "explorer",
      assetId: undefined,
      searchQuery,
      resultType: result.entityType,
      resultId: result.entityId,
    }, "replace");
  }

  function clearDataExplorer() {
    const fallbackAssetId = assets[0]?.externalId;
    setQuery("");
    setTreeVisible(typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 791px)").matches);
    if (fallbackAssetId) {
      openAsset(fallbackAssetId, "replace");
      return;
    }
    updateRoute({
      view: "explorer",
      assetId: undefined,
      searchQuery: undefined,
      resultType: undefined,
      resultId: undefined,
    }, "replace");
  }

  if (viewMode === "canvas") {
    return (
      <>
        <CanvasWorkspace
          snapshot={snapshot}
          workspace={workspace}
          platformContext={platformContext}
          tenants={platformTenants}
          projects={platformProjects}
          selectedTenantId={selectedTenantId}
          platformState={platformBootstrap}
          onTenantChange={selectPlatformTenant}
          onProjectChange={selectPlatformProject}
          onRetryProjectDiscovery={() => void retryPlatformBootstrap()}
          onWorkspaceUpdated={acceptWorkspace}
          onOpenExplorer={() => showView("explorer")}
          onNavigate={navigate}
          onNotify={notify}
        />
        {toast ? <div className="toast" role="status">{toast}</div> : null}
      </>
    );
  }

  const activeNavigation = navigationByView[viewMode];
  const sectionView = viewMode !== "explorer";
  const dataExplorerQuery = viewMode === "explorer" ? route.searchQuery ?? "" : "";
  const dataExplorerActive = Boolean(dataExplorerQuery);

  return (
    <div className={`app-shell${treeVisible && viewMode === "explorer" && !dataExplorerActive ? "" : " tree-collapsed"}${sectionView ? " section-shell" : ""}${navigationCollapsed ? " navigation-collapsed" : ""}`}>
      <Sidebar active={activeNavigation} collapsed={navigationCollapsed} collapseLocked={compactNavigation} onNavigate={navigate} onToggleCollapsed={() => setNavigationCollapsed((collapsed) => !collapsed)} />
      <Topbar
        query={query}
        onQueryChange={setQuery}
        onResultSelect={selectSearchResult}
        onSearchSubmit={openDataExplorer}
        apiOnline={apiOnline}
        platformContext={platformContext}
        tenants={platformTenants}
        projects={platformProjects}
        selectedTenantId={selectedTenantId}
        platformState={platformBootstrap}
        activeSection={activeNavigation}
        onTenantChange={selectPlatformTenant}
        onProjectChange={selectPlatformProject}
        onRetry={() => void retryPlatformBootstrap()}
        onSectionChange={navigate}
      />
      {sectionView ? <PlatformContextBar tenants={platformTenants} projects={platformProjects} selectedTenantId={selectedTenantId} context={platformContext} state={platformBootstrap} onTenantChange={selectPlatformTenant} onProjectChange={selectPlatformProject} onRetry={() => void retryPlatformBootstrap()} /> : null}
      {viewMode === "explorer" ? (
        dataExplorerActive ? (
          <DataExplorerWorkspace
            context={platformContext}
            query={dataExplorerQuery}
            selected={route.resultType && route.resultId ? { entityType: route.resultType, entityId: route.resultId } : null}
            onSelect={selectDataExplorerResult}
            onOpen={selectSearchResult}
            onClear={clearDataExplorer}
          />
        ) : <>
          {treeVisible ? (
            <AssetTree assets={assets} total={assetTotal} selectedExternalId={selectedAssetId} loading={assetsLoading} loadingMore={assetsLoadingMore} error={assetsError} onCollapse={() => setTreeVisible(false)} onSelect={(asset) => openAsset(asset.externalId)} onRetry={() => void reloadAssets()} onLoadMore={() => void loadMoreAssets()} />
          ) : <button className="show-tree-button" type="button" onClick={() => setTreeVisible(true)} aria-label="Show asset hierarchy"><PanelLeftOpen size={20} /></button>}
          <AssetWorkspace onIngest={() => setIngestOpen(true)} snapshot={snapshot} loading={explorerLoading} error={explorerError} onRetry={() => selectedAssetId && void loadExplorerAsset(selectedAssetId)} />
          <button className="related-rail-trigger" type="button" aria-label="Open related data" aria-expanded={relatedRailOpen} onClick={() => setRelatedRailOpen(true)}><PanelRightOpen size={18} /> Related data</button>
          {relatedRailOpen ? <button className="related-rail-backdrop" type="button" aria-label="Close related data" onClick={() => setRelatedRailOpen(false)} /> : null}
          <RelatedRail snapshot={explorerLoading ? null : snapshot} onAction={notify} open={relatedRailOpen} onClose={() => setRelatedRailOpen(false)} />
        </>
      ) : null}
      {viewMode === "overview" ? <ProjectOverviewWorkspace key={platformContext ? `${platformContext.tenantId}:${platformContext.projectId}` : "no-project"} context={platformContext} onNavigate={navigate} /> : null}
      {viewMode === "context" ? <PlatformContextWorkspace context={platformContext} onOpenAsset={openAsset} /> : null}
      {viewMode === "audit" ? <AuditWorkspace context={platformContext} /> : null}
      {viewMode === "sources" ? <SourcesWorkspace context={platformContext} /> : null}
      {viewMode === "pipelines" ? <PipelinesWorkspace context={platformContext} /> : null}
      {viewMode === "models" ? <ModelsWorkspace context={platformContext} /> : null}
      {viewMode === "diagrams" ? <DiagramsWorkspace context={platformContext} /> : null}
      {viewMode === "matching" ? <MatchingWorkspace context={platformContext} /> : null}
      {viewMode === "spatial" ? <SpatialWorkspace context={platformContext} /> : null}
      {viewMode === "writeback" ? <WritebackWorkspace context={platformContext} /> : null}
      <button className="switch-canvas-button" type="button" onClick={() => showView("canvas")}>Open Canvas</button>
      <IngestModal context={platformContext} open={ingestOpen} onClose={() => setIngestOpen(false)} onComplete={(message) => { notify(message); void reloadAssets(); }} />
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
