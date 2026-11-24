/**
 * Pure radar-chart geometry for the live gameweek comparison chart.
 *
 * Kept separate from the React component so normalization, polygon math,
 * scaling and percentile calculations can be unit tested without a DOM.
 * No charting library is used: the chart is plain SVG driven by these
 * helpers, so the only runtime dependency is the geometry in this file.
 */

import type { GameweekPerformance } from "../types";

/** How many managers can be compared on one radar canvas at once */
export const MAX_RADAR_MANAGERS = 4;

/** Distinct colour accents, one per compared manager (reuses the chart palette) */
export const RADAR_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500"] as const;

export type RadarDimensionId = "attack" | "defense" | "captain" | "bench" | "transfers" | "form";

export interface RadarDimension {
  id: RadarDimensionId;
  /** Short label drawn on the axis */
  label: string;
  /** Full label used in tooltips and the data table */
  fullLabel: string;
  /** Plain-language explanation shown in the tooltip */
  description: string;
  /** False when a smaller raw value is better (bench points, transfer hits) */
  higherIsBetter: boolean;
  /** Raw value for one gameweek entry; null when the entry has no data */
  valueOf: (entry: GameweekPerformance) => number | null;
}

/**
 * The six tactical dimensions, each mapped to a real field of
 * `GameweekPerformance` (GET /api/v1/analytics/me/performance).
 *
 * The backend exposes no per-position defensive split, so "defense" is the
 * starting XI's output without the captain multiplier (total points minus
 * captain points): how the squad performs on its own structure, independent
 * of the captain pick. "Form" is the rolling average, i.e. recent output
 * rather than a single gameweek spike.
 */
export const RADAR_DIMENSIONS: RadarDimension[] = [
  {
    id: "attack",
    label: "Attack",
    fullLabel: "Attack",
    description: "Total points scored this gameweek. Higher is better.",
    higherIsBetter: true,
    valueOf: (entry) => entry.points,
  },
  {
    id: "defense",
    label: "Defense",
    fullLabel: "Defense",
    description:
      "Starting XI points without the captain multiplier (total points minus captain points). Higher is better.",
    higherIsBetter: true,
    valueOf: (entry) => entry.points - entry.captainPoints,
  },
  {
    id: "captain",
    label: "Captain",
    fullLabel: "Captain effectiveness",
    description: "Points scored by the captain pick. Higher is better.",
    higherIsBetter: true,
    valueOf: (entry) => entry.captainPoints,
  },
  {
    id: "bench",
    label: "Bench",
    fullLabel: "Bench efficiency",
    description: "Points left on the bench. Lower is better: fewer wasted points.",
    higherIsBetter: false,
    valueOf: (entry) => entry.benchPoints,
  },
  {
    id: "transfers",
    label: "Transfers",
    fullLabel: "Transfer ROI",
    description: "Points lost to transfer hits. Lower is better: 0 means no hit was taken.",
    higherIsBetter: false,
    valueOf: (entry) => entry.transferCost,
  },
  {
    id: "form",
    label: "Form",
    fullLabel: "Recent form",
    description: "Rolling average points per gameweek. Higher is better.",
    higherIsBetter: true,
    valueOf: (entry) => entry.rollingAverage,
  },
];

export const RADAR_DIMENSION_COUNT = RADAR_DIMENSIONS.length;

export interface RadarPoint {
  x: number;
  y: number;
}

export interface RadarCenter {
  x: number;
  y: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Angle (radians) of an axis: first axis points straight up, then clockwise */
export function axisAngle(index: number, dimensionCount = RADAR_DIMENSION_COUNT): number {
  return -Math.PI / 2 + (index * 2 * Math.PI) / dimensionCount;
}

/**
 * Cartesian point for a normalized value (0 = centre, 1 = outer ring) on one
 * axis. A null value has no data and is plotted at the centre.
 */
export function radarPoint(
  value: number | null,
  index: number,
  radius: number,
  center: RadarCenter,
  dimensionCount = RADAR_DIMENSION_COUNT
): RadarPoint {
  const distance = value === null ? 0 : Math.max(0, Math.min(1, value)) * radius;
  const angle = axisAngle(index, dimensionCount);
  return { x: round2(center.x + distance * Math.cos(angle)), y: round2(center.y + distance * Math.sin(angle)) };
}

/** Outer end of an axis (used for the axis line and label placement) */
export function axisEndpoint(
  index: number,
  radius: number,
  center: RadarCenter,
  dimensionCount = RADAR_DIMENSION_COUNT
): RadarPoint {
  return radarPoint(1, index, radius, center, dimensionCount);
}

/** Vertices of a manager's polygon, one per dimension, in axis order */
export function radarPolygonPoints(
  values: Array<number | null>,
  radius: number,
  center: RadarCenter
): RadarPoint[] {
  return values.map((value, index) => radarPoint(value, index, radius, center));
}

/** "x,y x,y ..." attribute for an SVG <polygon> */
export function polygonPointsAttr(points: RadarPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(" ");
}

/** Vertices of one concentric grid ring at `level` (0..1) of the radius */
export function gridRingPoints(level: number, radius: number, center: RadarCenter): RadarPoint[] {
  return RADAR_DIMENSIONS.map((_, index) => radarPoint(level, index, radius, center));
}

/**
 * Min-max normalization of one dimension across the compared cohort
 * (managers plus the league average where it has a value). The best value in
 * the cohort maps to 1, the worst to 0; lower-is-better dimensions are
 * inverted so 1 always means "best in this comparison". Nulls stay null.
 * A cohort with no spread (everyone equal, or a single value) maps to 0.5,
 * the neutral middle ring, so equal managers draw identical mid-size shapes
 * instead of collapsing to the centre or exploding to the edge.
 */
export function normalizeDimension(
  values: Array<number | null>,
  higherIsBetter: boolean
): Array<number | null> {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return values.map(() => null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  if (max === min) return values.map((v) => (v === null ? null : 0.5));
  return values.map((v) => {
    if (v === null) return null;
    const scaled = (v - min) / (max - min);
    return higherIsBetter ? round2(scaled) : round2(1 - scaled);
  });
}

/**
 * Normalizes every dimension of every series in one pass. `series` is one
 * raw-value array per manager (length 6, in RADAR_DIMENSIONS order) and
 * `leagueAverage` is the same shape for the league average, when known.
 * The cohort for each dimension is the managers' values plus the league
 * average value, so the average always sits somewhere on the scale too.
 */
export function normalizeAllDimensions(
  series: Array<Array<number | null>>,
  leagueAverage: Array<number | null> = []
): Array<Array<number | null>> {
  return series.map((values, seriesIndex) =>
    values.map((_, dimensionIndex) => {
      const dimension = RADAR_DIMENSIONS[dimensionIndex];
      const cohort = [...series.map((s) => s[dimensionIndex] ?? null), leagueAverage[dimensionIndex] ?? null];
      return normalizeDimension(cohort, dimension.higherIsBetter)[seriesIndex];
    })
  );
}

/**
 * Percentile rank of `value` within `cohort` (the compared managers plus the
 * league average where it has a value): the percentage of the other cohort
 * values the manager beats, counting ties as half a win. 100 means best in
 * the comparison, 0 means worst, 50 means exactly at the middle. Direction
 * aware: for lower-is-better dimensions a smaller value ranks higher.
 * Returns null when the value is missing or there is nothing to compare
 * against (a cohort of one).
 */
export function percentileRank(
  value: number | null,
  cohort: Array<number | null>,
  higherIsBetter: boolean
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const others = cohort.filter((v): v is number => v !== null && Number.isFinite(v) && v !== value);
  // Other entries tied with this one (the manager's own value is in the cohort once)
  const equals = Math.max(0, cohort.filter((v) => v === value).length - 1);
  if (others.length + equals === 0) return null;
  const wins = others.filter((v) => (higherIsBetter ? value > v : value < v)).length;
  return Math.round(((wins + 0.5 * equals) / (others.length + equals)) * 100);
}

/** Ordinal suffix for a percentile: 75 -> "75th", 1 -> "1st" */
export function percentileLabel(percentile: number): string {
  const mod100 = percentile % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[percentile % 10] ?? "th";
  return `${percentile}${suffix}`;
}

/**
 * Plain-language explanation of a percentile for the tooltip: what was
 * compared, how many values were in the cohort, and where the manager sits.
 */
export function percentileExplanation(
  dimension: RadarDimension,
  value: number | null,
  leagueAverage: number | null,
  percentile: number | null,
  cohortSize: number
): string {
  if (value === null) return `${dimension.fullLabel}: no data for this gameweek.`;
  if (percentile === null || cohortSize < 2) {
    return (
      `${dimension.fullLabel}: ${value} points` +
      (leagueAverage === null ? ". No league average to compare against." : `; league average ${leagueAverage} points.`)
    );
  }
  const direction = dimension.higherIsBetter ? "higher is better" : "lower is better";
  const averagePart =
    leagueAverage === null
      ? "no league average is available for this dimension"
      : `the league average is ${leagueAverage} points`;
  return (
    `${dimension.fullLabel}: ${value} points, ${percentileLabel(percentile)} percentile ` +
    `among the ${cohortSize} values compared (${direction}; ${averagePart}). ` +
    `That means this manager beats about ${percentile}% of the compared values on ${dimension.fullLabel.toLowerCase()}.`
  );
}

/**
 * Linear interpolation between two normalized value sets, for the animated
 * transition when the gameweek filter changes. `t` goes 0 (from) to 1 (to).
 * Nulls stay null on both sides; a value appearing or disappearing fades
 * from/to the centre (0).
 */
export function interpolateNormalized(
  from: Array<number | null>,
  to: Array<number | null>,
  t: number
): Array<number | null> {
  const clamped = Math.max(0, Math.min(1, t));
  return to.map((target, i) => {
    const start = from[i] ?? 0;
    const end = target ?? 0;
    if (from[i] === null && target === null) return null;
    return round2(start + (end - start) * clamped);
  });
}

/**
 * Toggle a manager on/off the comparison canvas. Adding is refused (the
 * selection is returned unchanged) once MAX_RADAR_MANAGERS are selected.
 */
export function toggleManagerIds(selectedIds: string[], id: string, max = MAX_RADAR_MANAGERS): string[] {
  if (selectedIds.includes(id)) return selectedIds.filter((selected) => selected !== id);
  if (selectedIds.length >= max) return selectedIds;
  return [...selectedIds, id];
}

/** Average of a numeric field across entries, skipping missing values; null when there are none */
function averageField(
  entries: GameweekPerformance[],
  pick: (entry: GameweekPerformance) => number | null
): number | null {
  const values = entries.map(pick).filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length === 0) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Raw six-dimension values for one manager from their per-gameweek history.
 * With `gameweekId` it uses that single gameweek; without it (an "all
 * gameweeks" filter) it averages each field across the entries given.
 * Returns all nulls when the manager has no history for the selection.
 */
export function managerRadarValues(
  entries: GameweekPerformance[],
  gameweekId: number | null = null
): Array<number | null> {
  const selected =
    gameweekId === null ? entries : entries.filter((entry) => entry.gameweekId === gameweekId);
  if (selected.length === 0) return RADAR_DIMENSIONS.map(() => null);
  if (gameweekId !== null) {
    const entry = selected[0];
    return RADAR_DIMENSIONS.map((dimension) => dimension.valueOf(entry));
  }
  return RADAR_DIMENSIONS.map((dimension) => averageField(selected, dimension.valueOf));
}

/**
 * Raw six-dimension values for the league average from one gameweek entry.
 * Only attack and form have a league figure in the API (both derive from
 * `averagePoints`: the league's mean score, which is also its rolling
 * average over recent gameweeks). The other dimensions have no league
 * average published, so they stay null and are left off the average markers
 * rather than invented.
 */
export function leagueAverageRadarValues(entry: GameweekPerformance | null): Array<number | null> {
  if (entry === null) return RADAR_DIMENSIONS.map(() => null);
  return RADAR_DIMENSIONS.map((dimension) => {
    if (dimension.id === "attack" || dimension.id === "form") return entry.averagePoints;
    return null;
  });
}
