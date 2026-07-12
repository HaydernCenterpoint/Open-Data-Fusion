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
if (process.env.NODE_ENV === 'production' && !configuredObjectStorePath) {
  throw new Error('ODF_OBJECT_STORE_PATH is required in production');
}
const objectStoreMaxBytes = Number(process.env.ODF_OBJECT_STORE_MAX_BYTES ?? 50 * 1024 * 1024);
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

let workspacePersistence: PostgresWorkspacePersistence | undefined;
let industrialPersistence: IndustrialPersistence;
let platformDiscovery: PlatformDiscoveryPersistence | undefined;
let postgresRuntime: PostgresRuntime | undefined;
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
  rawLandingDirectory: configuredPath(process.env.ODF_RAW_LANDING_PATH, defaultRawLandingPath),
  objectStorePath: configuredObjectStorePath ?? defaultObjectStorePath,
  objectStoreMaxBytes,
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
