import { describe, expect, it } from "vitest";

import { PostgresProjectAccessResolver } from "../src/postgres-project-access-resolver.js";
import { PostgresRuntime } from "../src/runtime.js";
import { RecordingClient, RecordingPool, result } from "./recording-pg.js";

const scope = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  projectId: "22222222-2222-2222-2222-222222222222",
  userId: "operator@example.test",
};

describe("PostgresProjectAccessResolver", () => {
  it("reads a project role inside a tenant-local transaction", async () => {
    const client = new RecordingClient((query) => {
      if (query.text.includes("FROM odf.project_members")) return result([{ role: "editor" }]);
      return result();
    });
    const resolver = new PostgresProjectAccessResolver(PostgresRuntime.fromPool(new RecordingPool(client)));

    await expect(resolver.resolve(scope)).resolves.toEqual({ role: "editor" });
    const membership = client.queries.find((query) => query.text.includes("FROM odf.project_members"));
    expect(membership?.values).toEqual([scope.tenantId, scope.projectId, scope.userId]);
    expect(client.queries.some((query) => query.text === "SELECT set_config('odf.tenant_id', $1, true)")).toBe(true);
  });

  it("fails closed for missing or malformed membership roles", async () => {
    const missing = new PostgresProjectAccessResolver(PostgresRuntime.fromPool(new RecordingPool(new RecordingClient())));
    await expect(missing.resolve(scope)).resolves.toBeNull();

    const client = new RecordingClient((query) => (
      query.text.includes("FROM odf.project_members") ? result([{ role: "superuser" }]) : result()
    ));
    const malformed = new PostgresProjectAccessResolver(PostgresRuntime.fromPool(new RecordingPool(client)));
    await expect(malformed.resolve(scope)).resolves.toBeNull();
  });

  it("allows tenant management only for an owner or admin", async () => {
    const client = new RecordingClient((query) => (
      query.text.includes("FROM odf.tenant_members") ? result([{ role: "admin" }]) : result()
    ));
    const resolver = new PostgresProjectAccessResolver(PostgresRuntime.fromPool(new RecordingPool(client)));

    await expect(resolver.resolveTenantManagement({ tenantId: scope.tenantId, userId: scope.userId }))
      .resolves.toEqual({ canManageProjects: true });
  });
});
