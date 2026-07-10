import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { edgeAgentConfigSchema, loadEdgeAgentConfig, resolveEnvironmentReference } from "../src/config.js";

function validConfiguration(): Record<string, unknown> {
  return {
    agent: { archiveDirectory: "./data/raw", queuePath: "./data/queue.db" },
    delivery: {
      apiBaseUrl: "https://api.example.test",
      tenantId: "demo",
      projectId: "north-plant",
      token: {
        tokenUrl: "https://identity.example.test/oauth/token",
        clientIdEnv: "ODF_EDGE_CLIENT_ID",
        clientSecretEnv: "ODF_EDGE_CLIENT_SECRET",
      },
    },
    connectors: [
      {
        type: "csv",
        sourceSystem: "csv-pilot",
        filePath: "./pilot.csv",
        mapping: {
          timestampColumn: "timestamp",
          timeSeries: [
            {
              externalId: "P-101-PRESSURE",
              assetExternalId: "P-101",
              name: "Pressure",
              valueColumn: "pressure",
            },
          ],
        },
      },
    ],
  };
}

describe("edge-agent configuration", () => {
  it("applies bounded production defaults while retaining only environment references for credentials", () => {
    const configuration = edgeAgentConfigSchema.parse(validConfiguration());
    expect(configuration.agent.retry).toEqual({ baseDelayMs: 1_000, maxDelayMs: 300_000, jitterRatio: 0.2 });
    expect(configuration.connectors[0]).toMatchObject({ type: "csv", batchSize: 1_000 });
    expect(configuration.delivery.token.clientSecretEnv).toBe("ODF_EDGE_CLIENT_SECRET");
  });

  it("rejects inline secrets and unsafe PostgreSQL statements", () => {
    const inlineSecret = validConfiguration();
    (inlineSecret.delivery as { token: Record<string, unknown> }).token.clientSecret = "must-not-be-in-json";
    expect(edgeAgentConfigSchema.safeParse(inlineSecret).success).toBe(false);

    const unsafe = validConfiguration();
    unsafe.connectors = [
      {
        type: "postgres",
        sourceSystem: "plant-db",
        connectionStringEnv: "ODF_EDGE_PG_URL",
        query: "DELETE FROM telemetry WHERE id > $1 RETURNING * LIMIT $2",
        checkpointColumn: "id",
        initialCheckpoint: "0",
        mapping: {
          timestampColumn: "timestamp",
          timeSeries: [
            {
              externalId: "P-101-PRESSURE",
              assetExternalId: "P-101",
              name: "Pressure",
              valueColumn: "pressure",
            },
          ],
        },
      },
    ];
    expect(edgeAgentConfigSchema.safeParse(unsafe).success).toBe(false);
  });

  it("fails closed when a referenced secret is absent", () => {
    expect(() => resolveEnvironmentReference({}, "ODF_EDGE_CLIENT_SECRET", "test client")).toThrow(
      "Environment variable 'ODF_EDGE_CLIENT_SECRET' is required",
    );
    expect(resolveEnvironmentReference({ ODF_EDGE_CLIENT_SECRET: "runtime-only" }, "ODF_EDGE_CLIENT_SECRET", "test client")).toBe(
      "runtime-only",
    );
  });

  it("keeps the checked-in multi-connector example valid", async () => {
    const configuration = await loadEdgeAgentConfig(fileURLToPath(new URL("../config.example.json", import.meta.url)));
    expect(configuration.connectors.map((connector) => connector.type)).toEqual(["csv", "postgres", "opcua"]);
  });
});
