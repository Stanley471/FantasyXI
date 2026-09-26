import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { ChipType } from "../../types/index.js";

/**
 * Historical Performance Analytics.
 *
 * Aggregates a squad's settled SquadGameweekScore rows into a season timeline
 * (per-gameweek, cumulative and rolling points) benchmarked against the average
 * and highest score of every squad on the platform in the same gameweek.
 *
 * Laravel equivalent: a dedicated reporting service (app/Services/Analytics)
 * that builds a dashboard DTO from Eloquent aggregate queries.
 */

/** Number of gameweeks in the rolling average line */
export const ROLLING_WINDOW = 3;
/** Number of most recent gameweeks that make up "form" */
export const FORM_WINDOW = 5;

export interface GameweekScoreInput {
  gameweekId: number;
  gameweekFplId: number;
  gameweekName: string;
  deadline: Date;
  points: number;
  benchPoints: number;
  captainPoints: number;
  transferCost: number;
}

export interface GameweekBenchmark {
  gameweekId: number;
  averagePoints: number;
  highestPoints: number;
}

export interface ChipPlayed {
  chipType: ChipType;
  gameweekId: number;
  gameweekName: string;
}

export interface GameweekPerformance {
  gameweekId: number;
  gameweekFplId: number;
  gameweekName: string;
  deadline: string;
  points: number;
  benchPoints: number;
  captainPoints: number;
  transferCost: number;
  cumulativePoints: number;
  rollingAverage: number;
  averagePoints: number | null;
  cumulativeAveragePoints: number | null;
  highestPoints: number | null;
  differenceVsAverage: number | null;
  chip: ChipType | null;
}

export interface PerformanceSummary {
  gameweeksPlayed: number;
  totalPoints: number;
  averagePoints: number;
  medianPoints: number;
  standardDeviation: number;
  bestGameweek: { gameweekId: number; gameweekName: string; points: number } | null;
  worstGameweek: { gameweekId: number; gameweekName: string; points: number } | null;
  recentForm: number;
  gameweeksAboveAverage: number;
  totalBenchPoints: number;
  totalCaptainPoints: number;
  totalTransferCost: number;
  /** Share of total points earned through captaincy bonus, as a percentage */
  captainShare: number;
}

export interface PerformanceAnalytics {
  summary: PerformanceSummary;
  history: GameweekPerformance[];
  chips: ChipPlayed[];
}

export class AnalyticsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsNotFoundError";
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - avg) ** 2)));
}

/**
 * Pure aggregation of a squad's gameweek scores. Gameweeks are ordered by their
 * FPL round number; benchmarks missing for a gameweek are reported as null.
 */
export function buildPerformanceAnalytics(
  scores: GameweekScoreInput[],
  benchmarks: GameweekBenchmark[] = [],
  chips: ChipPlayed[] = []
): PerformanceAnalytics {
  const ordered = [...scores].sort((a, b) => a.gameweekFplId - b.gameweekFplId);
  const benchmarkByGameweek = new Map(benchmarks.map((b) => [b.gameweekId, b]));
  const chipByGameweek = new Map(chips.map((c) => [c.gameweekId, c.chipType]));

  let cumulativePoints = 0;
  let cumulativeAverage = 0;
  let benchmarkComplete = true;

  const history: GameweekPerformance[] = ordered.map((score, index) => {
    cumulativePoints += score.points;
    const window = ordered.slice(Math.max(0, index - ROLLING_WINDOW + 1), index + 1);
    const benchmark = benchmarkByGameweek.get(score.gameweekId);

    // A missing benchmark breaks the cumulative comparison from that point on
    if (benchmark && benchmarkComplete) {
      cumulativeAverage += benchmark.averagePoints;
    } else {
      benchmarkComplete = false;
    }

    return {
      gameweekId: score.gameweekId,
      gameweekFplId: score.gameweekFplId,
      gameweekName: score.gameweekName,
      deadline: score.deadline.toISOString(),
      points: score.points,
      benchPoints: score.benchPoints,
      captainPoints: score.captainPoints,
      transferCost: score.transferCost,
      cumulativePoints,
      rollingAverage: round1(mean(window.map((w) => w.points))),
      averagePoints: benchmark ? round1(benchmark.averagePoints) : null,
      cumulativeAveragePoints: benchmarkComplete ? round1(cumulativeAverage) : null,
      highestPoints: benchmark ? benchmark.highestPoints : null,
      differenceVsAverage: benchmark ? round1(score.points - benchmark.averagePoints) : null,
      chip: chipByGameweek.get(score.gameweekId) ?? null,
    };
  });

  const points = history.map((h) => h.points);
  const best = history.reduce<GameweekPerformance | null>(
    (top, h) => (top === null || h.points > top.points ? h : top),
    null
  );
  const worst = history.reduce<GameweekPerformance | null>(
    (low, h) => (low === null || h.points < low.points ? h : low),
    null
  );
  const totalCaptainPoints = history.reduce((sum, h) => sum + h.captainPoints, 0);
  const pick = (h: GameweekPerformance | null) =>
    h ? { gameweekId: h.gameweekId, gameweekName: h.gameweekName, points: h.points } : null;

  return {
    summary: {
      gameweeksPlayed: history.length,
      totalPoints: cumulativePoints,
      averagePoints: round1(mean(points)),
      medianPoints: round1(median(points)),
      standardDeviation: round1(standardDeviation(points)),
      bestGameweek: pick(best),
      worstGameweek: pick(worst),
      recentForm: round1(mean(points.slice(-FORM_WINDOW))),
      gameweeksAboveAverage: history.filter(
        (h) => h.differenceVsAverage !== null && h.differenceVsAverage > 0
      ).length,
      totalBenchPoints: history.reduce((sum, h) => sum + h.benchPoints, 0),
      totalCaptainPoints,
      totalTransferCost: history.reduce((sum, h) => sum + h.transferCost, 0),
      captainShare:
        cumulativePoints > 0 ? round1((totalCaptainPoints / cumulativePoints) * 100) : 0,
    },
    history,
    chips: [...chips].sort(
      (a, b) =>
        ordered.findIndex((s) => s.gameweekId === a.gameweekId) -
        ordered.findIndex((s) => s.gameweekId === b.gameweekId)
    ),
  };
}

export class AnalyticsService {
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Historical performance of one of the user's squads (their first squad by default).
   * A squadId that the user does not own is reported as not found.
   */
  public async getUserPerformance(
    userId: string,
    squadId?: string
  ): Promise<
    PerformanceAnalytics & {
      squads: Array<{ id: string; name: string }>;
      squadId: string | null;
    }
  > {
    const squads = await this.db.squad.findMany({
      where: { userId },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    });

    const selected = squadId ? squads.find((s) => s.id === squadId) : squads[0];
    if (squadId && !selected) {
      throw new AnalyticsNotFoundError("Squad not found");
    }
    if (!selected) {
      return { squads, squadId: null, ...buildPerformanceAnalytics([]) };
    }

    const [scores, chipUsages] = await Promise.all([
      this.db.squadGameweekScore.findMany({
        where: { squadId: selected.id },
        include: { gameweek: { select: { fplId: true, name: true, deadline: true } } },
      }),
      this.db.squadChipUsage.findMany({
        where: { squadId: selected.id },
        include: { gameweek: { select: { name: true } } },
      }),
    ]);

    const gameweekIds = scores.map((s) => s.gameweekId);
    const benchmarks =
      gameweekIds.length === 0
        ? []
        : await this.db.squadGameweekScore.groupBy({
            by: ["gameweekId"],
            where: { gameweekId: { in: gameweekIds } },
            _avg: { points: true },
            _max: { points: true },
          });

    const analytics = buildPerformanceAnalytics(
      scores.map((s) => ({
        gameweekId: s.gameweekId,
        gameweekFplId: s.gameweek.fplId,
        gameweekName: s.gameweek.name,
        deadline: s.gameweek.deadline,
        points: s.points,
        benchPoints: s.benchPoints,
        captainPoints: s.captainPoints,
        transferCost: s.transferCost,
      })),
      benchmarks.map((b) => ({
        gameweekId: b.gameweekId,
        averagePoints: b._avg.points ?? 0,
        highestPoints: b._max.points ?? 0,
      })),
      chipUsages.map((c) => ({
        chipType: c.chipType as ChipType,
        gameweekId: c.gameweekId,
        gameweekName: c.gameweek.name,
      }))
    );

    return { squads, squadId: selected.id, ...analytics };
  }
}

export const analyticsService = new AnalyticsService();
