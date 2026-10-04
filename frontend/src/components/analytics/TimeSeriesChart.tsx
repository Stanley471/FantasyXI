"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import {
  bandIndexAt,
  buildColumnPath,
  buildLinePath,
  formatPoints,
  labelInterval,
  linearScale,
  niceTicks,
} from "@/lib/chart";

export interface ChartSeries {
  id: string;
  label: string;
  color: string;
  kind: "line" | "column";
  /** One value per category; null means no data (line breaks, no column) */
  values: Array<number | null>;
}

export interface TimeSeriesChartProps {
  title: string;
  /** Plain-language summary read by screen readers in place of the graphic */
  summary: string;
  /** Full category names, e.g. "Gameweek 12" (tooltip, table, announcements) */
  categories: string[];
  /** Compact axis labels, e.g. "GW12"; defaults to `categories` */
  axisLabels?: string[];
  series: ChartSeries[];
  unit?: string;
  height?: number;
}

const MARGIN = { top: 12, right: 12, bottom: 28, left: 40 };
const DEFAULT_WIDTH = 640;
const MAX_COLUMN_WIDTH = 24;
const COLUMN_GAP = 2;

/** Tracks the rendered width of an element so the SVG is drawn at 1:1 scale */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/**
 * Accessible category/time-series chart (lines and grouped columns on one axis).
 *
 * - Responsive: redraws at the container's width instead of scaling text.
 * - Pointer: a crosshair snaps to the nearest gameweek and one tooltip lists every series.
 * - Keyboard: focus the chart and use Left/Right/Home/End; values are announced politely.
 * - Screen readers: the SVG exposes a text summary and a full data table is always available.
 */
export const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({
  title,
  summary,
  categories,
  axisLabels = categories,
  series,
  unit = "pts",
  height = 240,
}) => {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const titleId = useId();
  const summaryId = useId();

  const count = categories.length;
  const plotLeft = MARGIN.left;
  const plotRight = Math.max(plotLeft + 1, width - MARGIN.right);
  const plotTop = MARGIN.top;
  const plotBottom = height - MARGIN.bottom;
  const plotWidth = plotRight - plotLeft;
  const bandWidth = count > 0 ? plotWidth / count : plotWidth;

  const allValues = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const ticks = niceTicks(Math.min(0, ...allValues), Math.max(0, ...allValues));
  const y = linearScale([ticks[0], ticks[ticks.length - 1]], [plotBottom, plotTop]);
  const baseline = y(0);
  const bandCenter = (index: number) => plotLeft + bandWidth * (index + 0.5);

  const columnSeries = series.filter((s) => s.kind === "column");
  const lineSeries = series.filter((s) => s.kind === "line");
  const columnWidth = Math.max(
    2,
    Math.min(MAX_COLUMN_WIDTH, (bandWidth * 0.7 - COLUMN_GAP * (columnSeries.length - 1)) / Math.max(1, columnSeries.length))
  );
  const groupWidth = columnWidth * columnSeries.length + COLUMN_GAP * (columnSeries.length - 1);
  const every = labelInterval(count, plotWidth);

  const describe = (index: number) =>
    `${categories[index]}: ` +
    series.map((s) => `${s.label} ${formatPoints(s.values[index])} ${unit}`).join(", ");

  const moveTo = (index: number) => setActiveIndex(Math.min(count - 1, Math.max(0, index)));

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const current = activeIndex ?? count - 1;
    const keys: Record<string, number> = {
      ArrowLeft: current - 1,
      ArrowRight: current + 1,
      Home: 0,
      End: count - 1,
    };
    if (event.key in keys) {
      event.preventDefault();
      moveTo(keys[event.key]);
    } else if (event.key === "Escape") {
      setActiveIndex(null);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setActiveIndex(bandIndexAt(event.clientX - bounds.left + plotLeft, plotLeft, bandWidth, count));
  };

  const tooltipOnLeft = activeIndex !== null && bandCenter(activeIndex) > width * 0.6;

  return (
    <figure className="m-0 space-y-3" aria-labelledby={titleId}>
      <figcaption className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 id={titleId} className="text-sm font-bold text-slate-100">
          {title}
        </h3>
        {series.length > 1 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300" aria-label={`${title} legend`}>
            {series.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5">
                {s.kind === "line" ? (
                  <span aria-hidden="true" className="inline-block h-0.5 w-4 rounded" style={{ backgroundColor: s.color }} />
                ) : (
                  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
                )}
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </figcaption>

      <div
        ref={containerRef}
        className="relative w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
        tabIndex={count > 0 ? 0 : undefined}
        role="group"
        aria-roledescription="interactive chart"
        aria-label={`${title}. Use the left and right arrow keys to read each gameweek.`}
        aria-describedby={summaryId}
        onKeyDown={handleKeyDown}
        onFocus={() => activeIndex === null && count > 0 && setActiveIndex(count - 1)}
        onBlur={() => setActiveIndex(null)}
      >
        <p id={summaryId} className="sr-only">
          {summary}
        </p>
        <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="block h-auto w-full">
          {/* Gridlines and y-axis */}
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={plotLeft} x2={plotRight} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "#334155" : "#1e293b"} strokeWidth={1} />
              <text x={plotLeft - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-slate-400 text-[11px] tabular-nums">
                {formatPoints(tick)}
              </text>
            </g>
          ))}

          {/* X-axis labels */}
          {axisLabels.map((label, index) =>
            // Always label the latest gameweek, dropping any interval label that would crowd it
            (index % every === 0 && count - 1 - index >= every) || index === count - 1 ? (
              <text
                key={`${label}-${index}`}
                x={bandCenter(index)}
                y={plotBottom + 18}
                textAnchor="middle"
                className="fill-slate-400 text-[11px]"
              >
                {label}
              </text>
            ) : null
          )}

          {/* Crosshair */}
          {activeIndex !== null && (
            <line
              x1={bandCenter(activeIndex)}
              x2={bandCenter(activeIndex)}
              y1={plotTop}
              y2={plotBottom}
              stroke="#64748b"
              strokeWidth={1}
            />
          )}

          {/* Columns, grouped per category with a 2px gap */}
          {columnSeries.map((s, seriesIndex) =>
            s.values.map((value, index) => {
              if (value === null) return null;
              const x = bandCenter(index) - groupWidth / 2 + seriesIndex * (columnWidth + COLUMN_GAP);
              return (
                <path
                  key={`${s.id}-${index}`}
                  d={buildColumnPath(x, columnWidth, baseline, y(value))}
                  fill={s.color}
                  opacity={activeIndex === null || activeIndex === index ? 1 : 0.55}
                  data-series={s.id}
                />
              );
            })
          )}

          {/* Lines with end markers */}
          {lineSeries.map((s) => {
            const lastIndex = s.values.reduce<number>((last, v, i) => (v === null ? last : i), -1);
            return (
              <g key={s.id} data-series={s.id}>
                <path
                  d={buildLinePath(s.values.map((v, i) => ({ x: bandCenter(i), y: v === null ? null : y(v) })))}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {lastIndex >= 0 && (
                  <circle cx={bandCenter(lastIndex)} cy={y(s.values[lastIndex] as number)} r={4} fill={s.color} stroke="#0f172a" strokeWidth={2} />
                )}
                {activeIndex !== null && s.values[activeIndex] !== null && (
                  <circle cx={bandCenter(activeIndex)} cy={y(s.values[activeIndex] as number)} r={5} fill={s.color} stroke="#0f172a" strokeWidth={2} />
                )}
              </g>
            );
          })}

          {/* Pointer hit area: the whole plot, snapping to the nearest gameweek */}
          {count > 0 && (
            <rect
              x={plotLeft}
              y={plotTop}
              width={plotWidth}
              height={plotBottom - plotTop}
              fill="transparent"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setActiveIndex(null)}
            />
          )}
        </svg>

        {activeIndex !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-[10rem] rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs shadow-xl"
            style={
              tooltipOnLeft
                ? { right: width - bandCenter(activeIndex) + 12 }
                : { left: bandCenter(activeIndex) + 12 }
            }
            aria-hidden="true"
          >
            <p className="mb-1 font-semibold text-slate-300">{categories[activeIndex]}</p>
            {series.map((s) => (
              <p key={s.id} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5 text-slate-400">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: s.color }} />
                  {s.label}
                </span>
                <span className="font-mono font-bold text-white tabular-nums">
                  {formatPoints(s.values[activeIndex])} {unit}
                </span>
              </p>
            ))}
          </div>
        )}

        <p className="sr-only" aria-live="polite">
          {activeIndex !== null ? describe(activeIndex) : ""}
        </p>
      </div>

      <details className="group text-xs text-slate-400">
        <summary className="cursor-pointer select-none rounded font-semibold text-slate-400 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-emerald-400">
          View {title.toLowerCase()} as a table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-800">
          <table className="w-full text-left">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-slate-950 text-slate-400">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">
                  Gameweek
                </th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="px-3 py-2 text-right font-semibold">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {categories.map((category, index) => (
                <tr key={`${category}-${index}`}>
                  <th scope="row" className="px-3 py-1.5 font-medium text-slate-300">
                    {category}
                  </th>
                  {series.map((s) => (
                    <td key={s.id} className="px-3 py-1.5 text-right font-mono tabular-nums text-slate-200">
                      {formatPoints(s.values[index])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
};
