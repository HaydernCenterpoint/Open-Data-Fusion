import { describe, expect, it } from "vitest";

import {
  NotFoundError,
  PostgresRuntime,
} from "../src/index.js";
import { RecordingClient, RecordingPool, result } from "./recording-pg.js";

const tenantId = "11111111-1111-1111-1111-111111111111";
const projectId = "22222222-2222-2222-2222-222222222222";
const correlationId = "33333333-3333-3333-3333-333333333333";
const userId = "tenant.owner@example.test";

const projectRow = {
  project_id: projectId,
  tenant_id: tenantId,
  slug: "operations",
  name: "Operations",
  description: "Real production data",
  status: "active",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
  created: true,
};

describe("PostgresTenantProjectAdministrationRepository", () => {
  it("creates a project through the narrow database routine rather than direct table DML", async () => {
    const client = new RecordingClient((query) => (
      query.text.includes("odf.admin_create_project") ? result([projectRow]) : result()
    ));
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    const created = await runtime.administration.createProject({ tenantId, userId }, {
      projectId,
      slug: "operations",
      name: "Operations",
      description: "Real production data",
      correlationId,
    });

    expect(created).toMatchObject({
      created: true,
      changed: true,
      project: { projectId, tenantId, slug: "operations", name: "Operations" },
    });
    const command = client.queries.find((query) => query.text.includes("odf.admin_create_project"));
    expect(command?.values).toEqual([projectId, "operations", "Operations", "Real production data", correlationId]);
    expect(command?.text).not.toContain("INSERT INTO odf.projects");
    expect(client.queries.some((query) => query.text.startsWith("INSERT INTO odf.projects"))).toBe(false);
    expect(client.queries.find((query) => query.text.includes("set_config('odf.tenant_id'"))?.values).toEqual([tenantId]);
  });

  it("uses a bounded security-definer member listing with an opaque keyset cursor", async () => {
    const client = new RecordingClient((query) => (
      query.text.includes("odf.admin_list_project_members")
        ? result([
            {
              tenant_id: tenantId,
              project_id: projectId,
              user_id: "alpha@example.test",
              role: "owner",
              created_by: userId,
              created_at: "2026-07-12T00:00:00.000Z",
              updated_at: "2026-07-12T00:00:00.000Z",
            },
            {
              tenant_id: tenantId,
              project_id: projectId,
              user_id: "beta@example.test",
              role: "viewer",
              created_by: userId,
              created_at: "2026-07-12T00:00:01.000Z",
              updated_at: "2026-07-12T00:00:01.000Z",
            },
          ])
        : result()
    ));
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    const page = await runtime.administration.listProjectMembers(
      { tenantId, projectId, userId },
      1,
      { value: "before@example.test" },
    );

    expect(page.items).toEqual([expect.objectContaining({ userId: "alpha@example.test", role: "owner" })]);
    expect(page.nextCursor).toEqual({ value: "alpha@example.test" });
    const command = client.queries.find((query) => query.text.includes("odf.admin_list_project_members"));
    expect(command?.values).toEqual(["before@example.test", 2]);
    expect(command?.text).not.toContain("FROM odf.project_members");
  });

  it("maps a false routine removal result to a stable not-found error", async () => {
    const client = new RecordingClient((query) => (
      query.text.includes("odf.admin_remove_project_member") ? result([{ removed: false }]) : result()
    ));
    const runtime = PostgresRuntime.fromPool(new RecordingPool(client));

    await expect(runtime.administration.removeProjectMember(
      { tenantId, projectId, userId },
      "missing@example.test",
      correlationId,
    )).rejects.toEqual(expect.any(NotFoundError));
    expect(client.queries.some((query) => query.text.startsWith("DELETE FROM odf.project_members"))).toBe(false);
  });
});
