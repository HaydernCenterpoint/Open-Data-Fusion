import { readFile } from "node:fs/promises";
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

  it("validates file-backed outbound mTLS configuration", () => {
    const configured = validConfiguration();
    (configured.delivery as Record<string, unknown>).mtls = {
      certificateFile: "/run/secrets/edge-client.crt",
      privateKeyFile: "/run/secrets/edge-client.key",
      caFile: "/run/secrets/ingest-ca.pem",
      serverName: "ingest.example.test",
    };
    expect(edgeAgentConfigSchema.parse(configured).delivery.mtls).toEqual({
      certificateFile: "/run/secrets/edge-client.crt",
      privateKeyFile: "/run/secrets/edge-client.key",
      caFile: "/run/secrets/ingest-ca.pem",
      serverName: "ingest.example.test",
    });

    const incomplete = validConfiguration();
    (incomplete.delivery as Record<string, unknown>).mtls = { certificateFile: "/run/secrets/edge-client.crt" };
    expect(edgeAgentConfigSchema.safeParse(incomplete).success).toBe(false);

    const plaintext = validConfiguration();
    (plaintext.delivery as Record<string, unknown>).mtls = {
      certificateFile: "-----BEGIN CERTIFICATE-----\\ncertificate-data",
      privateKeyFile: "/run/secrets/edge-client.key",
    };
    expect(edgeAgentConfigSchema.safeParse(plaintext).success).toBe(false);

    const insecureEndpoint = validConfiguration();
    (insecureEndpoint.delivery as Record<string, unknown>).apiBaseUrl = "http://api.example.test";
    (insecureEndpoint.delivery as Record<string, unknown>).mtls = {
      certificateFile: "/run/secrets/edge-client.crt",
      privateKeyFile: "/run/secrets/edge-client.key",
    };
    expect(edgeAgentConfigSchema.safeParse(insecureEndpoint).success).toBe(false);

    const unknownMtlsField = validConfiguration();
    (unknownMtlsField.delivery as Record<string, unknown>).mtls = {
      certificateFile: "/run/secrets/edge-client.crt",
      privateKeyFile: "/run/secrets/edge-client.key",
      rejectUnauthorized: false,
    };
    expect(edgeAgentConfigSchema.safeParse(unknownMtlsField).success).toBe(false);
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

  it("keeps the checked-in multi-connector example valid without requiring mTLS files", async () => {
    const configuration = await loadEdgeAgentConfig(fileURLToPath(new URL("../config.example.json", import.meta.url)));
    expect(configuration.delivery.mtls).toBeUndefined();
    expect(configuration.connectors.map((connector) => connector.type)).toEqual(["csv", "postgres", "opcua"]);
  });

  it("keeps the local mTLS rehearsal configuration file-backed and Compose-local", async () => {
    const configuration = await loadEdgeAgentConfig(
      fileURLToPath(new URL("../../../infra/security/rehearsal/edge-agent-mtls.json", import.meta.url)),
    );
    const fixture = await readFile(
      fileURLToPath(new URL("../../../infra/security/rehearsal/edge-agent-mtls.csv", import.meta.url)),
      "utf8",
    );

    expect(configuration.delivery).toMatchObject({
      apiBaseUrl: "https://odf-mtls-gateway:9443",
      tenantId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      mtls: {
        certificateFile: "/run/secrets/odf_edge_ingest_client_cert",
        privateKeyFile: "/run/secrets/odf_edge_ingest_client_key",
        caFile: "/run/secrets/odf_ingress_client_ca",
      },
      token: {
        tokenUrl: "http://keycloak:8080/realms/open-data-fusion/protocol/openid-connect/token",
        clientIdEnv: "ODF_EDGE_CLIENT_ID",
        clientSecretEnv: "ODF_EDGE_CLIENT_SECRET",
      },
    });
    expect(configuration.delivery.mtls?.serverName).toBeUndefined();
    expect(configuration.connectors).toHaveLength(1);
    expect(configuration.connectors[0]).toMatchObject({
      type: "csv",
      sourceSystem: "ci-edge-mtls",
      filePath: "/workspace/rehearsal/edge-agent-mtls.csv",
    });
    expect(fixture).toBe("timestamp,pressure_bar,quality\n2026-07-15T00:00:00.000Z,7.25,good\n");
  });
});
