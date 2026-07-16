import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, searchPlatform } from "../lib/api";
import { DataExplorerWorkspace } from "./DataExplorerWorkspace";

vi.mock("../lib/api", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    constructor(message: string, readonly status: number, readonly detail: unknown = null) {
      super(message);
    }
  },
  searchPlatform: vi.fn(),
}));

const results = [
  {
    tenantId: "demo",
    projectId: "north-plant",
    entityType: "asset",
    entityId: "P-101",
    title: "Pump P-101",
    summary: "Centrifugal pump",
    updatedAt: "2026-07-16T01:00:00.000Z",
  },
  {
    tenantId: "demo",
    projectId: "north-plant",
    entityType: "pipeline",
    entityId: "normalize-telemetry",
    title: "Normalize telemetry",
    summary: "Pipeline for industrial telemetry",
    updatedAt: "2026-07-16T02:00:00.000Z",
  },
  {
    tenantId: "demo",
    projectId: "north-plant",
    entityType: "source",
    entityId: "opcua-north",
    title: "North OPC-UA",
    summary: "Read-only collector",
    updatedAt: "2026-07-16T03:00:00.000Z",
  },
];

function renderWorkspace(overrides: Partial<ComponentProps<typeof DataExplorerWorkspace>> = {}) {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  const onClear = vi.fn();
  render(
    <DataExplorerWorkspace
      context={{ tenantId: "demo", projectId: "north-plant" }}
      query="pump"
      selected={{ entityType: "pipeline", entityId: "normalize-telemetry" }}
      onSelect={onSelect}
      onOpen={onOpen}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onSelect, onOpen, onClear };
}

describe("DataExplorerWorkspace", () => {
  beforeEach(() => {
    vi.mocked(searchPlatform).mockReset();
    vi.mocked(searchPlatform).mockResolvedValue({ items: results, nextCursor: null });
  });

  it("filters category results, previews the selected record, and opens its workspace", async () => {
    const { onOpen } = renderWorkspace();

    expect(await screen.findByRole("heading", { name: "Data Explorer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All (3)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pipelines (1)" }));

    const listbox = screen.getByRole("listbox", { name: "Data Explorer results" });
    expect(within(listbox).getByRole("option", { name: /Normalize telemetry/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: /Pump P-101/ })).not.toBeInTheDocument();

    fireEvent.click(within(listbox).getByRole("option", { name: /Normalize telemetry/ }));
    const preview = screen.getByRole("complementary", { name: "Result preview" });
    expect(preview).toHaveTextContent("Pipeline");
    fireEvent.click(within(preview).getByRole("button", { name: "Open Pipelines" }));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ entityType: "pipeline", entityId: "normalize-telemetry" }));
    expect(searchPlatform).toHaveBeenCalledWith(
      { tenantId: "demo", projectId: "north-plant" },
      { q: "pump", limit: 100 },
      expect.any(AbortSignal),
    );
  });

  it("supports keyboard result selection", async () => {
    const { onSelect } = renderWorkspace({ selected: null });
    const listbox = await screen.findByRole("listbox", { name: "Data Explorer results" });

    fireEvent.keyDown(listbox, { key: "End" });
    expect(within(listbox).getByRole("option", { name: /North OPC-UA/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ entityId: "opcua-north" }));
  });

  it("retries a failed scoped search", async () => {
    vi.mocked(searchPlatform)
      .mockRejectedValueOnce(new ApiRequestError("Search unavailable", 503, null))
      .mockResolvedValueOnce({ items: results, nextCursor: null });

    renderWorkspace();
    expect(await screen.findByRole("alert")).toHaveTextContent("Search is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(searchPlatform).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("listbox", { name: "Data Explorer results" })).toBeInTheDocument();
  });
});
