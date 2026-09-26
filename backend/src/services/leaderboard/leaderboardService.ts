import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../config/db.js";

/**
 * Global Leaderboard (read-only).
 *
 * Ranks every squad on the platform by season points (Squad.totalPoints) or by
 * the points scored in one gameweek (SquadGameweekScore.points). Points are
 * read as already calculated by the scoring engine; nothing is recalculated here.
 *
 * Ranking uses standard competition ranking: squads on equal points share a
 * rank and the next rank skips (1, 2, 2, 4). Display order within a tie is the
 * earliest-created squad first. Ranks are always global, so searching for a
 * manager shows their real position rather than their position in the results.
 */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_SEARCH_LENGTH = 50;

export interface LeaderboardQuery {
  page: number;
  pageSize: number;
  search?: string;
  /** When set, rank by points scored in this gameweek instead of season total */
  gameweekId?: number;
}

export interface LeaderboardEntry {
  rank: number;
  squadId: string;
  squadName: string;
  userId: string;
  username: string;
  points: number;
  isCurrentUser: boolean;
}

export interface LeaderboardViewerPosition {
  rank: number;
  /** Page of the unfiltered leaderboard (at the requested page size) containing the viewer */
  page: number;
  squadId: string;
  points: number;
}

export interface LeaderboardResult {
  mode: "overall" | "gameweek";
  gameweek: { id: number; name: string } | null;
  entries: LeaderboardEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  viewer: LeaderboardViewerPosition | null;
}

export class LeaderboardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaderboardValidationError";
  }
}

export class LeaderboardNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaderboardNotFoundError";
  }
}

function parsePositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new LeaderboardValidationError(`${name} must be a positive integer`);
  }
  return Number(value);
}

/**
 * Assigns competition ranks to one page of rows sorted by points (descending).
 *
 * Unfiltered pages are contiguous slices of the full ranking, so only the first
 * row can share a rank with the previous page; every later row's rank follows
 * from its position. Filtered (search) pages are not contiguous, so each
 * distinct points value is ranked against the whole leaderboard.
 */
export async function assignCompetitionRanks(
  points: number[],
  offset: number,
  contiguous: boolean,
  countAbove: (points: number) => Promise<number>
): Promise<number[]> {
  if (points.length === 0) return [];

  if (contiguous) {
    const firstRank = offset === 0 ? 1 : 1 + (await countAbove(points[0]));
    const ranks = [firstRank];
    for (let i = 1; i < points.length; i++) {
      ranks.push(points[i] === points[i - 1] ? ranks[i - 1] : offset + i + 1);
    }
    return ranks;
  }

  const distinct = [...new Set(points)];
  const above = await Promise.all(distinct.map(countAbove));
  const rankByPoints = new Map(distinct.map((p, i) => [p, above[i] + 1]));
  return points.map((p) => rankByPoints.get(p)!);
}

export class LeaderboardService {
  constructor(private readonly db: PrismaClient = prisma) {}

  /** Validates raw query-string values (page, pageSize, q, gameweekId). */
  public static parseQuery(raw: Record<string, unknown>): LeaderboardQuery {
    const page = parsePositiveInt(raw.page, "page") ?? 1;
    const pageSize = parsePositiveInt(raw.pageSize, "pageSize") ?? DEFAULT_PAGE_SIZE;
    if (pageSize > MAX_PAGE_SIZE) {
      throw new LeaderboardValidationError(`pageSize must be at most ${MAX_PAGE_SIZE}`);
    }

    let search: string | undefined;
    if (raw.q !== undefined) {
      if (typeof raw.q !== "string") {
        throw new LeaderboardValidationError("q must be a single search term");
      }
      search = raw.q.trim() || undefined;
      if (search && search.length > MAX_SEARCH_LENGTH) {
        throw new LeaderboardValidationError(`q must be at most ${MAX_SEARCH_LENGTH} characters`);
      }
    }

    return { page, pageSize, search, gameweekId: parsePositiveInt(raw.gameweekId, "gameweekId") };
  }

  public async getLeaderboard(query: LeaderboardQuery, viewerId?: string): Promise<LeaderboardResult> {
    return query.gameweekId === undefined
      ? this.getOverallLeaderboard(query, viewerId)
      : this.getGameweekLeaderboard(query, query.gameweekId, viewerId);
  }

  private static squadSearch(search?: string): Prisma.SquadWhereInput {
    if (!search) return {};
    return {
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        { user: { username: { contains: search, mode: "insensitive" } } },
      ],
    };
  }

  private async getOverallLeaderboard(query: LeaderboardQuery, viewerId?: string): Promise<LeaderboardResult> {
    const where = LeaderboardService.squadSearch(query.search);
    const skip = (query.page - 1) * query.pageSize;

    const [rows, total] = await Promise.all([
      this.db.squad.findMany({
        where,
        orderBy: [{ totalPoints: "desc" }, { createdAt: "asc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: { id: true, name: true, totalPoints: true, userId: true, user: { select: { username: true } } },
      }),
      this.db.squad.count({ where }),
    ]);

    const ranks = await assignCompetitionRanks(
      rows.map((r) => r.totalPoints),
      skip,
      !query.search,
      (points) => this.db.squad.count({ where: { totalPoints: { gt: points } } })
    );

    let viewer: LeaderboardViewerPosition | null = null;
    if (viewerId) {
      const best = await this.db.squad.findFirst({
        where: { userId: viewerId },
        orderBy: [{ totalPoints: "desc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, totalPoints: true, createdAt: true },
      });
      if (best) {
        const [above, ahead] = await Promise.all([
          this.db.squad.count({ where: { totalPoints: { gt: best.totalPoints } } }),
          this.db.squad.count({
            where: {
              OR: [
                { totalPoints: { gt: best.totalPoints } },
                { totalPoints: best.totalPoints, createdAt: { lt: best.createdAt } },
                { totalPoints: best.totalPoints, createdAt: best.createdAt, id: { lt: best.id } },
              ],
            },
          }),
        ]);
        viewer = {
          rank: above + 1,
          page: Math.floor(ahead / query.pageSize) + 1,
          squadId: best.id,
          points: best.totalPoints,
        };
      }
    }

    return {
      mode: "overall",
      gameweek: null,
      entries: rows.map((r, i) => ({
        rank: ranks[i],
        squadId: r.id,
        squadName: r.name,
        userId: r.userId,
        username: r.user.username,
        points: r.totalPoints,
        isCurrentUser: viewerId !== undefined && r.userId === viewerId,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
      viewer,
    };
  }

  private async getGameweekLeaderboard(
    query: LeaderboardQuery,
    gameweekId: number,
    viewerId?: string
  ): Promise<LeaderboardResult> {
    const gameweek = await this.db.gameweek.findUnique({
      where: { id: gameweekId },
      select: { id: true, name: true },
    });
    if (!gameweek) {
      throw new LeaderboardNotFoundError(`Gameweek ${gameweekId} not found`);
    }

    const where: Prisma.SquadGameweekScoreWhereInput = query.search
      ? { gameweekId, squad: LeaderboardService.squadSearch(query.search) }
      : { gameweekId };
    const skip = (query.page - 1) * query.pageSize;

    const [rows, total] = await Promise.all([
      this.db.squadGameweekScore.findMany({
        where,
        orderBy: [{ points: "desc" }, { squad: { createdAt: "asc" } }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          points: true,
          squad: { select: { id: true, name: true, userId: true, user: { select: { username: true } } } },
        },
      }),
      this.db.squadGameweekScore.count({ where }),
    ]);

    const ranks = await assignCompetitionRanks(
      rows.map((r) => r.points),
      skip,
      !query.search,
      (points) => this.db.squadGameweekScore.count({ where: { gameweekId, points: { gt: points } } })
    );

    let viewer: LeaderboardViewerPosition | null = null;
    if (viewerId) {
      const best = await this.db.squadGameweekScore.findFirst({
        where: { gameweekId, squad: { userId: viewerId } },
        orderBy: [{ points: "desc" }, { squad: { createdAt: "asc" } }, { id: "asc" }],
        select: { points: true, squad: { select: { id: true, createdAt: true } } },
      });
      if (best) {
        const [above, ahead] = await Promise.all([
          this.db.squadGameweekScore.count({ where: { gameweekId, points: { gt: best.points } } }),
          this.db.squadGameweekScore.count({
            where: {
              gameweekId,
              OR: [
                { points: { gt: best.points } },
                { points: best.points, squad: { createdAt: { lt: best.squad.createdAt } } },
              ],
            },
          }),
        ]);
        viewer = {
          rank: above + 1,
          page: Math.floor(ahead / query.pageSize) + 1,
          squadId: best.squad.id,
          points: best.points,
        };
      }
    }

    return {
      mode: "gameweek",
      gameweek,
      entries: rows.map((r, i) => ({
        rank: ranks[i],
        squadId: r.squad.id,
        squadName: r.squad.name,
        userId: r.squad.userId,
        username: r.squad.user.username,
        points: r.points,
        isCurrentUser: viewerId !== undefined && r.squad.userId === viewerId,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
      viewer,
    };
  }
}

export const leaderboardService = new LeaderboardService();
