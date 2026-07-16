import { describe, expect, it } from "vitest";

import { buildCsvIngestBundle, CsvIngestError, parseDelimitedText, type CsvIngestMapping } from "./csvIngest";

describe("parseDelimitedText", () => {
  it("parses comma-delimited headers and a data row", () => {
    expect(parseDelimitedText("timestamp,value\n2026-07-16T12:00:00Z,42", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "2026-07-16T12:00:00Z", value: "42" }],
    });
  });

  it("rejects delimiters other than comma and tab", () => {
    const parseUnchecked = parseDelimitedText as (input: string, delimiter: string) => unknown;

    expect(() => parseUnchecked("timestamp;value\n2026-07-16;42", ";")).toThrow(
      CsvIngestError,
    );
  });

  it("preserves delimiters inside quoted cells", () => {
    expect(parseDelimitedText("timestamp,comment\n2026-07-16,\"rain, then sun\"", ",")).toEqual({
      headers: ["timestamp", "comment"],
      rows: [{ timestamp: "2026-07-16", comment: "rain, then sun" }],
    });
  });

  it("decodes doubled quotes inside quoted cells", () => {
    expect(parseDelimitedText("message\n\"The device said \"\"ready\"\"\"", ",")).toEqual({
      headers: ["message"],
      rows: [{ message: 'The device said "ready"' }],
    });
  });

  it("rejects a quote that does not begin a field", () => {
    expect(() => parseDelimitedText("timestamp,value\n2026-07-16,bad\"quote", ",")).toThrow(
      "row 2: quote must begin a field",
    );
  });

  it("rejects characters after a closing quote", () => {
    expect(() => parseDelimitedText("timestamp,value\n\"2026-07-16\"oops,42", ",")).toThrow(
      "row 2: invalid character after closing quote",
    );
  });

  it("rejects an unclosed quoted field with its source row", () => {
    expect(() => parseDelimitedText("timestamp,value\n2026-07-16,\"unfinished", ",")).toThrow(
      "row 2: unclosed quoted field",
    );
  });

  it("keeps the opening source row for an unclosed multiline quoted field", () => {
    expect(() => parseDelimitedText("timestamp,value\n\"first line\nsecond line", ",")).toThrow(
      "row 2: unclosed quoted field",
    );
  });

  it("rejects empty headers", () => {
    expect(() => parseDelimitedText(",value\n2026-07-16,42", ",")).toThrow("row 1: header 1 is empty");
  });

  it("rejects duplicate headers", () => {
    expect(() => parseDelimitedText("timestamp,timestamp\n2026-07-16,42", ",")).toThrow(
      "row 1: duplicate header 'timestamp'",
    );
  });

  it("rejects non-empty uneven rows with source-row context", () => {
    expect(() => parseDelimitedText("timestamp,value\n2026-07-16", ",")).toThrow(
      "row 2 has 1 cells; expected 2",
    );
  });

  it("ignores an entirely trailing empty physical record", () => {
    expect(parseDelimitedText("timestamp,value\n2026-07-16,42\n", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "2026-07-16", value: "42" }],
    });
  });

  it("ignores a completely empty trailing record but not one before data", () => {
    expect(parseDelimitedText("timestamp,value\n2026-07-16,42\n\n", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "2026-07-16", value: "42" }],
    });

    expect(() => parseDelimitedText("timestamp,value\n\n2026-07-16,42\n", ",")).toThrow(
      "row 2 has 1 cells; expected 2",
    );
  });

  it("retains valid empty cells before a trailing newline", () => {
    expect(parseDelimitedText("timestamp,value\n,\n", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "", value: "" }],
    });
  });

  it("parses tab-delimited input with quoted tabs", () => {
    expect(parseDelimitedText("timestamp\tcomment\n2026-07-16\t\"rain\tthen sun\"", "\t")).toEqual({
      headers: ["timestamp", "comment"],
      rows: [{ timestamp: "2026-07-16", comment: "rain\tthen sun" }],
    });
  });

  it("strips a leading UTF-8 byte-order mark", () => {
    expect(parseDelimitedText("\uFEFFtimestamp,value\n2026-07-16,42", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [{ timestamp: "2026-07-16", value: "42" }],
    });
  });

  it("recognizes CRLF, CR, and LF record endings", () => {
    expect(parseDelimitedText("timestamp,value\r2026-07-16,42\r\n2026-07-17,43\n", ",")).toEqual({
      headers: ["timestamp", "value"],
      rows: [
        { timestamp: "2026-07-16", value: "42" },
        { timestamp: "2026-07-17", value: "43" },
      ],
    });
  });
});

describe("buildCsvIngestBundle", () => {
  const baseMapping: CsvIngestMapping = {
    sourceSystem: " csv-pilot ",
    runId: " ",
    timestampColumn: "timestamp",
    assets: [{ externalId: " P-101 ", name: " Pump 101 ", type: " pump " }],
    timeSeries: [
      {
        externalId: "P-101-PRESSURE",
        assetExternalId: "P-101",
        name: "Pressure",
        valueColumn: "pressure",
        qualityColumn: "quality",
      },
      { externalId: "P-101-TEMP", assetExternalId: "P-101", name: "Temperature", valueColumn: "temperature" },
    ],
  };

  it("builds a wide-form bundle and omits a blank run ID", () => {
    const table = parseDelimitedText(
      "timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n",
      ",",
    );

    expect(buildCsvIngestBundle(table, baseMapping)).toEqual({
      source: { system: "csv-pilot" },
      assets: [{ externalId: "P-101", name: "Pump 101", type: "pump" }],
      timeSeries: [
        { externalId: "P-101-PRESSURE", assetExternalId: "P-101", name: "Pressure" },
        { externalId: "P-101-TEMP", assetExternalId: "P-101", name: "Temperature" },
      ],
      dataPoints: [
        {
          timeSeriesExternalId: "P-101-PRESSURE",
          timestamp: "2026-07-11T00:00:00.000Z",
          value: 101.2,
          quality: "good",
        },
        {
          timeSeriesExternalId: "P-101-TEMP",
          timestamp: "2026-07-11T00:00:00.000Z",
          value: 42.5,
          quality: "good",
        },
      ],
    });
  });

  it("rejects a source system longer than the API contract allows", () => {
    const table = parseDelimitedText(
      "timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n",
      ",",
    );

    expect(() => buildCsvIngestBundle(table, { ...baseMapping, sourceSystem: "s".repeat(101) })).toThrow(
      "sourceSystem must be at most 100 characters",
    );
  });

  it("normalizes integer epoch timestamps and uncertain quality", () => {
    const table = parseDelimitedText("timestamp,pressure,temperature,quality\n1783728000000,101.2,42.5, Uncertain \n", ",");

    expect(buildCsvIngestBundle(table, baseMapping).dataPoints?.[0]).toMatchObject({
      timestamp: "2026-07-11T00:00:00.000Z",
      quality: "uncertain",
    });
  });

  it("rejects missing static asset and series sets", () => {
    const table = parseDelimitedText("timestamp,pressure\n2026-07-11T00:00:00Z,101.2\n", ",");

    expect(() => buildCsvIngestBundle(table, { ...baseMapping, assets: [] })).toThrow("at least one asset");
    expect(() => buildCsvIngestBundle(table, { ...baseMapping, timeSeries: [] })).toThrow("at least one time series");
  });

  it("rejects asset and series definition counts above the API limits", () => {
    const table = parseDelimitedText(
      "timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n",
      ",",
    );
    const tooManyAssets = Array.from({ length: 10_001 }, (_, index) => ({
      externalId: `A-${index}`,
      name: `Asset ${index}`,
      type: "pump",
    }));
    const tooManySeries = Array.from({ length: 10_001 }, (_, index) => ({
      ...baseMapping.timeSeries[0],
      externalId: `S-${index}`,
    }));

    expect(() => buildCsvIngestBundle(table, { ...baseMapping, assets: tooManyAssets })).toThrow(
      "at most 10000 assets",
    );
    expect(() => buildCsvIngestBundle(table, { ...baseMapping, timeSeries: tooManySeries })).toThrow(
      "at most 10000 time series",
    );
  });

  it("rejects a header-only file that would produce no data points", () => {
    const table = parseDelimitedText("timestamp,pressure,temperature,quality\n", ",");

    expect(() => buildCsvIngestBundle(table, baseMapping)).toThrow("at least one data point");
  });

  it("rejects invalid external IDs, unknown assets, and shared entity IDs", () => {
    const table = parseDelimitedText("timestamp,pressure,temperature\n2026-07-11T00:00:00Z,101.2,42.5\n", ",");

    expect(() => buildCsvIngestBundle(table, { ...baseMapping, sourceSystem: "ok", runId: "bad id" })).toThrow(
      "not a valid external ID",
    );
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0], assetExternalId: "UNKNOWN" }],
    })).toThrow("unknown asset");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0], externalId: "P-101" }],
    })).toThrow("both an asset and a time series");
  });

  it("rejects external IDs longer than the API contract allows", () => {
    const table = parseDelimitedText(
      "timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n",
      ",",
    );
    const longId = "x".repeat(256);

    expect(() => buildCsvIngestBundle(table, { ...baseMapping, runId: longId })).toThrow(
      "runId must be at most 255 characters",
    );
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      assets: [{ ...baseMapping.assets[0], externalId: longId }],
    })).toThrow("assets[0].externalId must be at most 255 characters");
  });

  it("rejects asset and series metadata longer than the API contract allows", () => {
    const table = parseDelimitedText(
      "timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n",
      ",",
    );

    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      assets: [{ ...baseMapping.assets[0], name: "n".repeat(256) }],
    })).toThrow("assets[0].name must be at most 255 characters");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      assets: [{ ...baseMapping.assets[0], type: "t".repeat(101) }],
    })).toThrow("assets[0].type must be at most 100 characters");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0], name: "n".repeat(256) }],
    })).toThrow("timeSeries[0].name must be at most 255 characters");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0], unit: "u".repeat(51) }],
    })).toThrow("timeSeries[0].unit must be at most 50 characters");
  });

  it("rejects repeated IDs and invalid column reuse", () => {
    const table = parseDelimitedText("timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n", ",");

    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      assets: [...baseMapping.assets, { externalId: "P-101", name: "Duplicate", type: "pump" }],
    })).toThrow("asset external ID");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0] }, { ...baseMapping.timeSeries[0] }],
    })).toThrow("time series external ID");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0] }, { ...baseMapping.timeSeries[1], valueColumn: "pressure" }],
    })).toThrow("value column");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0], valueColumn: "timestamp" }],
    })).toThrow("timestamp column");
    expect(() => buildCsvIngestBundle(table, {
      ...baseMapping,
      timeSeries: [{ ...baseMapping.timeSeries[0] }, { ...baseMapping.timeSeries[1], valueColumn: "quality" }],
    })).toThrow("quality column");
  });

  it("rejects invalid timestamp, value, and quality cells", () => {
    expect(() => buildCsvIngestBundle(parseDelimitedText("timestamp,pressure,temperature,quality\nnot-a-date,101.2,42.5,good\n", ","), baseMapping)).toThrow("timestamp");
    expect(() => buildCsvIngestBundle(parseDelimitedText("timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,NaN,42.5,good\n", ","), baseMapping)).toThrow("finite number");
    expect(() => buildCsvIngestBundle(parseDelimitedText("timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,excellent\n", ","), baseMapping)).toThrow("quality");
  });

  it("reports the physical source row and mapped column for an invalid cell", () => {
    const table = parseDelimitedText(
      "timestamp,pressure,temperature,quality,note\n"
        + "2026-07-11T00:00:00Z,101.2,42.5,good,\"line one\nline two\"\n"
        + "2026-07-11T00:01:00Z,not-a-number,42.6,good,stable\n",
      ",",
    );

    expect(() => buildCsvIngestBundle(table, baseMapping)).toThrow("row 4, column 'pressure'");
  });

  it("rejects duplicate observations", () => {
    const table = parseDelimitedText(
      "timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n2026-07-11T00:00:00.000Z,101.3,42.6,good\n",
      ",",
    );

    expect(() => buildCsvIngestBundle(table, baseMapping)).toThrow("duplicate observation");
  });

  it("rejects more than 100,000 output points", () => {
    const rows = Array.from({ length: 50_001 }, (_, index) => `${1783728000000 + index},${index},${index},good`);
    const table = parseDelimitedText(`timestamp,pressure,temperature,quality\n${rows.join("\n")}`, ",");

    expect(() => buildCsvIngestBundle(table, baseMapping)).toThrow("100000 data points");
  });

  it("rejects serialized bundles at or above the 10 MiB boundary", () => {
    const rows = Array.from({ length: 40_000 }, (_, index) => `${1783728000000 + index},${index}`);
    const table = parseDelimitedText(`timestamp,pressure\n${rows.join("\n")}`, ",");
    const longSeriesId = `S${"x".repeat(254)}`;

    expect(() => buildCsvIngestBundle(table, {
      sourceSystem: "csv-pilot",
      runId: "",
      timestampColumn: "timestamp",
      assets: [{ externalId: "P-101", name: "Pump 101", type: "pump" }],
      timeSeries: [{
        externalId: longSeriesId,
        assetExternalId: "P-101",
        name: "Pressure",
        valueColumn: "pressure",
      }],
    })).toThrow("10 MiB");
  });
});
