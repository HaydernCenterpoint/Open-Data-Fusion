# Browser CSV Import Design

**Date:** 2026-07-16
**Status:** Approved direction; awaiting review of this written specification

## Decision

Add a one-shot browser importer for UTF-8 CSV and TSV files in the existing
`Ingest data` dialog. It will use the same wide-form mapping model as the edge
CSV connector: one timestamp column and one or more value columns, with static
asset and time-series metadata supplied in the dialog. It will construct an
existing `IngestBundle` and submit it to the existing scoped `/api/ingest`
endpoint. No API route, storage path, or new dependency is introduced.

This is an interactive import helper, not a scheduled connector. Repeated,
large, or durable source ingestion remains the responsibility of the edge
agent.

## Goals

- Import a local, headered CSV or TSV file into the currently selected
  tenant/project without sending it anywhere until the user clicks Import.
- Preview parsed headers and rows, then map one timestamp column plus one or
  more series value columns.
- Allow one or more static assets and per-series external ID, name, asset,
  optional unit, and optional quality-column mapping.
- Validate all mapped records in the browser before one atomic ingest request.
- Preserve the API's idempotency behavior: the source run ID is optional; when
  blank, the client omits it so the API derives its stable content key.
- Keep the manual one-asset/one-series/one-point entry path available.

## Non-goals

- Long-form rows that carry dynamic asset or series IDs.
- Server-side file upload, original-file retention, mapping persistence,
  scheduling, retries, or background processing.
- ZIP, Excel, JSON, locale-specific numeric formats, or arbitrary encodings.
- Replacing the edge agent's checkpointed CSV connector.

## User flow

1. The existing ingest dialog gains a choice between **Manual measurement** and
   **Import CSV/TSV**. The current manual form is unchanged.
2. In import mode, the user selects a `.csv` or `.tsv` file and chooses comma
   or tab as its delimiter. The parser accepts a UTF-8 BOM, quoted fields,
   escaped quotes, and LF or CRLF line endings.
3. A bounded preview shows the header and the first parsed rows. The user enters
   the source system and an optional source run ID, selects the timestamp
   column, configures one or more static assets, and configures one or more
   series mappings.
4. Each series mapping selects a value column and may select a quality column.
   It also declares the series external ID, name, asset external ID, and an
   optional unit. Every series must select one of the configured assets. The
   dialog prevents duplicate selected value columns and duplicate entity
   definitions before submission.
5. The dialog displays the generated asset, series, and data-point counts.
   Import becomes available only when the mapping and every record are valid.
6. Import sends exactly one `IngestBundle` through `ingestBundle(context, bundle)`.
   On success, it uses the existing completion notice and asset refresh. On an
   API error, the dialog remains open with the returned message.

## Mapping model

For a file such as:

```csv
timestamp,pressure,temperature,quality
2026-07-11T00:00:00Z,101.2,42.5,good
2026-07-11T00:01:00Z,101.8,42.7,uncertain
```

the user can configure one Pump asset and two series (`pressure` and
`temperature`). Each input row produces one data point for each configured
series. Timestamp values accept ISO-8601 text or epoch milliseconds. Values
must be finite JavaScript numbers. Quality values, when mapped, must be
`good`, `uncertain`, or `bad`; unmapped quality defaults to `good`.

Asset and series definitions are emitted once, while points are emitted per
row. A configured series must refer to a configured asset; submitting that
asset definition makes its create-or-update behavior deterministic across both
supported persistence backends. The client constructs only the existing
`IngestBundle` shape, so the API remains the authority for tenant scope,
authorization, schema validation, atomicity, idempotency, and persistence.

## Limits and failure handling

- The generated bundle must contain at least one record and at most 100,000
  data points, matching the API schema.
- Before sending, the browser serializes the generated bundle and rejects a
  payload at or above the API's 10 MB JSON request limit.
- Missing headers, duplicate headers, malformed quoting, uneven rows, empty
  required cells, invalid timestamps, non-finite values, unsupported quality,
  duplicate points, duplicate definitions, and cross-type external-ID
  collisions produce a clear local error with the relevant row and column.
- Selecting a new file or delimiter clears the old mapping and validation
  result. The raw file is never inserted into the DOM or rendered as HTML.
- The file stays in browser memory only. This feature does not claim original
  CSV retention or replay capability.

## Code boundaries

- Add a focused browser-only parser/mapper module under
  `apps/web/src/lib/`. It owns CSV parsing, preview records, mapping validation,
  and `IngestBundle` construction. It does not perform network requests or
  render UI.
- Extend `apps/web/src/components/IngestModal.tsx` to own dialog state and call
  the existing API function after the mapper succeeds.
- Extend the existing component tests and add mapper tests. No API, database,
  Compose, or dependency-manifest changes are required.

## Verification

Unit coverage will prove quoted CSV/TSV parsing; BOM and newline handling;
wide-form mapping for multiple series; ISO and epoch timestamps; quality
propagation; validation errors; idempotency-friendly absent run IDs; 100,000
point and 10 MB payload guards; and the dialog's preview, submit, error, and
focus behavior. The completion gate is the web test suite, web typecheck and
production build, followed by the repository-wide `npm run check`.

## Acceptance criteria

1. A user can import a valid CSV or TSV with one timestamp column and multiple
   mapped value columns into the selected tenant/project.
2. The browser never sends data before an explicit Import action and sends one
   valid atomic bundle after successful local validation.
3. Invalid source data is rejected with actionable row/column feedback before
   the network request.
4. Manual ingestion continues to work unchanged.
5. The feature adds no dependency and all prescribed checks pass.
