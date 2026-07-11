import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PressureChart, type PressureChartProps } from "./PressureChart";

const rangeEnd = "2025-05-14T12:00:00.000Z";

function renderChart(overrides: Partial<PressureChartProps> = {}) {
  const props: PressureChartProps = {
    onRangeChange: vi.fn(),
    points: [],
    range: "24h",
    rangeEnd,
    ...overrides,
  };
  return { ...render(<PressureChart {...props} />), props };
}

describe("PressureChart", () => {
  it("positions and labels points from their real timestamps and pads the Y-domain", () => {
    const { container } = renderChart({
      points: [
        { timestamp: "2025-05-13T12:00:00.000Z", value: 100 },
        { timestamp: "2025-05-13T18:00:00.000Z", value: 105 },
        { timestamp: "2025-05-14T12:00:00.000Z", value: 110 },
      ],
    });

    const chart = screen.getByRole("img", { name: "Pressure over 24h" });
    expect(chart).toHaveAccessibleDescription(/3 telemetry points.*latest value is 110 psi at 2025-05-14 12:00 UTC/i);
    expect(container.querySelector(".pressure-line")).toHaveAttribute(
      "d",
      "M 64.0 272.7 L 245.5 156.0 L 790.0 39.3",
    );
    expect(Array.from(container.querySelectorAll(".y-label"), (label) => label.textContent)).toEqual([
      "111",
      "108",
      "105",
      "102",
      "99",
    ]);

    const firstTimeTick = container.querySelector('g[data-timestamp="2025-05-13T12:00:00.000Z"]');
    expect(firstTimeTick?.querySelector(".axis-label")).toHaveTextContent("May 13, 2025");
    expect(firstTimeTick?.querySelector(".date-label")).toHaveTextContent("12:00 UTC");
  });

  it("filters telemetry by the selected 24h, 7d, and 30d windows", () => {
    const onRangeChange = vi.fn();
    const points = [
      { timestamp: "2025-04-20T12:00:00.000Z", value: 90 },
      { timestamp: "2025-05-10T12:00:00.000Z", value: 95 },
      { timestamp: "2025-05-14T00:00:00.000Z", value: 100 },
      { timestamp: "2025-05-14T12:00:00.000Z", value: 105 },
    ];
    const { container, rerender } = renderChart({ onRangeChange, points });

    expect(container.querySelector(".pressure-line")).toHaveAttribute("data-point-count", "2");
    fireEvent.change(screen.getByLabelText("Time range"), { target: { value: "7d" } });
    expect(onRangeChange).toHaveBeenCalledWith("7d");

    rerender(<PressureChart range="7d" onRangeChange={onRangeChange} points={points} rangeEnd={rangeEnd} />);
    expect(container.querySelector(".pressure-line")).toHaveAttribute("data-point-count", "3");
    expect(screen.getByRole("heading", { name: "Pressure (7d)" })).toBeInTheDocument();

    rerender(<PressureChart range="30d" onRangeChange={onRangeChange} points={points} rangeEnd={rangeEnd} />);
    expect(container.querySelector(".pressure-line")).toHaveAttribute("data-point-count", "4");
  });

  it("truthfully labels a latest-available fallback when the requested window is empty", () => {
    const { container } = renderChart({
      points: [
        { timestamp: "2025-04-01T12:00:00.000Z", value: 98 },
        { timestamp: "2025-04-02T12:00:00.000Z", value: 101 },
      ],
    });

    expect(screen.getByRole("heading", { name: "Pressure (latest available 24h)" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Pressure over latest available 24h" })).toHaveAccessibleDescription(
      /No telemetry points fall within the requested 24-hour window ending 2025-05-14 12:00 UTC/i,
    );
    expect(container.querySelector(".pressure-line")).toHaveAttribute("data-point-count", "2");
    expect(container.querySelector(".pressure-line")).toHaveAttribute("data-window-end", "2025-04-02T12:00:00.000Z");
    expect(screen.queryByRole("button", { name: /live/i })).not.toBeInTheDocument();
  });

  it("shows an empty state instead of an inaccessible or misleading chart for invalid data", () => {
    renderChart({
      points: [
        { timestamp: "not-a-timestamp", value: 100 },
        { timestamp: rangeEnd, value: Number.NaN },
      ],
    });

    expect(screen.getByRole("status")).toHaveTextContent("No valid telemetry points are available.");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
