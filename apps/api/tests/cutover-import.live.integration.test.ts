import { createPostgresPool } from '@open-data-fusion/postgres-runtime';
import { afterAll, describe, expect, it } from 'vitest';

import { importSqliteCutoverBundle } from '../src/cutover-import.js';
import { createSqliteCutoverPreflightReport } from '../src/cutover-preflight.js';
import { FusionDatabase } from '../src/database.js';

const connectionString = process.env.ODF_TEST_CUTOVER_POSTGRES_URL;

if (connectionString) {
  describe('SQLite cutover live PostgreSQL rehearsal', () => {
    const source = new FusionDatabase({ path: ':memory:' });
    const pool = createPostgresPool({
      connectionString,
      applicationName: 'open-data-fusion-cutover-live-test',
      max: 1,
      statementTimeoutMillis: 120_000,
      lockTimeoutMillis: 10_000,
      idleInTransactionTimeoutMillis: 180_000,
    }).pool;

    afterAll(async () => {
      source.close();
      await pool.end();
    });

    it('imports and verifies a real bundle before rolling every row back', async () => {
      const bundle = createSqliteCutoverPreflightReport(source.database, ':memory:');

      const result = await importSqliteCutoverBundle(pool, bundle);

      expect(result).toMatchObject({
        mode: 'dry-run',
        counts: bundle.counts,
        correlationIds: { algorithm: 'open-data-fusion.uuidv8.sha256.v1' },
      });
    });
  });
} else {
  describe.skip('SQLite cutover live PostgreSQL rehearsal', () => {
    it('requires ODF_TEST_CUTOVER_POSTGRES_URL', () => {});
  });
}
