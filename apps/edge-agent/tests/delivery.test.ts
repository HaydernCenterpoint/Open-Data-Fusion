import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { SecureContext } from "node:tls";

import { describe, expect, it } from "vitest";

import { ClientCredentialsTokenCache, type FetchLike } from "../src/auth.js";
import { AuthenticatedIngestDelivery } from "../src/delivery.js";
import {
  createMutualTlsFetch,
  MAX_MUTUAL_TLS_RESPONSE_BODY_BYTES,
  readBoundedResponse,
  type MutualTlsTransportOptions,
} from "../src/mtls.js";
import type { QueuedBatch } from "../src/types.js";

function responseStream(headers: Record<string, string> = {}): PassThrough {
  const response = new PassThrough();
  Object.assign(response, { headers });
  return response;
}

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

  it("loads file-backed credentials into a verified mTLS delivery transport", async () => {
    const files = new Map([
      ["/run/secrets/client.crt", Buffer.from("client certificate")],
      ["/run/secrets/client.key", Buffer.from("client private key")],
      ["/run/secrets/ingest-ca.pem", Buffer.from("ingest CA")],
    ]);
    let transportOptions: MutualTlsTransportOptions | undefined;
    let deliveryRequests = 0;
    const transportFetch: FetchLike = async (input, init) => {
      deliveryRequests += 1;
      expect(String(input)).toBe("https://api.example.test/api/v1/ingest/bundle");
      expect(init?.body).toBe("{}");
      return new Response(null, { status: 201 });
    };

    const fetch = await createMutualTlsFetch(
      {
        certificateFile: "/run/secrets/client.crt",
        privateKeyFile: "/run/secrets/client.key",
        caFile: "/run/secrets/ingest-ca.pem",
        serverName: "ingest.example.test",
      },
      {
        readFile: async (path) => {
          const value = files.get(path);
          if (!value) throw new Error("missing test file");
          return value;
        },
        createSecureContext: () => ({}) as SecureContext,
        createTransport: (options) => {
          transportOptions = options;
          return transportFetch;
        },
      },
    );

    await fetch("https://api.example.test/api/v1/ingest/bundle", { method: "POST", body: "{}" });

    expect(deliveryRequests).toBe(1);
    expect(transportOptions).toEqual({
      certificate: Buffer.from("client certificate"),
      privateKey: Buffer.from("client private key"),
      ca: Buffer.from("ingest CA"),
      serverName: "ingest.example.test",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
  });

  it("preserves bounded JSON delivery responses", async () => {
    const response = responseStream({ "content-length": "11" });
    const body = readBoundedResponse(response as unknown as IncomingMessage, 64);

    response.end('{"ok":true}');

    await expect(body).resolves.toEqual(Buffer.from('{"ok":true}'));
  });

  it("rejects and destroys mTLS responses exceeding the declared content length", async () => {
    const response = responseStream({ "content-length": String(MAX_MUTUAL_TLS_RESPONSE_BODY_BYTES + 1) });

    await expect(readBoundedResponse(response as unknown as IncomingMessage)).rejects.toThrow(
      `exceeds ${MAX_MUTUAL_TLS_RESPONSE_BODY_BYTES} byte limit`,
    );
    expect(response.destroyed).toBe(true);
  });

  it("rejects and destroys streamed mTLS responses that exceed the byte limit", async () => {
    const response = responseStream();
    const body = readBoundedResponse(response as unknown as IncomingMessage, 4);

    response.end("12345");

    await expect(body).rejects.toThrow("exceeds 4 byte limit");
    expect(response.destroyed).toBe(true);
  });

  it("fails closed when mTLS material is unreadable or invalid", async () => {
    await expect(createMutualTlsFetch(
      { certificateFile: "/missing/client.crt", privateKeyFile: "/missing/client.key" },
      { readFile: async () => Buffer.alloc(0) },
    )).rejects.toThrow("Unable to read a non-empty outbound mTLS client certificate file");

    await expect(createMutualTlsFetch(
      { certificateFile: "/run/secrets/client.crt", privateKeyFile: "/run/secrets/client.key" },
      {
        readFile: async () => Buffer.from("test material"),
        createSecureContext: () => {
          throw new Error("invalid test credentials");
        },
      },
    )).rejects.toThrow("Unable to initialize outbound mTLS credentials");
  });
});
