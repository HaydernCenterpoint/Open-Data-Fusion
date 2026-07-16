import type { IngestBundle } from "../types";

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

type ParserState = "unquoted" | "quoted" | "after-quote";

type NormalizedQuality = "good" | "uncertain" | "bad";

interface ParsedRecord {
  cells: string[];
  sourceRow: number;
  hasContent: boolean;
}

const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_ENTITY_DEFINITIONS = 10_000;
const MAX_DATA_POINTS = 100_000;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const INTEGER_EPOCH_PATTERN = /^-?\d+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SOURCE_ROW_BY_RECORD = new WeakMap<Record<string, string>, number>();

function isRecordEnding(character: string): boolean {
  return character === "\r" || character === "\n";
}

export function parseDelimitedText(input: string, delimiter: CsvDelimiter): DelimitedTable {
  if (delimiter !== "," && delimiter !== "\t") {
    throw new CsvIngestError("delimiter must be a comma or tab");
  }

  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let state: ParserState = "unquoted";
  let sourceRow = 1;
  let recordSourceRow = 1;
  let recordHasContent = false;
  let index = input.charCodeAt(0) === 0xfeff ? 1 : 0;

  const finishRecord = () => {
    cells.push(cell);
    records.push({ cells, sourceRow: recordSourceRow, hasContent: recordHasContent });
    cells = [];
    cell = "";
    recordHasContent = false;
  };

  const advancePastRecordEnding = (character: string, startsNextRecord = true) => {
    if (character === "\r" && input[index + 1] === "\n") index += 1;
    sourceRow += 1;
    if (startsNextRecord) recordSourceRow = sourceRow;
  };

  for (; index < input.length; index += 1) {
    const character = input[index];

    if (state === "quoted") {
      if (character === "\"") {
        if (input[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          state = "after-quote";
        }
      } else if (isRecordEnding(character)) {
        cell += character;
        advancePastRecordEnding(character, false);
        if (character === "\r" && input[index] === "\n") cell += "\n";
      } else {
        cell += character;
      }
      continue;
    }

    if (state === "after-quote") {
      if (character === delimiter) {
        cells.push(cell);
        cell = "";
        state = "unquoted";
        continue;
      }
      if (isRecordEnding(character)) {
        finishRecord();
        advancePastRecordEnding(character);
        state = "unquoted";
        continue;
      }
      throw new CsvIngestError(`row ${sourceRow}: invalid character after closing quote`);
    }

    if (character === delimiter) {
      cells.push(cell);
      cell = "";
      recordHasContent = true;
      continue;
    }

    if (isRecordEnding(character)) {
      finishRecord();
      advancePastRecordEnding(character);
      continue;
    }

    if (character === "\"") {
      if (cell !== "") {
        throw new CsvIngestError(`row ${sourceRow}: quote must begin a field`);
      }
      recordHasContent = true;
      state = "quoted";
      continue;
    }

    cell += character;
    recordHasContent = true;
  }

  if (state === "quoted") {
    throw new CsvIngestError(`row ${recordSourceRow}: unclosed quoted field`);
  }

  if (recordHasContent || records.length === 0) finishRecord();

  while (records.length > 1 && !records[records.length - 1].hasContent) {
    records.pop();
  }

  const [headerRecord, ...dataRecords] = records;
  const headers = headerRecord.cells;
  const headerNames = new Set<string>();

  headers.forEach((header, column) => {
    if (header === "") {
      throw new CsvIngestError(`row ${headerRecord.sourceRow}: header ${column + 1} is empty`);
    }
    if (headerNames.has(header)) {
      throw new CsvIngestError(`row ${headerRecord.sourceRow}: duplicate header '${header}'`);
    }
    headerNames.add(header);
  });

  dataRecords.forEach((record) => {
    if (record.cells.length !== headers.length) {
      throw new CsvIngestError(
        `row ${record.sourceRow} has ${record.cells.length} cells; expected ${headers.length}`,
      );
    }
  });

  const rows = dataRecords.map((record) => {
    const row = Object.fromEntries(record.cells.map((value, column) => [headers[column], value]));
    SOURCE_ROW_BY_RECORD.set(row, record.sourceRow);
    return row;
  });

  return { headers, rows };
}

function requireNonBlank(value: string, field: string, maxLength?: number): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new CsvIngestError(`${field} is required`);
  if (maxLength !== undefined && trimmed.length > maxLength) {
    throw new CsvIngestError(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function requireExternalId(value: string, field: string): string {
  const trimmed = requireNonBlank(value, field, 255);
  if (!EXTERNAL_ID_PATTERN.test(trimmed)) {
    throw new CsvIngestError(`${field} '${trimmed}' is not a valid external ID`);
  }
  return trimmed;
}

function requireColumn(headers: Set<string>, column: string, field: string): string {
  const trimmed = requireNonBlank(column, field);
  if (!headers.has(trimmed)) throw new CsvIngestError(`${field} '${trimmed}' is not a table column`);
  return trimmed;
}

function normalizeTimestamp(value: string, column: string, sourceRow: number): string {
  const trimmed = value.trim();
  const timestamp = INTEGER_EPOCH_PATTERN.test(trimmed) ? Number(trimmed) : trimmed;
  if (typeof timestamp === "string" && !ISO_TIMESTAMP_PATTERN.test(timestamp)) {
    throw new CsvIngestError(
      `row ${sourceRow}, column '${column}': timestamp '${trimmed}' is not an ISO-8601 timestamp or integer epoch milliseconds`,
    );
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new CsvIngestError(
      `row ${sourceRow}, column '${column}': timestamp '${trimmed}' is not an ISO-8601 timestamp or integer epoch milliseconds`,
    );
  }
  return date.toISOString();
}

function normalizeValue(value: string, column: string, sourceRow: number): number {
  const trimmed = value.trim();
  if (trimmed === "") throw new CsvIngestError(`row ${sourceRow}, column '${column}': value is blank`);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new CsvIngestError(`row ${sourceRow}, column '${column}': value must be a finite number`);
  }
  return parsed;
}

function normalizeQuality(value: string | undefined, column: string, sourceRow: number): NormalizedQuality {
  if (value === undefined || value.trim() === "") return "good";
  const normalized = value.trim().toLowerCase();
  if (normalized === "good" || normalized === "uncertain" || normalized === "bad") return normalized;
  throw new CsvIngestError(
    `row ${sourceRow}, column '${column}': quality '${value}' must be good, uncertain, or bad`,
  );
}

function assertUnique(value: string, values: Set<string>, description: string): void {
  if (values.has(value)) throw new CsvIngestError(`${description} '${value}' is duplicated`);
  values.add(value);
}

export function buildCsvIngestBundle(table: DelimitedTable, mapping: CsvIngestMapping): IngestBundle {
  const headers = new Set(table.headers);
  const sourceSystem = requireNonBlank(mapping.sourceSystem, "sourceSystem", 100);
  const runId = mapping.runId.trim() === "" ? "" : requireExternalId(mapping.runId, "runId");
  const timestampColumn = requireColumn(headers, mapping.timestampColumn, "timestampColumn");

  if (mapping.assets.length === 0) throw new CsvIngestError("at least one asset is required");
  if (mapping.timeSeries.length === 0) throw new CsvIngestError("at least one time series is required");
  if (mapping.assets.length > MAX_ENTITY_DEFINITIONS) {
    throw new CsvIngestError(`CSV import may define at most ${MAX_ENTITY_DEFINITIONS} assets`);
  }
  if (mapping.timeSeries.length > MAX_ENTITY_DEFINITIONS) {
    throw new CsvIngestError(`CSV import may define at most ${MAX_ENTITY_DEFINITIONS} time series`);
  }
  if (table.rows.length === 0) throw new CsvIngestError("at least one data point is required");

  const assetIds = new Set<string>();
  const seriesIds = new Set<string>();
  const valueColumns = new Set<string>();
  const qualityColumns = new Set<string>();

  const assets = mapping.assets.map((asset, index) => {
    const externalId = requireExternalId(asset.externalId, `assets[${index}].externalId`);
    assertUnique(externalId, assetIds, "asset external ID");
    return {
      externalId,
      name: requireNonBlank(asset.name, `assets[${index}].name`, 255),
      type: requireNonBlank(asset.type, `assets[${index}].type`, 100),
    };
  });

  const timeSeries = mapping.timeSeries.map((series, index) => {
    const externalId = requireExternalId(series.externalId, `timeSeries[${index}].externalId`);
    assertUnique(externalId, seriesIds, "time series external ID");
    if (assetIds.has(externalId)) {
      throw new CsvIngestError(`external ID '${externalId}' is used by both an asset and a time series`);
    }

    const assetExternalId = requireExternalId(series.assetExternalId, `timeSeries[${index}].assetExternalId`);
    if (!assetIds.has(assetExternalId)) {
      throw new CsvIngestError(`time series '${externalId}' is bound to unknown asset '${assetExternalId}'`);
    }

    const valueColumn = requireColumn(headers, series.valueColumn, `timeSeries[${index}].valueColumn`);
    assertUnique(valueColumn, valueColumns, "value column");
    if (valueColumn === timestampColumn) throw new CsvIngestError(`value column '${valueColumn}' reuses the timestamp column`);

    const qualityColumn = series.qualityColumn === undefined || series.qualityColumn.trim() === ""
      ? undefined
      : requireColumn(headers, series.qualityColumn, `timeSeries[${index}].qualityColumn`);
    if (qualityColumn !== undefined) qualityColumns.add(qualityColumn);

    const unit = series.unit?.trim();
    if (unit !== undefined && unit.length > 50) {
      throw new CsvIngestError(`timeSeries[${index}].unit must be at most 50 characters`);
    }
    return {
      externalId,
      assetExternalId,
      name: requireNonBlank(series.name, `timeSeries[${index}].name`, 255),
      ...(unit ? { unit } : {}),
      valueColumn,
      qualityColumn,
    };
  });

  valueColumns.forEach((valueColumn) => {
    if (qualityColumns.has(valueColumn)) throw new CsvIngestError(`value column '${valueColumn}' reuses a quality column`);
  });

  const pointKeys = new Set<string>();
  const dataPoints: NonNullable<IngestBundle["dataPoints"]> = [];
  table.rows.forEach((row, rowIndex) => {
    const sourceRow = SOURCE_ROW_BY_RECORD.get(row) ?? rowIndex + 2;
    const timestamp = normalizeTimestamp(row[timestampColumn] ?? "", timestampColumn, sourceRow);
    timeSeries.forEach((series) => {
      if (dataPoints.length >= MAX_DATA_POINTS) throw new CsvIngestError(`CSV import would exceed ${MAX_DATA_POINTS} data points`);
      const key = `${series.externalId}\u0000${timestamp}`;
      if (pointKeys.has(key)) throw new CsvIngestError(`duplicate observation for '${series.externalId}' at ${timestamp}`);
      pointKeys.add(key);
      dataPoints.push({
        timeSeriesExternalId: series.externalId,
        timestamp,
        value: normalizeValue(row[series.valueColumn] ?? "", series.valueColumn, sourceRow),
        quality: normalizeQuality(
          series.qualityColumn === undefined ? undefined : row[series.qualityColumn],
          series.qualityColumn ?? series.valueColumn,
          sourceRow,
        ),
      });
    });
  });

  const bundle: IngestBundle = {
    source: runId === "" ? { system: sourceSystem } : { system: sourceSystem, runId },
    assets,
    timeSeries: timeSeries.map(({ valueColumn: _valueColumn, qualityColumn: _qualityColumn, ...series }) => series),
    dataPoints,
  };

  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength >= MAX_BUNDLE_BYTES) {
    throw new CsvIngestError("CSV ingest bundle must be smaller than 10 MiB");
  }

  return bundle;
}
