import { describe, expect, it } from "vitest";

import { ClientCredentialsTokenCache, type FetchLike } from "../src/auth.js";
import { AuthenticatedIngestDelivery } from "../src/delivery.js";
import type { QueuedBatch } from "../src/types.js";

const queuedBatch: QueuedBatch = {
  id: "batch-1",
  sourceSystem: "csv-pilot",
  idempotencyKey: "edge:run-1",
  bundle: {
    source: { system: "csv-pilot", runId: "edge:run-1", actor: "edge-agent" },
    assets: [],
    timeSeries: [],
    dataPoints: [
      { timeSeriesExternalId: "P-101-PRESSURE", timestamp: "2026-07-11T00:00:00.000Z", value: 100, quality: "good" },
    ],
    documents: [],
    relations: [],
  },
  archivePath: "raw/batch-1.json",
  archiveSha256: "a".repeat(64),
  checkpointAfter: "1",
  attemptCount: 1,
};

describe("authenticated ingest delivery", () => {
  it("caches client-credentials tokens, refreshes once on 401, and preserves the idempotency key", async () => {
    let tokenRequests = 0;
    let ingestRequests = 0;
    const authorizations: string[] = [];
    const idempotencyKeys: string[] = [];
    const scopes: Array<[string | null, string | null]> = [];
    const fetch: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth/token")) {
        tokenRequests += 1;
        expect(init?.body).toBeInstanceOf(URLSearchParams);
        expect(String(init?.body)).toContain("grant_type=client_credentials");
        return new Response(
          JSON.stringify({ access_token: `token-${tokenRequests}`, token_type: "Bearer", expires_in: 3_600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      ingestRequests += 1;
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get("authorization") ?? "");
      idempotencyKeys.push(headers.get("idempotency-key") ?? "");
      scopes.push([headers.get("x-odf-tenant-id"), headers.get("x-odf-project-id")]);
      if (ingestRequests === 2) return new Response("expired", { status: 401 });
      return new Response(null, { status: 201 });
    };
    const tokens = new ClientCredentialsTokenCache(
      {
        tokenUrl: "https://identity.example.test/oauth/token",
        clientId: "edge-agent",
        clientSecret: "runtime-secret",
        expirySkewSeconds: 30,
        requestTimeoutMs: 1_000,
      },
      { fetch, now: () => Date.parse("2026-07-11T00:00:00Z") },
    );
    const delivery = new AuthenticatedIngestDelivery(
      { apiBaseUrl: "https://api.example.test", tenantId: "demo", projectId: "north-plant", requestTimeoutMs: 1_000 },
      tokens,
      { fetch },
    );

    await delivery.deliver(queuedBatch);
    await delivery.deliver(queuedBatch);
    await delivery.deliver(queuedBatch);

    expect(tokenRequests).toBe(2);
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2", "Bearer token-2"]);
    expect(idempotencyKeys).toEqual(Array(4).fill("edge:run-1"));
    expect(scopes).toEqual(Array(4).fill(["demo", "north-plant"]));
  });
});
