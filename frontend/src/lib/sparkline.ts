/**
 * Framework-free sparkline geometry for player form trends.
 *
 * Kept separate from the React component so coordinate generation, trend
 * analysis and tooltip text can be unit tested without a DOM. The chart
 * itself is pure SVG: no charting dependency is introduced.
 */

import { buildLinePath, linearScale } from "./chart";
import type { Fixture } from "@/types";

/** One gameweek of a player's recent form, oldest first. */
export interface FormTrendPoint {
  gameweekId: number;
  /** FPL gameweek number shown in tooltips; null when the gameweek is unknown. */
  gameweekNumber: number | null;
  gameweekName: string;
  points: number;
  /** e.g. "vs ARS" (home) or "@ CHE" (away); null when the fixture is unknown. */
  opponent: string | null;
}

export interface SparklineCoordinate {
  x: number;
  y: number;
}

export type FormTrendDirection = "up" | "down" | "flat";

export interface FormTrendSummary {
  direction: FormTrendDirection;
  /** Last gameweek points minus first gameweek points in the window. */
  delta: number;
  /** Points summed across the window. */
  totalPoints: number;
  /** Points in the most recent gameweek, or null when there is no data. */
  lastPoints: number | null;
}

/** The issue asks for the last 5 gameweeks. */
export const MAX_SPARKLINE_GAMEWEEKS = 5;

/** Fallback drawing size before the container width is measured. */
export const SPARKLINE_WIDTH = 200;
export const SPARKLINE_HEIGHT = 56;

const PADDING_X = 6;
const PADDING_Y = 8;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Maps point values onto SVG coordinates inside a `width` x `height` box.
 *
 * - x is evenly spaced across the width (a single point is centred).
 * - y scales to the value range: the largest value sits at the top, the
 *   smallest at the bottom. The range always includes the observed min and
 *   max, so negative points work and the line uses the full height.
 * - All-equal values (including a single point) draw a flat line at the
 *   vertical middle instead of dividing by zero.
 * - Every coordinate is finite and stays inside the box.
 */
export function computeSparklineCoordinates(
  values: number[],
  width: number = SPARKLINE_WIDTH,
  height: number = SPARKLINE_HEIGHT
): SparklineCoordinate[] {
  if (values.length === 0 || width <= 0 || height <= 0) return [];

  const xScale =
    values.length === 1
      ? () => width / 2
      : linearScale([0, values.length - 1], [PADDING_X, width - PADDING_X]);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const yScale =
    min === max
      ? () => height / 2
      : linearScale([min, max], [height - PADDING_Y, PADDING_Y]);

  return values.map((value, index) => ({
    x: round2(xScale(index)),
    y: round2(yScale(value)),
  }));
}

/** SVG path for the sparkline line through `coordinates` ("" when empty). */
export function buildSparklinePath(coordinates: SparklineCoordinate[]): string {
  return buildLinePath(coordinates);
}

/**
 * Trend across the window: the most recent points minus the oldest points.
 * Positive is "up", negative is "down", zero is "flat".
 */
export function analyseFormTrend(points: FormTrendPoint[]): FormTrendSummary {
  if (points.length === 0) {
    return { direction: "flat", delta: 0, totalPoints: 0, lastPoints: null };
  }
  const first = points[0].points;
  const last = points[points.length - 1].points;
  const delta = last - first;
  return {
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    delta,
    totalPoints: points.reduce((sum, point) => sum + point.points, 0),
    lastPoints: last,
  };
}

/** Per-gameweek stat as returned by GET /api/v1/players/:id (gameweek included). */
export interface PlayerGameweekStatInput {
  gameweekId: number;
  totalPoints: number;
  gameweek?: {
    id: number;
    fplId: number;
    name: string;
  } | null;
}

/**
 * Builds the sparkline window from a player's gameweek stats: the most
 * recent `MAX_SPARKLINE_GAMEWEEKS` gameweeks, oldest first. Stats with a
 * non-finite points value are dropped; missing gameweek details fall back to
 * the gameweek id so the point still renders.
 */
export function toFormTrendPoints(
  stats: PlayerGameweekStatInput[],
  opponentByGameweekId: ReadonlyMap<number, string> = new Map()
): FormTrendPoint[] {
  const usable = stats.filter((stat) => Number.isFinite(stat.totalPoints));
  const sorted = [...usable].sort((a, b) => a.gameweekId - b.gameweekId);
  const window = sorted.slice(-MAX_SPARKLINE_GAMEWEEKS);
  return window.map((stat) => ({
    gameweekId: stat.gameweekId,
    gameweekNumber: stat.gameweek?.fplId ?? null,
    gameweekName: stat.gameweek?.name ?? `Gameweek ${stat.gameweekId}`,
    points: stat.totalPoints,
    opponent: opponentByGameweekId.get(stat.gameweekId) ?? null,
  }));
}

/**
 * Maps each gameweek to the opponent a team faced, from the fixtures list.
 * Home fixtures read "vs ARS", away fixtures read "@ CHE". Fixtures without
 * a gameweek, without the team, or without a known opponent short name are
 * skipped so the tooltip falls back gracefully instead of showing garbage.
 */
export function opponentByGameweekId(
  fixtures: Fixture[],
  teamId: number
): Map<number, string> {
  const byGameweek = new Map<number, string>();
  for (const fixture of fixtures) {
    if (fixture.gameweekId === null || byGameweek.has(fixture.gameweekId)) continue;
    if (fixture.homeTeamId === teamId) {
      const shortName = fixture.awayTeam?.shortName;
      if (shortName) byGameweek.set(fixture.gameweekId, `vs ${shortName}`);
    } else if (fixture.awayTeamId === teamId) {
      const shortName = fixture.homeTeam?.shortName;
      if (shortName) byGameweek.set(fixture.gameweekId, `@ ${shortName}`);
    }
  }
  return byGameweek;
}

/**
 * Tooltip text for one sparkline point: gameweek number and opponent when
 * known, always with the points earned. Examples: "GW12 vs ARS · 8 pts",
 * "GW12 · 8 pts", "Gameweek 3 · 2 pts".
 */
export function formatSparklineTooltip(point: FormTrendPoint): string {
  const gameweekLabel =
    point.gameweekNumber !== null ? `GW${point.gameweekNumber}` : point.gameweekName;
  const opponent = point.opponent ? ` ${point.opponent}` : "";
  return `${gameweekLabel}${opponent} · ${point.points} pts`;
}
