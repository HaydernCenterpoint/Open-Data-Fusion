import { describe, expect, it } from "vitest";
import { appRouteHref, readAppRoute } from "./appRoute";

describe("app route", () => {
  it("reads a deep-linked Explorer asset and project context", () => {
    expect(readAppRoute("https://example.test/?view=explorer&asset=P-101&tenant=demo&project=north-plant&user=riley.chen")).toEqual({
      view: "explorer",
      assetId: "P-101",
      tenantId: "demo",
      projectId: "north-plant",
    });
  });

  it("falls back to Canvas and ignores orphaned route parameters", () => {
    expect(readAppRoute("https://example.test/?view=unknown&asset=P-101&project=north-plant")).toEqual({ view: "canvas" });
  });

  it("updates app-owned parameters while preserving collaboration identity", () => {
    expect(appRouteHref("https://example.test/?user=samantha.lee&view=canvas", {
      view: "context",
      tenantId: "demo",
      projectId: "north-plant",
    })).toBe("/?user=samantha.lee&view=context&tenant=demo&project=north-plant");
  });

  it("keeps an asset only on Explorer routes", () => {
    expect(appRouteHref("https://example.test/?view=explorer&asset=P-101", {
      view: "audit",
    })).toBe("/?view=audit");
  });
});
