import { shutdownTelemetry } from './instrumentation.js';

import { basename, dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { writebackPolicyFromEnvironment } from './advanced-platform.js';
import { createIdentityProviderFromEnvironment } from './auth.js';
import { WorkspaceEventHub } from './collaboration.js';
import { FusionDatabase } from './database.js';
import { PostgresWorkspacePersistence } from './postgres-workspace-persistence.js';
import { createSharedEventDelivery } from './shared-event-delivery.js';
import { PostgresProjectAccessResolver, PostgresRuntime } from '@open-data-fusion/postgres-runtime';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = basename(dirname(moduleDirectory)) === 'dist'
  ? resolve(moduleDirectory, '..', '..')
  : resolve(moduleDirectory, '..');
const repositoryEnvironmentPath = resolve(packageDirectory, '..', '..', '.env');
try {
  loadEnvFile(repositoryEnvironmentPath);
} catch (error) {
  if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
}
const defaultDatabasePath = join(packageDirectory, 'data', 'open-data-fusion.db');
const defaultRawLandingPath = join(packageDirectory, 'data', 'raw');
const defaultObjectStorePath = join(packageDirectory, 'data', 'objects');
const database = new FusionDatabase({
  path: process.env.ODF_DATABASE_PATH ?? defaultDatabasePath,
  // A production process must never silently create demonstration industrial
  // data. Local development retains the convenient seeded vertical slice.
  seed: process.env.ODF_SEED === undefined ? process.env.NODE_ENV !== 'production' : process.env.ODF_SEED !== 'false',
});
const identityProvider = createIdentityProviderFromEnvironment();
const metricsToken = process.env.ODF_METRICS_TOKEN?.trim();
if (process.env.NODE_ENV === 'production' && !metricsToken) {
  throw new Error('ODF_METRICS_TOKEN is required in production');
}
const configuredObjectStorePath = process.env.ODF_OBJECT_STORE_PATH?.trim();
if (process.env.NODE_ENV === 'production' && !configuredObjectStorePath) {
  throw new Error('ODF_OBJECT_STORE_PATH is required in production');
}
const objectStoreMaxBytes = Number(process.env.ODF_OBJECT_STORE_MAX_BYTES ?? 50 * 1024 * 1024);
const workspacePersistenceMode = (process.env.ODF_WORKSPACE_PERSISTENCE
  ?? (process.env.NODE_ENV === 'production' ? 'postgres' : 'sqlite')).trim().toLowerCase();
if (workspacePersistenceMode !== 'sqlite' && workspacePersistenceMode !== 'postgres') {
  throw new Error('ODF_WORKSPACE_PERSISTENCE must be sqlite or postgres');
}
let workspacePersistence: PostgresWorkspacePersistence | undefined;
if (workspacePersistenceMode === 'postgres') {
  const connectionString = process.env.ODF_API_POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error('ODF_API_POSTGRES_URL is required when ODF_WORKSPACE_PERSISTENCE=postgres');
  }
  const runtime = PostgresRuntime.connect({
    connectionString,
    applicationName: 'open-data-fusion-api',
  }, {
    projectAccessResolverFactory: (runner) => new PostgresProjectAccessResolver(runner),
  });
  const readiness = await runtime.readiness();
  if (readiness.status !== 'ready') {
    await runtime.close();
    throw new Error('PostgreSQL workspace runtime is not ready; apply migrations before starting the API');
  }
  workspacePersistence = new PostgresWorkspacePersistence(runtime);
}
const sharedEventsRequiredValue = process.env.ODF_SHARED_EVENTS_REQUIRED?.trim().toLowerCase();
if (sharedEventsRequiredValue && sharedEventsRequiredValue !== 'true' && sharedEventsRequiredValue !== 'false') {
  throw new Error('ODF_SHARED_EVENTS_REQUIRED must be true or false');
}
const sharedEventsRequired = sharedEventsRequiredValue === undefined
  ? process.env.NODE_ENV === 'production'
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
  rawLandingDirectory: process.env.ODF_RAW_LANDING_PATH ?? defaultRawLandingPath,
  objectStorePath: configuredObjectStorePath ?? defaultObjectStorePath,
  objectStoreMaxBytes,
  ...(workspacePersistence ? { workspacePersistence } : {}),
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
    await workspacePersistence?.close();
    await eventHub.close();
    await shutdownTelemetry();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
