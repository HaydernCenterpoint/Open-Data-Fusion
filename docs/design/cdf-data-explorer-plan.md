# CDF-style Data Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Turn the existing Explorer entry point into a bookmarkable, project-scoped CDF-style cross-resource discovery workflow while preserving asset-detail and Canvas flows.

**Architecture:** appRoute.ts owns compact Explorer URL state. A new DataExplorerWorkspace owns read-only search, category filtering, selection, preview, and retry. Topbar remains a fast command entry. App owns scope, route transitions, and navigation into existing surfaces.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Testing Library, existing REST API, premium.css.

---

## File map

| File | Responsibility |
| --- | --- |
| apps/web/src/lib/appRoute.ts | Normalized Explorer query and selected-result URL state. |
| apps/web/src/lib/appRoute.test.ts | URL round-trip and invalid-state tests. |
| apps/web/src/components/DataExplorerWorkspace.tsx | Fetch, filter, select, preview, retry, and keyboard behavior. |
| apps/web/src/components/DataExplorerWorkspace.test.tsx | Data Explorer user-visible tests. |
| apps/web/src/components/Topbar.tsx | Delegate unselected Enter submissions to Explorer. |
| apps/web/src/components/Topbar.test.tsx | Quick-select versus full-search submission tests. |
| apps/web/src/App.tsx | Route-to-workspace state and result-to-surface navigation. |
| apps/web/src/App.test.tsx | Integration and deep-link tests. |
| apps/web/src/premium.css | Scoped responsive layout. |

### Task 1: Persist Explorer search state

**Files:**
- Modify: apps/web/src/lib/appRoute.ts
- Modify: apps/web/src/lib/appRoute.test.ts

- [ ] **Step 1: Write the failing route tests**

~~~ts
it("reads a bookmarkable Explorer search with a selected result", () => {
  expect(readAppRoute("https://example.test/?view=explorer&q=pump&resultType=pipeline&result=normalize-telemetry&tenant=demo&project=north-plant")).toEqual({
    view: "explorer",
    searchQuery: "pump",
    resultType: "pipeline",
    resultId: "normalize-telemetry",
    tenantId: "demo",
    projectId: "north-plant",
  });
});

it("drops orphaned Explorer result state", () => {
  expect(readAppRoute("https://example.test/?view=explorer&resultType=pipeline&result=normalize-telemetry")).toEqual({ view: "explorer" });
});
~~~

- [ ] **Step 2: Run the route test to verify it fails**

Run: npm.cmd run test --workspace @open-data-fusion/web -- appRoute.test.ts

Expected: FAIL because AppRoute has no searchQuery, resultType, or resultId.

- [ ] **Step 3: Add normalized route fields**

~~~ts
export interface AppRoute {
  view: AppViewMode;
  assetId?: string;
  searchQuery?: string;
  resultType?: string;
  resultId?: string;
  tenantId?: string;
  projectId?: string;
}

const searchQuery = optionalParameter(url.searchParams.get("q"));
const resultType = optionalParameter(url.searchParams.get("resultType"));
const resultId = optionalParameter(url.searchParams.get("result"));

return {
  view,
  ...(view === "explorer" && assetId && !searchQuery ? { assetId } : {}),
  ...(view === "explorer" && searchQuery ? { searchQuery } : {}),
  ...(view === "explorer" && searchQuery && resultType && resultId ? { resultType, resultId } : {}),
  ...(tenantId ? { tenantId } : {}),
  ...(tenantId && projectId ? { projectId } : {}),
};
~~~

In appRouteHref, always delete asset, q, resultType, and result first. Add only valid state from route so asset-detail and full-search URLs are mutually exclusive.

- [ ] **Step 4: Verify and commit**

Run: npm.cmd run test --workspace @open-data-fusion/web -- appRoute.test.ts && npm.cmd run typecheck --workspace @open-data-fusion/web

Expected: PASS.

~~~powershell
git add apps/web/src/lib/appRoute.ts apps/web/src/lib/appRoute.test.ts
git commit -m "feat(web): persist data explorer routes"
~~~

### Task 2: Build the isolated Data Explorer workspace

**Files:**
- Create: apps/web/src/components/DataExplorerWorkspace.tsx
- Create: apps/web/src/components/DataExplorerWorkspace.test.tsx

- [ ] **Step 1: Write failing filter, preview, and retry tests**

Mock searchPlatform and render:

~~~tsx
<DataExplorerWorkspace
  context={{ tenantId: "demo", projectId: "north-plant" }}
  query="pump"
  selected={{ entityType: "pipeline", entityId: "normalize-telemetry" }}
  onSelect={onSelect}
  onOpen={onOpen}
  onClear={onClear}
/>
~~~

The test must assert:

~~~ts
expect(await screen.findByRole("heading", { name: "Data Explorer" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "All (3)" })).toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: "Pipelines (1)" }));
fireEvent.click(screen.getByRole("button", { name: /Normalize telemetry/ }));
expect(screen.getByRole("complementary", { name: "Result preview" })).toHaveTextContent("Pipeline");
fireEvent.click(screen.getByRole("button", { name: "Open Pipelines" }));
expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ entityType: "pipeline" }));
~~~

Also reject searchPlatform once, assert role="alert", click Retry, and assert a second request.

- [ ] **Step 2: Run the component test to verify it fails**

Run: npm.cmd run test --workspace @open-data-fusion/web -- DataExplorerWorkspace.test.tsx

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the fetch/filter boundary**

~~~tsx
type ResultSelection = Pick<PlatformSearchResult, "entityType" | "entityId"> | null;
type SearchStatus = "idle" | "loading" | "ready" | "unauthorized" | "forbidden" | "error";

export function DataExplorerWorkspace({ context, query, selected, onSelect, onOpen, onClear }: {
  context: PlatformContext | null;
  query: string;
  selected: ResultSelection;
  onSelect: (result: PlatformSearchResult) => void;
  onOpen: (result: PlatformSearchResult) => void;
  onClear: () => void;
}) {
  const [items, setItems] = useState<PlatformSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [activeType, setActiveType] = useState("all");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const normalized = query.trim();
    if (!context || !normalized) { setItems([]); setStatus("idle"); return undefined; }
    const controller = new AbortController();
    setStatus("loading");
    void searchPlatform(context, { q: normalized, limit: 100 }, controller.signal)
      .then((page) => { if (!controller.signal.aborted) { setItems(page.items); setStatus("ready"); } })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setStatus(error instanceof ApiRequestError && error.status === 401 ? "unauthorized" : error instanceof ApiRequestError && error.status === 403 ? "forbidden" : "error");
      });
    return () => controller.abort();
  }, [context?.tenantId, context?.projectId, query, reloadToken]);
~~~

Derive category counts with Map<string, number>. Filter only in memory after the scoped API request. Reset activeType to all when its category count becomes zero.

- [ ] **Step 4: Add accessible list, preview, and failure states**

Use a selected result computed by entityType/entityId. Render result buttons in a listbox with ArrowUp, ArrowDown, Home, End, and Enter handling. Render exactly these states:

~~~tsx
{status === "idle" ? <p>Enter a search term to discover project data.</p> : null}
{status === "loading" ? <p role="status">Searching project data…</p> : null}
{status === "unauthorized" ? <p role="alert">Sign-in expired. Sign in again to search this project.</p> : null}
{status === "forbidden" ? <p role="alert">Your role cannot search this project.</p> : null}
{status === "error" ? <p role="alert">Search is unavailable <button type="button" onClick={() => setReloadToken((value) => value + 1)}>Retry</button></p> : null}
~~~

Render an aside with aria-label="Result preview". The action label is Open Explorer for assets and Open + destination name for source, pipeline, model, context candidate, diagram extraction, matching evaluation, spatial link, write-back request, and audit result types.

- [ ] **Step 5: Verify and commit**

Run: npm.cmd run test --workspace @open-data-fusion/web -- DataExplorerWorkspace.test.tsx && npm.cmd run typecheck --workspace @open-data-fusion/web

Expected: PASS.

~~~powershell
git add apps/web/src/components/DataExplorerWorkspace.tsx apps/web/src/components/DataExplorerWorkspace.test.tsx
git commit -m "feat(web): add CDF-style data explorer"
~~~

### Task 3: Delegate full searches from Topbar

**Files:**
- Modify: apps/web/src/components/Topbar.tsx
- Modify: apps/web/src/components/Topbar.test.tsx

- [ ] **Step 1: Write the failing submit test**

~~~ts
fireEvent.change(input, { target: { value: "pump P-101" } });
fireEvent.keyDown(input, { key: "Enter" });
expect(onSearchSubmit).toHaveBeenCalledWith("pump P-101");
expect(screen.queryByRole("listbox", { name: "Search results" })).not.toBeInTheDocument();
~~~

- [ ] **Step 2: Run Topbar tests to verify failure**

Run: npm.cmd run test --workspace @open-data-fusion/web -- Topbar.test.tsx

Expected: FAIL because TopbarProps has no onSearchSubmit property.

- [ ] **Step 3: Add the explicit callback**

~~~ts
interface TopbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onResultSelect: (result: PlatformSearchResult) => void;
  onSearchSubmit: (query: string) => void;
  apiOnline: boolean | null;
  platformContext: PlatformContext | null;
  tenants: PlatformTenant[];
  projects: PlatformProject[];
  selectedTenantId: string;
  platformState: PlatformBootstrapState;
  activeSection: NavigationLabel;
  onTenantChange: (tenantId: string) => void;
  onProjectChange: (projectId: string) => void;
  onRetry: () => void;
  onSectionChange: (section: NavigationLabel) => void;
}
~~~

Keep active-option Enter behavior. Then handle Enter with a non-empty query:

~~~ts
if (event.key === "Enter" && query.trim()) {
  event.preventDefault();
  closeResults();
  onSearchSubmit(query.trim());
}
~~~

Do not call it for a selected option; quick result selection remains unchanged.

- [ ] **Step 4: Verify and commit**

Run: npm.cmd run test --workspace @open-data-fusion/web -- Topbar.test.tsx

Expected: PASS.

~~~powershell
git add apps/web/src/components/Topbar.tsx apps/web/src/components/Topbar.test.tsx
git commit -m "feat(web): open data explorer from search"
~~~

### Task 4: Integrate routes, Explorer, and existing surfaces

**Files:**
- Modify: apps/web/src/App.tsx
- Modify: apps/web/src/App.test.tsx

- [ ] **Step 1: Write failing integration tests**

~~~ts
window.history.replaceState({}, "", "/?view=explorer&q=telemetry&resultType=pipeline&result=normalize-telemetry&tenant=demo&project=north-plant");
render(<App />);
expect(await screen.findByRole("heading", { name: "Data Explorer" })).toBeInTheDocument();
expect(screen.getByRole("complementary", { name: "Result preview" })).toHaveTextContent("Normalize telemetry");

fireEvent.click(screen.getByRole("button", { name: "Open Pipelines" }));
expect(await screen.findByRole("heading", { name: "Pipelines" })).toBeInTheDocument();
expect(new URLSearchParams(window.location.search).get("q")).toBeNull();
~~~

Also assert global submit creates view=explorer&q=pump and opening an asset removes q then reaches the existing Pump P-101 detail.

- [ ] **Step 2: Run App tests to verify failure**

Run: npm.cmd run test --workspace @open-data-fusion/web -- App.test.tsx

Expected: FAIL because App ignores q and always renders the asset-detail Explorer shell.

- [ ] **Step 3: Add route-owned helpers**

~~~ts
function openDataExplorer(nextQuery: string, historyMode: AppRouteHistoryMode = "push") {
  const searchQuery = nextQuery.trim();
  if (!searchQuery) return;
  setViewMode("explorer");
  setQuery(searchQuery);
  setRelatedRailOpen(false);
  updateRoute({ view: "explorer", searchQuery, assetId: undefined, resultType: undefined, resultId: undefined }, historyMode);
}

function selectExplorerResult(result: PlatformSearchResult) {
  updateRoute({
    view: "explorer",
    searchQuery: routeRef.current.searchQuery,
    resultType: result.entityType,
    resultId: result.entityId,
    assetId: undefined,
  }, "replace");
}
~~~

Update openAsset and all non-Explorer showView calls to clear searchQuery, resultType, and resultId.

- [ ] **Step 4: Render one Explorer state at a time**

Import DataExplorerWorkspace. When routeRef.current.searchQuery exists, render it instead of AssetTree, AssetWorkspace, and RelatedRail. Pass this action:

~~~ts
function openExplorerResult(result: PlatformSearchResult) {
  if (result.entityType === "asset") {
    openAsset(result.entityId);
    return;
  }
  selectSearchResult(result);
}
~~~

Pass onSearchSubmit={openDataExplorer} to Topbar while retaining onResultSelect={selectSearchResult}.

- [ ] **Step 5: Verify and commit**

Run: npm.cmd run test --workspace @open-data-fusion/web -- App.test.tsx appRoute.test.ts

Expected: PASS, including Canvas to Explorer, deep-link, tenant/project, and existing section tests.

~~~powershell
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): connect data explorer navigation"
~~~

### Task 5: Style and validate the product

**Files:**
- Modify: apps/web/src/premium.css

- [ ] **Step 1: Add scoped desktop layout**

~~~css
.data-explorer {
  display: grid;
  grid-template-columns: minmax(180px, 0.72fr) minmax(320px, 1.35fr) minmax(260px, 0.9fr);
  min-height: min(760px, calc(100vh - var(--topbar-height, 72px)));
  background: var(--surface, #fff);
}
.data-explorer__filters,
.data-explorer__results,
.data-explorer__preview {
  min-width: 0;
  padding: 20px;
  border-right: 1px solid var(--border, #e2e8f0);
}
.data-explorer__preview { border-right: 0; background: var(--surface-muted, #f8fafc); }
~~~

Use existing typography and color tokens. Selected rows must have both a visible border/background treatment and aria-selected state. Add focus-visible outlines.

- [ ] **Step 2: Add mobile layout**

~~~css
@media (max-width: 900px) {
  .data-explorer { grid-template-columns: 1fr; min-height: auto; }
  .data-explorer__filters,
  .data-explorer__results,
  .data-explorer__preview {
    border-right: 0;
    border-bottom: 1px solid var(--border, #e2e8f0);
  }
}
~~~

- [ ] **Step 3: Run focused web validation**

Run: npm.cmd run test --workspace @open-data-fusion/web && npm.cmd run typecheck --workspace @open-data-fusion/web && npm.cmd run build --workspace @open-data-fusion/web

Expected: all web tests, typechecks, and Vite build pass.

- [ ] **Step 4: Run the repository gate**

Run: npm.cmd run check

Expected: workspace typechecks/tests/builds plus infrastructure and production-gate validation pass.

- [ ] **Step 5: Commit the visual slice**

~~~powershell
git add apps/web/src/premium.css
git commit -m "feat(web): style responsive data explorer"
~~~

## Plan self-review

- **Spec coverage:** Tasks 1–4 cover URL state, scoped search, categories, selection, preview, callbacks, and existing-surface navigation. Task 5 covers responsive accessibility and verification.
- **No placeholders:** Test names, files, user-visible text, commands, route parameters, and callback contracts are explicit.
- **Type consistency:** searchQuery/resultType/resultId are route names throughout. PlatformSearchResult remains the only cross-resource result contract. onSelect changes preview/route state; onOpen navigates.
