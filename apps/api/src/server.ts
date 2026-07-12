import { shutdownTelemetry } from './instrumentation.js';

import { basename, dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { writebackPolicyFromEnvironment } from './advanced-platform.js';
import { createIdentityProviderFromEnvironment } from './auth.js';
import { WorkspaceEventHub } from './collaboration.js';
import { FusionDatabase } from './database.js';
import type { IndustrialPersistence } from './industrial-persistence.js';
import { createS3BlobStoreFromEnvironment, type ImmutableBlobStore } from './object-storage.js';
import { PostgresPlatformDiscoveryPersistence, type PlatformDiscoveryPersistence } from './platform-discovery.js';
import { PostgresIndustrialPersistence } from './postgres-industrial-persistence.js';
import { PostgresWorkspacePersistence } from './postgres-workspace-persistence.js';
import { createSharedEventDelivery } from './shared-event-delivery.js';
import { SqliteIndustrialPersistence } from './sqlite-industrial-persistence.js';
import { PostgresProjectAccessResolver, PostgresRuntime } from '@open-data-fusion/postgres-runtime';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = basename(dirname(moduleDirectory)) === 'dist'
  ? resolve(moduleDirectory, '..', '..')
  : resolve(moduleDirectory, '..');
const repositoryDirectory = resolve(packageDirectory, '..', '..');
const repositoryEnvironmentPath = resolve(repositoryDirectory, '.env');
try {
  loadEnvFile(repositoryEnvironmentPath);
} catch (error) {
  if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
}
const defaultDatabasePath = join(packageDirectory, 'data', 'open-data-fusion.db');
const defaultRawLandingPath = join(packageDirectory, 'data', 'raw');
const defaultObjectStorePath = join(packageDirectory, 'data', 'objects');
const defaultObjectStorageTemporaryPath = join(packageDirectory, 'data', 'object-staging');
const configuredPath = (value: string | undefined, fallback: string): string => (
  value?.trim() ? resolve(repositoryDirectory, value.trim()) : fallback
);
const database = new FusionDatabase({
  path: configuredPath(process.env.ODF_DATABASE_PATH, defaultDatabasePath),
  // Real data is the default in every environment. The demonstration dataset
  // is available only through an explicit opt-in.
  seed: process.env.ODF_SEED?.trim().toLowerCase() === 'true',
});
const identityProvider = createIdentityProviderFromEnvironment();
const metricsToken = process.env.ODF_METRICS_TOKEN?.trim();
if (process.env.NODE_ENV === 'production' && !metricsToken) {
  throw new Error('ODF_METRICS_TOKEN is required in production');
}
const configuredObjectStoreValue = process.env.ODF_OBJECT_STORE_PATH?.trim();
const configuredObjectStorePath = configuredObjectStoreValue
  ? configuredPath(configuredObjectStoreValue, defaultObjectStorePath)
  : undefined;
const objectStoreMaxBytes = Number(
  process.env.ODF_OBJECT_STORAGE_MAX_BYTES
  ?? process.env.ODF_OBJECT_STORE_MAX_BYTES
  ?? 50 * 1024 * 1024,
);
const dataPersistenceValue = process.env.ODF_DATA_PERSISTENCE?.trim().toLowerCase();
if (process.env.NODE_ENV === 'production' && !dataPersistenceValue) {
  throw new Error('ODF_DATA_PERSISTENCE must be explicitly set to sqlite or postgres in production');
}
const dataPersistenceMode = dataPersistenceValue ?? 'sqlite';
if (dataPersistenceMode !== 'sqlite' && dataPersistenceMode !== 'postgres') {
  throw new Error('ODF_DATA_PERSISTENCE must be sqlite or postgres');
}
const legacyWorkspaceMode = process.env.ODF_WORKSPACE_PERSISTENCE?.trim().toLowerCase();
if (legacyWorkspaceMode && legacyWorkspaceMode !== dataPersistenceMode) {
  throw new Error('ODF_WORKSPACE_PERSISTENCE cannot differ from ODF_DATA_PERSISTENCE; dual-write/hybrid mode is disabled');
}
const objectStorageDriver = (process.env.ODF_OBJECT_STORAGE_DRIVER
  ?? (dataPersistenceMode === 'postgres' ? 's3' : 'filesystem')).trim().toLowerCase();
if (objectStorageDriver !== 'filesystem' && objectStorageDriver !== 's3') {
  throw new Error('ODF_OBJECT_STORAGE_DRIVER must be filesystem or s3');
}
if (dataPersistenceMode === 'postgres' && objectStorageDriver !== 's3') {
  throw new Error('PostgreSQL persistence requires ODF_OBJECT_STORAGE_DRIVER=s3; local filesystem object metadata is not shared across replicas');
}
if (dataPersistenceMode === 'sqlite' && objectStorageDriver !== 'filesystem') {
  throw new Error('SQLite persistence currently requires ODF_OBJECT_STORAGE_DRIVER=filesystem');
}
const objectStorageSse = process.env.ODF_OBJECT_STORAGE_SSE?.trim();
if (dataPersistenceMode === 'postgres' && objectStorageSse !== 'AES256' && objectStorageSse !== 'aws:kms') {
  throw new Error('PostgreSQL persistence requires ODF_OBJECT_STORAGE_SSE=AES256 or ODF_OBJECT_STORAGE_SSE=aws:kms');
}
if (process.env.NODE_ENV === 'production' && dataPersistenceMode === 'sqlite' && !configuredObjectStorePath) {
  throw new Error('ODF_OBJECT_STORE_PATH is required for production SQLite single-instance storage');
}
const objectStorageTemporaryPath = configuredPath(
  process.env.ODF_OBJECT_STORAGE_TEMP_PATH,
  defaultObjectStorageTemporaryPath,
);

async function assertSharedObjectMetadataReady(runtime: PostgresRuntime): Promise<void> {
  const result = await runtime.withTransaction({
    tenantId: null,
    userId: 'odf-api-object-storage-readiness',
    platformAdmin: false,
  }, async (transaction) => transaction.query<{ ready: unknown }>({
    text: [
      'SELECT (',
      "  to_regclass('odf.raw_landing_objects') IS NOT NULL",
      "  AND to_regclass('odf.raw_landing_events') IS NOT NULL",
      "  AND to_regclass('odf.governed_objects') IS NOT NULL",
      "  AND to_regclass('odf.governed_object_versions') IS NOT NULL",
      "  AND to_regclass('odf.governed_object_events') IS NOT NULL",
      // has_table_privilege accepts a comma-separated list but returns true
      // when *any* listed privilege exists. Check every write capability
      // independently so readiness cannot pass for a partially granted role.
      "  AND has_table_privilege(current_user, 'odf.raw_landing_objects', 'SELECT')",
      "  AND has_table_privilege(current_user, 'odf.raw_landing_objects', 'INSERT')",
      "  AND has_table_privilege(current_user, 'odf.raw_landing_events', 'SELECT')",
      "  AND has_table_privilege(current_user, 'odf.raw_landing_events', 'INSERT')",
      "  AND has_table_privilege(current_user, 'odf.governed_objects', 'SELECT')",
      "  AND has_table_privilege(current_user, 'odf.governed_objects', 'INSERT')",
      "  AND has_table_privilege(current_user, 'odf.governed_objects', 'UPDATE')",
      "  AND has_table_privilege(current_user, 'odf.governed_object_versions', 'SELECT')",
      "  AND has_table_privilege(current_user, 'odf.governed_object_versions', 'INSERT')",
      "  AND has_table_privilege(current_user, 'odf.governed_object_events', 'SELECT')",
      "  AND has_table_privilege(current_user, 'odf.governed_object_events', 'INSERT')",
      ') AS ready',
    ].join('\n'),
  }));
  if (result.rows[0]?.ready !== true) {
    throw new Error('PostgreSQL shared object metadata is not ready; apply migration 011 and verify the API role grants');
  }
}

let workspacePersistence: PostgresWorkspacePersistence | undefined;
let industrialPersistence: IndustrialPersistence;
let platformDiscovery: PlatformDiscoveryPersistence | undefined;
let postgresRuntime: PostgresRuntime | undefined;
let sharedBlobStore: ImmutableBlobStore | undefined;
if (dataPersistenceMode === 'postgres') {
  const connectionString = process.env.ODF_API_POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error('ODF_API_POSTGRES_URL is required when ODF_DATA_PERSISTENCE=postgres');
  }
  postgresRuntime = PostgresRuntime.connect({
    connectionString,
    applicationName: 'open-data-fusion-api',
  }, {
    projectAccessResolverFactory: (runner) => new PostgresProjectAccessResolver(runner),
  });
  const readiness = await postgresRuntime.readiness();
  if (readiness.status !== 'ready') {
    await postgresRuntime.close();
    throw new Error('PostgreSQL data runtime is not ready; apply migrations and verify the API role before starting');
  }
  workspacePersistence = new PostgresWorkspacePersistence(postgresRuntime);
  industrialPersistence = new PostgresIndustrialPersistence(postgresRuntime);
  const postgresPlatformDiscovery = new PostgresPlatformDiscoveryPersistence(postgresRuntime);
  try {
    await postgresPlatformDiscovery.assertReady();
  } catch (error) {
    await postgresRuntime.close();
    throw error;
  }
  platformDiscovery = postgresPlatformDiscovery;
  sharedBlobStore = createS3BlobStoreFromEnvironment();
  const objectStorageHealth = await sharedBlobStore.health();
  if (objectStorageHealth.status !== 'ok') {
    await postgresRuntime.close();
    throw new Error('Shared S3-compatible object storage is not ready; verify private bucket access and versioning before starting PostgreSQL API replicas');
  }
  try {
    await assertSharedObjectMetadataReady(postgresRuntime);
  } catch (error) {
    await postgresRuntime.close();
    throw error;
  }
} else {
  industrialPersistence = new SqliteIndustrialPersistence(database.database);
}
const sharedEventsRequiredValue = process.env.ODF_SHARED_EVENTS_REQUIRED?.trim().toLowerCase();
if (sharedEventsRequiredValue && sharedEventsRequiredValue !== 'true' && sharedEventsRequiredValue !== 'false') {
  throw new Error('ODF_SHARED_EVENTS_REQUIRED must be true or false');
}
const sharedEventsRequired = sharedEventsRequiredValue === undefined
  ? process.env.NODE_ENV === 'production' && dataPersistenceMode === 'postgres'
  : sharedEventsRequiredValue === 'true';
const sharedEventDelivery = await createSharedEventDelivery({
  logger: { warn: (message) => console.warn(message) },
});
if (sharedEventsRequired && sharedEventDelivery.mode !== 'redis') {
  await sharedEventDelivery.close();
  throw new Error('ODF_REDIS_URL is required when shared event delivery is required');
}
const eventHub = new WorkspaceEventHub(sharedEventDelivery);
const app = createApp(database, eventHub, {
  identityProvider,
  writebackPolicy: writebackPolicyFromEnvironment(),
  objectStoreMaxBytes,
  ...(dataPersistenceMode === 'sqlite' ? {
    rawLandingDirectory: configuredPath(process.env.ODF_RAW_LANDING_PATH, defaultRawLandingPath),
    objectStorePath: configuredObjectStorePath ?? defaultObjectStorePath,
  } : {
    sharedBlobStore: sharedBlobStore!,
    postgresRuntime: postgresRuntime!,
    objectStorageTemporaryPath,
  }),
  ...(workspacePersistence ? { workspacePersistence } : {}),
  industrialPersistence,
  ...(platformDiscovery ? { platformDiscovery } : {}),
  sharedEventsRequired,
  ...(metricsToken ? { metricsToken } : {}),
});
const port = Number.parseInt(process.env.PORT ?? '4310', 10);

const server = app.listen(port, () => {
  console.log(`Open Data Fusion API listening on http://localhost:${port} (auth: ${identityProvider.mode})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received; closing Open Data Fusion API`);
  server.close(async () => {
    database.close();
    await postgresRuntime?.close();
    await eventHub.close();
    await shutdownTelemetry();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
