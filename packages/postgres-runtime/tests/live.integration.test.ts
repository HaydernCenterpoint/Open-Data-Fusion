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
  });
} else {
  describe.skip("PostgreSQL runtime live harness", () => {
    it("requires ODF_TEST_POSTGRES_URL", () => {});
  });
}
