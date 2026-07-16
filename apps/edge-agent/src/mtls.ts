import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { createSecureContext, type SecureContext, type SecureContextOptions } from "node:tls";

import type { FetchLike } from "./auth.js";
import type { DeliveryMtlsConfig } from "./config.js";

export interface MutualTlsTransportOptions {
  certificate: Buffer;
  privateKey: Buffer;
  ca?: Buffer | undefined;
  serverName?: string | undefined;
  rejectUnauthorized: true;
  minVersion: "TLSv1.2";
}

export type MutualTlsTransportFactory = (options: MutualTlsTransportOptions) => FetchLike;

export interface MutualTlsFetchDependencies {
  readFile?: ((path: string) => Promise<Buffer>) | undefined;
  createSecureContext?: ((options: SecureContextOptions) => SecureContext) | undefined;
  createTransport?: MutualTlsTransportFactory | undefined;
}

export type MutualTlsFetchFactory = (configuration: DeliveryMtlsConfig) => Promise<FetchLike>;

export const MAX_MUTUAL_TLS_RESPONSE_BODY_BYTES = 1024 * 1024;

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function declaredContentLength(headers: IncomingHttpHeaders): number | undefined {
  const header = headers["content-length"];
  if (typeof header !== "string" || !/^\d+$/u.test(header.trim())) return undefined;
  const bytes = Number(header);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function responseTooLargeError(maximumBytes: number): Error {
  return new Error(`Outbound mTLS delivery response exceeds ${maximumBytes} byte limit`);
}

/** Reads an HTTPS response without allowing an upstream peer to grow memory without bound. */
export function readBoundedResponse(
  response: IncomingMessage,
  maximumBytes = MAX_MUTUAL_TLS_RESPONSE_BODY_BYTES,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return Promise.reject(new RangeError("Outbound mTLS response limit must be a positive safe integer"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const failAndDestroy = (error: Error): void => {
      if (settled) return;
      settled = true;
      response.destroy(error);
      reject(error);
    };

    response.once("aborted", () => fail(new Error("Outbound mTLS delivery response was aborted")));
    response.once("error", fail);

    if ((declaredContentLength(response.headers) ?? 0) > maximumBytes) {
      failAndDestroy(responseTooLargeError(maximumBytes));
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (value.byteLength > maximumBytes - bytes) {
        failAndDestroy(responseTooLargeError(maximumBytes));
        return;
      }
      chunks.push(value);
      bytes += value.byteLength;
    });
    response.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

function requestBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError("Outbound mTLS delivery supports only string or byte-array request bodies");
}

function nativeMutualTlsTransport(transportOptions: MutualTlsTransportOptions): FetchLike {
  return async (input, init = {}) => {
    const endpoint = new URL(input);
    if (endpoint.protocol !== "https:") {
      throw new Error("Outbound mTLS delivery requires an HTTPS endpoint");
    }

    const body = requestBody(init.body);
    const headers = new Headers(init.headers);
    if (body && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });

    const options: RequestOptions = {
      protocol: "https:",
      hostname: endpoint.hostname,
      ...(endpoint.port ? { port: Number(endpoint.port) } : {}),
      path: `${endpoint.pathname}${endpoint.search}`,
      method: init.method ?? "GET",
      headers: requestHeaders,
      cert: transportOptions.certificate,
      key: transportOptions.privateKey,
      ...(transportOptions.ca ? { ca: transportOptions.ca } : {}),
      rejectUnauthorized: transportOptions.rejectUnauthorized,
      minVersion: transportOptions.minVersion,
      ...(transportOptions.serverName ? { servername: transportOptions.serverName } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    };

    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(options, (response) => {
        void readBoundedResponse(response).then(
          (responseBody) => resolve(new Response(new Uint8Array(responseBody), {
            status: response.statusCode ?? 500,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders(response.headers),
          })),
          reject,
        );
      });
      request.once("error", reject);
      if (body) request.end(body);
      else request.end();
    });
  };
}

async function readMutualTlsFile(
  filePath: string,
  label: string,
  loadFile: (path: string) => Promise<Buffer>,
): Promise<Buffer> {
  try {
    const value = await loadFile(filePath);
    if (value.byteLength === 0) throw new Error("empty file");
    return value;
  } catch {
    throw new Error(`Unable to read a non-empty outbound mTLS ${label} file '${filePath}'`);
  }
}

/** Loads file-backed client credentials and creates the HTTPS transport used only for ingest delivery. */
export async function createMutualTlsFetch(
  configuration: DeliveryMtlsConfig,
  dependencies: MutualTlsFetchDependencies = {},
): Promise<FetchLike> {
  const loadFile = dependencies.readFile ?? ((filePath: string) => readFile(filePath));
  const certificate = await readMutualTlsFile(configuration.certificateFile, "client certificate", loadFile);
  const privateKey = await readMutualTlsFile(configuration.privateKeyFile, "private key", loadFile);
  const ca = configuration.caFile
    ? await readMutualTlsFile(configuration.caFile, "CA bundle", loadFile)
    : undefined;
  const transportOptions: MutualTlsTransportOptions = {
    certificate,
    privateKey,
    ...(ca ? { ca } : {}),
    ...(configuration.serverName ? { serverName: configuration.serverName } : {}),
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  };

  try {
    (dependencies.createSecureContext ?? createSecureContext)({
      cert: certificate,
      key: privateKey,
      ...(ca ? { ca } : {}),
    });
  } catch {
    throw new Error("Unable to initialize outbound mTLS credentials");
  }

  return (dependencies.createTransport ?? nativeMutualTlsTransport)(transportOptions);
}
