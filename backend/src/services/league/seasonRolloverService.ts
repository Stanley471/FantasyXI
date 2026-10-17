import crypto from "crypto";
import { LeagueService, LeagueValidationError, LeagueNotFoundError } from "./leagueService.js";

export type TrophyType =
  | "GOLD_CHAMPION"
  | "SILVER_RUNNER_UP"
  | "BRONZE_PODIUM"
  | "HIGHEST_GW_SCORER";

export interface SeasonStandingEntry {
  userId: string;
  username: string;
  squadId: string;
  squadName: string;
  rank: number;
  totalPoints: number;
  highestGameweekPoints: number;
  highestGameweekId: number;
  prizeWon: number;
  h2hWins?: number;
  h2hDraws?: number;
  h2hLosses?: number;
  h2hPoints?: number;
}

export interface LeagueTrophyAward {
  id: string;
  userId: string;
  username: string;
  leagueId: string;
  leagueName: string;
  seasonKey: string;
  trophyType: TrophyType;
  rank?: number;
  points: number;
  awardedAt: Date;
}

export interface LeagueSeasonArchive {
  archiveId: string;
  leagueId: string;
  leagueName: string;
  seasonKey: string;
  startGameweekId: number;
  endGameweekId: number;
  prizePool: number;
  championUserId: string;
  championUsername: string;
  highestSingleGwScore: {
    userId: string;
    username: string;
    gameweekId: number;
    points: number;
  };
  finalStandings: ReadonlyArray<Readonly<SeasonStandingEntry>>;
  trophiesAwarded: ReadonlyArray<Readonly<LeagueTrophyAward>>;
  archivedAt: Date;
}

export interface RolloverLeagueState {
  id: string;
  name: string;
  inviteCode: string;
  adminId: string;
  seasonKey: string;
  status: "COMPLETED" | "ACTIVE" | "OPEN";
  startGameweekId: number;
  endGameweekId: number;
  prizePool: number;
  members: Array<{
    userId: string;
    username: string;
    squadId: string;
    squadName: string;
    totalPoints: number;
    rank: number | null;
    prizeWon: number;
    highestGameweekPoints: number;
    highestGameweekId: number;
    h2hWins?: number;
    h2hDraws?: number;
    h2hLosses?: number;
    h2hPoints?: number;
  }>;
  h2hScheduleCount: number;
}

export interface RolloverCampaignOptions {
  newSeasonKey?: string;
  newStartGameweekId: number;
  newEndGameweekId: number;
  retainMembers?: boolean;
  /** Optional hook for injecting failure in tests to verify atomic rollback */
  beforeCommitHook?: () => void;
}

export interface RolloverResult {
  archive: LeagueSeasonArchive;
  updatedLeague: RolloverLeagueState;
  trophies: LeagueTrophyAward[];
}

export class SeasonRolloverService {
  private readonly leagues = new Map<string, RolloverLeagueState>();
  private readonly archivesByLeague = new Map<string, LeagueSeasonArchive[]>();
  private readonly trophiesByUser = new Map<string, LeagueTrophyAward[]>();

  public registerLeagueState(league: RolloverLeagueState): void {
    this.leagues.set(league.id, structuredClone(league));
  }

  public getLeagueState(leagueId: string): RolloverLeagueState {
    const state = this.leagues.get(leagueId);
    if (!state) {
      throw new LeagueNotFoundError(leagueId);
    }
    return structuredClone(state);
  }

  /**
   * Atomically archives a completed league season, awards podium & top-scorer trophies,
   * and resets the league state for the next multi-gameweek campaign while preserving
   * the league inviteCode, admin, and member roster.
   */
  public rolloverLeagueSeason(
    leagueId: string,
    options: RolloverCampaignOptions,
    now: Date = new Date()
  ): RolloverResult {
    const current = this.leagues.get(leagueId);
    if (!current) {
      throw new LeagueNotFoundError(leagueId);
    }

    if (current.status !== "COMPLETED") {
      throw new LeagueValidationError(
        `Cannot rollover league ${leagueId}: current status is ${current.status}, expected COMPLETED`
      );
    }

    if (
      options.newStartGameweekId <= 0 ||
      options.newEndGameweekId < options.newStartGameweekId
    ) {
      throw new LeagueValidationError(
        "Invalid gameweek range for new campaign: newEndGameweekId must be >= newStartGameweekId"
      );
    }

    if (current.members.length === 0) {
      throw new LeagueValidationError("Cannot archive a league season with zero members");
    }

    const existingArchives = this.archivesByLeague.get(leagueId) ?? [];
    if (existingArchives.some((a) => a.seasonKey === current.seasonKey)) {
      throw new LeagueValidationError(
        `Season ${current.seasonKey} for league ${leagueId} has already been archived`
      );
    }

    // Take deep snapshots for rollback safety
    const leagueSnapshot = structuredClone(current);
    const archivesSnapshot = structuredClone(existingArchives);

    try {
      // 1. Compute final ordered standings (by h2hPoints then totalPoints descending)
      const sortedMembers = [...current.members].sort((a, b) => {
        const aH2H = a.h2hPoints ?? 0;
        const bH2H = b.h2hPoints ?? 0;
        if (bH2H !== aH2H) return bH2H - aH2H;
        if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
        return b.highestGameweekPoints - a.highestGameweekPoints;
      });

      const finalStandings: SeasonStandingEntry[] = sortedMembers.map((m, idx) =>
        Object.freeze({
          userId: m.userId,
          username: m.username,
          squadId: m.squadId,
          squadName: m.squadName,
          rank: idx + 1,
          totalPoints: m.totalPoints,
          highestGameweekPoints: m.highestGameweekPoints,
          highestGameweekId: m.highestGameweekId,
          prizeWon: m.prizeWon,
          h2hWins: m.h2hWins,
          h2hDraws: m.h2hDraws,
          h2hLosses: m.h2hLosses,
          h2hPoints: m.h2hPoints,
        })
      );

      // 2. Determine highest single-gameweek scorer
      const topGwMember = [...current.members].sort(
        (a, b) => b.highestGameweekPoints - a.highestGameweekPoints
      )[0];

      // 3. Generate podium and highest-GW trophies
      const trophies: LeagueTrophyAward[] = [];
      const podiumMap: Array<{ rank: number; type: TrophyType }> = [
        { rank: 1, type: "GOLD_CHAMPION" },
        { rank: 2, type: "SILVER_RUNNER_UP" },
        { rank: 3, type: "BRONZE_PODIUM" },
      ];

      for (const { rank, type } of podiumMap) {
        const finisher = finalStandings[rank - 1];
        if (finisher) {
          trophies.push(
            Object.freeze({
              id: crypto.randomUUID(),
              userId: finisher.userId,
              username: finisher.username,
              leagueId: current.id,
              leagueName: current.name,
              seasonKey: current.seasonKey,
              trophyType: type,
              rank,
              points: finisher.totalPoints,
              awardedAt: now,
            })
          );
        }
      }

      if (topGwMember && topGwMember.highestGameweekPoints > 0) {
        trophies.push(
          Object.freeze({
            id: crypto.randomUUID(),
            userId: topGwMember.userId,
            username: topGwMember.username,
            leagueId: current.id,
            leagueName: current.name,
            seasonKey: current.seasonKey,
            trophyType: "HIGHEST_GW_SCORER",
            points: topGwMember.highestGameweekPoints,
            awardedAt: now,
          })
        );
      }

      const champion = finalStandings[0];
      const archive: LeagueSeasonArchive = Object.freeze({
        archiveId: crypto.randomUUID(),
        leagueId: current.id,
        leagueName: current.name,
        seasonKey: current.seasonKey,
        startGameweekId: current.startGameweekId,
        endGameweekId: current.endGameweekId,
        prizePool: current.prizePool,
        championUserId: champion.userId,
        championUsername: champion.username,
        highestSingleGwScore: Object.freeze({
          userId: topGwMember.userId,
          username: topGwMember.username,
          gameweekId: topGwMember.highestGameweekId,
          points: topGwMember.highestGameweekPoints,
        }),
        finalStandings: Object.freeze(finalStandings),
        trophiesAwarded: Object.freeze(trophies),
        archivedAt: now,
      });

      // 4. Prepare reset league state for the next campaign
      const nextSeasonKey =
        options.newSeasonKey ?? LeagueService.nextSeasonKey(current.seasonKey);
      const retainMembers = options.retainMembers ?? true;

      const resetMembers = retainMembers
        ? current.members.map((m) => ({
            ...m,
            totalPoints: 0,
            rank: null,
            prizeWon: 0,
            highestGameweekPoints: 0,
            highestGameweekId: options.newStartGameweekId,
            h2hWins: 0,
            h2hDraws: 0,
            h2hLosses: 0,
            h2hPoints: 0,
          }))
        : [];

      const updatedLeague: RolloverLeagueState = {
        ...current,
        seasonKey: nextSeasonKey,
        status: "OPEN",
        startGameweekId: options.newStartGameweekId,
        endGameweekId: options.newEndGameweekId,
        prizePool: 0,
        members: resetMembers,
        h2hScheduleCount: 0,
      };

      // Execute optional pre-commit hook (used to test atomic rollback on error)
      if (options.beforeCommitHook) {
        options.beforeCommitHook();
      }

      // 5. Commit all state mutations atomically
      this.leagues.set(leagueId, updatedLeague);
      this.archivesByLeague.set(leagueId, [...existingArchives, archive]);

      for (const trophy of trophies) {
        const userList = this.trophiesByUser.get(trophy.userId) ?? [];
        userList.push(trophy);
        this.trophiesByUser.set(trophy.userId, userList);
      }

      return {
        archive,
        updatedLeague: structuredClone(updatedLeague),
        trophies,
      };
    } catch (error) {
      // Restore snapshots on any failure
      this.leagues.set(leagueId, leagueSnapshot);
      this.archivesByLeague.set(leagueId, archivesSnapshot);
      throw error;
    }
  }

  public getLeagueHistory(leagueId: string): ReadonlyArray<LeagueSeasonArchive> {
    return this.archivesByLeague.get(leagueId) ?? [];
  }

  public getUserTrophyCabinet(userId: string): ReadonlyArray<LeagueTrophyAward> {
    return this.trophiesByUser.get(userId) ?? [];
  }
}

export const seasonRolloverService = new SeasonRolloverService();
