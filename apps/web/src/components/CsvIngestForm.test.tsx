import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestBundle } from "../lib/api";
import { CsvIngestForm } from "./CsvIngestForm";

vi.mock("../lib/api", () => ({
  ingestBundle: vi.fn(),
}));

const mockedIngestBundle = vi.mocked(ingestBundle);

function csvFile(contents: string, name = "pump.csv") {
  const file = new File([contents], name, { type: "text/csv" });
  Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(contents) });
  return file;
}

async function mapSingleSeries(contents: string, name = "pump.csv") {
  fireEvent.change(screen.getByLabelText("CSV or TSV file"), {
    target: { files: [csvFile(contents, name)] },
  });

  await screen.findByText(name);
  fireEvent.change(screen.getByRole("textbox", { name: "Source system" }), { target: { value: "csv-pilot" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Timestamp column" }), { target: { value: "timestamp" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Asset 1 external ID" }), { target: { value: "P-101" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Asset 1 name" }), { target: { value: "Pump 101" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Asset 1 type" }), { target: { value: "pump" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Time series 1 external ID" }), {
    target: { value: "P-101-PRESSURE" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Time series 1 name" }), { target: { value: "Pressure" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Time series 1 asset" }), { target: { value: "P-101" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Time series 1 value column" }), {
    target: { value: "pressure" },
  });
}

describe("CsvIngestForm", () => {
  beforeEach(() => {
    mockedIngestBundle.mockReset();
  });

  it("previews and imports a mapped wide-form file in one atomic request", async () => {
    mockedIngestBundle.mockResolvedValue({ runId: "content-run", status: "completed" });
    const onComplete = vi.fn();

    render(
      <CsvIngestForm
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        onCancel={vi.fn()}
        onComplete={onComplete}
      />,
    );

    fireEvent.change(screen.getByLabelText("CSV or TSV file"), {
      target: {
        files: [csvFile("timestamp,pressure,temperature,quality\n2026-07-11T00:00:00Z,101.2,42.5,good\n")],
      },
    });

    await screen.findByText("pump.csv");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Source system" }), { target: { value: "csv-pilot" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Timestamp column" }), { target: { value: "timestamp" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset 1 external ID" }), { target: { value: "P-101" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset 1 name" }), { target: { value: "Pump 101" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset 1 type" }), { target: { value: "pump" } });
    fireEvent.click(screen.getByRole("button", { name: "Add asset" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Asset 2 external ID" }), { target: { value: "P-102" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset 2 name" }), { target: { value: "Pump 102" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Asset 2 type" }), { target: { value: "pump" } });

    fireEvent.change(screen.getByRole("textbox", { name: "Time series 1 external ID" }), {
      target: { value: "P-101-PRESSURE" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Time series 1 name" }), { target: { value: "Pressure" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Time series 1 asset" }), { target: { value: "P-101" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Time series 1 value column" }), {
      target: { value: "pressure" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Time series 1 quality column" }), {
      target: { value: "quality" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add time series" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Time series 2 external ID" }), {
      target: { value: "P-101-TEMP" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Time series 2 name" }), { target: { value: "Temperature" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Time series 2 asset" }), { target: { value: "P-102" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Time series 2 value column" }), {
      target: { value: "temperature" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Time series 2 unit" }), { target: { value: "°C" } });

    await screen.findByText("1 row · 2 data points");
    expect(mockedIngestBundle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import 2 data points" }));

    await waitFor(() => expect(mockedIngestBundle).toHaveBeenCalledTimes(1));
    expect(mockedIngestBundle).toHaveBeenCalledWith(
      { tenantId: "tenant-1", projectId: "project-1" },
      {
        source: { system: "csv-pilot" },
        assets: [
          { externalId: "P-101", name: "Pump 101", type: "pump" },
          { externalId: "P-102", name: "Pump 102", type: "pump" },
        ],
        timeSeries: [
          { externalId: "P-101-PRESSURE", assetExternalId: "P-101", name: "Pressure" },
          { externalId: "P-101-TEMP", assetExternalId: "P-102", name: "Temperature", unit: "°C" },
        ],
        dataPoints: [
          {
            timeSeriesExternalId: "P-101-PRESSURE",
            timestamp: "2026-07-11T00:00:00.000Z",
            value: 101.2,
            quality: "good",
          },
          {
            timeSeriesExternalId: "P-101-TEMP",
            timestamp: "2026-07-11T00:00:00.000Z",
            value: 42.5,
            quality: "good",
          },
        ],
      },
    );
    expect(onComplete).toHaveBeenCalledWith("Ingest run content-run accepted");
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toHaveFocus());
  });

  it("keeps invalid numeric data local and reports its row and column", async () => {
    render(
      <CsvIngestForm
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    await mapSingleSeries("timestamp,pressure\n2026-07-11T00:00:00Z,not-a-number\n");

    expect(await screen.findByRole("alert")).toHaveTextContent("row 2, column 'pressure': value must be a finite number");
    expect(screen.getByRole("button", { name: "Import 0 data points" })).toBeDisabled();
    expect(mockedIngestBundle).not.toHaveBeenCalled();
  });

  it("keeps the mapped form open with the API error when import fails", async () => {
    mockedIngestBundle.mockRejectedValue(new Error("The API rejected this bundle."));
    const onComplete = vi.fn();
    render(
      <CsvIngestForm
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        onCancel={vi.fn()}
        onComplete={onComplete}
      />,
    );

    await mapSingleSeries("timestamp,pressure\n2026-07-11T00:00:00Z,101.2\n");
    fireEvent.click(screen.getByRole("button", { name: "Import 1 data points" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The API rejected this bundle.");
    expect(screen.getByLabelText("CSV or TSV file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 1 data points" })).toBeEnabled();
    expect(mockedIngestBundle).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("locks the selected file and mapping while the atomic request is pending", async () => {
    mockedIngestBundle.mockImplementation(() => new Promise(() => undefined));
    render(
      <CsvIngestForm
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    await mapSingleSeries("timestamp,pressure\n2026-07-11T00:00:00Z,101.2\n");
    fireEvent.click(screen.getByRole("button", { name: "Import 1 data points" }));

    await waitFor(() => expect(screen.getByLabelText("CSV or TSV file")).toBeDisabled());
    expect(screen.getByRole("textbox", { name: "Source system" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add asset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(mockedIngestBundle).toHaveBeenCalledTimes(1);
  });

  it("reparses TSV input and clears stale mapping when the delimiter changes", async () => {
    render(
      <CsvIngestForm
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    const contents = "timestamp\tpressure\n2026-07-11T00:00:00Z\t101.2\n";

    fireEvent.change(screen.getByLabelText("CSV or TSV file"), {
      target: { files: [csvFile(contents, "pump.tsv")] },
    });
    await screen.findByText("pump.tsv");
    const sourceField = screen.getByRole("textbox", { name: "Source system" });
    fireEvent.change(sourceField, { target: { value: "stale-source" } });

    fireEvent.change(screen.getByRole("combobox", { name: "Delimiter" }), { target: { value: "\t" } });

    await waitFor(() => expect(screen.getByRole("combobox", { name: "Timestamp column" })).toHaveValue("timestamp"));
    expect(screen.getByRole("textbox", { name: "Source system" })).toHaveValue("");
    expect(screen.getByRole("columnheader", { name: "pressure" })).toBeInTheDocument();
    expect(mockedIngestBundle).not.toHaveBeenCalled();
  });

  it("clears stale mapping when a different file is selected", async () => {
    render(
      <CsvIngestForm
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("CSV or TSV file"), {
      target: { files: [csvFile("timestamp,pressure\n2026-07-11T00:00:00Z,101.2\n", "first.csv")] },
    });
    await screen.findByText("first.csv");
    fireEvent.change(screen.getByRole("textbox", { name: "Source system" }), { target: { value: "stale-source" } });

    fireEvent.change(screen.getByLabelText("CSV or TSV file"), {
      target: { files: [csvFile("observed_at,temperature\n2026-07-11T00:00:00Z,42.5\n", "second.csv")] },
    });

    await screen.findByText("second.csv");
    expect(screen.getByRole("textbox", { name: "Source system" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Timestamp column" })).toHaveValue("observed_at");
    expect(screen.queryByText("first.csv")).not.toBeInTheDocument();
    expect(mockedIngestBundle).not.toHaveBeenCalled();
  });

  it("renders at most five preview rows and treats cell markup as plain text", async () => {
    render(
      <CsvIngestForm
        context={{ tenantId: "tenant-1", projectId: "project-1" }}
        onCancel={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    const rows = [
      "2026-07-11T00:00:00Z,<img src=x onerror=alert(1)>",
      "2026-07-11T00:01:00Z,row-two",
      "2026-07-11T00:02:00Z,row-three",
      "2026-07-11T00:03:00Z,row-four",
      "2026-07-11T00:04:00Z,row-five",
      "2026-07-11T00:05:00Z,row-six",
      "2026-07-11T00:06:00Z,row-seven",
    ];

    fireEvent.change(screen.getByLabelText("CSV or TSV file"), {
      target: { files: [csvFile(`timestamp,note\n${rows.join("\n")}\n`, "preview.csv")] },
    });

    const preview = await screen.findByRole("table");
    expect(within(preview).getAllByRole("row")).toHaveLength(6);
    expect(within(preview).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(preview.querySelector("img")).toBeNull();
    expect(within(preview).queryByText("row-six")).not.toBeInTheDocument();
  });
});
