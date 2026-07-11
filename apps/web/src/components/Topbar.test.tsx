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
  function Harness() {
    const [query, setQuery] = useState("");
    return (
      <Topbar
        query={query}
        onQueryChange={setQuery}
        onResultSelect={onResultSelect}
        apiOnline
        platformContext={null}
        platformStatus="degraded"
        activeSection="Explorer"
        onSectionChange={vi.fn()}
      />
    );
  }

  render(<Harness />);
  return { onResultSelect };
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
});
