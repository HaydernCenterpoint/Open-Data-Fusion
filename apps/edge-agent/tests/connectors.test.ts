import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectorConfigSchema } from "../src/config.js";
import { CsvConnector } from "../src/connectors/csv.js";
import { OpcUaConnector, type OpcUaReadValue, type OpcUaValueReader } from "../src/connectors/opcua.js";
import { PostgresConnector, type PostgresQuerySource } from "../src/connectors/postgres.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const tabularMapping = {
  timestampColumn: "timestamp",
  assets: [{ externalId: "P-101", name: "Pump 101", type: "pump" }],
  timeSeries: [
    {
      externalId: "P-101-PRESSURE",
      assetExternalId: "P-101",
      name: "Pressure",
      unit: "bar",
      valueColumn: "pressure",
      qualityColumn: "quality",
    },
  ],
};

describe("source connectors", () => {
  it("backfills an append-only CSV in bounded checkpointed batches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odf-csv-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "telemetry.csv");
    await writeFile(
      filePath,
      "timestamp,pressure,quality\n2026-07-11T00:00:00Z,101.2,good\n2026-07-11T00:01:00Z,101.8,uncertain\n2026-07-11T00:02:00Z,102.1,good\n",
    );
    const configuration = connectorConfigSchema.parse({
      type: "csv",
      sourceSystem: "csv-pilot",
      filePath,
      batchSize: 2,
      mapping: tabularMapping,
    });
    if (configuration.type !== "csv") throw new Error("Unexpected connector type");
    const connector = new CsvConnector(configuration, { now: () => new Date("2026-07-11T01:00:00Z") });

    const first = await connector.poll(null);
    expect(first?.rawRecords).toHaveLength(2);
    expect(first?.dataPoints.map((point) => point.value)).toEqual([101.2, 101.8]);
    const second = await connector.poll(first!.checkpointAfter);
    expect(second?.dataPoints.map((point) => point.value)).toEqual([102.1]);
    expect(await connector.poll(second!.checkpointAfter)).toBeNull();

    await appendFile(filePath, "2026-07-11T00:03:00Z,102.7,bad\n");
    const appended = await connector.poll(second!.checkpointAfter);
    expect(appended?.dataPoints[0]).toMatchObject({ value: 102.7, quality: "bad" });

    await writeFile(
      filePath,
      "timestamp,pressure,quality\n2026-07-11T00:00:00Z,999.9,good\n2026-07-11T00:01:00Z,101.8,uncertain\n2026-07-11T00:02:00Z,102.1,good\n2026-07-11T00:03:00Z,102.7,bad\n",
    );
    await expect(connector.poll(appended!.checkpointAfter)).rejects.toThrow("changed before its checkpoint boundary");
  });

  it("passes the PostgreSQL checkpoint and batch bound as parameters and rejects non-monotonic results", async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const source: PostgresQuerySource = {
      async query(text, values) {
        calls.push({ text, values });
        return {
          rows: [
            { id: 11, timestamp: "2026-07-11T00:00:00Z", pressure: "100.1", quality: "good" },
            { id: 12, timestamp: "2026-07-11T00:01:00Z", pressure: "100.4", quality: "good" },
          ],
        };
      },
      async close() {},
    };
    const configuration = connectorConfigSchema.parse({
      type: "postgres",
      sourceSystem: "plant-db",
      connectionStringEnv: "ODF_EDGE_PG_URL",
      query: "SELECT id, timestamp, pressure, quality FROM telemetry WHERE id > $1 ORDER BY id LIMIT $2",
      checkpointColumn: "id",
      initialCheckpoint: "0",
      batchSize: 2,
      mapping: tabularMapping,
    });
    if (configuration.type !== "postgres") throw new Error("Unexpected connector type");
    const connector = new PostgresConnector(configuration, source, { now: () => new Date("2026-07-11T01:00:00Z") });

    const batch = await connector.poll("10");
    expect(calls).toEqual([{ text: configuration.query, values: ["10", 2] }]);
    expect(batch?.checkpointAfter).toBe("12");
    expect(batch?.dataPoints.map((point) => point.value)).toEqual([100.1, 100.4]);

    source.query = async () => ({
      rows: [
        { id: 9, timestamp: "2026-07-11T00:02:00Z", pressure: 100.5, quality: "good" },
        { id: 11, timestamp: "2026-07-11T00:03:00Z", pressure: 100.6, quality: "good" },
      ],
    });
    await expect(connector.poll("10")).rejects.toThrow("first checkpoint column 'id' must be strictly greater than the stored checkpoint");

    source.query = async () => ({
      rows: [
        { id: 10, timestamp: "2026-07-11T00:02:00Z", pressure: 100.5, quality: "good" },
        { id: 11, timestamp: "2026-07-11T00:03:00Z", pressure: 100.6, quality: "good" },
      ],
    });
    await expect(connector.poll("10")).rejects.toThrow("first checkpoint column 'id' must be strictly greater than the stored checkpoint");

    source.query = async () => ({
      rows: [
        { id: 12, timestamp: "2026-07-11T00:02:00Z", pressure: 100.5, quality: "good" },
        { id: 11, timestamp: "2026-07-11T00:03:00Z", pressure: 100.6, quality: "good" },
      ],
    });
    await expect(connector.poll("10")).rejects.toThrow("strictly increasing");
  });

  it("maps OPC-UA node security/read metadata and checkpoints each node independently", async () => {
    let values: OpcUaReadValue[] = [
      {
        nodeId: "ns=2;s=P101.Pressure",
        value: 10,
        sourceTimestamp: new Date("2026-07-11T00:00:00Z"),
        serverTimestamp: null,
        quality: "good",
        statusCode: "Good",
      },
      {
        nodeId: "ns=2;s=P101.Temperature",
        value: 20,
        sourceTimestamp: new Date("2026-07-11T00:00:00Z"),
        serverTimestamp: null,
        quality: "uncertain",
        statusCode: "Uncertain",
      },
    ];
    let closed = false;
    const reader: OpcUaValueReader = {
      async read() {
        return values;
      },
      async close() {
        closed = true;
      },
    };
    const configuration = connectorConfigSchema.parse({
      type: "opcua",
      sourceSystem: "plc-1",
      endpointUrl: "opc.tcp://plc.example.test:4840",
      securityMode: "None",
      securityPolicy: "None",
      assets: [{ externalId: "P-101", name: "Pump 101", type: "pump" }],
      nodes: [
        {
          nodeId: "ns=2;s=P101.Pressure",
          timeSeriesExternalId: "P-101-PRESSURE",
          assetExternalId: "P-101",
          name: "Pressure",
          scale: 2,
          offset: 1,
        },
        {
          nodeId: "ns=2;s=P101.Temperature",
          timeSeriesExternalId: "P-101-TEMPERATURE",
          assetExternalId: "P-101",
          name: "Temperature",
        },
      ],
    });
    if (configuration.type !== "opcua") throw new Error("Unexpected connector type");
    const connector = new OpcUaConnector(configuration, reader, { now: () => new Date("2026-07-11T00:00:01Z") });

    const first = await connector.poll(null);
    expect(first?.dataPoints).toEqual([
      expect.objectContaining({ timeSeriesExternalId: "P-101-PRESSURE", value: 21, quality: "good" }),
      expect.objectContaining({ timeSeriesExternalId: "P-101-TEMPERATURE", value: 20, quality: "uncertain" }),
    ]);
    expect(await connector.poll(first!.checkpointAfter)).toBeNull();

    values = [
      { ...values[0]!, value: 11, sourceTimestamp: new Date("2026-07-11T00:00:02Z") },
      values[1]!,
    ];
    const incremental = await connector.poll(first!.checkpointAfter);
    expect(incremental?.dataPoints).toHaveLength(1);
    expect(incremental?.dataPoints[0]?.value).toBe(23);
    await connector.close();
    expect(closed).toBe(true);
  });
});
