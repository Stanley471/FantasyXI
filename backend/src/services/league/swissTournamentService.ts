import { prisma } from "../../config/db.js";
import { MembershipStatus, ScoringType } from "../../types/index.js";
import {
  SwissMatchRecord,
  SwissStanding,
  computeSwissStandings,
  generateSwissPairings,
  resolveSwissResult,
} from "./swissPairingEngine.js";

export class SwissTournamentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwissTournamentError";
  }
}

export class SwissLeagueNotFoundError extends Error {
  constructor(leagueId: string) {
    super(`League with ID ${leagueId} was not found`);
    this.name = "SwissLeagueNotFoundError";
  }
}

export interface SwissStandingsEntry extends Omit<SwissStanding, "opponents"> {
  userId: string;
  username: string;
  squadName: string;
}

/**
 * Swiss-system tournament runner for SWISS leagues (issue #270).
 *
 * One round is played per gameweek of the league window:
 * - activation creates the tournament and pairs round 1 for the start gameweek;
 * - after each gameweek is settled, `processGameweek` resolves that round from
 *   squad scores, snapshots the standings and pairs the next gameweek.
 * Every step is idempotent so the settlement job can be retried safely.
 * Pairing rules and tie-breaks live in swissPairingEngine.ts.
 */
export class SwissTournamentPairingService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  /** Runs `fn` atomically; reuses the caller's transaction when constructed with one. */
  private async inTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return typeof this.db.$transaction === "function" ? this.db.$transaction(fn) : fn(this.db);
  }

  private async getTournament(leagueId: string, seasonNumber?: number) {
    const league = await this.db.league.findUnique({ where: { id: leagueId } });
    if (!league) throw new SwissLeagueNotFoundError(leagueId);
    if (league.scoringType !== ScoringType.SWISS) {
      throw new SwissTournamentError("League does not use Swiss-system scoring");
    }
    const tournament = await this.db.swissTournament.findUnique({
      where: { leagueId_seasonNumber: { leagueId, seasonNumber: seasonNumber ?? league.seasonNumber ?? 1 } },
    });
    return { league, tournament };
  }

  private async activeMembers(leagueId: string) {
    return this.db.leagueMember.findMany({
      where: { leagueId, status: MembershipStatus.ACTIVE },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * Creates the tournament for the league's current season and pairs round 1.
   * Called when a SWISS league is activated. Returns the existing tournament
   * if one was already started.
   */
  public async startTournament(leagueId: string) {
    const { league, tournament: existing } = await this.getTournament(leagueId);
    if (existing) return existing;

    const members = await this.activeMembers(leagueId);
    if (members.length < 2) {
      throw new SwissTournamentError("A Swiss tournament needs at least 2 active members");
    }
    const gameweeks = await this.db.gameweek.findMany({
      where: { id: { gte: league.startGameweekId, lte: league.endGameweekId } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (gameweeks.length === 0) {
      throw new SwissTournamentError("The league window contains no gameweeks");
    }

    return this.inTransaction(async (tx) => {
      const tournament = await tx.swissTournament.create({
        data: {
          leagueId,
          seasonNumber: league.seasonNumber ?? 1,
          totalRounds: gameweeks.length,
        },
      });
      await this.pairRound(tx, tournament, members, gameweeks[0].id);
      return tx.swissTournament.findUnique({ where: { id: tournament.id } });
    });
  }

  /** Pairs the round after `tournament.currentRound` for `gameweekId` (call inside a transaction). */
  private async pairRound(tx: any, tournament: any, members: any[], gameweekId: number) {
    const round = tournament.currentRound + 1;
    const matches: SwissMatchRecord[] = await tx.swissPairing.findMany({
      where: { tournamentId: tournament.id },
    });
    const seeds = new Map<string, number>(members.map((m: any, idx: number) => [m.id, idx]));
    const standings = computeSwissStandings(members.map((m: any) => m.id), matches, seeds);
    const plan = generateSwissPairings(standings, matches);

    await tx.swissPairing.createMany({
      data: plan.pairings.map((p) => ({
        tournamentId: tournament.id,
        round,
        gameweekId,
        tableNumber: p.tableNumber,
        playerAId: p.playerAId,
        playerBId: p.playerBId,
        isRematch: p.isRematch,
      })),
    });
    await tx.swissTournament.update({
      where: { id: tournament.id },
      data: { currentRound: round },
    });
    return plan;
  }

  /**
   * Resolves the round played in `gameweekId` from squad scores (a bye scores
   * the squad's own points), snapshots the standings, mirrors the record onto
   * league members, then pairs the next gameweek of the window. No-op for a
   * gameweek without pairings.
   */
  public async processGameweek(leagueId: string, gameweekId: number): Promise<{ settled: number; nextRound: number | null }> {
    const { league, tournament } = await this.getTournament(leagueId);
    if (!tournament) return { settled: 0, nextRound: null };

    const pending = await this.db.swissPairing.findMany({
      where: { tournamentId: tournament.id, gameweekId, result: "PENDING" },
    });
    let settledRound: number | null = null;

    if (pending.length > 0) {
      settledRound = pending[0].round;
      const memberIds = pending.flatMap((p: any) => [p.playerAId, p.playerBId]).filter(Boolean);
      const members = await this.db.leagueMember.findMany({ where: { id: { in: memberIds } } });
      const squadByMember = new Map<string, string>(members.map((m: any) => [m.id, m.squadId]));
      const scores = await this.db.squadGameweekScore.findMany({
        where: { gameweekId, squadId: { in: [...squadByMember.values()] } },
      });
      const pointsBySquad = new Map<string, number>(scores.map((s: any) => [s.squadId, s.points]));
      const pointsOf = (memberId: string) => pointsBySquad.get(squadByMember.get(memberId) ?? "") ?? 0;

      await this.inTransaction(async (tx) => {
        const now = new Date();
        for (const pairing of pending) {
          const scoreA = pointsOf(pairing.playerAId);
          const scoreB = pairing.playerBId ? pointsOf(pairing.playerBId) : null;
          await tx.swissPairing.update({
            where: { id: pairing.id },
            data: {
              scoreA,
              scoreB,
              result: pairing.playerBId ? resolveSwissResult(scoreA, scoreB!) : "BYE",
              settledAt: now,
            },
          });
        }
        await this.snapshotStandings(tx, tournament, settledRound!);
      });
    }

    // Pair the next gameweek once this one is fully settled
    const fresh = await this.db.swissTournament.findUnique({ where: { id: tournament.id } });
    if (fresh.status !== "ACTIVE") return { settled: pending.length, nextRound: null };

    const unsettled = await this.db.swissPairing.count({
      where: { tournamentId: tournament.id, result: "PENDING" },
    });
    if (unsettled > 0) return { settled: pending.length, nextRound: null };

    if (fresh.currentRound >= fresh.totalRounds) {
      await this.db.swissTournament.update({ where: { id: fresh.id }, data: { status: "COMPLETED" } });
      return { settled: pending.length, nextRound: null };
    }

    const next = await this.db.gameweek.findFirst({
      where: { id: { gt: gameweekId, lte: league.endGameweekId } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (!next) return { settled: pending.length, nextRound: null };

    const alreadyPaired = await this.db.swissPairing.count({
      where: { tournamentId: fresh.id, gameweekId: next.id },
    });
    if (alreadyPaired > 0) return { settled: pending.length, nextRound: null };

    const members = await this.activeMembers(leagueId);
    if (members.length < 2) return { settled: pending.length, nextRound: null };
    await this.inTransaction((tx) => this.pairRound(tx, fresh, members, next.id));
    return { settled: pending.length, nextRound: fresh.currentRound + 1 };
  }

  /** Writes the round's standings snapshot and mirrors the record onto league members. */
  private async snapshotStandings(tx: any, tournament: any, round: number): Promise<void> {
    const matches: SwissMatchRecord[] = await tx.swissPairing.findMany({
      where: { tournamentId: tournament.id, round: { lte: round } },
    });
    const members = await tx.leagueMember.findMany({
      where: { leagueId: tournament.leagueId, status: MembershipStatus.ACTIVE },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    });
    const seeds = new Map<string, number>(members.map((m: any, idx: number) => [m.id, idx]));
    const standings = computeSwissStandings(members.map((m: any) => m.id), matches, seeds);

    await tx.swissRoundStanding.createMany({
      data: standings.map((s) => ({
        tournamentId: tournament.id,
        round,
        memberId: s.memberId,
        rank: s.rank,
        matchPoints: s.matchPoints,
        wins: s.wins,
        draws: s.draws,
        losses: s.losses,
        byes: s.byes,
        buchholz: s.buchholz,
        sonnebornBerger: s.sonnebornBerger,
        pointsFor: s.pointsFor,
        pointsAgainst: s.pointsAgainst,
        totalSquadScore: s.totalSquadScore,
      })),
      skipDuplicates: true,
    });

    for (const s of standings) {
      await tx.leagueMember.update({
        where: { id: s.memberId },
        data: {
          rank: s.rank,
          matchesWon: s.wins + s.byes,
          matchesDrawn: s.draws,
          matchesLost: s.losses,
          pointsFor: s.pointsFor,
          pointsAgainst: s.pointsAgainst,
          h2hPoints: s.matchPoints,
          totalPoints: s.totalSquadScore,
        },
      });
    }
  }

  /** Live standings with tie-breaks, computed from every settled pairing. */
  public async getStandings(leagueId: string, seasonNumber?: number): Promise<{
    tournament: { id: string; totalRounds: number; currentRound: number; status: string } | null;
    standings: SwissStandingsEntry[];
  }> {
    const { tournament } = await this.getTournament(leagueId, seasonNumber);
    if (!tournament) return { tournament: null, standings: [] };

    const members = await this.db.leagueMember.findMany({
      where: { leagueId, status: MembershipStatus.ACTIVE },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      include: { user: { select: { username: true } }, squad: { select: { name: true } } },
    });
    const byId = new Map<string, any>(members.map((m: any) => [m.id, m]));
    const seeds = new Map<string, number>(members.map((m: any, idx: number) => [m.id, idx]));
    const standings = computeSwissStandings(
      members.map((m: any) => m.id),
      await this.db.swissPairing.findMany({ where: { tournamentId: tournament.id } }),
      seeds
    );

    return {
      tournament: {
        id: tournament.id,
        totalRounds: tournament.totalRounds,
        currentRound: tournament.currentRound,
        status: tournament.status,
      },
      standings: standings.map(({ opponents: _opponents, ...s }) => ({
        ...s,
        userId: byId.get(s.memberId)?.userId ?? "",
        username: byId.get(s.memberId)?.user?.username ?? "",
        squadName: byId.get(s.memberId)?.squad?.name ?? "",
      })),
    };
  }

  /** Pairings of one round (or every round) of the current tournament. */
  public async getPairings(leagueId: string, round?: number) {
    const { tournament } = await this.getTournament(leagueId);
    if (!tournament) return [];
    return this.db.swissPairing.findMany({
      where: { tournamentId: tournament.id, ...(round ? { round } : {}) },
      orderBy: [{ round: "asc" }, { tableNumber: "asc" }],
    });
  }
}

export const swissTournamentService = new SwissTournamentPairingService();
