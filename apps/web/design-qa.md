# Design QA — Open Data Fusion Industrial Canvas

- Reference interaction: Cognite Data Fusion Quick Start demo
- Reference URL: `https://www.cognite.com/en/demos/cltd3po5v001v0fk1a83q8oiz`
- Accepted concept: `../../docs/design/open-data-fusion-canvas-concept.png`
- Desktop implementation: `../../docs/design/open-data-fusion-canvas-implementation.png`
- Collaborative implementation: `../../docs/design/open-data-fusion-collaborative-canvas.png`
- Responsive check: 900 × 900 and 390 × 844
- Result: passed

## Fidelity ledger

| Surface | Result | Evidence |
| --- | --- | --- |
| Canvas container | Pass | White infinite-workspace treatment, subtle dot grid, dark vertical tool rail, top workspace chrome, minimap, zoom controls, and pinned inspector are all present. |
| Industrial content | Pass | P&ID drawing, Pump P-101 asset node, Pressure psi time series, Cooling Water System node, document node, and visible relation paths form the primary canvas composition. |
| Visual system | Pass | Open Data Fusion graphite/cobalt palette, thin gray borders, restrained shadows, compact enterprise typography, and code-native SVG diagrams follow the generated Canvas concept. |
| Inspector anatomy | Pass | Selection, status, type, source, provenance, tags, and description remain visible in a dedicated right rail. |
| Interaction model | Pass | Select, Pan, Connect, node selection, zoom, reset, onboarding skip/template, New canvas notification, and Canvas ↔ Explorer navigation were exercised. |
| Collaborative revision control | Pass | Canvas displays the saved version, saves an immutable viewport revision, lists version history with actor/timestamp/summary, rejects stale API writes, and restores a selected historical revision by appending a new version. |
| Live collaboration | Pass | Three browser sessions showed shared presence; Harper's node drag, shared note, and new edge reached Riley via SSE and advanced the same workspace from v3 to v6. Viewer controls were disabled and the API separately returned 403. |
| Canvas authoring | Pass | Node/edge inspector edits, resize, connected-node deletion, and semantic undo were exercised against the real API. Deletion removed incident edges atomically and undo restored the node plus every edge as a new revision. |
| Member administration | Pass | Owner add/update/remove controls reached the owner-only API, roles refreshed through `members.updated`, and the viewer saw the roster without mutation controls. |
| Production identity path | Pass (automated) | Browser Authorization Code + PKCE, session storage, refresh-token renewal, bearer API headers, and authenticated fetch-SSE are covered by tests; the API verifies JWT signature, issuer, audience, expiry and claim. Local Keycloak runtime remains unexecuted because Docker is unavailable in this environment. |
| Responsive behavior | Pass | At 900px and 390px the document stays within the viewport; the inspector is removed at narrower widths and the canvas remains navigable in its own scroll surface. |
| Copy and clean-room boundary | Pass | Product copy uses Open Data Fusion; no Cognite logo, brand mark, proprietary screenshot, or claim of compatibility is shipped. |

## Browser verification

- Desktop browser capture was taken at 1536 × 1024 and inspected beside the accepted concept with `view_image` after the final layout fix.
- The onboarding dialog was dismissed, Pressure psi was selected, Pan was activated, and the stage zoom changed to 110%.
- The brand control opened Explorer; the Explorer Canvas control returned to the Canvas view.
- Fresh local load produced no new console warnings or errors.
- API-backed source and provenance values render in the inspector; telemetry renders in the chart.
- Live browser verification saved Canvas v1 as v2, opened both revisions, restored v1, and confirmed the resulting workspace became v3 without removing v2.
- A second QA pass opened Harper, Riley, and Samantha in separate browser tabs. All showed `3 online`; Riley received Harper's new coordinates, note, edge, and versions without reload. All three consoles remained free of warnings and errors.
- Stale `baseVersion` smoke testing returned HTTP 409 while a viewer mutation returned HTTP 403; neither changed workspace v6.
- The authoring pass advanced v6 to v12 while testing edit/undo, connected-node delete/undo, and a Riley-to-Harper live update/undo. The final v12 snapshot retained six nodes and five edges, and the temporary QA member was removed.
- Owner member controls added and removed a reviewer through the real API. Samantha's viewer tab showed three online users, disabled Note/Connect/New Canvas controls, and no member-management form.
- At 390 × 844, the member panel measured 374.4px wide at x=8 inside a 390px document with no horizontal overflow. Desktop and all three tabs logged zero warnings or errors.

## Intentional deviations

- The P&ID is an original code-native SVG approximation, not a copied Cognite drawing or raster asset.
- Node drag, semantic operations, SSE presence, reload-on-newer-version, and the conflict banner are implemented. Arbitrary asset-palette drag-to-create remains a later increment; the current `Note` tool is the implemented creation path.
- Presence remains process-local in this development profile; horizontal deployment requires a shared event transport.
- The current onboarding action loads the seeded Cooling Water System view and does not yet import arbitrary external files.
- Explorer remains available as the data-detail view through the Open Data Fusion brand or Canvas control.

## Material fixes during QA

- Corrected the canvas transform origin that clipped the P&ID at the initial viewport.
- Preserved a stable 1100px canvas coordinate surface while keeping the document viewport responsive.
- Updated the existing Explorer tests to enter the new default Canvas view before asserting Explorer behavior.
- Fixed connected-node deletion to submit `removeEdge` operations before `removeNode`; the earlier frontend mock had hidden the backend referential-integrity failure.

final result: passed
