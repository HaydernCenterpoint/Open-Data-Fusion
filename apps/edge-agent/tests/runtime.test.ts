import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FetchLike } from "../src/auth.js";
import { edgeAgentConfigSchema, type DeliveryMtlsConfig, type EdgeAgentConfig } from "../src/config.js";
import type { MutualTlsFetchFactory } from "../src/mtls.js";
import { createEdgeAgentRuntime } from "../src/runtime.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "odf-edge-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function configuration(directory: string, mtls: DeliveryMtlsConfig): EdgeAgentConfig {
  return edgeAgentConfigSchema.parse({
    agent: {
      archiveDirectory: join(directory, "raw"),
      queuePath: join(directory, "queue.db"),
      pollIntervalMs: 60_000,
      deliveryIntervalMs: 60_000,
    },
    delivery: {
      apiBaseUrl: "https://api.example.test",
      tenantId: "demo",
      projectId: "north-plant",
      mtls,
      token: {
        tokenUrl: "https://identity.example.test/oauth/token",
        clientIdEnv: "ODF_EDGE_CLIENT_ID",
        clientSecretEnv: "ODF_EDGE_CLIENT_SECRET",
      },
    },
    connectors: [{
      type: "csv",
      sourceSystem: "csv-pilot",
      filePath: join(directory, "telemetry.csv"),
      mapping: {
        timestampColumn: "timestamp",
        timeSeries: [{
          externalId: "P-101-PRESSURE",
          assetExternalId: "P-101",
          name: "Pressure",
          valueColumn: "pressure",
        }],
      },
    }],
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("edge-agent runtime mTLS delivery", () => {
  it("uses the mTLS transport for ingest while OAuth retains the injected fetch", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "telemetry.csv"), "timestamp,pressure\n2026-07-11T00:00:00Z,100\n");
    const mtls: DeliveryMtlsConfig = {
      certificateFile: "/run/secrets/edge-client.crt",
      privateKeyFile: "/run/secrets/edge-client.key",
      caFile: "/run/secrets/ingest-ca.pem",
      serverName: "ingest.example.test",
    };
    let selectedMtls: DeliveryMtlsConfig | undefined;
    let tokenRequests = 0;
    let ingestRequests = 0;
    const tokenFetch: FetchLike = async (input) => {
      tokenRequests += 1;
      expect(String(input)).toBe("https://identity.example.test/oauth/token");
      return new Response(JSON.stringify({ access_token: "runtime-token", expires_in: 3_600 }), { status: 200 });
    };
    const ingestFetch: FetchLike = async (input, init) => {
      ingestRequests += 1;
      expect(String(input)).toBe("https://api.example.test/api/v1/ingest/bundle");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-token");
      return new Response(null, { status: 201 });
    };
    const mtlsFetchFactory: MutualTlsFetchFactory = async (candidate) => {
      selectedMtls = candidate;
      return ingestFetch;
    };

    const runner = await createEdgeAgentRuntime(
      configuration(directory, mtls),
      { ODF_EDGE_CLIENT_ID: "edge-agent", ODF_EDGE_CLIENT_SECRET: "runtime-secret" },
      {
        fetch: tokenFetch,
        createMutualTlsFetch: mtlsFetchFactory,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
    );
    try {
      expect(await runner.pollConnector("csv-pilot")).toBe(true);
      expect(await runner.drainOne()).toBe(true);
      expect(selectedMtls).toEqual(mtls);
      expect(tokenRequests).toBe(1);
      expect(ingestRequests).toBe(1);
    } finally {
      await runner.shutdown();
    }
  });

  it("fails startup when configured mTLS credential files cannot be loaded", async () => {
    const directory = await temporaryDirectory();
    const mtls: DeliveryMtlsConfig = {
      certificateFile: join(directory, "missing-client.crt"),
      privateKeyFile: join(directory, "missing-client.key"),
    };

    await expect(createEdgeAgentRuntime(
      configuration(directory, mtls),
      { ODF_EDGE_CLIENT_ID: "edge-agent", ODF_EDGE_CLIENT_SECRET: "runtime-secret" },
    )).rejects.toThrow("Unable to read a non-empty outbound mTLS client certificate file");
  });
});
