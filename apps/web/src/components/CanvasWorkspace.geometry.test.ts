import { describe, expect, it } from "vitest";
import { edgePath, type CanvasNodeGeometry } from "./CanvasWorkspace";

describe("canvas relationship geometry", () => {
  const source: CanvasNodeGeometry = { x: 10, y: 20, width: 100, height: 80 };
  const target: CanvasNodeGeometry = { x: 300, y: 40, width: 120, height: 80 };

  it("derives both relationship endpoints from live node positions", () => {
    expect(edgePath(source, target)).toBe("M110 60 C205 60 205 80 300 80");

    expect(edgePath(
      { ...source, x: 50, y: 100 },
      { ...target, x: 360, y: 120 },
    )).toBe("M150 140 C255 140 255 160 360 160");
  });

  it("moves the source port when live node dimensions change", () => {
    expect(edgePath(
      { ...source, width: 160, height: 120 },
      target,
    )).toBe("M170 80 C235 80 235 80 300 80");
  });
});
