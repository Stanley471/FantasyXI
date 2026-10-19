import { prisma } from "../../config/db.js";
import { getRedisClient, type IRedisCacheClient } from "../../config/redis.js";
import { Position } from "../../types/index.js";

/**
 * Team strength profile used for Fixture Difficulty Rating (FDR) and xP calculations.
 * Matches FPL normalized team ratings (typically ~1000 to 1350 scale, or 1–5 strength tier).
 */
export interface TeamStrengthProfile {
  id: number;
  name?: string;
  shortName?: string;
  strength?: number | null;
  strengthOverallHome?: number | null;
  strengthOverallAway?: number | null;
  strengthAttackHome?: number | null;
  strengthAttackAway?: number | null;
  strengthDefenceHome?: number | null;
  strengthDefenceAway?: number | null;
}

export interface PlayerRecentMatchStat {
  gameweekId: number;
  minutes: number;
  totalPoints: number;
  goals?: number;
  assists?: number;
  cleanSheet?: boolean;
  saves?: number;
  bonus?: number;
}

export interface UpcomingFixtureContext {
  fixtureId?: number | null;
  gameweekId?: number | null;
  isHome: boolean;
  playerTeam: TeamStrengthProfile;
  opponentTeam: TeamStrengthProfile;
}

export interface PlayerPredictionInput {
  playerId: number;
  displayName: string;
  position: Position | "GKP" | "DEF" | "MID" | "FWD";
  price: number;
  form?: number | null;
  totalPoints?: number;
  minutesPlayed?: number;
  status?: string | null;
  chanceOfPlayingNextRound?: number | null;
  isAvailable?: boolean;
  recentStats: PlayerRecentMatchStat[];
  upcomingFixture?: UpcomingFixtureContext | null;
}

export interface FixtureDifficultyResult {
  /** Integer rating on the official 1 (Very Easy) to 5 (Very Hard) scale */
  fdr: 1 | 2 | 3 | 4 | 5;
  /** Continuous composite difficulty score (1.00 to 5.00) */
  rawDifficultyScore: number;
  /** Opponent attacking threat index (normalized around 1.0) */
  opponentAttackIndex: number;
  /** Opponent defensive solidity index (normalized around 1.0) */
  opponentDefenceIndex: number;
  /** Relative team strength differential (opponent - playerTeam) */
  strengthDelta: number;
  isHome: boolean;
}

export interface PlayerAnalyticsPrediction {
  playerId: number;
  displayName: string;
  position: string;
  price: number;
  expectedPoints: number;
  fdr: 1 | 2 | 3 | 4 | 5;
  fixtureDifficulty: FixtureDifficultyResult;
  breakdown: {
    weightedRollingForm: number;
    minutesProbability: number;
    positionMultiplier: number;
    homeAwayMultiplier: number;
    opponentDifficultyMultiplier: number;
    appearanceExpectedPoints: number;
    attackingExpectedPoints: number;
    defensiveExpectedPoints: number;
  };
  upcomingOpponent: {
    teamId: number;
    name: string;
    shortName: string;
    isHome: boolean;
    gameweekId: number | null;
  } | null;
  generatedAt: string;
}

const DEFAULT_STRENGTH_BASELINE = 1150;
const ANALYTICS_CACHE_TTL_SECONDS = 300;
const ANALYTICS_CACHE_PREFIX = "player:analytics:v1";

/**
 * Recency weights for the rolling 5-match window (most recent match has the highest weight).
 */
export const ROLLING_5_MATCH_WEIGHTS = [0.32, 0.25, 0.19, 0.14, 0.10] as const;

/**
 * Position-specific multipliers reflecting ceiling and point-scoring avenues in FPL.
 */
const POSITION_MULTIPLIERS: Record<string, number> = {
  GKP: 0.92,
  DEF: 0.98,
  MID: 1.08,
  FWD: 1.14,
};

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function normalizeTeamMetric(raw: number | null | undefined, fallbackTier?: number | null): number {
  if (typeof raw === "number" && raw > 100) {
    return raw;
  }
  if (typeof raw === "number" && raw >= 1 && raw <= 5) {
    return 950 + raw * 90;
  }
  if (typeof fallbackTier === "number" && fallbackTier >= 1 && fallbackTier <= 5) {
    return 950 + fallbackTier * 90;
  }
  return DEFAULT_STRENGTH_BASELINE;
}

/**
 * Player Analytics Engine.
 *
 * Computes Fixture Difficulty Ratings (FDR 1–5) and Expected Points (xP) for upcoming
 * gameweeks, backed by Redis caching (with automatic in-memory fallback).
 */
export class PlayerAnalyticsEngine {
  private readonly memoryCache = new Map<string, { expiresAt: number; value: PlayerAnalyticsPrediction }>();

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = prisma,
    private readonly redisClient?: IRedisCacheClient | null
  ) {}

  private getCacheClient(): IRedisCacheClient | null {
    if (this.redisClient !== undefined) {
      return this.redisClient;
    }
    return getRedisClient();
  }

  public clearCache(): void {
    this.memoryCache.clear();
  }

  /**
   * Computes the Fixture Difficulty Rating (FDR) on a 1 to 5 scale incorporating
   * both home/away team offensive and defensive strengths.
   */
  public calculateFixtureDifficulty(context: UpcomingFixtureContext): FixtureDifficultyResult {
    const { isHome, playerTeam, opponentTeam } = context;

    // When player is at home, opponent plays AWAY (use opponent's away attack/defence strengths)
    const oppAttack = normalizeTeamMetric(
      isHome ? opponentTeam.strengthAttackAway : opponentTeam.strengthAttackHome,
      opponentTeam.strength
    );
    const oppDefence = normalizeTeamMetric(
      isHome ? opponentTeam.strengthDefenceAway : opponentTeam.strengthDefenceHome,
      opponentTeam.strength
    );
    const oppOverall = normalizeTeamMetric(
      isHome ? opponentTeam.strengthOverallAway : opponentTeam.strengthOverallHome,
      opponentTeam.strength
    );

    const ownAttack = normalizeTeamMetric(
      isHome ? playerTeam.strengthAttackHome : playerTeam.strengthAttackAway,
      playerTeam.strength
    );
    const ownDefence = normalizeTeamMetric(
      isHome ? playerTeam.strengthDefenceHome : playerTeam.strengthDefenceAway,
      playerTeam.strength
    );
    const ownOverall = normalizeTeamMetric(
      isHome ? playerTeam.strengthOverallHome : playerTeam.strengthOverallAway,
      playerTeam.strength
    );

    const opponentComposite = oppAttack * 0.4 + oppDefence * 0.4 + oppOverall * 0.2;
    const playerTeamComposite = ownAttack * 0.4 + ownDefence * 0.4 + ownOverall * 0.2;

    // Venue adjustment: away fixtures are inherently ~55 strength points harder
    const venueDifficultyAdjustment = isHome ? -35 : 40;
    const strengthDelta = opponentComposite - playerTeamComposite + venueDifficultyAdjustment;

    // Map composite opponent strength + relative delta onto continuous [1.0, 5.0] scale
    const absoluteComponent = (opponentComposite - DEFAULT_STRENGTH_BASELINE) / 95;
    const relativeComponent = strengthDelta / 160;
    const rawDifficultyScore = round2(clamp(3.0 + absoluteComponent * 0.65 + relativeComponent * 0.55, 1.0, 5.0));

    let fdr: 1 | 2 | 3 | 4 | 5;
    if (rawDifficultyScore < 1.85) {
      fdr = 1;
    } else if (rawDifficultyScore < 2.65) {
      fdr = 2;
    } else if (rawDifficultyScore < 3.45) {
      fdr = 3;
    } else if (rawDifficultyScore < 4.2) {
      fdr = 4;
    } else {
      fdr = 5;
    }

    return {
      fdr,
      rawDifficultyScore,
      opponentAttackIndex: round2(oppAttack / DEFAULT_STRENGTH_BASELINE),
      opponentDefenceIndex: round2(oppDefence / DEFAULT_STRENGTH_BASELINE),
      strengthDelta: round2(strengthDelta),
      isHome,
    };
  }

  /**
   * Computes recency-weighted rolling 5-match form from recent gameweek performances.
   */
  public calculateWeightedRollingForm(
    recentStats: PlayerRecentMatchStat[],
    reportedForm?: number | null
  ): number {
    const sorted = [...recentStats]
      .sort((a, b) => b.gameweekId - a.gameweekId)
      .slice(0, 5);

    if (sorted.length === 0) {
      return typeof reportedForm === "number" && !Number.isNaN(reportedForm)
        ? Math.max(0, reportedForm)
        : 2.5;
    }

    let weightedSum = 0;
    let totalWeight = 0;

    sorted.forEach((match, idx) => {
      const weight = ROLLING_5_MATCH_WEIGHTS[idx] ?? 0.1;
      const underlyingBonus =
        (match.goals ?? 0) * 0.35 +
        (match.assists ?? 0) * 0.25 +
        (match.cleanSheet ? 0.2 : 0) +
        (match.bonus ?? 0) * 0.15;
      const effectiveMatchScore = match.totalPoints + underlyingBonus;
      weightedSum += effectiveMatchScore * weight;
      totalWeight += weight;
    });

    const rollingScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    if (typeof reportedForm === "number" && !Number.isNaN(reportedForm) && reportedForm > 0) {
      return round2(rollingScore * 0.75 + reportedForm * 0.25);
    }

    return round2(rollingScore);
  }

  /**
   * Estimates the probability [0, 1] of a player playing meaningful minutes in the next round.
   */
  public calculateMinutesProbability(input: {
    status?: string | null;
    chanceOfPlayingNextRound?: number | null;
    isAvailable?: boolean;
    recentStats: PlayerRecentMatchStat[];
    minutesPlayed?: number;
  }): number {
    if (input.isAvailable === false) {
      return 0;
    }
    const status = (input.status ?? "a").toLowerCase();
    if (status === "i" || status === "s" || status === "u" || status === "n") {
      if (input.chanceOfPlayingNextRound === 0 || input.chanceOfPlayingNextRound == null) {
        return 0;
      }
    }
    if (input.chanceOfPlayingNextRound !== null && input.chanceOfPlayingNextRound !== undefined) {
      if (input.chanceOfPlayingNextRound <= 0) {
        return 0;
      }
    }

    const availabilityFactor =
      input.chanceOfPlayingNextRound !== null && input.chanceOfPlayingNextRound !== undefined
        ? clamp(input.chanceOfPlayingNextRound / 100, 0, 1)
        : status === "d"
        ? 0.5
        : 1.0;

    const recent = [...input.recentStats]
      .sort((a, b) => b.gameweekId - a.gameweekId)
      .slice(0, 5);

    let minutesRatio = 0.85;
    if (recent.length > 0) {
      const avgMinutes = recent.reduce((sum, r) => sum + clamp(r.minutes, 0, 90), 0) / recent.length;
      minutesRatio = clamp(avgMinutes / 90, 0.15, 1.0);
    } else if (typeof input.minutesPlayed === "number") {
      minutesRatio = input.minutesPlayed > 0 ? clamp(input.minutesPlayed / 900, 0.3, 0.95) : 0.25;
    }

    return round2(clamp(availabilityFactor * (0.3 + 0.7 * minutesRatio), 0, 1));
  }

  /**
   * Calculates Expected Points (xP) and Fixture Difficulty Rating (FDR) for a player.
   */
  public predictPlayerAnalytics(input: PlayerPredictionInput): PlayerAnalyticsPrediction {
    const defaultTeam: TeamStrengthProfile = {
      id: 0,
      name: "League Average",
      shortName: "AVG",
      strength: 3,
      strengthAttackHome: DEFAULT_STRENGTH_BASELINE,
      strengthAttackAway: DEFAULT_STRENGTH_BASELINE,
      strengthDefenceHome: DEFAULT_STRENGTH_BASELINE,
      strengthDefenceAway: DEFAULT_STRENGTH_BASELINE,
      strengthOverallHome: DEFAULT_STRENGTH_BASELINE,
      strengthOverallAway: DEFAULT_STRENGTH_BASELINE,
    };

    const fixtureContext: UpcomingFixtureContext = input.upcomingFixture ?? {
      isHome: true,
      playerTeam: defaultTeam,
      opponentTeam: defaultTeam,
    };

    const fixtureDifficulty = this.calculateFixtureDifficulty(fixtureContext);
    const weightedRollingForm = this.calculateWeightedRollingForm(input.recentStats, input.form);
    const minutesProbability = this.calculateMinutesProbability({
      status: input.status,
      chanceOfPlayingNextRound: input.chanceOfPlayingNextRound,
      isAvailable: input.isAvailable,
      recentStats: input.recentStats,
      minutesPlayed: input.minutesPlayed,
    });

    if (minutesProbability <= 0) {
      return {
        playerId: input.playerId,
        displayName: input.displayName,
        position: input.position,
        price: input.price,
        expectedPoints: 0,
        fdr: fixtureDifficulty.fdr,
        fixtureDifficulty,
        breakdown: {
          weightedRollingForm,
          minutesProbability: 0,
          positionMultiplier: POSITION_MULTIPLIERS[input.position] ?? 1.0,
          homeAwayMultiplier: fixtureContext.isHome ? 1.08 : 0.94,
          opponentDifficultyMultiplier: 1.0,
          appearanceExpectedPoints: 0,
          attackingExpectedPoints: 0,
          defensiveExpectedPoints: 0,
        },
        upcomingOpponent: input.upcomingFixture
          ? {
              teamId: input.upcomingFixture.opponentTeam.id,
              name: input.upcomingFixture.opponentTeam.name ?? "Unknown",
              shortName: input.upcomingFixture.opponentTeam.shortName ?? "UNK",
              isHome: input.upcomingFixture.isHome,
              gameweekId: input.upcomingFixture.gameweekId ?? null,
            }
          : null,
        generatedAt: new Date().toISOString(),
      };
    }

    const positionMultiplier = POSITION_MULTIPLIERS[input.position] ?? 1.0;
    const homeAwayMultiplier = fixtureContext.isHome ? 1.08 : 0.94;

    // Difficulty multiplier: FDR 1 -> ~1.22, FDR 2 -> ~1.12, FDR 3 -> ~1.00, FDR 4 -> ~0.88, FDR 5 -> ~0.76
    const opponentDifficultyMultiplier = round2(
      clamp(1.36 - (fixtureDifficulty.rawDifficultyScore - 1.0) * 0.15, 0.72, 1.32)
    );

    const appearanceExpectedPoints = round2(2.0 * minutesProbability);

    const isDefensiveRole = input.position === Position.GKP || input.position === Position.DEF;
    const cleanSheetProb = clamp(
      0.34 * (1 / Math.max(0.75, fixtureDifficulty.opponentAttackIndex)) * (fixtureContext.isHome ? 1.1 : 0.92),
      0.08,
      0.6
    );
    const cleanSheetPointsWeight =
      input.position === Position.GKP || input.position === Position.DEF
        ? 4.0
        : input.position === Position.MID
        ? 1.0
        : 0;
    const defensiveExpectedPoints = round2(cleanSheetProb * cleanSheetPointsWeight * minutesProbability);

    const formContribution = Math.max(0.8, weightedRollingForm * 0.50);
    const attackingShare = isDefensiveRole ? 0.55 : 0.85;
    const attackingExpectedPoints = round2(
      formContribution *
        attackingShare *
        positionMultiplier *
        homeAwayMultiplier *
        opponentDifficultyMultiplier *
        minutesProbability
    );

    const rawXp = appearanceExpectedPoints + attackingExpectedPoints + defensiveExpectedPoints;
    const expectedPoints = round2(clamp(rawXp, 0, 16.0));

    return {
      playerId: input.playerId,
      displayName: input.displayName,
      position: input.position,
      price: input.price,
      expectedPoints,
      fdr: fixtureDifficulty.fdr,
      fixtureDifficulty,
      breakdown: {
        weightedRollingForm,
        minutesProbability,
        positionMultiplier,
        homeAwayMultiplier,
        opponentDifficultyMultiplier,
        appearanceExpectedPoints,
        attackingExpectedPoints,
        defensiveExpectedPoints,
      },
      upcomingOpponent: input.upcomingFixture
        ? {
            teamId: input.upcomingFixture.opponentTeam.id,
            name: input.upcomingFixture.opponentTeam.name ?? "Unknown",
            shortName: input.upcomingFixture.opponentTeam.shortName ?? "UNK",
            isHome: input.upcomingFixture.isHome,
            gameweekId: input.upcomingFixture.gameweekId ?? null,
          }
        : null,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetches player analytics by player ID (with Redis and in-memory caching).
   */
  public async getPlayerAnalytics(
    playerId: number,
    targetGameweekId?: number
  ): Promise<{ prediction: PlayerAnalyticsPrediction; cached: boolean } | null> {
    const cacheKey = `${ANALYTICS_CACHE_PREFIX}:${playerId}:${targetGameweekId ?? "next"}`;
    const redis = this.getCacheClient();

    if (redis) {
      try {
        const cachedRaw = await redis.get(cacheKey);
        if (cachedRaw) {
          const parsed = JSON.parse(cachedRaw) as PlayerAnalyticsPrediction;
          return { prediction: parsed, cached: true };
        }
      } catch {
        // Fall through to memory cache / database
      }
    }

    const memHit = this.memoryCache.get(cacheKey);
    if (memHit && memHit.expiresAt > Date.now()) {
      return { prediction: memHit.value, cached: true };
    }

    const player = await this.db.player.findUnique({
      where: { id: playerId },
      include: {
        team: true,
        gameweekStats: {
          orderBy: { gameweekId: "desc" },
          take: 5,
        },
      },
    });

    if (!player) {
      return null;
    }

    let upcomingFixtureRecord: any = null;
    if (this.db.fixture?.findFirst) {
      const fixtureWhere: any = {
        finished: false,
        OR: [{ homeTeamId: player.teamId }, { awayTeamId: player.teamId }],
      };
      if (targetGameweekId !== undefined) {
        fixtureWhere.gameweekId = targetGameweekId;
      }
      upcomingFixtureRecord = await this.db.fixture.findFirst({
        where: fixtureWhere,
        include: {
          homeTeam: true,
          awayTeam: true,
        },
        orderBy: [{ gameweekId: "asc" }, { kickoffTime: "asc" }],
      });
    }

    let upcomingFixture: UpcomingFixtureContext | null = null;
    if (upcomingFixtureRecord && player.team) {
      const isHome = upcomingFixtureRecord.homeTeamId === player.teamId;
      const opponentTeam = isHome
        ? upcomingFixtureRecord.awayTeam
        : upcomingFixtureRecord.homeTeam;
      if (opponentTeam) {
        upcomingFixture = {
          fixtureId: upcomingFixtureRecord.id,
          gameweekId: upcomingFixtureRecord.gameweekId ?? null,
          isHome,
          playerTeam: player.team,
          opponentTeam,
        };
      }
    }

    const priceNum =
      typeof player.price === "number"
        ? player.price
        : parseFloat(String(player.price ?? "5.0")) || 5.0;
    const formNum =
      player.form !== null && player.form !== undefined
        ? parseFloat(String(player.form))
        : null;

    const prediction = this.predictPlayerAnalytics({
      playerId: player.id,
      displayName: player.displayName,
      position: player.position,
      price: priceNum,
      form: formNum,
      totalPoints: player.totalPoints,
      minutesPlayed: player.minutesPlayed,
      status: player.status,
      chanceOfPlayingNextRound: player.chanceOfPlayingNextRound,
      isAvailable: player.isAvailable,
      recentStats: (player.gameweekStats ?? []).map((s: any) => ({
        gameweekId: s.gameweekId,
        minutes: s.minutes,
        totalPoints: s.totalPoints,
        goals: s.goals,
        assists: s.assists,
        cleanSheet: s.cleanSheet,
        saves: s.saves,
        bonus: s.bonus,
      })),
      upcomingFixture,
    });

    this.memoryCache.set(cacheKey, {
      expiresAt: Date.now() + ANALYTICS_CACHE_TTL_SECONDS * 1000,
      value: prediction,
    });

    if (redis) {
      try {
        await redis.set(
          cacheKey,
          JSON.stringify(prediction),
          "EX",
          ANALYTICS_CACHE_TTL_SECONDS
        );
      } catch {
        // Ignore Redis write error; memory cache already holds prediction
      }
    }

    return { prediction, cached: false };
  }
}

export const playerAnalyticsEngine = new PlayerAnalyticsEngine();
