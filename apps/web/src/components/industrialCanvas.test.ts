import { beforeEach, describe, expect, it } from "vitest";
import {
  bringWidgetForward,
  createEmptyCanvas,
  createWidget,
  duplicateWidget,
  loadCanvas,
  saveCanvas,
  sendWidgetBackward,
  snapToGrid,
  zoomAroundPoint,
} from "./industrialCanvas";

describe("industrial canvas state", () => {
  beforeEach(() => localStorage.clear());

  it("creates, duplicates and reorders widgets without mutating the source", () => {
    const original = createWidget("asset", { x: 41, y: 59 }, 2);
    const copy = duplicateWidget(original, 7);

    expect(original).toMatchObject({ x: 40, y: 60, z: 2, title: "Asset" });
    expect(copy).toMatchObject({ x: 64, y: 84, z: 7, title: "Asset copy" });
    expect(copy.id).not.toBe(original.id);
    expect(bringWidgetForward(original, 8).z).toBe(9);
    expect(sendWidgetBackward(original, 1).z).toBe(1);
  });

  it("keeps the same world point under the cursor while zooming", () => {
    expect(zoomAroundPoint({ x: 40, y: 30, zoom: 1 }, { x: 200, y: 120 }, 1.2)).toEqual({
      x: 8,
      y: 12,
      zoom: 1.2,
    });
    expect(snapToGrid(47)).toBe(48);
  });

  it("round-trips a versioned canvas through localStorage", () => {
    const canvas = createEmptyCanvas();
    canvas.title = "Inspection board";
    canvas.widgets = [createWidget("note", { x: 102, y: 120 }, 1)];

    saveCanvas(canvas);

    expect(loadCanvas()).toMatchObject({
      version: 1,
      title: "Inspection board",
      widgets: [{ kind: "note", x: 104, y: 120 }],
    });
  });
});
