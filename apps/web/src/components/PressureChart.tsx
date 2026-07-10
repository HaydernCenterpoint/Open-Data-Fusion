import { ChevronDown, EllipsisVertical } from "lucide-react";
import { pressureValues } from "../data/demo";

const yTicks = [120, 115, 110, 105, 100, 95, 90, 85, 80];
const timeTicks = ["12:00", "15:00", "18:00", "21:00", "00:00", "03:00", "06:00", "09:00", "12:00"];

function linePath(values: number[]) {
  const plotLeft = 38;
  const plotTop = 16;
  const plotWidth = 752;
  const plotHeight = 280;
  const points = values.map((value, index) => {
    const x = plotLeft + (index / (values.length - 1)) * plotWidth;
    const y = plotTop + ((120 - value) / 40) * plotHeight;
    return [x, y] as const;
  });

  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point[0].toFixed(1)} ${point[1].toFixed(1)}`;
    const previous = points[index - 1];
    const controlX = (previous[0] + point[0]) / 2;
    return `${path} C ${controlX.toFixed(1)} ${previous[1].toFixed(1)}, ${controlX.toFixed(1)} ${point[1].toFixed(1)}, ${point[0].toFixed(1)} ${point[1].toFixed(1)}`;
  }, "");
}

interface PressureChartProps {
  range: string;
  onRangeChange: (range: string) => void;
  live: boolean;
  onLiveToggle: () => void;
  values?: number[];
}

export function PressureChart({ range, onRangeChange, live, onLiveToggle, values }: PressureChartProps) {
  const chartValues = values && values.length > 1 ? values : pressureValues;
  const path = linePath(chartValues);
  const finalValue = chartValues.at(-1) ?? 0;
  const finalX = 790;
  const finalY = 16 + ((120 - finalValue) / 40) * 280;

  return (
    <section className="chart-section" aria-labelledby="pressure-title">
      <div className="chart-header">
        <div>
          <h2 id="pressure-title">Pressure ({range})</h2>
          <div className="series-key"><span /> psi</div>
        </div>
        <div className="chart-actions">
          <button type="button" className={`live-control${live ? " active" : ""}`} onClick={onLiveToggle} aria-pressed={live}>
            <span /> Live
          </button>
          <label className="range-select">
            <span className="sr-only">Time range</span>
            <select value={range} onChange={(event) => onRangeChange(event.target.value)}>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
              <option value="30d">30d</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <button className="icon-button" type="button" aria-label="More chart actions">
            <EllipsisVertical size={21} />
          </button>
        </div>
      </div>
      <div className="chart-wrap">
        <svg viewBox="0 0 812 332" role="img" aria-label={`Pressure fluctuates between 94 and 117 psi over ${range}, ending at ${finalValue} psi`}>
          <title>Pressure time series for Pump P-101</title>
          {yTicks.map((tick, index) => {
            const y = 16 + index * 35;
            return (
              <g key={tick}>
                <line className="grid-line" x1="38" y1={y} x2="790" y2={y} />
                <text className="axis-label y-label" x="25" y={y + 4} textAnchor="end">{tick}</text>
              </g>
            );
          })}
          {timeTicks.map((tick, index) => {
            const x = 38 + index * 94;
            return <text key={`${tick}-${index}`} className="axis-label" x={x} y="316" textAnchor={index === 0 ? "start" : index === timeTicks.length - 1 ? "end" : "middle"}>{tick}</text>;
          })}
          <text className="date-label" x="414" y="330" textAnchor="middle">May 14</text>
          <path className="pressure-line" d={path} />
          <circle className="final-ring" cx={finalX} cy={finalY} r="7" />
          <circle className="final-dot" cx={finalX} cy={finalY} r="3.7" />
        </svg>
      </div>
    </section>
  );
}
