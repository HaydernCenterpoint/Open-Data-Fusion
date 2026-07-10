import { afterAll, describe, expect, it } from "vitest";

import { PostgresRuntime } from "../src/index.js";

const connectionString = process.env.ODF_TEST_POSTGRES_URL;
if (connectionString) {
  describe("PostgreSQL runtime live harness", () => {
    const runtime = PostgresRuntime.connect({
      connectionString,
      applicationName: "open-data-fusion-postgres-runtime-live-test",
    });

    afterAll(async () => {
      await runtime.close();
    });

    it("probes health and migration-created runtime relations", async () => {
      expect(await runtime.health()).toMatchObject({ status: "ok" });
      expect(await runtime.readiness()).toMatchObject({
        status: "ready",
        schemaPresent: true,
        tenantDataPlanePresent: true,
      });
    });

    it("finds the additional migration-003 production relations inside a scoped transaction", async () => {
      const relations = await runtime.withTransaction({
        tenantId: "00000000-0000-0000-0000-000000000000",
        userId: "postgres-runtime-live-harness",
      }, (transaction) => transaction.query({
        text: [
          "SELECT",
          "  to_regclass('odf.projects') IS NOT NULL AS projects_present,",
          "  to_regclass('odf.time_series_points') IS NOT NULL AS points_present,",
          "  to_regclass('odf.quality_rules') IS NOT NULL AS quality_present,",
          "  to_regclass('odf.writeback_requests') IS NOT NULL AS writeback_present",
        ].join("\n"),
      }));
      expect(relations.rows[0]).toMatchObject({
        projects_present: true,
        points_present: true,
        quality_present: true,
        writeback_present: true,
      });
    });
  });
} else {
  describe.skip("PostgreSQL runtime live harness", () => {
    it("requires ODF_TEST_POSTGRES_URL", () => {});
  });
}
