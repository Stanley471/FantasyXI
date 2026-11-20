"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import {
  analyseFormTrend,
  buildSparklinePath,
  computeSparklineCoordinates,
  formatSparklineTooltip,
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  type FormTrendPoint,
} from "@/lib/sparkline";
import { IconChevronDown, IconChevronUp } from "@/components/ui/Icons";

export interface PlayerFormSparklineProps {
  /** Last-5-gameweeks form, oldest first. Empty while loading or with no data. */
  points: FormTrendPoint[];
  /** Shows a skeleton in the same fixed-height space while data loads. */
  loading?: boolean;
  className?: string;
}

const DEFAULT_WIDTH = SPARKLINE_WIDTH;
const CHART_HEIGHT = SPARKLINE_HEIGHT;

/** Tracks the rendered width of an element so the SVG is drawn at 1:1 scale. */
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

const TREND_STYLES = {
  up: {
    line: "#059669",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    label: "Improving",
  },
  down: {
    line: "#e11d48",
    badge: "bg-rose-50 text-rose-700 border-rose-200",
    label: "Declining",
  },
  flat: {
    line: "#64748b",
    badge: "bg-slate-100 text-slate-600 border-slate-200",
    label: "Steady",
  },
} as const;

/**
 * Mini form-trend sparkline for the Player Details modal.
 *
 * - Pure SVG line + dots, no charting dependency.
 * - The section is a fixed height in every state (loading skeleton, empty
 *   state, data) so the modal never shifts when the trend loads.
 * - Each dot carries a native SVG tooltip (`<title>`) and a hover/focus
 *   tooltip showing gameweek number, opponent and points earned.
 * - The header shows the trend direction, the points swing across the
 *   window, and the total points earned in the window.
 */
export const PlayerFormSparkline: React.FC<PlayerFormSparklineProps> = ({
  points,
  loading = false,
  className = "",
}) => {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const titleId = useId();

  const trend = analyseFormTrend(points);
  const style = TREND_STYLES[trend.direction];
  const coordinates = computeSparklineCoordinates(
    points.map((point) => point.points),
    width,
    CHART_HEIGHT
  );
  const linePath = buildSparklinePath(coordinates);
  const areaPath =
    coordinates.length > 1
      ? `${linePath} L${coordinates[coordinates.length - 1].x},${CHART_HEIGHT} L${coordinates[0].x},${CHART_HEIGHT} Z`
      : "";

  const summary =
    points.length === 0
      ? "No recent gameweek data"
      : `Form over the last ${points.length} gameweeks: ${points
          .map((point) => `${formatSparklineTooltip(point)}`)
          .join("; ")}. Total ${trend.totalPoints} points, trend ${style.label.toLowerCase()}.`;

  const trendSign = trend.delta > 0 ? `+${trend.delta}` : `${trend.delta}`;
  const activePoint = activeIndex !== null ? points[activeIndex] : null;
  const activeCoordinate = activeIndex !== null ? coordinates[activeIndex] : null;

  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-2xl border border-slate-200/80 bg-slate-50/70 px-3 py-2.5 ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={titleId} className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Form &middot; last {points.length > 0 ? points.length : 5} gameweeks
        </h3>
        {!loading && points.length > 0 && (
          <span
            data-testid="form-trend-badge"
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${style.badge}`}
          >
            {trend.direction === "up" ? (
              <IconChevronUp className="w-3 h-3" />
            ) : trend.direction === "down" ? (
              <IconChevronDown className="w-3 h-3" />
            ) : (
              <span aria-hidden="true">&mdash;</span>
            )}
            {style.label} {trendSign} &middot; {trend.totalPoints} pts
          </span>
        )}
      </div>

      {/* Fixed-height chart area: identical in loading, empty and data states. */}
      <div className="relative mt-2 h-14">
        {loading ? (
          <div
            data-testid="form-sparkline-loading"
            className="h-14 w-full animate-pulse rounded-xl bg-slate-200/70"
            aria-label="Loading form trend"
          />
        ) : points.length === 0 ? (
          <div
            data-testid="form-sparkline-empty"
            className="flex h-14 w-full items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white/60 px-3 text-center text-[11px] font-medium text-slate-400"
          >
            No recent gameweek data yet
          </div>
        ) : (
          <div ref={containerRef} className="relative h-14 w-full">
            <svg
              viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
              width={width}
              height={CHART_HEIGHT}
              className="h-14 w-full overflow-visible"
              role="img"
              aria-label={summary}
              data-testid="form-sparkline-svg"
            >
              {areaPath && (
                <path d={areaPath} fill={style.line} fillOpacity={0.08} stroke="none" />
              )}
              <path
                d={linePath}
                fill="none"
                stroke={style.line}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {coordinates.map((coordinate, index) => (
                <circle
                  key={points[index].gameweekId}
                  cx={coordinate.x}
                  cy={coordinate.y}
                  r={activeIndex === index ? 4.5 : 3.5}
                  fill="#ffffff"
                  stroke={style.line}
                  strokeWidth={2}
                  tabIndex={0}
                  aria-label={formatSparklineTooltip(points[index])}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseLeave={() => setActiveIndex(null)}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                >
                  <title>{formatSparklineTooltip(points[index])}</title>
                </circle>
              ))}
            </svg>
            {activePoint && activeCoordinate && (
              <div
                data-testid="form-sparkline-tooltip"
                className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-slate-900 px-2 py-1 text-[10px] font-bold text-white shadow-lg"
                style={{ left: `${(activeCoordinate.x / width) * 100}%` }}
              >
                {formatSparklineTooltip(activePoint)}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
