import { describe, expect, it, vi } from "vitest";

import { connectorConfigSchema } from "../src/config.js";
import { connectorSchemaContract, rehearseConnectors } from "../src/rehearsal.js";
import type { ManagedConnector } from "../src/runner.js";
import type { ConnectorBatch } from "../src/types.js";

const tabularMapping = {
  timestampColumn: "observed_at",
  assets: [],
  timeSeries: [{
    externalId: "P-101-PRESSURE",
    assetExternalId: "P-101",
    name: "Pressure",
    valueColumn: "pressure",
    qualityColumn: "quality",
  }],
};

const postgresConfiguration = connectorConfigSchema.parse({
  type: "postgres",
  sourceSystem: "historian",
  connectionStringEnv: "ODF_EDGE_HISTORIAN_URL",
  query: "SELECT id, observed_at, pressure, quality FROM historian.readings WHERE id > $1 ORDER BY id LIMIT $2",
  checkpointColumn: "id",
  initialCheckpoint: "0",
  mapping: tabularMapping,
});

if (postgresConfiguration.type !== "postgres") throw new Error("Unexpected connector configuration");

function batch(checkpointAfter: string): ConnectorBatch {
  return {
    checkpointAfter,
    observedAt: "2026-07-12T00:00:00.000Z",
    assets: [],
    timeSeries: [],
    dataPoints: [{ timeSeriesExternalId: "P-101-PRESSURE", timestamp: "2026-07-12T00:00:00.000Z", value: 100, quality: "good" }],
    documents: [],
    relations: [],
    rawRecords: [{ id: checkpointAfter, observed_at: "2026-07-12T00:00:00.000Z", pressure: 100, quality: "good" }],
  };
}

describe("connector rehearsal", () => {
  it("proves a bounded backfill can resume without queuing or delivery", async () => {
    const poll = vi.fn()
      .mockResolvedValueOnce(batch("11"))
      .mockResolvedValueOnce(batch("12"))
      .mockResolvedValueOnce(null);
    const close = vi.fn().mockResolvedValue(undefined);
    const connectors: ManagedConnector[] = [{ sourceSystem: "historian", connector: { poll, close } }];

    const results = await rehearseConnectors(connectors, [postgresConfiguration], { maxBatches: 3 });

    expect(poll).toHaveBeenNthCalledWith(1, null);
    expect(poll).toHaveBeenNthCalledWith(2, "11");
    expect(poll).toHaveBeenNthCalledWith(3, "12");
    expect(close).toHaveBeenCalledOnce();
    expect(results).toEqual([expect.objectContaining({
      sourceSystem: "historian",
      initialCheckpoint: null,
      finalCheckpoint: "12",
      exhausted: true,
      batches: [
        { checkpointAfter: "11", rawRecordCount: 1, dataPointCount: 1 },
        { checkpointAfter: "12", rawRecordCount: 1, dataPointCount: 1 },
      ],
    })]);
  });

  it("rejects a non-advancing source checkpoint and still closes the connector", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const connectors: ManagedConnector[] = [{ sourceSystem: "historian", connector: { poll: vi.fn().mockResolvedValue(batch("7")), close } }];

    await expect(rehearseConnectors(connectors, [postgresConfiguration], {
      checkpoints: { historian: "7" },
    })).rejects.toThrow("did not advance");
    expect(close).toHaveBeenCalledOnce();
  });

  it("publishes the required source fields and schema-evolution contract", () => {
    expect(connectorSchemaContract(postgresConfiguration)).toEqual({
      connectorType: "postgres",
      requiredFields: ["id", "observed_at", "pressure", "quality"],
      schemaEvolutionPolicy: expect.stringContaining("Removing or renaming"),
    });
  });
});
