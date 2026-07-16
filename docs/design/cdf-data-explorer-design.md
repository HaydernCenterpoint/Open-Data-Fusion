# CDF-style Data Explorer design

## Context

Open Data Fusion already provides the core industrial surfaces: a collaborative Canvas, an asset-detail Explorer, governed catalog screens, contextualization reviews, and a project-scoped platform search. The remaining highest-value gap against the Cognite Data Fusion workflow is a single Data Explorer experience that lets an operator search across resource types, narrow results, inspect a preview, and continue into the relevant industrial workflow.

This design builds on the existing project-scoped `GET /api/v1/platform/search` endpoint and does not introduce a new persistence model, dependency, or authorization path.

## Goals

- Make **Explorer** a cross-resource discovery workspace in addition to its existing asset-detail role.
- Preserve tenant/project scope, existing RBAC, and deep links.
- Provide category filters, keyboard-accessible result selection, an inspectable preview, and deterministic navigation to the appropriate existing surface.
- Keep the current asset hierarchy and asset-detail experience available when an asset is selected.

## Non-goals

- A production 3D renderer, AI copilot, document OCR/P&ID vision, or a new backend search index.
- Arbitrary client-side writes to Canvas from search results.
- Changing existing platform API contracts or weakening access checks.

## Considered approaches

1. **Dedicated CDF-style explorer shell (chosen).** Upgrade the existing Explorer view into a discovery-and-preview workflow while retaining its asset-detail layout. This is the smallest change that improves the main user journey and reuses tested search/RBAC primitives.
2. **Canvas-first search insertion.** Add an asset palette directly to Canvas. It improves authoring but does not solve general cross-resource discovery and increases the collaboration/conflict surface.
3. **3D or AI-first work.** These are recognizable CDF features but require new data/model or provider boundaries and would be less useful before users can reliably discover their data.

## Interaction design

1. The global search field opens the Explorer search workspace when a user submits a query without choosing a quick result.
2. The search workspace reads the query from the URL and requests scoped platform results. It shows All plus dynamically populated resource-type filters, result counts, loading/error/degraded states, and an accessible result list.
3. Selecting a result opens a right-side preview with identity, resource type, summary, last update, and the available primary action:
   - asset: open the existing asset detail and preserve the deep link;
   - resource types with existing workspaces: open Sources, Pipelines, Models, Context, Diagrams, Matching, Spatial, Write-back, or Audit;
   - unsupported result types: keep the preview and explain that the record is indexed but has no dedicated workspace yet.
4. A selected asset keeps the current tree/detail/related-data layout. Search is a deliberate discovery state rather than a replacement for the asset workspace.
5. Browser history preserves tenant, project, Explorer query, and selected asset appropriately. A new query replaces only the query/selection portion of the route; explicit navigation remains a history entry.

## Component boundaries

- `appRoute.ts`: owns the optional Explorer query and selected non-asset result parameters, plus URL round-trip tests.
- `DataExplorerWorkspace.tsx`: owns result fetching, filtering, selection, preview, keyboard behavior, and retry. It consumes `PlatformContext` and callbacks; it does not own tenant/project selection or routing.
- `Topbar.tsx`: remains a fast command-style search; on submit it delegates to the Explorer route instead of duplicating the full discovery UI.
- `App.tsx`: owns route state and maps each result type to its existing destination.
- `premium.css`: supplies only scoped Data Explorer styles, using the existing design tokens and responsive breakpoints.

## Error and authorization behavior

- Abort stale searches when query, project, or component lifecycle changes.
- Render existing unauthorized/forbidden messages without retry loops.
- If platform search is unavailable, retain the existing asset-only fallback and visibly label it as degraded.
- Never infer a resource permission from search output; each target workspace continues to enforce its API permission checks.

## Verification

- Unit-test URL parsing and serialization for Explorer queries/selections.
- Component-test category filtering, keyboard selection, preview state, retry/error state, and deep-link callbacks.
- Extend App tests for global-search submit, asset routing, and cross-surface result routing.
- Run web tests, web typecheck/build, then the repository `npm.cmd run check` gate.

## Acceptance criteria

- A scoped query can be bookmarked and restored into the same Explorer search state.
- Users can restrict results by type and obtain deterministic counts/selection behavior.
- Selecting an asset opens the current asset-detail view; selecting another indexed type routes to its existing workspace.
- Search remains operable by keyboard and is usable on the existing responsive breakpoints.
- Existing Explorer, Canvas, tenant/project selection, and API fallback tests remain green.
