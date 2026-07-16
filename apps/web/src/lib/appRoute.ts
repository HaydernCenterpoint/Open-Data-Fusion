export const APP_VIEWS = [
  "canvas",
  "overview",
  "explorer",
  "sources",
  "pipelines",
  "models",
  "context",
  "diagrams",
  "matching",
  "spatial",
  "writeback",
  "audit",
] as const;

export type AppViewMode = (typeof APP_VIEWS)[number];

export interface AppRoute {
  view: AppViewMode;
  assetId?: string;
  searchQuery?: string;
  resultType?: string;
  resultId?: string;
  tenantId?: string;
  projectId?: string;
}

export type AppRouteHistoryMode = "push" | "replace";

const appViewSet = new Set<string>(APP_VIEWS);

function optionalParameter(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function routeUrl(input: string | URL | Location): URL {
  if (input instanceof URL) return new URL(input.href);
  if (typeof input === "string") return new URL(input, "http://open-data-fusion.local");
  return new URL(input.href);
}

export function readAppRoute(input: string | URL | Location = window.location): AppRoute {
  const url = routeUrl(input);
  const requestedView = optionalParameter(url.searchParams.get("view"));
  const view = requestedView && appViewSet.has(requestedView)
    ? requestedView as AppViewMode
    : "canvas";
  const assetId = optionalParameter(url.searchParams.get("asset"));
  const searchQuery = optionalParameter(url.searchParams.get("q"));
  const resultType = optionalParameter(url.searchParams.get("resultType"));
  const resultId = optionalParameter(url.searchParams.get("result"));
  const tenantId = optionalParameter(url.searchParams.get("tenant"));
  const projectId = optionalParameter(url.searchParams.get("project"));

  return {
    view,
    ...(view === "explorer" && assetId && !searchQuery ? { assetId } : {}),
    ...(view === "explorer" && searchQuery ? { searchQuery } : {}),
    ...(view === "explorer" && searchQuery && resultType && resultId ? { resultType, resultId } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(tenantId && projectId ? { projectId } : {}),
  };
}

export function appRouteHref(current: string | URL | Location, route: AppRoute): string {
  const url = routeUrl(current);
  url.searchParams.set("view", route.view);

  url.searchParams.delete("asset");
  url.searchParams.delete("q");
  url.searchParams.delete("resultType");
  url.searchParams.delete("result");

  if (route.view === "explorer" && route.assetId) url.searchParams.set("asset", route.assetId);
  if (route.view === "explorer" && route.searchQuery) {
    url.searchParams.set("q", route.searchQuery);
    if (route.resultType && route.resultId) {
      url.searchParams.set("resultType", route.resultType);
      url.searchParams.set("result", route.resultId);
    }
  }

  if (route.tenantId) url.searchParams.set("tenant", route.tenantId);
  else url.searchParams.delete("tenant");

  if (route.tenantId && route.projectId) url.searchParams.set("project", route.projectId);
  else url.searchParams.delete("project");

  return `${url.pathname}${url.search}${url.hash}`;
}

export function commitAppRoute(route: AppRoute, mode: AppRouteHistoryMode = "push"): void {
  const nextHref = appRouteHref(window.location, route);
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextHref === currentHref) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"](
    window.history.state,
    "",
    nextHref,
  );
}
