import { basename, dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { createIdentityProviderFromEnvironment } from './auth.js';
import { WorkspaceEventHub } from './collaboration.js';
import { FusionDatabase } from './database.js';

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
const database = new FusionDatabase({
  path: process.env.ODF_DATABASE_PATH ?? defaultDatabasePath,
  seed: process.env.ODF_SEED !== 'false',
});
const identityProvider = createIdentityProviderFromEnvironment();
const app = createApp(database, new WorkspaceEventHub(), { identityProvider });
const port = Number.parseInt(process.env.PORT ?? '4310', 10);

const server = app.listen(port, () => {
  console.log(`Open Data Fusion API listening on http://localhost:${port} (auth: ${identityProvider.mode})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received; closing Open Data Fusion API`);
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
