import type { CSSProperties, ReactElement } from "react";

import { addDays, dateFraction, daysBetween, formatShortDate } from "@/app/_lib/dates";

/**
 * Hand-written SVG line chart for the panels.
 *
 * Lines, gridlines, bands and shading live in an SVG stretched over the plot
 * area (viewBox 0–1000 both ways, preserveAspectRatio="none", non-scaling
 * strokes), so the chart follows its container's percent width without a
 * ResizeObserver. Text (axis ticks, end-of-line values, marker pills) is HTML
 * positioned in percentages, so it stays legible at any width.
 *
 * Null values are drawn as gaps, never interpolated.
 */

export interface ChartPoint {
  /** ISO date of the point. */
  x: string;
  y: number | null;
  band?: [number, number] | null;
}

export interface ChartSeries {
  id: string;
  label: string;
  variant: "main" | "control";
  points: ChartPoint[];
  /** Print the last value at the end of the line. */
  endLabel?: boolean;
}

export interface ChartMarker {
  x: string;
  label: string;
}

export interface ChartShade {
  /** Centre date of the shaded bucket. */
  x: string;
  widthDays: number;
  kind: "partial" | "unknown";
}

export interface ChartBracket {
  x: string;
  from: number;
  to: number;
  label: string;
}

export interface ChartTable {
  caption: string;
  columns: string[];
  rows: string[][];
}

export interface LineChartProps {
  ariaLabel: string;
  /** X domain as ISO dates (inclusive). */
  from: string;
  to: string;
  /** Days added to every point's date (e.g. 3 to centre weekly buckets). */
  pointOffsetDays?: number;
  series: ChartSeries[];
  yDomain: [number, number];
  yTicks: number[];
  formatY: (value: number) => string;
  formatValue: (value: number) => string;
  markers?: ChartMarker[];
  shades?: ChartShade[];
  bracket?: ChartBracket;
  /** Plot height in px. */
  height?: number;
  table: ChartTable;
}

const SIZE = 1000;
const MARKER_ROW = 26;

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(3)}%`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface Projected {
  fx: number;
  fy: number;
  band: [number, number] | null;
}

function segments(points: Array<Projected | null>): Projected[][] {
  const runs: Projected[][] = [];
  let current: Projected[] = [];
  for (const point of points) {
    if (point) current.push(point);
    else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

function linePath(run: Projected[]): string {
  return run
    .map((point, index) => `${index ? "L" : "M"}${(point.fx * SIZE).toFixed(2)} ${(point.fy * SIZE).toFixed(2)}`)
    .join(" ");
}

function bandPath(run: Projected[]): string | null {
  const withBand = run.filter((point) => point.band);
  if (withBand.length < 2) return null;
  const upper = withBand.map((point) => `${(point.fx * SIZE).toFixed(2)} ${((point.band?.[1] ?? 0) * SIZE).toFixed(2)}`);
  const lower = withBand
    .slice()
    .reverse()
    .map((point) => `${(point.fx * SIZE).toFixed(2)} ${((point.band?.[0] ?? 0) * SIZE).toFixed(2)}`);
  return `M${upper.join(" L")} L${lower.join(" L")} Z`;
}

function xTicks(from: string, to: string, count: number): string[] {
  const span = daysBetween(from, to);
  if (span <= 0) return [from];
  const steps = Math.min(count - 1, span);
  return Array.from({ length: steps + 1 }, (_, index) => addDays(from, Math.round((span * index) / steps)));
}

/** Assigns marker labels to rows so close markers don't overlap. */
function markerRows(markers: Array<ChartMarker & { fx: number }>): Array<ChartMarker & { fx: number; row: number }> {
  const lastByRow: number[] = [];
  return markers
    .slice()
    .sort((a, b) => a.fx - b.fx)
    .map((marker) => {
      let row = lastByRow.findIndex((last) => marker.fx - last > 0.12);
      if (row === -1) row = lastByRow.length;
      lastByRow[row] = marker.fx;
      return { ...marker, row };
    });
}

function anchorStyle(fx: number): CSSProperties {
  if (fx < 0.08) return { left: pct(fx), transform: "translateX(-6px)" };
  if (fx > 0.92) return { left: pct(fx), transform: "translateX(calc(-100% + 6px))" };
  return { left: pct(fx), transform: "translateX(-50%)" };
}

export function LineChart({
  ariaLabel,
  from,
  to,
  pointOffsetDays = 0,
  series,
  yDomain,
  yTicks,
  formatY,
  formatValue,
  markers = [],
  shades = [],
  bracket,
  height = 260,
  table,
}: LineChartProps): ReactElement {
  const [y0, y1] = yDomain;
  const fy = (value: number) => clamp01(1 - (value - y0) / (y1 - y0 || 1));
  const fx = (date: string, offset = 0) => clamp01(dateFraction(date, from, to, offset));

  const projected = series.map((item) => ({
    ...item,
    projected: item.points.map((point) =>
      point.y === null
        ? null
        : {
            fx: fx(point.x, pointOffsetDays),
            fy: fy(point.y),
            band: point.band ? ([fy(point.band[0]), fy(point.band[1])] as [number, number]) : null,
          },
    ),
  }));

  const placedMarkers = markerRows(
    markers
      .filter((marker) => marker.x >= from && marker.x <= to)
      .map((marker) => ({ ...marker, fx: fx(marker.x) })),
  );
  const rows = placedMarkers.reduce((max, marker) => Math.max(max, marker.row + 1), 0);

  // End-of-line values, nudged apart so they never overlap.
  const ends = projected
    .filter((item) => item.endLabel)
    .map((item) => {
      const lastIndex = item.points.findLastIndex((point) => point.y !== null);
      const last = lastIndex >= 0 ? item.projected[lastIndex] : null;
      const value = lastIndex >= 0 ? item.points[lastIndex].y : null;
      return last && value !== null ? { id: item.id, variant: item.variant, fx: last.fx, fy: last.fy, top: last.fy * height, text: formatValue(value) } : null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.top - b.top);
  for (let index = 1; index < ends.length; index += 1) {
    if (ends[index].top - ends[index - 1].top < 16) ends[index].top = ends[index - 1].top + 16;
  }

  const ticks = xTicks(from, to, 5);
  const plotStyle = { height, marginTop: rows * MARKER_ROW + 10 } as CSSProperties;

  return (
    <>
      <div className="lc" role="img" aria-label={ariaLabel}>
        <div className="lc__plot" style={plotStyle}>
          <svg className="lc__svg" viewBox={`0 0 ${SIZE} ${SIZE}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
            {shades.map((shade) => {
              const left = fx(shade.x, pointOffsetDays - shade.widthDays / 2);
              const right = fx(shade.x, pointOffsetDays + shade.widthDays / 2);
              return (
                <rect
                  key={`${shade.kind}-${shade.x}`}
                  className={`lc__shade lc__shade--${shade.kind}`}
                  x={left * SIZE}
                  y={0}
                  width={Math.max(2, (right - left) * SIZE)}
                  height={SIZE}
                />
              );
            })}
            {yTicks.map((tick) => (
              <line key={tick} className="lc__grid" x1={0} x2={SIZE} y1={fy(tick) * SIZE} y2={fy(tick) * SIZE} vectorEffect="non-scaling-stroke" />
            ))}
            {placedMarkers.map((marker) => (
              <line
                key={`m-${marker.x}-${marker.label}`}
                className="lc__marker-line"
                x1={marker.fx * SIZE}
                x2={marker.fx * SIZE}
                y1={0}
                y2={SIZE}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {projected.map((item) =>
              segments(item.projected).map((run, index) => {
                const band = bandPath(run);
                return band ? <path key={`b-${item.id}-${index}`} className="lc__band" d={band} /> : null;
              }),
            )}
            {projected.map((item) =>
              segments(item.projected)
                .filter((run) => run.length > 1)
                .map((run, index) => (
                  <path
                    key={`l-${item.id}-${index}`}
                    className={`lc__line lc__line--${item.variant}`}
                    d={linePath(run)}
                    vectorEffect="non-scaling-stroke"
                  />
                )),
            )}
            {bracket && (
              <g className="lc__bracket">
                {[bracket.from, bracket.to].map((value) => (
                  <line
                    key={value}
                    x1={fx(bracket.x) * SIZE - 8}
                    x2={fx(bracket.x) * SIZE}
                    y1={fy(value) * SIZE}
                    y2={fy(value) * SIZE}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <line
                  x1={fx(bracket.x) * SIZE - 8}
                  x2={fx(bracket.x) * SIZE - 8}
                  y1={fy(bracket.from) * SIZE}
                  y2={fy(bracket.to) * SIZE}
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )}
          </svg>

          {yTicks.map((tick) => (
            <span key={tick} className="lc__ytick mono" style={{ top: pct(fy(tick)) }}>
              {formatY(tick)}
            </span>
          ))}

          {placedMarkers.map((marker) => (
            <span
              key={`p-${marker.x}-${marker.label}`}
              className="lc__marker"
              style={{ ...anchorStyle(marker.fx), top: -(rows - marker.row) * MARKER_ROW - 2 }}
            >
              {marker.label}
            </span>
          ))}

          {projected.map((item) =>
            segments(item.projected)
              .filter((run) => run.length === 1)
              .map((run) => (
                <span
                  key={`d-${item.id}-${run[0].fx}`}
                  className={`lc__dot lc__dot--${item.variant}`}
                  style={{ left: pct(run[0].fx), top: pct(run[0].fy) }}
                />
              )),
          )}

          {ends.map((end) => (
            <span key={`e-${end.id}`}>
              <span className={`lc__dot lc__dot--${end.variant}`} style={{ left: pct(end.fx), top: pct(end.fy) }} />
              <span className={`lc__end lc__end--${end.variant}`} style={{ top: end.top }}>
                {end.text}
              </span>
            </span>
          ))}

          {bracket && (
            <span
              className="lc__bracket-label mono"
              style={{ left: pct(fx(bracket.x)), top: pct((fy(bracket.from) + fy(bracket.to)) / 2) }}
            >
              {bracket.label}
            </span>
          )}
        </div>

        <div className="lc__xaxis" aria-hidden="true">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className={index % 2 === 1 ? "lc__xtick lc__xtick--minor mono" : "lc__xtick mono"}
              style={anchorStyle(fx(tick))}
            >
              {formatShortDate(tick)}
            </span>
          ))}
        </div>
      </div>

      <div className="visually-hidden">
      <table>
        <caption>{table.caption}</caption>
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.join("|")}>
              {row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th> : <td key={index}>{cell}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>
  );
}
