import type { ClientCredentialsTokenCache, FetchLike } from "./auth.js";
import type { QueuedBatch } from "./types.js";

export interface DeliveryClient {
  deliver(batch: QueuedBatch): Promise<void>;
}

export interface IngestDeliveryOptions {
  apiBaseUrl: string;
  tenantId: string;
  projectId: string;
  requestTimeoutMs: number;
}

export interface IngestDeliveryDependencies {
  fetch?: FetchLike;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export class AuthenticatedIngestDelivery implements DeliveryClient {
  private readonly fetch: FetchLike;
  private readonly ingestUrl: URL;

  constructor(
    private readonly options: IngestDeliveryOptions,
    private readonly tokens: ClientCredentialsTokenCache,
    dependencies: IngestDeliveryDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.ingestUrl = new URL("/api/v1/ingest/bundle", options.apiBaseUrl);
  }

  async deliver(batch: QueuedBatch): Promise<void> {
    let accessToken = await this.tokens.getToken();
    let response = await this.post(batch, accessToken);
    if (response.status === 401) {
      this.tokens.invalidate(accessToken);
      accessToken = await this.tokens.getToken();
      response = await this.post(batch, accessToken);
    }

    if (response.ok) {
      await response.body?.cancel();
      return;
    }
    const body = (await response.text()).replace(/[\r\n\t]+/g, " ").slice(0, 1_000);
    throw new DeliveryError(
      `Ingest delivery failed with HTTP ${response.status}: ${body}`,
      response.status,
      retryAfterMilliseconds(response.headers.get("retry-after")),
    );
  }

  private post(batch: QueuedBatch, accessToken: string): Promise<Response> {
    return this.fetch(this.ingestUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": batch.idempotencyKey,
        "x-odf-tenant-id": this.options.tenantId,
        "x-odf-project-id": this.options.projectId,
      },
      body: JSON.stringify(batch.bundle),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
  }
}
