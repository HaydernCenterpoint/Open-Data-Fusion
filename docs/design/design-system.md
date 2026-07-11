# Open Data Fusion Explorer design system

Source of truth: `open-data-fusion-explorer-concept.png`.

## Visual direction

The product uses an industrial editorial layout: a deep graphite global rail, true-white working canvas, cobalt interaction accent, restrained green/amber state colors, crisp dividers, and almost no elevation. Information is organized through rails, lists, and open analysis surfaces rather than rounded card grids.

## Tokens

```css
--color-shell: #071521;
--color-shell-hover: #162737;
--color-canvas: #ffffff;
--color-surface-muted: #f6f8fa;
--color-selected: #edf4ff;
--color-accent: #0b6ffb;
--color-accent-strong: #005bd8;
--color-ink: #111820;
--color-ink-muted: #606b76;
--color-border: #d7dde3;
--color-grid: #e7ebef;
--color-success: #159447;
--color-warning: #c77a08;
--radius-control: 4px;
--shadow-control: 0 1px 2px rgb(15 23 42 / 8%);
--nav-width: 188px;
--tree-width: 244px;
--context-width: 280px;
--topbar-height: 62px;
```

## Brand mark

- The product mark visualizes multiple governed data streams converging into one fusion point.
- Use the full wordmark only where at least 150px of horizontal space is available; use the icon variant in compact navigation.
- Teal is reserved for the brand fusion accent and must not replace cobalt as the interaction color.
- Keep the SVG mark code-native and legible at 24px, 32px, and 40px sizes.

## Typography

- UI chrome: Inter or a system grotesk, 13–14px, 500–600 weight.
- Page title: 26–28px, 650–700 weight, tight line height.
- Entity title: 25–27px, 650–700 weight.
- Body and table rows: 13–14px, 400–500 weight.
- IDs, timestamps, units, and telemetry: `IBM Plex Mono`, `Roboto Mono`, or system monospace.

## Component families

- Global navigation: icon plus label, 56px row, blue left selection bar.
- Asset tree: disclosure row, 42–46px density, indentation by hierarchy depth, pale blue selected row.
- Tabs: open strip with blue underline; no pill container.
- Chart: open canvas, thin blue stroke, quiet grey grid, compact controls in the header.
- Detail tables: key/value rows separated by 1px rules.
- Context rail: stacked semantic sections separated by full-width dividers.
- Modal: one focused form surface with a small radius and explicit cancel/submit actions.

## Responsive behavior

- At 1180px, the contextual rail becomes an accessible drawer with an explicit open/close control.
- At 1080px, the Canvas inspector becomes a right-side drawer instead of removing selection details.
- At 900px, Canvas tools move to a horizontally scrollable bottom toolbar; revision, member, and inspector actions remain available through mobile controls.
- At 790px, the asset tree becomes a drawer and global section navigation moves to a labeled selector.
- At 560px, the Canvas inspector becomes a bottom sheet, chart content scrolls within its own surface, and property sections stack.

## Interaction integrity

- Every visible control must perform its labeled action, be explicitly disabled with a reason, or be removed from the shipped surface.
- Charts derive axes and labels from telemetry timestamps and values; a historical snapshot must never be labeled as live.
- Tabs follow the keyboard tab pattern, search follows the combobox/listbox pattern, and modal dialogs trap and restore focus.
- Governed accept/reject actions require an explicit confirmation step and support review evidence.

## Allowed first-viewport copy

`Open Data Fusion`, `Explorer`, `Sources`, `Pipelines`, `Models`, `Context`, `Audit`, `Asset Explorer`, `Search assets, time series, and documents`, `Ingest data`, `Local`, `Pump P-101`, `Overview`, `Time series`, `Documents`, `Relations`, `Lineage`, `Pressure (24h)`, `Properties`, `Contextualization`.
