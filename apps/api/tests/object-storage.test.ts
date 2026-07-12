import { describe, expect, it, vi } from 'vitest';

import {
  createS3BlobStoreFromEnvironment,
  S3ImmutableBlobStore,
  type BlobReference,
} from '../src/object-storage.js';

const reference: BlobReference = {
  storageProfile: 'primary',
  objectKey: 'odf/v1/governed/example.blob',
  objectVersionId: 'version-1',
  sha256: 'a'.repeat(64),
  byteSize: 3,
  contentType: 'text/plain',
  etag: '"etag"',
};

function storeWithHeadResult(result: Record<string, unknown>): S3ImmutableBlobStore {
  const store = new S3ImmutableBlobStore({
    bucket: 'odf-test-objects',
    region: 'us-east-1',
    serverSideEncryption: 'AES256',
  });
  Object.defineProperty(store, 'client', {
    value: { send: vi.fn().mockResolvedValue(result) },
  });
  return store;
}

describe('S3 immutable object storage', () => {
  it('accepts a head response with the required immutable SSE metadata', async () => {
    const store = storeWithHeadResult({
      Metadata: { 'odf-sha256': reference.sha256 },
      ContentLength: reference.byteSize,
      ContentType: reference.contentType,
      VersionId: reference.objectVersionId,
      ETag: reference.etag,
      ServerSideEncryption: 'AES256',
    });

    await expect(store.head(reference)).resolves.toMatchObject({
      objectVersionId: reference.objectVersionId,
      sha256: reference.sha256,
    });
  });

  it('rejects a readable object that is missing its required server-side encryption', async () => {
    const store = storeWithHeadResult({
      Metadata: { 'odf-sha256': reference.sha256 },
      ContentLength: reference.byteSize,
      ContentType: reference.contentType,
      VersionId: reference.objectVersionId,
      ETag: reference.etag,
    });

    await expect(store.head(reference)).rejects.toThrow('required server-side encryption');
  });

  it('rejects a KMS key identifier without SSE-KMS mode', () => {
    expect(() => createS3BlobStoreFromEnvironment({
      ODF_OBJECT_STORAGE_BUCKET: 'odf-test-objects',
      ODF_OBJECT_STORAGE_REGION: 'us-east-1',
      ODF_OBJECT_STORAGE_SSE: 'AES256',
      ODF_OBJECT_STORAGE_SSE_KMS_KEY_ID: 'unexpected-key',
    })).toThrow('requires ODF_OBJECT_STORAGE_SSE=aws:kms');
  });

  it('rejects a production HTTP endpoint unless its local-only override is explicit', () => {
    expect(() => createS3BlobStoreFromEnvironment({
      NODE_ENV: 'production',
      ODF_OBJECT_STORAGE_BUCKET: 'odf-test-objects',
      ODF_OBJECT_STORAGE_REGION: 'us-east-1',
      ODF_OBJECT_STORAGE_ENDPOINT: 'http://object-store.internal:9000',
      ODF_OBJECT_STORAGE_SSE: 'AES256',
    })).toThrow('must use HTTPS in production');
  });
});
