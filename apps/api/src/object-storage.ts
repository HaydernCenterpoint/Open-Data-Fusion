import { createReadStream, readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';

import {
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { DataIntegrityError } from './database.js';

export interface BlobRange {
  start: number;
  end: number;
}

/** A server-generated immutable S3 locator. It never contains a URL or secret. */
export interface BlobReference {
  storageProfile: 'primary';
  objectKey: string;
  objectVersionId: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  etag: string | null;
}

export interface BlobWrite {
  objectKey: string;
  body: Buffer | Readable;
  byteSize: number;
  sha256: string;
  contentType: string;
  /**
   * Allows multipart transfer only for a freshly generated server-side key.
   * Conditional S3 PUT protects deterministic/idempotent raw keys instead.
   */
  allowMultipart?: boolean;
}

export interface BlobHead {
  objectKey: string;
  objectVersionId: string;
  sha256: string;
  byteSize: number;
  contentType: string | null;
  etag: string | null;
}

export interface BlobStorageHealth {
  status: 'ok' | 'degraded';
  mode: 's3';
  bucket: string;
  versioning: 'required' | 'not_required';
  timestamp: string;
}

/** Used when a private object store cannot be safely reached. */
export class ObjectStorageUnavailableError extends Error {}

export interface ImmutableBlobStore {
  readonly mode: 's3';
  readonly maxObjectBytes: number;
  /** Prefix a server-generated, provider-neutral immutable suffix. */
  keyFor(suffix: string): string;
  health(): Promise<BlobStorageHealth>;
  putImmutable(input: BlobWrite): Promise<BlobReference>;
  head(reference: BlobReference): Promise<BlobHead>;
  open(reference: BlobReference, range?: BlobRange): Promise<Readable>;
}

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  requireVersioning?: boolean;
  serverSideEncryption?: ServerSideEncryption;
  sseKmsKeyId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  maxObjectBytes?: number;
}

const MAX_S3_PUT_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function required(value: string | undefined, label: string): string {
  const resolved = value?.trim();
  if (!resolved) throw new Error(`${label} is required`);
  return resolved;
}

function optionalFileValue(environment: NodeJS.ProcessEnv, variable: string): string | undefined {
  const literal = environment[variable]?.trim();
  const file = environment[`${variable}_FILE`]?.trim();
  if (literal && file) throw new Error(`${variable} and ${variable}_FILE cannot both be set`);
  if (!file) return literal || undefined;
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new Error('empty');
    return value;
  } catch {
    throw new Error(`${variable}_FILE could not be read as a non-empty secret`);
  }
}

function booleanEnvironment(value: string | undefined, label: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

function normalizePrefix(value: string | undefined): string {
  const prefix = (value ?? 'odf/v1').trim().replace(/^\/+|\/+$/gu, '');
  if (!prefix) return '';
  if (prefix.split('/').some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/u.test(segment))) {
    throw new Error('ODF_OBJECT_STORAGE_PREFIX must contain only safe non-empty path segments');
  }
  return prefix;
}

function normalizeKey(value: string): string {
  const key = value.trim().replace(/^\/+|\/+$/gu, '');
  if (!key || key.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new DataIntegrityError('Object storage key is not a safe immutable locator');
  }
  return key;
}

function contentLength(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new DataIntegrityError('Object storage returned an invalid content length');
  return result;
}

function metadataSha256(metadata: Record<string, string> | undefined): string | null {
  if (!metadata) return null;
  for (const [key, value] of Object.entries(metadata)) {
    if (key.toLowerCase() === 'odf-sha256') return value.toLowerCase();
  }
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

function isPreconditionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === 'PreconditionFailed'
    || candidate.name === 'ConditionalRequestConflict'
    || candidate.$metadata?.httpStatusCode === 409
    || candidate.$metadata?.httpStatusCode === 412;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === 'NotFound'
    || candidate.name === 'NoSuchKey'
    || candidate.$metadata?.httpStatusCode === 404;
}

function asReadable(value: unknown): Readable {
  if (value && typeof value === 'object' && 'pipe' in value && typeof value.pipe === 'function') {
    return value as Readable;
  }
  throw new ObjectStorageUnavailableError('Object storage returned a response body that cannot be streamed');
}

/**
 * Private S3-compatible immutable blob store.  The application never accepts
 * a key from HTTP input; callers build opaque keys from scoped server IDs.
 */
export class S3ImmutableBlobStore implements ImmutableBlobStore {
  readonly mode = 's3' as const;
  readonly maxObjectBytes: number;
  private readonly client: S3Client;
  private readonly prefix: string;
  private readonly requireVersioning: boolean;
  private readonly encryption: Pick<S3BlobStoreOptions, 'serverSideEncryption' | 'sseKmsKeyId'>;

  constructor(private readonly options: S3BlobStoreOptions) {
    const bucket = required(options.bucket, 'Object storage bucket');
    const region = required(options.region, 'Object storage region');
    this.prefix = normalizePrefix(options.prefix);
    this.requireVersioning = options.requireVersioning !== false;
    this.maxObjectBytes = options.maxObjectBytes ?? MAX_S3_PUT_OBJECT_BYTES;
    if (!Number.isSafeInteger(this.maxObjectBytes) || this.maxObjectBytes < 1 || this.maxObjectBytes > MAX_S3_PUT_OBJECT_BYTES) {
      throw new Error(`S3 object-store maxObjectBytes must be between 1 byte and ${MAX_S3_PUT_OBJECT_BYTES} bytes`);
    }
    if ((options.accessKeyId === undefined) !== (options.secretAccessKey === undefined)) {
      throw new Error('S3 access key ID and secret access key must be supplied together');
    }
    this.client = new S3Client({
      region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle === true,
      ...(options.accessKeyId && options.secretAccessKey
        ? { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } }
        : {}),
    });
    this.encryption = {
      ...(options.serverSideEncryption ? { serverSideEncryption: options.serverSideEncryption } : {}),
      ...(options.sseKmsKeyId ? { sseKmsKeyId: options.sseKmsKeyId } : {}),
    };
    // Keep values normalized after validating them. This intentionally avoids
    // exposing them through a public config object.
    this.options = { ...options, bucket, region };
  }

  keyFor(suffix: string): string {
    const normalized = normalizeKey(suffix);
    return this.prefix ? `${this.prefix}/${normalized}` : normalized;
  }

  async health(): Promise<BlobStorageHealth> {
    try {
      // GetBucketVersioning proves both bucket access and the required
      // immutable-versioning contract. Avoid HeadBucket/ListBucket so the
      // application identity never needs bucket enumeration permission.
      const versioning = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.options.bucket }));
      if (this.requireVersioning && versioning.Status !== 'Enabled') {
        throw new ObjectStorageUnavailableError('Object storage bucket versioning is required but not enabled');
      }
      return {
        status: 'ok',
        mode: this.mode,
        bucket: this.options.bucket,
        versioning: this.requireVersioning ? 'required' : 'not_required',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'degraded',
        mode: this.mode,
        bucket: this.options.bucket,
        versioning: this.requireVersioning ? 'required' : 'not_required',
        timestamp: new Date().toISOString(),
      };
    }
  }

  async putImmutable(input: BlobWrite): Promise<BlobReference> {
    const objectKey = normalizeKey(input.objectKey);
    if (!SHA256_PATTERN.test(input.sha256)) throw new DataIntegrityError('Object storage requires a lowercase SHA-256 checksum');
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 0 || input.byteSize > this.maxObjectBytes) {
      throw new DataIntegrityError('Object storage write size is invalid or exceeds its configured maximum');
    }
    if (!input.contentType.trim()) throw new DataIntegrityError('Object storage content type is required');

    try {
      const params = {
        Bucket: this.options.bucket,
        Key: objectKey,
        Body: input.body,
        ContentLength: input.byteSize,
        ContentType: input.contentType,
        Metadata: { 'odf-sha256': input.sha256 },
        ...(this.encryption.serverSideEncryption ? { ServerSideEncryption: this.encryption.serverSideEncryption } : {}),
        ...(this.encryption.sseKmsKeyId ? { SSEKMSKeyId: this.encryption.sseKmsKeyId } : {}),
      };
      if (!input.allowMultipart && input.byteSize > MAX_S3_PUT_OBJECT_BYTES) {
        throw new DataIntegrityError('A deterministic immutable S3 object exceeds the single-PUT safety limit');
      }
      const result = input.allowMultipart
        ? await new Upload({ client: this.client, params, leavePartsOnError: false }).done()
        : await this.client.send(new PutObjectCommand({
          ...params,
          // Final deterministic keys are immutable. An exact idempotent race
          // verifies and reuses the object below; a different value cannot
          // overwrite it.
          IfNoneMatch: '*',
        }));
      const objectVersionId = result.VersionId;
      if (!objectVersionId && this.requireVersioning) {
        throw new ObjectStorageUnavailableError('Object storage did not return an immutable object version ID');
      }
      const reference: BlobReference = {
        storageProfile: 'primary',
        objectKey,
        objectVersionId: objectVersionId ?? 'unversioned',
        sha256: input.sha256,
        byteSize: input.byteSize,
        contentType: input.contentType,
        etag: result.ETag ?? null,
      };
      await this.head(reference);
      return reference;
    } catch (error) {
      if (error instanceof DataIntegrityError || error instanceof ObjectStorageUnavailableError) throw error;
      if (isPreconditionFailure(error)) {
        const reference: BlobReference = {
          storageProfile: 'primary',
          objectKey,
          objectVersionId: 'unversioned',
          sha256: input.sha256,
          byteSize: input.byteSize,
          contentType: input.contentType,
          etag: null,
        };
        return this.reuseExisting(reference);
      }
      throw new ObjectStorageUnavailableError(`Object storage could not write immutable content (${errorName(error)})`);
    }
  }

  async head(reference: BlobReference): Promise<BlobHead> {
    const objectKey = normalizeKey(reference.objectKey);
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        ...(reference.objectVersionId !== 'unversioned' ? { VersionId: reference.objectVersionId } : {}),
      }));
      const sha256 = metadataSha256(result.Metadata);
      const byteSize = contentLength(result.ContentLength);
      const objectVersionId = result.VersionId ?? reference.objectVersionId;
      if (!SHA256_PATTERN.test(sha256 ?? '')) {
        throw new DataIntegrityError('Object storage checksum metadata is missing or invalid');
      }
      if (reference.objectVersionId !== 'unversioned' && objectVersionId !== reference.objectVersionId) {
        throw new DataIntegrityError('Object storage returned a different immutable object version');
      }
      if (sha256 !== reference.sha256 || byteSize !== reference.byteSize) {
        throw new DataIntegrityError('Object storage content no longer matches its immutable metadata');
      }
      if (reference.contentType && result.ContentType && reference.contentType !== result.ContentType) {
        throw new DataIntegrityError('Object storage content type no longer matches its immutable metadata');
      }
      if (this.encryption.serverSideEncryption && result.ServerSideEncryption !== this.encryption.serverSideEncryption) {
        throw new DataIntegrityError('Object storage content is missing the required server-side encryption');
      }
      if (this.encryption.sseKmsKeyId && result.SSEKMSKeyId !== this.encryption.sseKmsKeyId) {
        throw new DataIntegrityError('Object storage content was encrypted with an unexpected KMS key');
      }
      return {
        objectKey,
        objectVersionId,
        sha256,
        byteSize,
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
      };
    } catch (error) {
      if (error instanceof DataIntegrityError || error instanceof ObjectStorageUnavailableError) throw error;
      if (isNotFound(error)) throw new DataIntegrityError('Immutable object storage content is missing');
      throw new ObjectStorageUnavailableError(`Object storage could not verify immutable content (${errorName(error)})`);
    }
  }

  async open(reference: BlobReference, range?: BlobRange): Promise<Readable> {
    await this.head(reference);
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: normalizeKey(reference.objectKey),
        ...(reference.objectVersionId !== 'unversioned' ? { VersionId: reference.objectVersionId } : {}),
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }));
      return asReadable(response.Body);
    } catch (error) {
      if (error instanceof DataIntegrityError || error instanceof ObjectStorageUnavailableError) throw error;
      if (isNotFound(error)) throw new DataIntegrityError('Immutable object storage content is missing');
      throw new ObjectStorageUnavailableError(`Object storage could not read immutable content (${errorName(error)})`);
    }
  }

  private async reuseExisting(reference: BlobReference): Promise<BlobReference> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.options.bucket,
        Key: reference.objectKey,
      }));
      const objectVersionId = result.VersionId;
      if (!objectVersionId && this.requireVersioning) {
        throw new ObjectStorageUnavailableError('Existing immutable object does not expose a version ID');
      }
      const resolved = { ...reference, objectVersionId: objectVersionId ?? 'unversioned', etag: result.ETag ?? null };
      await this.head(resolved);
      return resolved;
    } catch (error) {
      if (error instanceof DataIntegrityError || error instanceof ObjectStorageUnavailableError) throw error;
      if (isNotFound(error)) {
        throw new ObjectStorageUnavailableError('Object storage reported a conditional conflict but the immutable object was not found');
      }
      throw new ObjectStorageUnavailableError(`Object storage could not verify idempotent content (${errorName(error)})`);
    }
  }
}

/** Builds the shared S3 adapter from production environment configuration. */
export function createS3BlobStoreFromEnvironment(environment: NodeJS.ProcessEnv = process.env): S3ImmutableBlobStore {
  const endpoint = environment.ODF_OBJECT_STORAGE_ENDPOINT?.trim() || undefined;
  const production = environment.NODE_ENV === 'production';
  const allowInsecureEndpoint = booleanEnvironment(
    environment.ODF_OBJECT_STORAGE_ALLOW_INSECURE_ENDPOINT,
    'ODF_OBJECT_STORAGE_ALLOW_INSECURE_ENDPOINT',
    false,
  );
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('ODF_OBJECT_STORAGE_ENDPOINT must be an absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('ODF_OBJECT_STORAGE_ENDPOINT must use http or https');
    }
    if (production && url.protocol !== 'https:' && !allowInsecureEndpoint) {
      throw new Error('ODF_OBJECT_STORAGE_ENDPOINT must use HTTPS in production unless ODF_OBJECT_STORAGE_ALLOW_INSECURE_ENDPOINT=true');
    }
  }
  const accessKeyId = optionalFileValue(environment, 'ODF_OBJECT_STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = optionalFileValue(environment, 'ODF_OBJECT_STORAGE_SECRET_ACCESS_KEY');
  const encryptionValue = environment.ODF_OBJECT_STORAGE_SSE?.trim();
  const serverSideEncryption = encryptionValue === undefined || encryptionValue === ''
    ? undefined
    : encryptionValue as ServerSideEncryption;
  if (serverSideEncryption && serverSideEncryption !== 'AES256' && serverSideEncryption !== 'aws:kms') {
    throw new Error('ODF_OBJECT_STORAGE_SSE must be AES256 or aws:kms');
  }
  const sseKmsKeyId = environment.ODF_OBJECT_STORAGE_SSE_KMS_KEY_ID?.trim() || undefined;
  if (sseKmsKeyId && serverSideEncryption !== 'aws:kms') {
    throw new Error('ODF_OBJECT_STORAGE_SSE_KMS_KEY_ID requires ODF_OBJECT_STORAGE_SSE=aws:kms');
  }
  const rawMaxObjectBytes = environment.ODF_OBJECT_STORAGE_MAX_BYTES ?? environment.ODF_OBJECT_STORE_MAX_BYTES;
  const maxObjectBytes = rawMaxObjectBytes === undefined
    ? undefined
    : Number(rawMaxObjectBytes);
  return new S3ImmutableBlobStore({
    bucket: required(environment.ODF_OBJECT_STORAGE_BUCKET, 'ODF_OBJECT_STORAGE_BUCKET'),
    region: required(environment.ODF_OBJECT_STORAGE_REGION, 'ODF_OBJECT_STORAGE_REGION'),
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: booleanEnvironment(environment.ODF_OBJECT_STORAGE_FORCE_PATH_STYLE, 'ODF_OBJECT_STORAGE_FORCE_PATH_STYLE', false),
    prefix: environment.ODF_OBJECT_STORAGE_PREFIX,
    requireVersioning: booleanEnvironment(
      environment.ODF_OBJECT_STORAGE_REQUIRE_VERSIONING,
      'ODF_OBJECT_STORAGE_REQUIRE_VERSIONING',
      production,
    ),
    ...(serverSideEncryption ? { serverSideEncryption } : {}),
    ...(sseKmsKeyId
      ? { sseKmsKeyId }
      : {}),
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
    ...(maxObjectBytes !== undefined ? { maxObjectBytes } : {}),
  });
}

/** Opens a temporary upload file without exposing its path in domain metadata. */
export function openTemporaryObjectFile(path: string): Readable {
  return createReadStream(path);
}
