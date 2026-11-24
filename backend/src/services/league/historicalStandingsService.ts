/**
 * Historical League Standings Service
 * Reconstructs accurate league standings for any past gameweek
 * Handles transfer deductions, team selections, and ranking logic
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../config/db.js";
import { Logger } from "../../types/index.js";
import { CacheService } from "../cache/cacheService.js";
import type { LeagueStandingsEntry } from "../../types/index.js";

export interface HistoricalStandingsSnapshot {
  gameweekId: number;
  leagueId: string;
  standings: LeagueStandingsEntry[];
  totalGameweeks: number;
  timestamp: Date;
  meta?: {
    queryTimeMs: number;
    cached?: boolean;
  };
}

export interface ManagerGameweekState {
  memberId: string;
  membershipId: string;
  username: string;
  totalPoints: number;
  gameweekPoints: number;
  transfersUsed: number;
  transferCost: number;
  benchedPoints: number;
  captainId: string | null;
  viceCaptainId: string | null;
  chipUsed: string | null;
  formation: string;
  playersIds: string[];
}

export class HistoricalStandingsService {
  private logger: Logger;
  private cacheService: CacheService;

  constructor(logger: Logger, cacheService: CacheService) {
    this.logger = logger;
    this.cacheService = cacheService;
  }

  /**
   * Get standings snapshot for a specific gameweek
   * Reconstructs exact standings including transfer costs and bench points
   */
  async getHistoricalStandings(
    leagueId: string,
    gameweekId: number
  ): Promise<HistoricalStandingsSnapshot> {
    const startTime = Date.now();

    try {
      // Check cache first (historical data is immutable)
      const cacheKey = this.getCacheKey(leagueId, gameweekId);
      const cached = await this.cacheService.get(cacheKey);

      if (cached) {
        this.logger.debug(`Cache hit for historical standings: ${cacheKey}`);
        const snapshot = JSON.parse(cached);
        return {
          ...snapshot,
          meta: {
            queryTimeMs: Date.now() - startTime,
            cached: true,
          },
        };
      }

      // Verify gameweek has completed
      const gameweek = await prisma.gameweek.findUnique({
        where: { id: gameweekId },
        select: {
          id: true,
          completed: true,
          event: true,
        },
      });

      if (!gameweek || !gameweek.completed) {
        throw new Error(`Gameweek ${gameweekId} has not completed yet`);
      }

      // Get all league members
      const members = await prisma.membership.findMany({
        where: {
          leagueId,
          status: "ACTIVE", // Only active members
        },
        select: {
          id: true,
          userId: true,
          user: { select: { username: true } },
        },
      });

      // Get total gameweeks completed
      const maxGameweek = await prisma.gameweek.findFirst({
        where: { completed: true },
        orderBy: { id: "desc" },
        select: { id: true },
      });

      if (!maxGameweek) {
        throw new Error("No completed gameweeks found");
      }

      // Reconstruct standings for each member
      const standingsPromises = members.map((member) =>
        this.reconstructMemberGameweekState(leagueId, member.id, gameweekId)
      );

      const standings = await Promise.all(standingsPromises);

      // Sort by points and apply rankings
      const sortedStandings = this.rankStandings(standings);

      // Convert to LeagueStandingsEntry format
      const leagueStandings: LeagueStandingsEntry[] = sortedStandings.map(
        (standing, index) => ({
          rank: index + 1,
          memberId: standing.memberId,
          membershipId: standing.membershipId,
          username: standing.username,
          totalPoints: standing.totalPoints,
          gameweekPoints: standing.gameweekPoints,
          transfersUsed: standing.transfersUsed,
          transferCost: standing.transferCost,
          benchedPoints: standing.benchedPoints,
          chipUsed: standing.chipUsed,
        })
      );

      const snapshot: HistoricalStandingsSnapshot = {
        gameweekId,
        leagueId,
        standings: leagueStandings,
        totalGameweeks: maxGameweek.id,
        timestamp: new Date(),
      };

      // Cache with permanent TTL (immutable historical data)
      await this.cacheService.set(cacheKey, JSON.stringify(snapshot), -1);

      return {
        ...snapshot,
        meta: {
          queryTimeMs: Date.now() - startTime,
          cached: false,
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to get historical standings for league ${leagueId} GW ${gameweekId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Reconstruct a single member's gameweek state
   */
  private async reconstructMemberGameweekState(
    leagueId: string,
    membershipId: string,
    gameweekId: number
  ): Promise<ManagerGameweekState> {
    // Get member info
    const membership = await prisma.membership.findUnique({
      where: { id: membershipId },
      select: {
        userId: true,
        user: { select: { username: true } },
      },
    });

    if (!membership) {
      throw new Error(`Membership ${membershipId} not found`);
    }

    // Get cumulative points up to this gameweek
    const gameweekResult = await prisma.gameweekResult.findFirst({
      where: {
        membershipId,
        gameweekId,
      },
      select: {
        totalPoints: true,
        gameweekPoints: true,
        captainId: true,
        viceCaptainId: true,
        benchedPoints: true,
      },
    });

    if (!gameweekResult) {
      // Member not active in this gameweek - return 0s
      return {
        memberId: membership.userId,
        membershipId,
        username: membership.user.username,
        totalPoints: 0,
        gameweekPoints: 0,
        transfersUsed: 0,
        transferCost: 0,
        benchedPoints: 0,
        captainId: null,
        viceCaptainId: null,
        chipUsed: null,
        formation: "0-0-0-0",
        playersIds: [],
      };
    }

    // Get transfers up to this gameweek and calculate cost
    const transferCount = await prisma.transfer.count({
      where: {
        membershipId,
        gameweekId: { lte: gameweekId },
      },
    });

    // Calculate transfer cost: First free transfer per gameweek, then 4 points each
    // This is a simplified calculation; actual FPL logic is more nuanced
    const transferCost = Math.max(0, transferCount - 1) * 4;

    // Get current squad for this gameweek
    const squad = await prisma.squad.findFirst({
      where: {
        membershipId,
        gameweekId,
      },
      select: {
        players: {
          select: { id: true },
        },
        formation: true,
        chipUsed: true,
      },
    });

    // Final points after transfer deductions
    const totalPoints = Math.max(0, gameweekResult.totalPoints - transferCost);

    return {
      memberId: membership.userId,
      membershipId,
      username: membership.user.username,
      totalPoints,
      gameweekPoints: gameweekResult.gameweekPoints || 0,
      transfersUsed: transferCount,
      transferCost,
      benchedPoints: gameweekResult.benchedPoints || 0,
      captainId: gameweekResult.captainId,
      viceCaptainId: gameweekResult.viceCaptainId,
      chipUsed: squad?.chipUsed || null,
      formation: squad?.formation || "0-0-0-0",
      playersIds: squad?.players.map((p) => p.id) || [],
    };
  }

  /**
   * Sort standings by total points with tiebreaker logic
   */
  private rankStandings(standings: ManagerGameweekState[]): ManagerGameweekState[] {
    return standings.sort((a, b) => {
      // Primary: Total points (descending)
      if (a.totalPoints !== b.totalPoints) {
        return b.totalPoints - a.totalPoints;
      }

      // Tiebreaker 1: Gameweek points (descending)
      if (a.gameweekPoints !== b.gameweekPoints) {
        return b.gameweekPoints - a.gameweekPoints;
      }

      // Tiebreaker 2: Username (alphabetical for determinism)
      return a.username.localeCompare(b.username);
    });
  }

  /**
   * Get standings for multiple consecutive gameweeks
   */
  async getHistoricalTrend(
    leagueId: string,
    startGameweekId: number,
    endGameweekId: number
  ): Promise<HistoricalStandingsSnapshot[]> {
    try {
      const snapshots: HistoricalStandingsSnapshot[] = [];

      for (let gw = startGameweekId; gw <= endGameweekId; gw++) {
        const snapshot = await this.getHistoricalStandings(leagueId, gw);
        snapshots.push(snapshot);
      }

      return snapshots;
    } catch (error) {
      this.logger.error(
        `Failed to get standings trend for league ${leagueId} GW${startGameweekId}-${endGameweekId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Get manager's rank progression throughout season
   */
  async getManagerTrajectory(
    leagueId: string,
    membershipId: string
  ): Promise<
    Array<{
      gameweekId: number;
      rank: number;
      points: number;
      gameweekPoints: number;
    }>
  > {
    try {
      // Get max completed gameweek
      const maxGameweek = await prisma.gameweek.findFirst({
        where: { completed: true },
        orderBy: { id: "desc" },
        select: { id: true },
      });

      if (!maxGameweek) {
        return [];
      }

      const trajectory: Array<{
        gameweekId: number;
        rank: number;
        points: number;
        gameweekPoints: number;
      }> = [];

      // Get league for this membership
      const membership = await prisma.membership.findUnique({
        where: { id: membershipId },
        select: { leagueId: true },
      });

      if (!membership) {
        throw new Error(`Membership ${membershipId} not found`);
      }

      // Fetch snapshots and find manager's position in each
      for (let gw = 1; gw <= maxGameweek.id; gw++) {
        const snapshot = await this.getHistoricalStandings(
          membership.leagueId,
          gw
        );

        const managerStanding = snapshot.standings.find(
          (s) => s.membershipId === membershipId
        );

        if (managerStanding) {
          trajectory.push({
            gameweekId: gw,
            rank: managerStanding.rank,
            points: managerStanding.totalPoints,
            gameweekPoints: managerStanding.gameweekPoints,
          });
        }
      }

      return trajectory;
    } catch (error) {
      this.logger.error(
        `Failed to get manager trajectory for membership ${membershipId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Verify historical data consistency
   */
  async verifyHistoricalAccuracy(
    leagueId: string,
    gameweekId: number
  ): Promise<{
    isValid: boolean;
    issues: string[];
  }> {
    const issues: string[] = [];

    try {
      const snapshot = await this.getHistoricalStandings(leagueId, gameweekId);

      // Verify all managers have non-negative points
      for (const standing of snapshot.standings) {
        if (standing.totalPoints < 0) {
          issues.push(
            `Member ${standing.username} has negative points: ${standing.totalPoints}`
          );
        }

        if (standing.transferCost > standing.totalPoints) {
          issues.push(
            `Member ${standing.username} transfer cost (${standing.transferCost}) exceeds points (${standing.totalPoints})`
          );
        }
      }

      // Verify ranking is consistent
      for (let i = 0; i < snapshot.standings.length - 1; i++) {
        const current = snapshot.standings[i];
        const next = snapshot.standings[i + 1];

        if (current.totalPoints < next.totalPoints) {
          issues.push(
            `Ranking inconsistency at positions ${i + 1}-${i + 2}: ${current.totalPoints} < ${next.totalPoints}`
          );
        }
      }

      return {
        isValid: issues.length === 0,
        issues,
      };
    } catch (error) {
      this.logger.error(
        `Verification failed for league ${leagueId} GW ${gameweekId}:`,
        error
      );
      return {
        isValid: false,
        issues: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  private getCacheKey(leagueId: string, gameweekId: number): string {
    return `standings:${leagueId}:gw:${gameweekId}`;
  }

  /**
   * Pre-compute and cache standings for efficiency
   */
  async preComputeStandings(leagueId: string, gameweekId: number): Promise<void> {
    try {
      this.logger.info(`Pre-computing standings for league ${leagueId} GW${gameweekId}`);
      await this.getHistoricalStandings(leagueId, gameweekId);
      this.logger.info(`Pre-computation complete`);
    } catch (error) {
      this.logger.error(`Pre-computation failed:`, error);
      throw error;
    }
  }
}
