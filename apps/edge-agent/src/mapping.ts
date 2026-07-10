import type { TabularMappingConfig } from "./config.js";
import type { IngestAsset, IngestDataPoint, IngestTimeSeries } from "./types.js";

export interface MappedTabularRecords {
  assets: IngestAsset[];
  timeSeries: IngestTimeSeries[];
  dataPoints: IngestDataPoint[];
}

export function mappedAssets(assets: TabularMappingConfig["assets"]): IngestAsset[] {
  return assets.map((asset) => ({
    externalId: asset.externalId,
    name: asset.name,
    type: asset.type,
    metadata: asset.metadata,
    ...(asset.parentExternalId !== undefined ? { parentExternalId: asset.parentExternalId } : {}),
    ...(asset.description !== undefined ? { description: asset.description } : {}),
  }));
}

function mappedTimeSeries(mapping: TabularMappingConfig): IngestTimeSeries[] {
  return mapping.timeSeries.map((series) => ({
    externalId: series.externalId,
    assetExternalId: series.assetExternalId,
    name: series.name,
    metadata: series.metadata,
    ...(series.unit !== undefined ? { unit: series.unit } : {}),
    ...(series.description !== undefined ? { description: series.description } : {}),
  }));
}

function requiredColumn(record: Record<string, unknown>, column: string, rowNumber: number): unknown {
  if (!Object.hasOwn(record, column)) {
    throw new Error(`Row ${rowNumber} does not contain configured column '${column}'`);
  }
  return record[column];
}

function timestamp(value: unknown, column: string, rowNumber: number): string {
  let milliseconds: number;
  if (value instanceof Date) {
    milliseconds = value.getTime();
  } else if (typeof value === "number") {
    milliseconds = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const parsedDate = Date.parse(trimmed);
    milliseconds = Number.isFinite(parsedDate) ? parsedDate : Number(trimmed);
  } else {
    milliseconds = Number.NaN;
  }

  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Row ${rowNumber} column '${column}' is not a valid ISO-8601 timestamp or epoch milliseconds`);
  }
  return new Date(milliseconds).toISOString();
}

function finiteNumber(value: unknown, column: string, rowNumber: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`Row ${rowNumber} column '${column}' is not a finite number`);
  }
  return parsed;
}

function quality(value: unknown, column: string, rowNumber: number): IngestDataPoint["quality"] {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "good" || normalized === "uncertain" || normalized === "bad") return normalized;
  throw new Error(`Row ${rowNumber} column '${column}' must be good, uncertain, or bad`);
}

export function mapTabularRecords(
  records: readonly Record<string, unknown>[],
  mapping: TabularMappingConfig,
): MappedTabularRecords {
  const timeSeries = mappedTimeSeries(mapping);
  const dataPoints: IngestDataPoint[] = [];

  records.forEach((record, index) => {
    const rowNumber = index + 1;
    const observedAt = timestamp(requiredColumn(record, mapping.timestampColumn, rowNumber), mapping.timestampColumn, rowNumber);
    for (const series of mapping.timeSeries) {
      const pointQuality = series.qualityColumn
        ? quality(requiredColumn(record, series.qualityColumn, rowNumber), series.qualityColumn, rowNumber)
        : "good";
      dataPoints.push({
        timeSeriesExternalId: series.externalId,
        timestamp: observedAt,
        value: finiteNumber(requiredColumn(record, series.valueColumn, rowNumber), series.valueColumn, rowNumber),
        quality: pointQuality,
      });
    }
  });

  return {
    assets: mappedAssets(mapping.assets),
    timeSeries,
    dataPoints,
  };
}
