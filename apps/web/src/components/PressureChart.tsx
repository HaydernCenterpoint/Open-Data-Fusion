import { ChevronDown } from "lucide-react";
import { useId } from "react";
import type { TelemetryPoint } from "../types";

const HOUR_MS = 60 * 60 * 1_000;
const RANGE_DURATION_MS = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
} as const;
const RANGE_DESCRIPTIONS: Record<PressureChartRange, string> = {
  "24h": "24-hour",
  "7d": "7-day",
  "30d": "30-day",
};

const PLOT_LEFT = 64;
const PLOT_RIGHT = 790;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 296;
const X_TICK_COUNT = 5;
const Y_TICK_COUNT = 5;

const tickDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const tickTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: "UTC",
});

export type PressureChartRange = keyof typeof RANGE_DURATION_MS;

type PressureChartPoint = Pick<TelemetryPoint, "timestamp" | "value">;

export interface PressureChartProps {
  range: PressureChartRange;
  onRangeChange: (range: PressureChartRange) => void;
  points?: readonly PressureChartPoint[];
  rangeEnd?: string;
  title?: string;
  unit?: string;
}

interface NormalizedPoint extends PressureChartPoint {
  time: number;
}

function parseTimestamp(timestamp?: string) {
  if (!timestamp) return null;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? time : null;
}

function normalizePoints(points: readonly PressureChartPoint[]) {
  return points
    .reduce<NormalizedPoint[]>((validPoints, point) => {
      const time = parseTimestamp(point.timestamp);
      if (time !== null && Number.isFinite(point.value)) validPoints.push({ ...point, time });
      return validPoints;
    }, [])
    .sort((left, right) => left.time - right.time);
}

function yDomain(points: readonly NormalizedPoint[]) {
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum;
  const magnitude = Math.max(Math.abs(minimum), Math.abs(maximum));
  const padding = spread === 0
    ? (magnitude === 0 ? 1 : magnitude * 0.05)
    : Math.max(spread * 0.1, magnitude * 0.005);

  return { minimum: minimum - padding, maximum: maximum + padding };
}

function chartData(points: readonly PressureChartPoint[], range: PressureChartRange, rangeEnd?: string) {
  const normalizedPoints = normalizePoints(points);
  const latestPoint = normalizedPoints.at(-1);
  if (!latestPoint) return null;

  const duration = RANGE_DURATION_MS[range];
  const requestedEnd = parseTimestamp(rangeEnd) ?? latestPoint.time;
  const requestedStart = requestedEnd - duration;
  const requestedPoints = normalizedPoints.filter((point) => point.time >= requestedStart && point.time <= requestedEnd);
  const usesLatestAvailable = requestedPoints.length === 0;
  const domainEnd = usesLatestAvailable ? latestPoint.time : requestedEnd;
  const domainStart = domainEnd - duration;
  const visiblePoints = usesLatestAvailable
    ? normalizedPoints.filter((point) => point.time >= domainStart && point.time <= domainEnd)
    : requestedPoints;

  return {
    domainEnd,
    domainStart,
    points: visiblePoints,
    requestedEnd,
    usesLatestAvailable,
    yDomain: yDomain(visiblePoints),
  };
}

function xPosition(time: number, domainStart: number, domainEnd: number) {
  return PLOT_LEFT + ((time - domainStart) / (domainEnd - domainStart)) * (PLOT_RIGHT - PLOT_LEFT);
}

function yPosition(value: number, minimum: number, maximum: number) {
  return PLOT_TOP + ((maximum - value) / (maximum - minimum)) * (PLOT_BOTTOM - PLOT_TOP);
}

function linePath(points: readonly NormalizedPoint[], domainStart: number, domainEnd: number, minimum: number, maximum: number) {
  return points.map((point, index) => {
    const x = xPosition(point.time, domainStart, domainEnd);
    const y = yPosition(point.value, minimum, maximum);
    return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function fractionDigits(step: number) {
  if (!Number.isFinite(step) || step === 0) return 2;
  return Math.min(6, Math.max(0, 1 - Math.floor(Math.log10(Math.abs(step)))));
}

function formatValue(value: number, maximumFractionDigits: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(Object.is(value, -0) ? 0 : value);
}

function formatDateTime(time: number) {
  return new Date(time).toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC");
}

function isPressureChartRange(value: string): value is PressureChartRange {
  return value in RANGE_DURATION_MS;
}

export function PressureChart({ range, onRangeChange, points = [], rangeEnd, title = "Pressure", unit = "psi" }: PressureChartProps) {
  const headingId = useId();
  const svgTitleId = useId();
  const svgDescriptionId = useId();
  const data = chartData(points, range, rangeEnd);
  const displayRange = data?.usesLatestAvailable ? `latest available ${range}` : range;

  let chart = null;
  if (data) {
    const { domainEnd, domainStart, requestedEnd, usesLatestAvailable, yDomain: domain } = data;
    const finalPoint = data.points.at(-1)!;
    const yStep = (domain.maximum - domain.minimum) / (Y_TICK_COUNT - 1);
    const digits = fractionDigits(yStep);
    const yTicks = Array.from({ length: Y_TICK_COUNT }, (_, index) => domain.maximum - index * yStep);
    const timeTicks = Array.from({ length: X_TICK_COUNT }, (_, index) => domainStart + (index / (X_TICK_COUNT - 1)) * (domainEnd - domainStart));
    const path = linePath(data.points, domainStart, domainEnd, domain.minimum, domain.maximum);
    const finalX = xPosition(finalPoint.time, domainStart, domainEnd);
    const finalY = yPosition(finalPoint.value, domain.minimum, domain.maximum);
    const pointLabel = `telemetry point${data.points.length === 1 ? "" : "s"}`;
    const observedStart = data.points[0].time;
    const rangeDescription = RANGE_DESCRIPTIONS[range];
    const valueSummary = `Values range from ${formatValue(Math.min(...data.points.map((point) => point.value)), digits)} to ${formatValue(Math.max(...data.points.map((point) => point.value)), digits)} ${unit}; the latest value is ${formatValue(finalPoint.value, digits)} ${unit} at ${formatDateTime(finalPoint.time)}.`;
    const description = usesLatestAvailable
      ? `No telemetry points fall within the requested ${rangeDescription} window ending ${formatDateTime(requestedEnd)}. Showing ${data.points.length} ${pointLabel} from the latest available ${rangeDescription} window, observed between ${formatDateTime(observedStart)} and ${formatDateTime(finalPoint.time)}. ${valueSummary}`
      : `Showing ${data.points.length} ${pointLabel} in the ${rangeDescription} window from ${formatDateTime(domainStart)} to ${formatDateTime(domainEnd)}, observed between ${formatDateTime(observedStart)} and ${formatDateTime(finalPoint.time)}. ${valueSummary}`;

    chart = (
      <svg viewBox="0 0 812 332" role="img" aria-labelledby={svgTitleId} aria-describedby={svgDescriptionId} focusable="false">
        <title id={svgTitleId}>{title} over {displayRange}</title>
        <desc id={svgDescriptionId}>{description}</desc>
        <g aria-hidden="true">
          {yTicks.map((tick, index) => {
            const y = PLOT_TOP + (index / (Y_TICK_COUNT - 1)) * (PLOT_BOTTOM - PLOT_TOP);
            return (
              <g key={index}>
                <line className="grid-line" x1={PLOT_LEFT} y1={y} x2={PLOT_RIGHT} y2={y} />
                <text className="axis-label y-label" x={PLOT_LEFT - 10} y={y + 4} textAnchor="end">{formatValue(tick, digits)}</text>
              </g>
            );
          })}
          {timeTicks.map((tick, index) => {
            const x = xPosition(tick, domainStart, domainEnd);
            const textAnchor = index === 0 ? "start" : index === timeTicks.length - 1 ? "end" : "middle";
            const timestamp = new Date(tick).toISOString();
            return (
              <g key={timestamp} data-timestamp={timestamp}>
                <text className="axis-label" x={x} y="316" textAnchor={textAnchor}>{tickDateFormatter.format(tick)}</text>
                <text className="date-label" x={x} y="330" textAnchor={textAnchor}>{tickTimeFormatter.format(tick)} UTC</text>
              </g>
            );
          })}
          <path
            className="pressure-line"
            d={path}
            data-point-count={data.points.length}
            data-window-end={new Date(domainEnd).toISOString()}
            data-window-start={new Date(domainStart).toISOString()}
          />
          <circle className="final-ring" cx={finalX} cy={finalY} r="7" />
          <circle className="final-dot" cx={finalX} cy={finalY} r="3.7" />
        </g>
      </svg>
    );
  }

  return (
    <section className="chart-section" aria-labelledby={headingId}>
      <div className="chart-header">
        <div>
          <h2 id={headingId}>{title} ({displayRange})</h2>
          <div className="series-key"><span /> {unit}</div>
        </div>
        <div className="chart-actions">
          <label className="range-select">
            <span className="sr-only">Time range</span>
            <select value={range} onChange={(event) => {
              if (isPressureChartRange(event.target.value)) onRangeChange(event.target.value);
            }}>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
              <option value="30d">30d</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>

        </div>
      </div>
      <div className="chart-wrap">
        {chart ?? <div className="chart-empty-state" role="status">No valid telemetry points are available.</div>}
      </div>
    </section>
  );
}
