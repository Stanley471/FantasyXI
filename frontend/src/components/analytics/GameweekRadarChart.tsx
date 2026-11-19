"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatPoints } from "@/lib/chart";
import {
  MAX_RADAR_MANAGERS,
  RADAR_COLORS,
  RADAR_DIMENSIONS,
  axisEndpoint,
  gridRingPoints,
  interpolateNormalized,
  normalizeAllDimensions,
  normalizeDimension,
  percentileExplanation,
  percentileLabel,
  percentileRank,
  polygonPointsAttr,
  radarPolygonPoints,
  toggleManagerIds,
} from "@/lib/radar";

export interface RadarManagerSeries {
  id: string;
  label: string;
  color?: string;
  /** Raw values, one per dimension in RADAR_DIMENSIONS order; null = no data */
  values: Array<number | null>;
}

export interface GameweekRadarChartProps {
  title: string;
  /** Plain-language summary read by screen readers in place of the graphic */
  summary: string;
  /** e.g. "Gameweek 12" or "All gameweeks" — shown as a badge and in the table */
  gameweekLabel: string;
  /** Managers to compare; at most MAX_RADAR_MANAGERS are shown at once */
  managers: RadarManagerSeries[];
  /** League-average raw values in the same dimension order; null where unknown */
  leagueAverage?: Array<number | null>;
  height?: number;
  /** Length of the transition when the gameweek filter changes; 0 = instant */
  animationDurationMs?: number;
  /** Ids selected on first render; defaults to the first MAX_RADAR_MANAGERS */
  initialSelectedIds?: string[];
}

const DEFAULT_WIDTH = 640;
const GRID_LEVELS = [0.25, 0.5, 0.75, 1];
const LABEL_OFFSET = 20;

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

function colorFor(manager: RadarManagerSeries, index: number): string {
  return manager.color ?? RADAR_COLORS[index % RADAR_COLORS.length];
}

/**
 * Accessible, interactive SVG radar chart comparing up to four managers
 * across the six tactical dimensions in RADAR_DIMENSIONS.
 *
 * - Plain SVG, no charting library: geometry lives in `@/lib/radar`.
 * - Managers toggle on/off with the legend buttons; at most four at once.
 * - Switching gameweek filters animates the polygons between the old and
 *   new normalized values (requestAnimationFrame interpolation).
 * - Hovering or focusing a vertex, or arrowing across the chart, opens a
 *   tooltip that explains each value's percentile relative to the league
 *   average; the same numbers are always available as a data table.
 * - Screen readers get the SVG's text summary plus the full data table;
 *   the SVG itself is a labelled image, not a tab stop maze.
 */
export const GameweekRadarChart: React.FC<GameweekRadarChartProps> = ({
  title,
  summary,
  gameweekLabel,
  managers,
  leagueAverage = [],
  height = 420,
  animationDurationMs = 300,
  initialSelectedIds,
}) => {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [selectedIds, setSelectedIds] = useState<string[]>(
    () => initialSelectedIds ?? managers.slice(0, MAX_RADAR_MANAGERS).map((m) => m.id)
  );
  const [activeDimension, setActiveDimension] = useState<number | null>(null);
  const titleId = useId();
  const summaryId = useId();

  const visibleManagers = useMemo(
    () => managers.filter((m) => selectedIds.includes(m.id)),
    [managers, selectedIds]
  );
  const selectedCount = visibleManagers.length;

  // Normalization cohort is every supplied manager plus the league average,
  // so toggling a manager hides its polygon without rescaling the others.
  const normalized = useMemo(
    () => normalizeAllDimensions(managers.map((m) => m.values), leagueAverage),
    [managers, leagueAverage]
  );
  // League-average marker positions: normalize the average against the same
  // cohort, one dimension at a time.
  const leagueMarkers = useMemo(
    () =>
      RADAR_DIMENSIONS.map((dimension, i) => {
        if (leagueAverage[i] == null) return null;
        const cohort = [...managers.map((m) => m.values[i] ?? null), leagueAverage[i]];
        return normalizeDimension(cohort, dimension.higherIsBetter)[cohort.length - 1];
      }),
    [managers, leagueAverage]
  );

  const valuesKey = JSON.stringify({ values: managers.map((m) => m.values), leagueAverage });

  // Animated values: the polygons ease from the previous normalized shape
  // to the new one whenever the gameweek filter (valuesKey) changes. With
  // no animation (duration 0) the new shape is used directly, no effect.
  const [displayed, setDisplayed] = useState(() => normalized);
  const previousRef = useRef(normalized);
  useEffect(() => {
    const from = previousRef.current;
    const to = normalized;
    previousRef.current = to;
    if (animationDurationMs <= 0 || typeof requestAnimationFrame === "undefined") return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / animationDurationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplayed(from.map((series, i) => interpolateNormalized(series, to[i] ?? series, eased)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valuesKey, animationDurationMs]);
  const shown = animationDurationMs <= 0 ? normalized : displayed;

  const center = { x: width / 2, y: height / 2 };
  const radius = Math.max(60, Math.min(width, height) / 2 - 56);

  const toggle = (id: string) =>
    setSelectedIds((current) => toggleManagerIds(current.filter((c) => managers.some((m) => m.id === c)), id));

  const moveDimension = (index: number) =>
    setActiveDimension(((index % RADAR_DIMENSIONS.length) + RADAR_DIMENSIONS.length) % RADAR_DIMENSIONS.length);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (managers.length === 0) return;
    const current = activeDimension ?? 0;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveDimension(current - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveDimension(current + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveDimension(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveDimension(RADAR_DIMENSIONS.length - 1);
    } else if (event.key === "Escape") {
      setActiveDimension(null);
    }
  };

  const describeDimension = (index: number): string => {
    const dimension = RADAR_DIMENSIONS[index];
    const parts = visibleManagers.map((manager) => {
      const value = manager.values[index] ?? null;
      const cohort = [...managers.map((m) => m.values[index] ?? null), leagueAverage[index] ?? null];
      const percentile = percentileRank(value, cohort, dimension.higherIsBetter);
      return `${manager.label} ${value === null ? "no data" : `${formatPoints(value)} points, ${percentile === null ? "no percentile" : `${percentileLabel(percentile)} percentile`}`}`;
    });
    return `${dimension.fullLabel}: ${parts.join("; ")}. League average ${formatPoints(leagueAverage[index] ?? null)} points.`;
  };

  // Tooltip anchor: the first visible manager's vertex on the active axis
  const tooltipPoint =
    activeDimension !== null && visibleManagers.length > 0
      ? radarPolygonPoints(shown[managers.findIndex((m) => m.id === visibleManagers[0].id)] ?? [], radius, center)[
          activeDimension
        ]
      : null;
  const tooltipOnLeft = tooltipPoint !== null && tooltipPoint.x > width * 0.6;

  return (
    <figure className="m-0 space-y-3" aria-labelledby={titleId}>
      <figcaption className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 id={titleId} className="text-sm font-black uppercase tracking-tight text-slate-900">
          {title}
          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold normal-case tracking-normal text-slate-600">
            {gameweekLabel}
          </span>
        </h3>
        {managers.length > 1 && (
          <ul className="flex flex-wrap gap-2 text-xs font-medium text-slate-600" aria-label={`${title} managers`}>
            {managers.map((manager, index) => {
              const selected = selectedIds.includes(manager.id);
              const atLimit = !selected && selectedCount >= MAX_RADAR_MANAGERS;
              return (
                <li key={manager.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    disabled={atLimit}
                    title={
                      atLimit
                        ? `Only ${MAX_RADAR_MANAGERS} managers can be compared at once — turn one off first`
                        : selected
                          ? `Hide ${manager.label} from the comparison`
                          : `Show ${manager.label} in the comparison`
                    }
                    onClick={() => toggle(manager.id)}
                    className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 shadow-sm transition-colors hover:border-slate-300 focus-visible:outline-2 focus-visible:outline-[#37003c] disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-slate-900 aria-pressed:text-white"
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: colorFor(manager, index) }}
                    />
                    {manager.label}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </figcaption>

      <div
        ref={containerRef}
        className="relative w-full rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[#37003c]"
        tabIndex={managers.length > 0 ? 0 : undefined}
        role="group"
        aria-roledescription="interactive chart"
        aria-label={`${title}. Use the left and right arrow keys to read each tactical dimension.`}
        aria-describedby={summaryId}
        onKeyDown={handleKeyDown}
        onFocus={() => activeDimension === null && setActiveDimension(0)}
        onBlur={() => setActiveDimension(null)}
      >
        <p id={summaryId} className="sr-only">
          {summary}
        </p>
        {managers.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-400">No managers to compare yet.</p>
        ) : (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${title} — ${gameweekLabel}. ${summary}`}
            className="block h-auto w-full"
            onPointerLeave={() => setActiveDimension(null)}
          >
            {/* Concentric grid rings */}
            {GRID_LEVELS.map((level) => (
              <polygon
                key={level}
                points={polygonPointsAttr(gridRingPoints(level, radius, center))}
                fill="none"
                stroke={level === 1 ? "#cbd5e1" : "#f1f5f9"}
                strokeWidth={1}
              />
            ))}

            {/* Axes and labels */}
            {RADAR_DIMENSIONS.map((dimension, index) => {
              const end = axisEndpoint(index, radius, center);
              const label = axisEndpoint(index, radius + LABEL_OFFSET, center);
              return (
                <g key={dimension.id}>
                  <line x1={center.x} y1={center.y} x2={end.x} y2={end.y} stroke="#e2e8f0" strokeWidth={1} />
                  <text
                    x={label.x}
                    y={label.y}
                    dy="0.32em"
                    textAnchor="middle"
                    className="fill-slate-500 text-[11px] font-mono font-medium"
                    onPointerEnter={() => setActiveDimension(index)}
                  >
                    {dimension.label}
                  </text>
                </g>
              );
            })}

            {/* League-average markers: a diamond on each axis where an average exists */}
            {leagueMarkers.map((marker, index) => {
              if (marker === null) return null;
              const point = radarPolygonPoints(
                RADAR_DIMENSIONS.map((_, i) => (i === index ? marker : null)),
                radius,
                center
              )[index];
              return (
                <g key={`average-${index}`}>
                  <rect
                    x={point.x - 4}
                    y={point.y - 4}
                    width={8}
                    height={8}
                    fill="#64748b"
                    transform={`rotate(45 ${point.x} ${point.y})`}
                  >
                    <title>{`League average ${RADAR_DIMENSIONS[index].fullLabel.toLowerCase()}: ${formatPoints(leagueAverage[index] ?? null)} points`}</title>
                  </rect>
                </g>
              );
            })}

            {/* Manager polygons */}
            {visibleManagers.map((manager) => {
              const managerIndex = managers.findIndex((m) => m.id === manager.id);
              const points = radarPolygonPoints(shown[managerIndex] ?? [], radius, center);
              const color = colorFor(manager, managerIndex);
              return (
                <g key={manager.id} data-series={manager.id}>
                  <polygon
                    points={polygonPointsAttr(points)}
                    fill={color}
                    fillOpacity={0.18}
                    stroke={color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                  {points.map((point, index) => (
                    <circle
                      key={`${manager.id}-${index}`}
                      cx={point.x}
                      cy={point.y}
                      r={activeDimension === index ? 5 : 3.5}
                      fill={color}
                      stroke="#ffffff"
                      strokeWidth={2}
                      onPointerEnter={() => setActiveDimension(index)}
                    >
                      <title>{`${manager.label} ${RADAR_DIMENSIONS[index].fullLabel.toLowerCase()}: ${formatPoints(manager.values[index])} points`}</title>
                    </circle>
                  ))}
                </g>
              );
            })}
          </svg>
        )}

        {activeDimension !== null && managers.length > 0 && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-72 max-w-[90%] rounded-2xl border border-slate-200 bg-white/95 backdrop-blur-sm px-3.5 py-2.5 text-xs shadow-xl"
            style={
              tooltipOnLeft
                ? { right: tooltipPoint ? width - tooltipPoint.x + 12 : 12 }
                : { left: tooltipPoint ? tooltipPoint.x + 12 : 12 }
            }
            aria-hidden="true"
          >
            <p className="mb-1 font-bold text-slate-900">{RADAR_DIMENSIONS[activeDimension].fullLabel}</p>
            <p className="mb-2 text-slate-500">{RADAR_DIMENSIONS[activeDimension].description}</p>
            {visibleManagers.map((manager) => {
              const value = manager.values[activeDimension] ?? null;
              const cohort = [...managers.map((m) => m.values[activeDimension] ?? null), leagueAverage[activeDimension] ?? null];
              const percentile = percentileRank(value, cohort, RADAR_DIMENSIONS[activeDimension].higherIsBetter);
              return (
                <p key={manager.id} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-slate-500 font-medium">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: colorFor(manager, managers.findIndex((m) => m.id === manager.id)) }}
                    />
                    {manager.label}
                  </span>
                  <span className="font-mono font-bold text-slate-900 tabular-nums">
                    {formatPoints(value)} pts
                    {percentile !== null ? ` · ${percentileLabel(percentile)} pct` : ""}
                  </span>
                </p>
              );
            })}
            <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-slate-500">
              League average: <span className="font-mono font-bold text-slate-900">{formatPoints(leagueAverage[activeDimension] ?? null)} pts</span>
            </p>
            <p className="mt-1 text-[11px] leading-snug text-slate-400">
              {visibleManagers.length > 0 &&
                percentileExplanation(
                  RADAR_DIMENSIONS[activeDimension],
                  visibleManagers[0].values[activeDimension] ?? null,
                  leagueAverage[activeDimension] ?? null,
                  percentileRank(
                    visibleManagers[0].values[activeDimension] ?? null,
                    [...managers.map((m) => m.values[activeDimension] ?? null), leagueAverage[activeDimension] ?? null],
                    RADAR_DIMENSIONS[activeDimension].higherIsBetter
                  ),
                  [...managers.map((m) => m.values[activeDimension] ?? null), leagueAverage[activeDimension] ?? null].filter(
                    (v) => v !== null
                  ).length
                )}
            </p>
          </div>
        )}

        <p className="sr-only" aria-live="polite">
          {activeDimension !== null ? describeDimension(activeDimension) : ""}
        </p>
      </div>

      <details className="group text-xs text-slate-500">
        <summary className="cursor-pointer select-none rounded font-bold text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-[#37003c]">
          View {title.toLowerCase()} as a table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-2xl border border-slate-200 shadow-sm">
          <table className="w-full text-left">
            <caption className="sr-only">
              {title} — {gameweekLabel}
            </caption>
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-500 uppercase text-[10px] font-bold tracking-wider">
              <tr>
                <th scope="col" className="px-4 py-2.5">
                  Dimension
                </th>
                {visibleManagers.map((manager) => (
                  <th key={manager.id} scope="col" className="px-4 py-2.5 text-right">
                    {manager.label}
                  </th>
                ))}
                <th scope="col" className="px-4 py-2.5 text-right">
                  League average
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {RADAR_DIMENSIONS.map((dimension, index) => (
                <tr key={dimension.id} className="hover:bg-slate-50 transition-colors">
                  <th scope="row" className="px-4 py-2 font-bold text-slate-800">
                    {dimension.fullLabel}
                  </th>
                  {visibleManagers.map((manager) => {
                    const value = manager.values[index] ?? null;
                    const cohort = [...managers.map((m) => m.values[index] ?? null), leagueAverage[index] ?? null];
                    const percentile = percentileRank(value, cohort, dimension.higherIsBetter);
                    return (
                      <td key={manager.id} className="px-4 py-2 text-right font-mono tabular-nums text-slate-700 font-medium">
                        {value === null ? "—" : `${formatPoints(value)} (${percentile === null ? "—" : `${percentileLabel(percentile)} pct`})`}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-700 font-medium">
                    {formatPoints(leagueAverage[index] ?? null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
};
