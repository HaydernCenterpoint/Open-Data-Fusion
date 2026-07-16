import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestBundle } from "../lib/api";
import { IngestModal } from "./IngestModal";

vi.mock("../lib/api", () => ({
  ingestBundle: vi.fn(),
}));

const mockedIngestBundle = vi.mocked(ingestBundle);

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open ingest</button>
      <IngestModal context={{ tenantId: "tenant-1", projectId: "project-1" }} open={open} onClose={() => setOpen(false)} onComplete={vi.fn()} />
    </>
  );
}

describe("IngestModal", () => {
  beforeEach(() => {
    mockedIngestBundle.mockReset();
  });

  it("switches ingest methods with tab semantics and moves focus to the active form", async () => {
    render(<ModalHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open ingest" }));

    const manualTab = screen.getByRole("tab", { name: "Manual measurement" });
    const csvTab = screen.getByRole("tab", { name: "Import CSV/TSV" });
    expect(manualTab).toHaveAttribute("aria-selected", "true");
    expect(csvTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Start ingest" })).toBeInTheDocument();

    fireEvent.click(csvTab);
    const fileInput = screen.getByLabelText("CSV or TSV file");
    await waitFor(() => expect(fileInput).toHaveFocus());
    expect(csvTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Start ingest" })).not.toBeInTheDocument();

    fireEvent.click(manualTab);
    const sourceField = screen.getByRole("textbox", { name: "Source system" });
    await waitFor(() => expect(sourceField).toHaveFocus());
    expect(manualTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Start ingest" })).toBeInTheDocument();
  });

  it("switches ingest methods with the tablist arrow keys", async () => {
    render(<ModalHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open ingest" }));

    const manualTab = screen.getByRole("tab", { name: "Manual measurement" });
    manualTab.focus();
    fireEvent.keyDown(manualTab, { key: "ArrowRight" });

    const csvTab = screen.getByRole("tab", { name: "Import CSV/TSV" });
    expect(csvTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByLabelText("CSV or TSV file")).toHaveFocus());

    csvTab.focus();
    fireEvent.keyDown(csvTab, { key: "ArrowLeft" });
    expect(manualTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Source system" })).toHaveFocus());
  });

  it("traps focus, closes on Escape, and restores focus to the trigger", async () => {
    render(<ModalHarness />);
    const trigger = screen.getByRole("button", { name: "Open ingest" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Ingest measurement bundle" });
    const firstField = screen.getByRole("textbox", { name: "Source system" });
    const closeButton = screen.getByRole("button", { name: "Close ingest dialog" });
    const submitButton = screen.getByRole("button", { name: "Start ingest" });

    expect(dialog).toHaveAccessibleDescription("Create or update a real asset and time series in the selected project.");
    await waitFor(() => expect(firstField).toHaveFocus());

    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(submitButton).toHaveFocus();

    fireEvent.keyDown(submitButton, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    trigger.focus();
    expect(firstField).toHaveFocus();

    fireEvent.keyDown(firstField, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Ingest measurement bundle" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the manual measurement bundle and completion flow unchanged", async () => {
    mockedIngestBundle.mockResolvedValue({ runId: "manual-result", message: "Manual bundle accepted." });
    const onComplete = vi.fn();
    render(
      <IngestModal
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        open
        onClose={vi.fn()}
        onComplete={onComplete}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Source system" }), { target: { value: "manual-ui" } });
    const runIdField = screen.getByRole("textbox", { name: "Source run ID" });
    fireEvent.change(runIdField, { target: { value: "manual-run-1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset external ID" }), { target: { value: "P-101" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset name" }), { target: { value: "Pump 101" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset type" }), { target: { value: "pump" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Time-series external ID" }), {
      target: { value: "P-101-PRESSURE" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Time-series name" }), { target: { value: "Pressure" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Unit" }), { target: { value: "bar" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Measurement value" }), { target: { value: "101.2" } });
    fireEvent.click(screen.getByRole("button", { name: "Start ingest" }));

    await waitFor(() => expect(mockedIngestBundle).toHaveBeenCalledTimes(1));
    expect(mockedIngestBundle).toHaveBeenCalledWith(
      { tenantId: "tenant-1", projectId: "project-1" },
      {
        source: { system: "manual-ui", runId: "manual-run-1" },
        assets: [{ externalId: "P-101", name: "Pump 101", type: "pump" }],
        timeSeries: [{
          externalId: "P-101-PRESSURE",
          assetExternalId: "P-101",
          name: "Pressure",
          unit: "bar",
        }],
        dataPoints: [{
          timeSeriesExternalId: "P-101-PRESSURE",
          timestamp: expect.any(String),
          value: 101.2,
          quality: "good",
        }],
      },
    );
    expect(onComplete).toHaveBeenCalledWith("Manual bundle accepted.");
    expect(screen.getByRole("heading", { name: "Bundle accepted" })).toBeInTheDocument();
  });
});
