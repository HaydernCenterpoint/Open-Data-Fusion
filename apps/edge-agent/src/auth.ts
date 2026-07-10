import { z } from "zod";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ClientCredentialsTokenOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  audience?: string;
  expirySkewSeconds: number;
  requestTimeoutMs: number;
}

export interface TokenCacheDependencies {
  fetch?: FetchLike;
  now?: () => number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().finite().positive().max(86_400).default(300),
});

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

function responseSummary(body: string): string {
  return body.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

export class ClientCredentialsTokenCache {
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private cached: CachedToken | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly options: ClientCredentialsTokenOptions,
    dependencies: TokenCacheDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    const usableUntil = this.now() + this.options.expirySkewSeconds * 1_000;
    if (this.cached && usableUntil < this.cached.expiresAt) return this.cached.accessToken;
    if (this.pending) return this.pending;
    this.pending = this.requestToken();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  invalidate(accessToken?: string): void {
    if (accessToken === undefined || this.cached?.accessToken === accessToken) this.cached = null;
  }

  private async requestToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
    });
    if (this.options.scope) body.set("scope", this.options.scope);
    if (this.options.audience) body.set("audience", this.options.audience);

    const response = await this.fetch(this.options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`Client-credentials token request failed with HTTP ${response.status}: ${responseSummary(responseBody)}`);
    }

    let tokenResponse: z.infer<typeof tokenResponseSchema>;
    try {
      tokenResponse = tokenResponseSchema.parse(JSON.parse(responseBody) as unknown);
    } catch (error) {
      throw new Error(`Client-credentials token response is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (tokenResponse.token_type && tokenResponse.token_type.toLowerCase() !== "bearer") {
      throw new Error(`Client-credentials token response uses unsupported token_type '${tokenResponse.token_type}'`);
    }

    this.cached = {
      accessToken: tokenResponse.access_token,
      expiresAt: this.now() + tokenResponse.expires_in * 1_000,
    };
    return tokenResponse.access_token;
  }
}
