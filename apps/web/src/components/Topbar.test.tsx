import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAssets } from "../lib/api";
import { Topbar } from "./Topbar";

vi.mock("../lib/api", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status = 500;
  },
  listAssets: vi.fn(),
  searchPlatform: vi.fn(),
}));

const assets = [
  {
    externalId: "P-101",
    name: "Pump P-101",
    description: null,
    type: "Centrifugal Pump",
    parentExternalId: null,
    metadata: {},
    sourceSystem: "OSIsoft PI",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    externalId: "P-102",
    name: "Pump P-102",
    description: null,
    type: "Centrifugal Pump",
    parentExternalId: null,
    metadata: {},
    sourceSystem: "OSIsoft PI",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

function renderTopbar(onResultSelect = vi.fn()) {
  const onTenantChange = vi.fn();
  const onProjectChange = vi.fn();
  const onRetry = vi.fn();
  function Harness() {
    const [query, setQuery] = useState("");
    return (
      <Topbar
        query={query}
        onQueryChange={setQuery}
        onResultSelect={onResultSelect}
        apiOnline
        platformContext={{ tenantId: "tenant-1", projectId: "project-1" }}
        tenants={[{ id: "tenant-1", name: "Tenant One", createdBy: "system", createdAt: "2026-01-01T00:00:00.000Z" }]}
        projects={[
          { tenantId: "tenant-1", id: "project-1", name: "Project One", description: null, createdBy: "system", createdAt: "2026-01-01T00:00:00.000Z" },
          { tenantId: "tenant-1", id: "project-2", name: "Project Two", description: null, createdBy: "system", createdAt: "2026-01-01T00:00:00.000Z" },
        ]}
        selectedTenantId="tenant-1"
        platformState={{ status: "ready", message: "tenant-1 / project-1" }}
        activeSection="Explorer"
        onTenantChange={onTenantChange}
        onProjectChange={onProjectChange}
        onRetry={onRetry}
        onSectionChange={vi.fn()}
      />
    );
  }

  render(<Harness />);
  return { onProjectChange, onResultSelect };
}

async function openSearchResults() {
  const input = screen.getByRole("combobox", { name: "Search project data" });
  fireEvent.change(input, { target: { value: "pump" } });
  const listbox = await screen.findByRole("listbox", { name: "Search results" });
  const options = await within(listbox).findAllByRole("option");
  return { input, listbox, options };
}

describe("Topbar search", () => {
  beforeEach(() => {
    vi.mocked(listAssets).mockResolvedValue({ items: assets, total: assets.length, limit: 20, offset: 0 });
  });

  it("exposes a combobox and selects the active result with the keyboard", async () => {
    const { onResultSelect } = renderTopbar();
    const { input, listbox, options } = await openSearchResults();

    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-controls", listbox.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onResultSelect).toHaveBeenCalledWith(expect.objectContaining({ entityId: "P-101", title: "Pump P-101" }));
    expect(screen.queryByRole("listbox", { name: "Search results" })).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("closes results on Escape, blur, and an outside pointer event", async () => {
    renderTopbar();
    const { input } = await openSearchResults();
    const sectionSelector = screen.getByRole("combobox", { name: "Workspace section" });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Search results" })).not.toBeInTheDocument();

    fireEvent.focus(input);
    expect(screen.getByRole("listbox", { name: "Search results" })).toBeInTheDocument();
    fireEvent.blur(input, { relatedTarget: sectionSelector });
    expect(screen.queryByRole("listbox", { name: "Search results" })).not.toBeInTheDocument();

    fireEvent.focus(input);
    expect(screen.getByRole("listbox", { name: "Search results" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox", { name: "Search results" })).not.toBeInTheDocument();
  });

  it("opens the active project selector and focuses search with Control+K", async () => {
    const { onProjectChange } = renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search project data" });

    fireEvent.click(screen.getByRole("button", { name: "Change project: Project One in Tenant One" }));
    const switcher = screen.getByRole("dialog", { name: "Project switcher" });
    const tenantSelector = within(switcher).getByRole("combobox", { name: "Project tenant" });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(tenantSelector).toHaveFocus();
    fireEvent.change(within(switcher).getByRole("combobox", { name: "Project" }), { target: { value: "project-2" } });
    expect(onProjectChange).toHaveBeenCalledWith("project-2");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(input).toHaveFocus();
  });
});
