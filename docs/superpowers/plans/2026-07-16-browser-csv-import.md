# Browser CSV Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-only wide-form CSV/TSV import path that previews and validates a file before atomically ingesting it through the existing scoped bundle endpoint.

**Architecture:** Keep parsing and bundle construction in a pure `csvIngest` module, separate from React and network calls. Add a focused CSV form inside the existing ingest modal; it uses the module to produce the existing `IngestBundle`, then calls the existing `ingestBundle` API function once. No server API, persistence, Compose, or dependency changes are allowed.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, browser `File.text`, `TextEncoder`, existing Open Data Fusion bundle API.

---

## File map

- Create: `apps/web/src/lib/csvIngest.ts` — quote-aware CSV/TSV parsing, mapping validation, and pure `IngestBundle` construction.
- Create: `apps/web/src/lib/csvIngest.test.ts` — parser and mapping regression coverage.
- Create: `apps/web/src/components/CsvIngestForm.tsx` — file selection, preview, mapping controls, and one scoped ingest request.
- Create: `apps/web/src/components/CsvIngestForm.test.tsx` — import interaction and failure-path coverage.
- Modify: `apps/web/src/components/IngestModal.tsx` — switch between unchanged manual entry and the new CSV form while retaining focus trap and close behavior.
- Modify: `apps/web/src/components/IngestModal.test.tsx` — lock manual-entry accessibility after the new mode switch exists.
- Modify: `apps/web/src/styles.css` — structural layout for preview, mapping rows, and responsive scrolling.
- Modify: `apps/web/src/premium.css` — visual refinements for the new structural classes.

### Task 1: Build a quote-aware delimited-text parser

**Files:**
- Create: `apps/web/src/lib/csvIngest.test.ts`
- Create: `apps/web/src/lib/csvIngest.ts`

- [ ] **Step 1: Write failing parser tests**

  Add tests for a UTF-8 BOM, CRLF, quoted delimiter, escaped quote, tab delimiter, duplicate/empty headers, uneven rows, and unterminated quotes:

  ```ts
  import { describe, expect, it } from "vitest";
  import { CsvIngestError, parseDelimitedText } from "./csvIngest";

  describe("parseDelimitedText", () => {
    it("parses a BOM-prefixed quoted CSV into named rows", () => {
      expect(parseDelimitedText("\uFEFFtimestamp,pressure,note\r\n2026-07-11T00:00:00Z,101.2,\"Pump, stable\"\r\n", ",")).toEqual({
        headers: ["timestamp", "pressure", "note"],
        rows: [{ timestamp: "2026-07-11T00:00:00Z", pressure: "101.2", note: "Pump, stable" }],
      });
    });

    it("rejects malformed tables with source-row context", () => {
      expect(() => parseDelimitedText("timestamp,value\n2026-07-11T00:00:00Z\n", ",")).toThrow("row 2 has 1 cells; expected 2");
      expect(() => parseDelimitedText("timestamp,timestamp\n1,2\n", ",")).toThrow("duplicate header 'timestamp'");
      expect(() => parseDelimitedText("timestamp,value\n\"2026-07-11,1\n", ",")).toThrow(CsvIngestError);
    });
  });
  ```

- [ ] **Step 2: Run the parser tests and confirm RED**

  Run:

  ```powershell
  npm.cmd test --workspace @open-data-fusion/web -- src/lib/csvIngest.test.ts
  ```

  Expected: fail because `csvIngest.ts` does not exist.

- [ ] **Step 3: Implement the minimal parser**

  In `csvIngest.ts`, export this contract and a single-pass character parser. Remove a leading BOM, allow a quote only at the beginning of a field, turn doubled quotes into one literal quote, normalize CRLF/CR/LF as row endings, reject malformed quote placement, and reject non-empty rows with a cell count different from the header.

  ```ts
  export type CsvDelimiter = "," | "\t";

  export interface DelimitedTable {
    headers: string[];
    rows: Array<Record<string, string>>;
  }

  export class CsvIngestError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CsvIngestError";
    }
  }

  export function parseDelimitedText(input: string, delimiter: CsvDelimiter): DelimitedTable {
    // Single-pass state machine: `quoted`, current `cell`, current `row`, and `records`.
    // Validate headers after parsing, then map each equally-sized data row to a record.
  }
  ```

  Do not import `csv-parse`, add a package, or accept a delimiter other than comma or tab.

- [ ] **Step 4: Run parser tests and web typecheck (GREEN)**

  Run:

  ```powershell
  npm.cmd test --workspace @open-data-fusion/web -- src/lib/csvIngest.test.ts
  npm.cmd run typecheck --workspace @open-data-fusion/web
  ```

  Expected: all focused parser tests pass and TypeScript emits no errors.

- [ ] **Step 5: Commit the parser slice**

  ```powershell
  git add apps/web/src/lib/csvIngest.ts apps/web/src/lib/csvIngest.test.ts
  git commit -m "feat(web): parse browser CSV ingest files"
  ```

### Task 2: Convert a validated wide table into an existing ingest bundle

**Files:**
- Modify: `apps/web/src/lib/csvIngest.ts`
- Modify: `apps/web/src/lib/csvIngest.test.ts`

- [ ] **Step 1: Add failing bundle-construction tests**

  Add one valid two-series case and explicit failures for missing static assets, a series bound to an unknown asset, invalid timestamp/value/quality, duplicate point, more than 100,000 output points, and a serialized payload at or above the API's 10 MB (`10 * 1024 * 1024` byte) boundary.

  ```ts
  import { buildCsvIngestBundle } from "./csvIngest";

  it("builds a wide-form bundle and omits a blank run ID", () => {
    const table = parseDelimitedText("timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n", ",");
    expect(buildCsvIngestBundle(table, {
      sourceSystem: "csv-pilot",
      runId: "",
      timestampColumn: "timestamp",
      assets: [{ externalId: "P-101", name: "Pump 101", type: "pump" }],
      timeSeries: [
        { externalId: "P-101-PRESSURE", assetExternalId: "P-101", name: "Pressure", valueColumn: "pressure", qualityColumn: "quality" },
        { externalId: "P-101-TEMP", assetExternalId: "P-101", name: "Temperature", valueColumn: "temperature" },
      ],
    })).toMatchObject({
      source: { system: "csv-pilot" },
      dataPoints: [
        { timeSeriesExternalId: "P-101-PRESSURE", timestamp: "2026-07-11T00:00:00.000Z", value: 101.2, quality: "good" },
        { timeSeriesExternalId: "P-101-TEMP", timestamp: "2026-07-11T00:00:00.000Z", value: 42.5, quality: "good" },
      ],
    });
  });
  ```

- [ ] **Step 2: Run the new mapping tests and confirm RED**

  Run:

  ```powershell
  npm.cmd test --workspace @open-data-fusion/web -- src/lib/csvIngest.test.ts
  ```

  Expected: fail because `buildCsvIngestBundle` is not exported.

- [ ] **Step 3: Implement explicit mapping guards**

  Add and export mapping types plus `buildCsvIngestBundle(table, mapping)`. Trim configuration fields; validate external IDs against `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`; require one or more asset and series definitions; require every series asset ID in the configured asset set; reject shared asset/series external IDs, repeated series definitions, repeated value columns, and a timestamp/quality column reused as a value column.

  For each data row, convert ISO-8601 or integer epoch milliseconds to canonical ISO text, require finite numeric values, normalize quality to `good`, `uncertain`, or `bad`, and reject duplicate `(series, timestamp)` observations. Stop before appending a point that would exceed `100_000`; after construction, use `new TextEncoder().encode(JSON.stringify(bundle)).byteLength` and reject `>= 10 * 1024 * 1024`.

  ```ts
  export interface CsvSeriesMapping {
    externalId: string;
    assetExternalId: string;
    name: string;
    unit?: string;
    valueColumn: string;
    qualityColumn?: string;
  }

  export interface CsvIngestMapping {
    sourceSystem: string;
    runId: string;
    timestampColumn: string;
    assets: Array<{ externalId: string; name: string; type: string }>;
    timeSeries: CsvSeriesMapping[];
  }
  ```

- [ ] **Step 4: Run mapping tests and build (GREEN)**

  Run:

  ```powershell
  npm.cmd test --workspace @open-data-fusion/web -- src/lib/csvIngest.test.ts
  npm.cmd run build --workspace @open-data-fusion/web
  ```

  Expected: parser and mapper tests pass; Vite production build completes.

- [ ] **Step 5: Commit the mapping slice**

  ```powershell
  git add apps/web/src/lib/csvIngest.ts apps/web/src/lib/csvIngest.test.ts
  git commit -m "feat(web): map CSV data into ingest bundles"
  ```

### Task 3: Add accessible CSV import controls to the ingest modal

**Files:**
- Create: `apps/web/src/components/CsvIngestForm.tsx`
- Create: `apps/web/src/components/CsvIngestForm.test.tsx`
- Modify: `apps/web/src/components/IngestModal.tsx`
- Modify: `apps/web/src/components/IngestModal.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/premium.css`

- [ ] **Step 1: Write failing UI tests before component code**

  Mock `ingestBundle`, render the existing dialog, select **Import CSV/TSV**, attach a `File`, fill a valid source, asset, and two-series mapping, then assert the preview count and the exact generated bundle passed to `ingestBundle`. Add a second test that supplies `not-a-number` and asserts an alert is shown while `ingestBundle` remains uncalled.

  ```tsx
  const file = new File([
    "timestamp,pressure,temperature\n2026-07-11T00:00:00Z,101.2,42.5\n",
  ], "pump.csv", { type: "text/csv" });

  fireEvent.change(screen.getByLabelText("CSV or TSV file"), { target: { files: [file] } });
  await screen.findByText("1 row · 2 data points");
  fireEvent.click(screen.getByRole("button", { name: "Import 2 data points" }));
  await waitFor(() => expect(ingestBundle).toHaveBeenCalledWith(
    { tenantId: "tenant-1", projectId: "project-1" },
    expect.objectContaining({ source: { system: "csv-pilot" } }),
  ));
  ```

- [ ] **Step 2: Run the component tests and confirm RED**

  Run:

  ```powershell
  npm.cmd test --workspace @open-data-fusion/web -- src/components/CsvIngestForm.test.tsx src/components/IngestModal.test.tsx
  ```

  Expected: fail because CSV mode and `CsvIngestForm` do not exist.

- [ ] **Step 3: Implement the focused form and wire it into the modal**

  `CsvIngestForm` owns file, delimiter, parsed table, mapping, local validation, submission state, and success/error rendering. Read only `await file.text()` after an explicit file selection; render file name, headers, and at most five data rows as plain React text. Use `useMemo` to call `buildCsvIngestBundle` only after the table and mapping exist, and disable import when it throws.

  Render these accessible controls and labels exactly:

  ```tsx
  <input id="csv-file" aria-label="CSV or TSV file" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" />
  <select aria-label="Delimiter"><option value=",">Comma</option><option value="\t">Tab</option></select>
  <select aria-label="Timestamp column">...</select>
  <button type="button">Add asset</button>
  <button type="button">Add time series</button>
  <button type="submit" disabled={!bundle || submitting}>Import {pointCount} data points</button>
  ```

  `IngestModal` adds this two-button tablist with **Manual measurement** and
  **Import CSV/TSV**:

  ```tsx
  <div role="tablist" aria-label="Ingest method">
    <button role="tab" aria-selected={mode === "manual"} onClick={() => setMode("manual")}>Manual measurement</button>
    <button role="tab" aria-selected={mode === "csv"} onClick={() => setMode("csv")}>Import CSV/TSV</button>
  </div>
  ```

  Preserve its Escape handling, focus trap, backdrop close, and manual
  source-field focus. When switching to CSV mode, focus the file control; when
  selecting another file or delimiter, clear stale mapping and error state. Do
  not change `ingestBundle`, `types.ts`, or any backend route.

  Add structural CSS for a scrollable preview table, mapping fieldsets, add/remove
  rows, count summary, and a mobile single-column layout. Add only matching
  color/border refinements in `premium.css`; do not alter unrelated modal styles.

- [ ] **Step 4: Run UI tests and web build (GREEN)**

  Run:

  ```powershell
  npm.cmd test --workspace @open-data-fusion/web -- src/components/CsvIngestForm.test.tsx src/components/IngestModal.test.tsx
  npm.cmd run typecheck --workspace @open-data-fusion/web
  npm.cmd run build --workspace @open-data-fusion/web
  ```

  Expected: CSV import tests and the existing manual accessibility test pass; typecheck and Vite build succeed.

- [ ] **Step 5: Commit the UI slice**

  ```powershell
  git add apps/web/src/components/CsvIngestForm.tsx apps/web/src/components/CsvIngestForm.test.tsx apps/web/src/components/IngestModal.tsx apps/web/src/components/IngestModal.test.tsx apps/web/src/styles.css apps/web/src/premium.css
  git commit -m "feat(web): import wide CSV measurement bundles"
  ```

### Task 4: Run feature and repository verification

**Files:**
- Verify: `apps/web/src/lib/csvIngest.ts`
- Verify: `apps/web/src/components/CsvIngestForm.tsx`
- Verify: `apps/web/src/components/IngestModal.tsx`

- [ ] **Step 1: Run the complete web suite**

  ```powershell
  npm.cmd test --workspace @open-data-fusion/web
  npm.cmd run typecheck --workspace @open-data-fusion/web
  npm.cmd run build --workspace @open-data-fusion/web
  ```

  Expected: all web tests pass, TypeScript passes, and Vite emits a production bundle.

- [ ] **Step 2: Run repository gates and inspect the final diff**

  ```powershell
  npm.cmd run check
  git diff --check origin/main...HEAD
  git status -sb
  ```

  Expected: all repository checks pass, no whitespace errors exist, and only the planned commits are ahead of `origin/main` before push.

- [ ] **Step 3: Push the verified commits and inspect remote CI**

  ```powershell
  git push origin main
  gh run list --branch main --limit 6 --json name,status,conclusion,headSha,url
  ```

  Expected: the latest CI, Security, and production-like smoke runs are queued or in progress for the pushed head; continue polling until each completes successfully before declaring the feature complete.
