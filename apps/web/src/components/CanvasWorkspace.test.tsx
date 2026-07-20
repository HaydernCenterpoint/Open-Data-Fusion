import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANVAS_STORAGE_KEY, createEmptyCanvas, createWidget, saveCanvas } from "./industrialCanvas";
import { CanvasWorkspace } from "./CanvasWorkspace";

function renderCanvas() {
  const onNotify = vi.fn();
  const onOpenExplorer = vi.fn();
  render(
    <CanvasWorkspace
      snapshot={null}
      workspace={null}
      platformContext={null}
      onWorkspaceUpdated={vi.fn()}
      onOpenExplorer={onOpenExplorer}
      onNotify={onNotify}
    />,
  );
  return { onNotify, onOpenExplorer };
}

describe("Industrial Data Canvas", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty with the complete navigation and authoring toolbar", () => {
    renderCanvas();

    expect(screen.getByRole("heading", { name: "Add your first widget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Canvas" })).toHaveAttribute("aria-current", "page");
    const toolbar = screen.getByRole("toolbar", { name: "Canvas tools" });
    for (const name of ["Select", "Hand / Pan", "Add text", "Add note", "Add image", "Add document", "Add chart", "Add time series", "Add 3D viewer", "Add asset card", "AI question card", "Connector", "Frame / Section", "Comment"]) {
      expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("adds and edits a widget, then persists it locally", async () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    expect(screen.getByLabelText("Note note widget")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open inspector" }));
    const inspector = screen.getByRole("complementary", { name: "Canvas inspector" });
    fireEvent.change(within(inspector).getByLabelText("Name"), { target: { value: "Shift context" } });

    expect(screen.getByLabelText("Shift context note widget")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toContain('"title":"Shift context"'), { timeout: 1500 });
  });

  it("does not intercept spaces or line breaks typed inside text widgets", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    const editor = within(screen.getByLabelText("Text text widget")).getByRole("textbox");

    expect(editor).toHaveValue("");
    expect(editor).toHaveAttribute("placeholder", "Add text");
    expect(fireEvent.keyDown(editor, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(editor, { key: "Enter" })).toBe(true);
    fireEvent.change(editor, { target: { value: "Xin chào\nca trực" } });
    expect(editor).toHaveValue("Xin chào\nca trực");
  });

  it("treats the old default text as a placeholder for saved widgets", () => {
    const canvas = createEmptyCanvas();
    const text = createWidget("text", { x: 80, y: 80 }, 1);
    text.data.text = "Add text";
    canvas.widgets = [text];
    saveCanvas(canvas);
    renderCanvas();

    const editor = within(screen.getByLabelText("Text text widget")).getByRole("textbox");
    expect(editor).toHaveValue("");
    expect(editor).toHaveAttribute("placeholder", "Add text");
  });

  it("wires every toolbar content control to an editable or actionable widget", async () => {
    const { onOpenExplorer } = renderCanvas();
    const toolbar = screen.getByRole("toolbar", { name: "Canvas tools" });
    const stage = screen.getByRole("main", { name: "Open Data Fusion industrial canvas" });
    const setPointerCapture = vi.fn();
    Object.defineProperty(stage, "setPointerCapture", { configurable: true, value: setPointerCapture });

    fireEvent.click(within(toolbar).getByRole("button", { name: "Hand / Pan" }));
    expect(stage).toHaveClass("tool-hand");
    const select = within(toolbar).getByRole("button", { name: "Select" });
    fireEvent.pointerDown(select, { button: 0, pointerId: 7 });
    expect(setPointerCapture).not.toHaveBeenCalled();
    fireEvent.click(select);
    expect(stage).toHaveClass("tool-select");

    for (const name of ["Add text", "Add note", "Add image", "Add document", "Add chart", "Add time series", "Add 3D viewer", "Add asset card", "AI question card", "Frame / Section"]) {
      fireEvent.click(within(toolbar).getByRole("button", { name }));
    }

    const text = screen.getByLabelText("Text text widget");
    const note = screen.getByLabelText("Note note widget");
    const image = screen.getByLabelText("Image image widget");
    const document = screen.getByLabelText("Document document widget");
    const chart = screen.getByLabelText("Chart chart widget");
    const timeSeries = screen.getByLabelText("Time series timeSeries widget");
    const model = screen.getByLabelText("3D viewer model3d widget");
    const asset = screen.getByLabelText("Asset asset widget");
    const ai = screen.getByLabelText("Ask the canvas ai widget");
    const frame = screen.getByLabelText("Section frame widget");

    fireEvent.change(within(text).getByRole("textbox"), { target: { value: "Operating envelope" } });
    fireEvent.change(within(note).getByRole("textbox"), { target: { value: "Inspect on next shift" } });
    expect(within(text).getByDisplayValue("Operating envelope")).toBeInTheDocument();
    expect(within(note).getByDisplayValue("Inspect on next shift")).toBeInTheDocument();

    const imageInput = image.querySelector<HTMLInputElement>('input[type="file"]');
    const documentInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(imageInput).not.toBeNull();
    expect(documentInput).not.toBeNull();
    fireEvent.change(imageInput!, { target: { files: [new File(["image"], "inspection.png", { type: "image/png" })] } });
    fireEvent.change(documentInput!, { target: { files: [new File(["pdf"], "procedure.pdf", { type: "application/pdf" })] } });
    expect(await within(image).findByAltText("inspection.png")).toBeInTheDocument();
    expect(await within(document).findByLabelText("procedure.pdf")).toBeInTheDocument();

    for (const [widget, action] of [[chart, "Select data source"], [timeSeries, "Select data source"], [model, "Select model source"], [asset, "Connect data source"], [ai, "Connect data source"]] as const) {
      fireEvent.click(within(widget).getByRole("button", { name: action }));
    }
    expect(onOpenExplorer).toHaveBeenCalledTimes(5);
    expect(within(frame).getByText("Drop related widgets inside this section")).toBeInTheDocument();
    expect(Number(frame.style.zIndex)).toBeLessThan(Number(note.style.zIndex));

    const notePosition = note.style.transform;
    const frameHeader = frame.querySelector("header");
    expect(frameHeader).not.toBeNull();
    fireEvent.pointerDown(frameHeader!, { button: 0, pointerId: 12, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 12, clientX: 140, clientY: 140 });
    fireEvent.pointerUp(stage, { pointerId: 12, clientX: 140, clientY: 140 });
    expect(note.style.transform).not.toBe(notePosition);
  });

  it("creates a connector between two widgets and removes it with Delete", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    fireEvent.click(screen.getByRole("button", { name: "Add asset card" }));
    const note = screen.getByLabelText("Note note widget");
    const asset = screen.getByLabelText("Asset asset widget");

    fireEvent.click(screen.getByRole("button", { name: "Connector" }));
    fireEvent.click(note);
    fireEvent.click(asset);

    const connector = screen.getByRole("button", { name: "Connector from Note to Asset" });
    fireEvent.click(connector);
    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.queryByRole("button", { name: "Connector from Note to Asset" })).not.toBeInTheDocument();
  });

  it("applies the connected 3D viewer controls to local viewer state", () => {
    const canvas = createEmptyCanvas();
    const model = createWidget("model3d", { x: 80, y: 80 }, 1);
    model.data = { ...model.data, connected: true, sourceLabel: "Model source" };
    canvas.widgets = [model];
    saveCanvas(canvas);
    renderCanvas();

    const viewer = screen.getByLabelText("3D viewer model3d widget");
    const pan = within(viewer).getByRole("button", { name: "Pan" });
    fireEvent.click(pan);
    expect(pan).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(viewer).getByRole("button", { name: "Zoom model in" }));
    expect(viewer.querySelector(".industrial-model-surface > div")).toHaveStyle({ transform: "scale(1.15)" });
  });

  it("places a comment pin and opens a working thread panel", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const stage = screen.getByRole("main", { name: "Open Data Fusion industrial canvas" });
    fireEvent.pointerDown(stage, { button: 0, pointerId: 5, clientX: 420, clientY: 260 });

    const pin = screen.getByRole("button", { name: /Comment 1: New comment/ });
    expect(pin).toBeInTheDocument();
    const inspector = screen.getByRole("complementary", { name: "Canvas inspector" });
    expect(within(inspector).getByRole("tab", { name: /Comments/ })).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByText("New comment")).toBeInTheDocument();

    fireEvent.click(within(inspector).getByRole("button", { name: "Close inspector" }));
    const initialPosition = pin.style.transform;
    fireEvent.pointerDown(pin, { button: 0, pointerId: 6, clientX: 420, clientY: 260 });
    fireEvent.pointerMove(stage, { pointerId: 6, clientX: 500, clientY: 320 });
    fireEvent.pointerUp(stage, { pointerId: 6, clientX: 500, clientY: 320 });
    fireEvent.click(pin);
    expect(pin.style.transform).not.toBe(initialPosition);
    expect(screen.getByRole("button", { name: "Open inspector" })).toBeInTheDocument();
  });

  it("opens the command palette and confirms a full reset", () => {
    renderCanvas();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("option", { name: /Add asset card/ }));
    expect(screen.getByLabelText("Asset asset widget")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More canvas actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reset canvas" }));
    expect(screen.getByRole("dialog", { name: "Reset this canvas?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset canvas" }));
    expect(screen.getByRole("heading", { name: "Add your first widget" })).toBeInTheDocument();
  });
});
