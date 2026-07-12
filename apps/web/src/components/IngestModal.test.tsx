import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { IngestModal } from "./IngestModal";

vi.mock("../lib/api", () => ({
  ingestBundle: vi.fn(),
}));

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
});
