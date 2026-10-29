/**
 * Player analytics engine (issue #232).
 *
 * Deterministic TypeScript model (no ML runtime) for:
 *  - Fixture Difficulty Rating (FDR, 1 = easiest, 5 = hardest) from FPL team
 *    strengths, split into attacking and defensive difficulty.
 *  - Expected points (xP) per upcoming gameweek from a weighted 5-match form,
 *    the season points-per-game, the chance of playing, and opponent strength.
 *
 * Results are cached in Redis (with an in-memory fallback).
 */

import { prisma } from "../../config/db.js";
import { getRedisClient, type IRedisCacheClient } from "../../config/redis.js";

export type PlayerPosition = "GOALKEEPER" | "DEFENDER" | "MIDFIELDER" | "FORWARD";

/** Strength fields as stored on Team (FPL scale, roughly 1000-1400). */
export interface TeamStrengths {
  id: number;
  shortName?: string;
  strength?: number | null;
  strengthOverallHome?: number | null;
  strengthOverallAway?: number | null;
  strengthAttackHome?: number | null;
  strengthAttackAway?: number | null;
  strengthDefenceHome?: number | null;
  strengthDefenceAway?: number | null;
}

/** Tunable constants. Exported so tests can assert the weighting. */
export const ANALYTICS_CONFIG = {
  /** Form weights, most recent appearance first. */
  formWeights: [5, 4, 3, 2, 1],
  /** Share of the baseline that comes from recent form (rest is season PPG). */
  formBlend: 0.3,
  /** Matches needed before season PPG is fully trusted over the position prior. */
  priorMatches: 8,
  /** Points-per-appearance prior by position, used for small samples. */
  positionPrior: { GOALKEEPER: 3.5, DEFENDER: 3.5, MIDFIELDER: 4.0, FORWARD: 4.0 } as Record<PlayerPosition, number>,
  /** Strength used when a team has no FPL strength data. */
  defaultStrength: 1150,
  /** Strength gaps (opponent minus own) at which FDR steps up from 1 to 2, 2 to 3, and so on. */
  fdrThresholds: [-200, -75, 75, 175],
  /** Multiplier applied to performance points for each FDR. */
  fdrMultiplier: { 1: 1.15, 2: 1.07, 3: 1.0, 4: 0.9, 5: 0.78 } as Record<number, number>,
  homeMultiplier: 1.03,
  awayMultiplier: 0.97,
  /** How much attacking vs defensive difficulty matters per position. */
  attackShare: { GOALKEEPER: 0, DEFENDER: 0.25, MIDFIELDER: 0.7, FORWARD: 1 } as Record<PlayerPosition, number>,
  /** FPL appearance points: 2 for 60+ minutes, 1 for fewer. */
  appearancePoints: { full: 2, partial: 1 },
};

export type Fdr = 1 | 2 | 3 | 4 | 5;

function strengthOrDefault(value: number | null | undefined, team: TeamStrengths): number {
  if (typeof value === "number" && value > 0) return value;
  // FPL's coarse 1-5 `strength` maps onto the detailed scale around the default.
  if (typeof team.strength === "number" && team.strength > 0) {
    return ANALYTICS_CONFIG.defaultStrength + (team.strength - 3) * 100;
  }
  return ANALYTICS_CONFIG.defaultStrength;
}

/** Maps a strength gap (positive = opponent stronger) to FDR 1-5. */
export function fdrFromStrengthGap(gap: number): Fdr {
  const steps = ANALYTICS_CONFIG.fdrThresholds.filter((threshold) => gap >= threshold).length;
  return (1 + steps) as Fdr;
}

export interface FixtureDifficulty {
  /** Overall difficulty for the team. */
  fdr: Fdr;
  /** Difficulty of scoring: own attack vs opponent defence. */
  attackFdr: Fdr;
  /** Difficulty of keeping a clean sheet: own defence vs opponent attack. */
  defenceFdr: Fdr;
}

/**
 * Computes how hard a fixture is for `team` against `opponent`.
 * Venue matters: each side uses its home or away strengths.
 */
export function computeFixtureDifficulty(
  team: TeamStrengths,
  opponent: TeamStrengths,
  isHome: boolean
): FixtureDifficulty {
  const own = isHome
    ? { overall: team.strengthOverallHome, attack: team.strengthAttackHome, defence: team.strengthDefenceHome }
    : { overall: team.strengthOverallAway, attack: team.strengthAttackAway, defence: team.strengthDefenceAway };
  const opp = isHome
    ? { overall: opponent.strengthOverallAway, attack: opponent.strengthAttackAway, defence: opponent.strengthDefenceAway }
    : { overall: opponent.strengthOverallHome, attack: opponent.strengthAttackHome, defence: opponent.strengthDefenceHome };

  return {
    fdr: fdrFromStrengthGap(strengthOrDefault(opp.overall, opponent) - strengthOrDefault(own.overall, team)),
    attackFdr: fdrFromStrengthGap(strengthOrDefault(opp.defence, opponent) - strengthOrDefault(own.attack, team)),
    defenceFdr: fdrFromStrengthGap(strengthOrDefault(opp.attack, opponent) - strengthOrDefault(own.defence, team)),
  };
}

export interface MatchRecord {
  gameweekId: number;
  minutes: number;
  totalPoints: number;
}

/**
 * Weighted average points over the last 5 appearances (minutes > 0), most
 * recent first. Returns null with no appearances.
 */
export function computeWeightedForm(recentFirst: MatchRecord[]): number | null {
  const appearances = recentFirst.filter((m) => m.minutes > 0).slice(0, ANALYTICS_CONFIG.formWeights.length);
  if (appearances.length === 0) return null;
  let weighted = 0;
  let weights = 0;
  appearances.forEach((match, i) => {
    const w = ANALYTICS_CONFIG.formWeights[i];
    weighted += match.totalPoints * w;
    weights += w;
  });
  return weighted / weights;
}

/** Season points per appearance, shrunk towards the position prior for small samples. */
export function computeSeasonBaseline(matches: MatchRecord[], position: PlayerPosition): number {
  const appearances = matches.filter((m) => m.minutes > 0);
  const prior = ANALYTICS_CONFIG.positionPrior[position];
  if (appearances.length === 0) return prior;
  const ppg = appearances.reduce((sum, m) => sum + m.totalPoints, 0) / appearances.length;
  const k = ANALYTICS_CONFIG.priorMatches;
  return (ppg * appearances.length + prior * k) / (appearances.length + k);
}

export interface MinutesProbability {
  /** Probability of featuring at all. */
  pPlay: number;
  /** Probability of playing 60+ minutes, given the player features. */
  p60: number;
}

/**
 * Chance of playing from the FPL availability flag and recent minutes.
 * `chanceOfPlaying` is FPL's 0-100 value (null means no doubt).
 */
export function computeMinutesProbability(input: {
  recentFirst: MatchRecord[];
  chanceOfPlaying?: number | null;
  status?: string | null;
}): MinutesProbability {
  if (input.status && ["i", "s", "u", "n"].includes(input.status) && !input.chanceOfPlaying) {
    return { pPlay: 0, p60: 0 };
  }
  const availability = input.chanceOfPlaying == null ? 1 : Math.max(0, Math.min(100, input.chanceOfPlaying)) / 100;
  const window = input.recentFirst.slice(0, ANALYTICS_CONFIG.formWeights.length);
  if (window.length === 0) {
    // Unknown history: assume a rotation risk.
    return { pPlay: availability * 0.5, p60: 0.5 };
  }
  const featured = window.filter((m) => m.minutes > 0);
  const featureRate = featured.length / window.length;
  const p60 = featured.length === 0 ? 0 : featured.filter((m) => m.minutes >= 60).length / featured.length;
  return { pPlay: availability * featureRate, p60 };
}

export interface ExpectedPointsBreakdown {
  xP: number;
  baseline: number;
  appearancePoints: number;
  performancePoints: number;
  difficultyMultiplier: number;
  venueMultiplier: number;
  pPlay: number;
}

/**
 * Expected points for one fixture.
 * xP = pPlay * (appearance points + performance points * difficulty * venue)
 */
export function computeExpectedPoints(input: {
  position: PlayerPosition;
  form: number | null;
  seasonBaseline: number;
  minutes: MinutesProbability;
  difficulty: FixtureDifficulty;
  isHome: boolean;
}): ExpectedPointsBreakdown {
  const cfg = ANALYTICS_CONFIG;
  const baseline =
    input.form === null ? input.seasonBaseline : cfg.formBlend * input.form + (1 - cfg.formBlend) * input.seasonBaseline;

  const appearancePoints = input.minutes.p60 * cfg.appearancePoints.full + (1 - input.minutes.p60) * cfg.appearancePoints.partial;
  const performancePoints = Math.max(0, baseline - appearancePoints);

  const attackShare = cfg.attackShare[input.position];
  const difficultyMultiplier =
    attackShare * cfg.fdrMultiplier[input.difficulty.attackFdr] +
    (1 - attackShare) * cfg.fdrMultiplier[input.difficulty.defenceFdr];
  const venueMultiplier = input.isHome ? cfg.homeMultiplier : cfg.awayMultiplier;

  const xP = input.minutes.pPlay * (appearancePoints + performancePoints * difficultyMultiplier * venueMultiplier);
  return {
    xP: round2(xP),
    baseline: round2(baseline),
    appearancePoints: round2(appearancePoints),
    performancePoints: round2(performancePoints),
    difficultyMultiplier: round2(difficultyMultiplier),
    venueMultiplier,
    pPlay: round2(input.minutes.pPlay),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ------------------------------------------------------------
// Service
// ------------------------------------------------------------

export interface FixtureAnalytics extends FixtureDifficulty {
  fixtureId: number;
  gameweekId: number;
  kickoffTime: string | null;
  isHome: boolean;
  opponentTeamId: number;
  opponentShortName: string | null;
  xP: number;
  breakdown: ExpectedPointsBreakdown;
}

export interface GameweekAnalytics {
  gameweekId: number;
  /** Sum over fixtures; 0 for a blank gameweek, more for a double. */
  xP: number;
  fixtures: FixtureAnalytics[];
}

export interface PlayerAnalytics {
  playerId: number;
  displayName: string;
  position: PlayerPosition;
  teamId: number;
  form: number | null;
  seasonBaseline: number;
  minutes: MinutesProbability;
  totalXP: number;
  averageFdr: number | null;
  gameweeks: GameweekAnalytics[];
  generatedAt: string;
}

export class PlayerNotFoundError extends Error {
  constructor(playerId: number) {
    super(`Player ${playerId} not found`);
    this.name = "PlayerNotFoundError";
  }
}

export interface PlayerAnalyticsEngineOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  cache?: IRedisCacheClient | null;
  cacheTtlSeconds?: number;
  now?: () => Date;
}

export class PlayerAnalyticsEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly cache: IRedisCacheClient | null;
  private readonly memory = new Map<string, { value: string; expiresAt: number }>();
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(options: PlayerAnalyticsEngineOptions = {}) {
    this.db = options.db ?? prisma;
    this.cache = options.cache === undefined ? getRedisClient() : options.cache;
    this.ttlSeconds =
      options.cacheTtlSeconds ?? (Number.parseInt(process.env.PLAYER_ANALYTICS_CACHE_TTL || "", 10) || 3600);
    this.now = options.now ?? (() => new Date());
  }

  public static cacheKey(playerId: number, horizon: number): string {
    return `analytics:player:${playerId}:h${horizon}`;
  }

  private async readCache(key: string): Promise<PlayerAnalytics | null> {
    try {
      const hit = this.cache ? await this.cache.get(key) : null;
      if (hit) return JSON.parse(hit);
    } catch {
      // Fall through to the memory cache.
    }
    const local = this.memory.get(key);
    if (local && local.expiresAt > Date.now()) return JSON.parse(local.value);
    return null;
  }

  private async writeCache(key: string, value: PlayerAnalytics): Promise<void> {
    const json = JSON.stringify(value);
    this.memory.set(key, { value: json, expiresAt: Date.now() + this.ttlSeconds * 1000 });
    if (this.memory.size > 2_000) this.memory.delete(this.memory.keys().next().value!);
    try {
      await this.cache?.set(key, json, "EX", this.ttlSeconds);
    } catch {
      // Cache failures must not fail the request.
    }
  }

  /** Drops cached analytics for a player (all horizons), e.g. after a stats sync. */
  public async invalidate(playerId: number): Promise<void> {
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(`analytics:player:${playerId}:`)) this.memory.delete(key);
    }
    try {
      const keys = (await this.cache?.keys(`analytics:player:${playerId}:*`)) ?? [];
      if (keys.length) await this.cache?.del(...keys);
    } catch {
      // ignore
    }
  }

  /**
   * xP and FDR for a player's next `horizon` unfinished gameweeks.
   */
  public async getPlayerAnalytics(playerId: number, horizon = 5): Promise<PlayerAnalytics> {
    const safeHorizon = Math.max(1, Math.min(10, Math.floor(horizon)));
    const key = PlayerAnalyticsEngine.cacheKey(playerId, safeHorizon);
    const cached = await this.readCache(key);
    if (cached) return cached;

    const player = await this.db.player.findUnique({
      where: { id: playerId },
      include: { team: true },
    });
    if (!player) throw new PlayerNotFoundError(playerId);

    const [history, gameweeks] = await Promise.all([
      this.db.playerGameweekStats.findMany({
        where: { playerId },
        select: { gameweekId: true, minutes: true, totalPoints: true },
        orderBy: [{ gameweekId: "desc" }, { fixtureId: "desc" }],
        take: 38,
      }),
      this.db.gameweek.findMany({
        where: { isFinished: false },
        select: { id: true },
        orderBy: { id: "asc" },
        take: safeHorizon,
      }),
    ]);
    const gameweekIds: number[] = gameweeks.map((g: { id: number }) => g.id);
    const fixtures = gameweekIds.length
      ? await this.db.fixture.findMany({
          where: {
            gameweekId: { in: gameweekIds },
            finished: false,
            OR: [{ homeTeamId: player.teamId }, { awayTeamId: player.teamId }],
          },
          include: { homeTeam: true, awayTeam: true },
          orderBy: [{ gameweekId: "asc" }, { kickoffTime: "asc" }],
        })
      : [];

    const position = player.position as PlayerPosition;
    const form = computeWeightedForm(history);
    const seasonBaseline = computeSeasonBaseline(history, position);
    const minutes = computeMinutesProbability({
      recentFirst: history,
      chanceOfPlaying: player.chanceOfPlayingNextRound,
      status: player.status,
    });

    const byGameweek = new Map<number, FixtureAnalytics[]>(gameweekIds.map((id) => [id, []]));
    for (const fixture of fixtures) {
      const isHome = fixture.homeTeamId === player.teamId;
      const team = isHome ? fixture.homeTeam : fixture.awayTeam;
      const opponent = isHome ? fixture.awayTeam : fixture.homeTeam;
      const difficulty = computeFixtureDifficulty(team, opponent, isHome);
      const breakdown = computeExpectedPoints({ position, form, seasonBaseline, minutes, difficulty, isHome });
      byGameweek.get(fixture.gameweekId)?.push({
        fixtureId: fixture.id,
        gameweekId: fixture.gameweekId,
        kickoffTime: fixture.kickoffTime ? new Date(fixture.kickoffTime).toISOString() : null,
        isHome,
        opponentTeamId: opponent.id,
        opponentShortName: opponent.shortName ?? null,
        ...difficulty,
        xP: breakdown.xP,
        breakdown,
      });
    }

    const gameweekAnalytics: GameweekAnalytics[] = [...byGameweek.entries()].map(([gameweekId, list]) => ({
      gameweekId,
      xP: round2(list.reduce((sum, f) => sum + f.xP, 0)),
      fixtures: list,
    }));
    const allFixtures = gameweekAnalytics.flatMap((g) => g.fixtures);

    const result: PlayerAnalytics = {
      playerId: player.id,
      displayName: player.displayName,
      position,
      teamId: player.teamId,
      form: form === null ? null : round2(form),
      seasonBaseline: round2(seasonBaseline),
      minutes: { pPlay: round2(minutes.pPlay), p60: round2(minutes.p60) },
      totalXP: round2(gameweekAnalytics.reduce((sum, g) => sum + g.xP, 0)),
      averageFdr: allFixtures.length
        ? round2(allFixtures.reduce((sum, f) => sum + f.fdr, 0) / allFixtures.length)
        : null,
      gameweeks: gameweekAnalytics,
      generatedAt: this.now().toISOString(),
    };

    await this.writeCache(key, result);
    return result;
  }
}

export const playerAnalyticsEngine = new PlayerAnalyticsEngine();
