import crypto from "crypto";
import { prisma } from "../../config/db.js";
import { getRedisClient, type IRedisCacheClient } from "../../config/redis.js";
import { Position } from "../../types/index.js";
import { SquadForbiddenError, SquadService } from "../squad/squadService.js";
import { SquadValidationError } from "../squad/squadValidator.js";
import {
  MAX_HORIZON,
  MIN_HORIZON,
  TransferOptimizerError,
  solveTransferPlan,
  type OptimizerFixture,
  type OptimizerPlayer,
  type TransferPlanInput,
  type TransferPlanResult,
} from "./transferOptimizer.js";

/**
 * Builds TransferOptimizerEngine inputs from the database and caches solver
 * results in Redis (issue #267). Identical squad states (same squad, bank, free
 * transfers, horizon, player prices/projections and fixtures) hash to the same
 * cache key, so repeated requests skip the CPU-heavy search. Redis failures
 * fall back to solving directly.
 */

export const TRANSFER_PLAN_CACHE_PREFIX = "fpl:transfer-plan:v1:";
export const TRANSFER_PLAN_CACHE_TTL_SECONDS = 600;

/** FPL statuses meaning the player will not feature (injured, suspended, unavailable, not in squad). */
const UNAVAILABLE_STATUSES = new Set(["i", "s", "u", "n"]);

export interface SquadTransferPlanOptions {
  horizon?: number;
  maxTransfersPerGameweek?: number;
}

export type CachedTransferPlanResult = TransferPlanResult & { cached: boolean };

export function transferPlanCacheKey(input: TransferPlanInput): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `${TRANSFER_PLAN_CACHE_PREFIX}${digest}`;
}

/** Per-match expected points: FPL form when present, otherwise season points per 90. */
export function expectedPointsPerMatch(player: {
  form?: unknown;
  totalPoints: number;
  minutesPlayed: number;
}): number {
  if (player.form !== null && player.form !== undefined && Number.isFinite(Number(player.form))) {
    return Math.max(0, Number(player.form));
  }
  return player.minutesPlayed >= 180 ? Math.max(0, player.totalPoints / (player.minutesPlayed / 90)) : 0;
}

/** Converts a team strength rating (FPL uses 1-5) into an FDR for the opponent. */
function difficultyFromStrength(strength: number | null | undefined): number {
  return Math.min(5, Math.max(1, strength ?? 3));
}

export class TransferPlanService {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly db: any = prisma,
    private readonly cache: IRedisCacheClient | null | undefined = undefined,
    private readonly ttlSeconds: number = TRANSFER_PLAN_CACHE_TTL_SECONDS
  ) {}

  private get redis(): IRedisCacheClient | null {
    return this.cache !== undefined ? this.cache : getRedisClient();
  }

  /** Solves a plan, serving identical inputs from the Redis cache. */
  public async solve(input: TransferPlanInput): Promise<CachedTransferPlanResult> {
    const key = transferPlanCacheKey(input);
    const redis = this.redis;

    if (redis) {
      try {
        const hit = await redis.get(key);
        if (hit) return { ...(JSON.parse(hit) as TransferPlanResult), cached: true };
      } catch (err) {
        console.warn(`[TransferPlanService] Redis GET failed, solving directly: ${(err as Error).message}`);
      }
    }

    const result = solveTransferPlan(input);

    if (redis) {
      try {
        await redis.set(key, JSON.stringify(result), "EX", this.ttlSeconds);
      } catch (err) {
        console.warn(`[TransferPlanService] Redis SET failed: ${(err as Error).message}`);
      }
    }
    return { ...result, cached: false };
  }

  /** Loads the caller's squad, upcoming fixtures and player pool, then solves. */
  public async getSquadPlan(
    squadId: string,
    userId: string,
    options: SquadTransferPlanOptions = {}
  ): Promise<CachedTransferPlanResult> {
    return this.solve(await this.buildInput(squadId, userId, options));
  }

  public async buildInput(
    squadId: string,
    userId: string,
    options: SquadTransferPlanOptions = {}
  ): Promise<TransferPlanInput> {
    const horizon = options.horizon ?? 3;
    if (!Number.isInteger(horizon) || horizon < MIN_HORIZON || horizon > MAX_HORIZON) {
      throw new TransferOptimizerError(`horizon must be an integer between ${MIN_HORIZON} and ${MAX_HORIZON}`);
    }

    const squad = await this.db.squad.findUnique({
      where: { id: squadId },
      include: { players: { include: { player: true } } },
    });
    if (!squad) {
      throw new SquadValidationError(`Squad ${squadId} not found`);
    }
    if (squad.userId !== userId) {
      throw new SquadForbiddenError("You can only plan transfers for your own squad");
    }

    const gameweeks: Array<{ id: number; fplId: number }> = await this.db.gameweek.findMany({
      where: { isFinished: false },
      orderBy: { deadline: "asc" },
      take: horizon,
      select: { id: true, fplId: true },
    });
    if (gameweeks.length === 0) {
      throw new TransferOptimizerError("No upcoming gameweeks to plan for");
    }
    const gameweekIds = gameweeks.map((g) => g.id);

    let freeTransfers: number = squad.freeTransfers;
    if (squad.freeTransfersGameweekId !== null && squad.freeTransfersGameweekId !== gameweeks[0].id) {
      const saved = await this.db.gameweek.findUnique({
        where: { id: squad.freeTransfersGameweekId },
        select: { fplId: true },
      });
      const elapsed = saved ? gameweeks[0].fplId - saved.fplId : 1;
      freeTransfers = SquadService.rollFreeTransfers(squad.freeTransfers, elapsed);
    }

    const ownedIds: number[] = squad.players.map((sp: any) => sp.playerId);
    const [dbPlayers, teams, dbFixtures] = await Promise.all([
      this.db.player.findMany({
        where: { OR: [{ isAvailable: true }, { id: { in: ownedIds } }] },
        select: {
          id: true,
          teamId: true,
          position: true,
          price: true,
          form: true,
          totalPoints: true,
          minutesPlayed: true,
          status: true,
          chanceOfPlayingNextRound: true,
        },
        orderBy: { id: "asc" },
      }),
      this.db.team.findMany({ select: { id: true, strength: true } }),
      this.db.fixture.findMany({
        where: { gameweekId: { in: gameweekIds } },
        select: { gameweekId: true, homeTeamId: true, awayTeamId: true },
        orderBy: { id: "asc" },
      }),
    ]);

    const strength = new Map<number, number | null>(teams.map((t: any) => [t.id, t.strength]));
    const fixtures: OptimizerFixture[] = dbFixtures.flatMap((f: any) => [
      { gameweekId: f.gameweekId, teamId: f.homeTeamId, difficulty: difficultyFromStrength(strength.get(f.awayTeamId)) },
      { gameweekId: f.gameweekId, teamId: f.awayTeamId, difficulty: difficultyFromStrength(strength.get(f.homeTeamId)) },
    ]);

    const players: OptimizerPlayer[] = dbPlayers.map((p: any) => ({
      id: p.id,
      teamId: p.teamId,
      position: p.position as Position,
      price: Number(p.price),
      expectedPointsPerMatch: Math.round(expectedPointsPerMatch(p) * 100) / 100,
      chanceOfPlaying:
        p.chanceOfPlayingNextRound ?? (p.status && UNAVAILABLE_STATUSES.has(p.status) ? 0 : null),
    }));

    return {
      squad: [...squad.players]
        .sort((a: any, b: any) => a.playerId - b.playerId)
        .map((sp: any) => ({
          playerId: sp.playerId,
          sellingPrice: SquadService.calculateSellingPrice(Number(sp.purchasePrice), Number(sp.player.price)),
        })),
      bank: Number(squad.budgetRemaining),
      freeTransfers,
      gameweekIds,
      players,
      fixtures,
      options: { maxTransfersPerGameweek: options.maxTransfersPerGameweek ?? 2 },
    };
  }
}

export const transferPlanService = new TransferPlanService();
