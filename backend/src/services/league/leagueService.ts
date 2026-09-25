import crypto from "crypto";
import { prisma } from "../../config/db.js";
import {
  LeagueStatus,
  MembershipStatus,
  PaymentStatus,
  ScoringType,
  CreateLeagueInput,
  LeagueStandingsEntry,
  H2HStandingsEntry,
} from "../../types/index.js";
import { PrizeService } from "./prizeService.js";
import { ScoringService } from "../scoring/scoringService.js";

/** A scheduled H2H pairing. awayMemberId null = the league 'Average' team. */
export interface H2HPairing {
  gameweekId: number;
  homeMemberId: string;
  awayMemberId: string | null;
}

export const MAX_LEAGUE_MEMBERS = 100_000;

export class LeagueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeagueValidationError";
  }
}

export class LeagueNotFoundError extends Error {
  constructor(leagueId: string) {
    super(`League with ID ${leagueId} was not found`);
    this.name = "LeagueNotFoundError";
  }
}

export class LeagueForbiddenError extends Error {
  constructor(message: string = "You do not have permission to perform this action") {
    super(message);
    this.name = "LeagueForbiddenError";
  }
}

export class LeagueService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  /**
   * Generates a unique, URL-safe 6-character alphanumeric invite code.
   */
  public static generateInviteCode(): string {
    return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
  }

  /**
   * Creates a new fantasy league and registers the creator as the first pending member.
   */
  public async createLeague(userId: string, input: CreateLeagueInput) {
    if (!input.name || input.name.trim().length === 0) {
      throw new LeagueValidationError("League name is required");
    }
    if (input.name.trim().length > 60) {
      throw new LeagueValidationError("League name must not exceed 60 characters");
    }
    if (input.entryFee < 0) {
      throw new LeagueValidationError("Entry fee must be 0 or greater");
    }

    const scoringType = input.scoringType ?? ScoringType.CLASSIC;
    if (!Object.values(ScoringType).includes(scoringType)) {
      throw new LeagueValidationError(`Invalid scoring type: ${scoringType}`);
    }

    const maxMembers = input.maxMembers ?? 20;
    const minMembers = input.minMembers ?? 2;

    if (maxMembers < 2 || maxMembers > MAX_LEAGUE_MEMBERS) {
      throw new LeagueValidationError(
        `Maximum participants must be between 2 and ${MAX_LEAGUE_MEMBERS}`
      );
    }
    if (minMembers < 2 || minMembers > maxMembers) {
      throw new LeagueValidationError(
        `Minimum participants must be at least 2 and cannot exceed maximum (${maxMembers})`
      );
    }

    // Verify creator exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new LeagueValidationError(`User with ID ${userId} not found`);
    }

    // Verify creator's squad exists and belongs to them
    const squad = await prisma.squad.findFirst({
      where: { id: input.squadId, userId },
    });
    if (!squad) {
      throw new LeagueValidationError(
        "Creator must specify a valid fantasy squad they own to create a league"
      );
    }

    // Verify start and end gameweeks exist
    const [startGw, endGw] = await Promise.all([
      prisma.gameweek.findUnique({ where: { id: input.startGameweekId } }),
      prisma.gameweek.findUnique({ where: { id: input.endGameweekId } }),
    ]);

    if (!startGw || !endGw) {
      throw new LeagueValidationError("Specified start or end gameweek does not exist");
    }

    if (endGw.fplId < startGw.fplId) {
      throw new LeagueValidationError(
        `End gameweek (${endGw.name}) cannot be earlier than start gameweek (${startGw.name})`
      );
    }

    // Ensure start gameweek deadline has not already passed
    if (new Date().getTime() >= startGw.deadline.getTime()) {
      throw new LeagueValidationError(
        `Cannot create league for Gameweek ${startGw.fplId}: deadline has already passed on ${startGw.deadline.toISOString()}`
      );
    }

    // Generate unique invite code
    let inviteCode = LeagueService.generateInviteCode();
    let codeExists = await prisma.league.findUnique({ where: { inviteCode } });
    let attempts = 0;
    while (codeExists && attempts < 5) {
      inviteCode = LeagueService.generateInviteCode();
      codeExists = await prisma.league.findUnique({ where: { inviteCode } });
      attempts++;
    }

    // Calculate initial estimated prize pool based on entry fee and creator joining
    const prizeCalc = PrizeService.calculatePrizeDistribution(1, input.entryFee);

    return prisma.$transaction(async (tx) => {
      const league = await tx.league.create({
        data: {
          name: input.name.trim(),
          description: input.description?.trim() || null,
          creatorId: userId,
          inviteCode,
          entryFee: input.entryFee,
          maxMembers,
          minMembers,
          currentMembers: 1,
          prizePool: prizeCalc.prizePool,
          status: LeagueStatus.UPCOMING,
          scoringType,
          startGameweekId: startGw.id,
          endGameweekId: endGw.id,
        },
      });

      // Automatically register creator as first member with status PENDING (awaiting payment confirmation)
      await tx.leagueMember.create({
        data: {
          leagueId: league.id,
          userId,
          squadId: input.squadId,
          status: input.entryFee === 0 ? MembershipStatus.ACTIVE : MembershipStatus.PENDING,
          hasPaid: input.entryFee === 0,
        },
      });

      return tx.league.findUnique({
        where: { id: league.id },
        include: {
          creator: { select: { id: true, username: true } },
          startGameweek: true,
          endGameweek: true,
          members: {
            include: {
              user: { select: { id: true, username: true } },
              squad: { select: { id: true, name: true } },
            },
          },
        },
      });
    });
  }

  /**
   * Joins an upcoming league with a valid fantasy squad.
   */
  public async joinLeague(leagueId: string, userId: string, squadId: string) {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: { startGameweek: true },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }

    // 1. Must be in UPCOMING state
    if (league.status !== LeagueStatus.UPCOMING) {
      throw new LeagueValidationError(
        `Cannot join league: League is currently ${league.status} (only UPCOMING leagues can be joined)`
      );
    }

    // 2. Start gameweek deadline must not have passed
    if (new Date().getTime() >= league.startGameweek.deadline.getTime()) {
      throw new LeagueValidationError(
        `Cannot join league: Gameweek deadline has passed (${league.startGameweek.deadline.toISOString()})`
      );
    }

    // 3. Capacity check
    if (league.currentMembers >= league.maxMembers) {
      throw new LeagueValidationError(
        `League is full (${league.currentMembers}/${league.maxMembers} participants)`
      );
    }

    // 4. Duplicate membership check
    const existingMember = await prisma.leagueMember.findUnique({
      where: {
        leagueId_userId: {
          leagueId,
          userId,
        },
      },
    });
    if (existingMember) {
      throw new LeagueValidationError("User is already a member of this league");
    }

    // 5. Squad validation
    const squad = await prisma.squad.findFirst({
      where: { id: squadId, userId },
    });
    if (!squad) {
      throw new LeagueValidationError(
        "Invalid squad specified: Squad does not exist or does not belong to you"
      );
    }

    const newMemberCount = league.currentMembers + 1;
    const prizeCalc = PrizeService.calculatePrizeDistribution(
      newMemberCount,
      Number(league.entryFee)
    );

    return prisma.$transaction(async (tx) => {
      const member = await tx.leagueMember.create({
        data: {
          leagueId,
          userId,
          squadId,
          status: Number(league.entryFee) === 0 ? MembershipStatus.ACTIVE : MembershipStatus.PENDING,
          hasPaid: Number(league.entryFee) === 0,
        },
        include: {
          user: { select: { id: true, username: true } },
          squad: { select: { id: true, name: true } },
        },
      });

      await tx.league.update({
        where: { id: leagueId },
        data: {
          currentMembers: newMemberCount,
          prizePool: prizeCalc.prizePool,
        },
      });

      return member;
    });
  }

  /**
   * Computes deterministic league standings across the competition's gameweek window.
   *
   * Tie-breaking hierarchy:
   * 1. Total Points in the league window (descending)
   * 2. Highest Single Gameweek Score in that window (descending)
   * 3. Earliest joined timestamp (ascending)
   */
  public async getLeagueStandings(leagueId: string): Promise<{
    league: {
      id: string;
      name: string;
      status: LeagueStatus;
      entryFee: number;
      prizePool: number;
      startGameweek: { id: number; name: string };
      endGameweek: { id: number; name: string };
    };
    standings: LeagueStandingsEntry[];
    prizeDistribution: ReturnType<typeof PrizeService.calculatePrizeDistribution>;
  }> {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: {
        startGameweek: true,
        endGameweek: true,
        members: {
          include: {
            user: { select: { id: true, username: true } },
            squad: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }

    const squadIds = league.members.map((m) => m.squadId);

    // Fetch all gameweek scores within the competition window [startGameweekId, endGameweekId]
    const gameweekScores = await prisma.squadGameweekScore.findMany({
      where: {
        squadId: { in: squadIds },
        gameweekId: {
          gte: league.startGameweekId,
          lte: league.endGameweekId,
        },
      },
      include: {
        gameweek: { select: { id: true, name: true } },
      },
    });

    // Group scores by squadId
    const scoresBySquad = new Map<
      string,
      Array<{ gameweekId: number; gameweekName: string; points: number }>
    >();

    for (const score of gameweekScores) {
      const list = scoresBySquad.get(score.squadId) || [];
      list.push({
        gameweekId: score.gameweekId,
        gameweekName: score.gameweek.name,
        points: score.points,
      });
      scoresBySquad.set(score.squadId, list);
    }

    // Build standings items
    const rawEntries = league.members.map((m) => {
      const scores = scoresBySquad.get(m.squadId) || [];
      const totalPoints = scores.reduce((sum, s) => sum + s.points, 0);
      const bestGameweekPoints = scores.length > 0
        ? Math.max(...scores.map((s) => s.points))
        : 0;

      return {
        userId: m.userId,
        username: m.user.username,
        squadId: m.squadId,
        squadName: m.squad.name,
        membershipStatus: m.status,
        totalPoints,
        bestGameweekPoints,
        gameweekScores: scores.sort((a, b) => a.gameweekId - b.gameweekId),
        joinedAt: m.joinedAt,
      };
    });

    // Deterministic Sort
    rawEntries.sort((a, b) => {
      // 1. Total Points (descending)
      if (b.totalPoints !== a.totalPoints) {
        return b.totalPoints - a.totalPoints;
      }
      // 2. Highest Single Gameweek Score (descending)
      if (b.bestGameweekPoints !== a.bestGameweekPoints) {
        return b.bestGameweekPoints - a.bestGameweekPoints;
      }
      // 3. Earliest Join Date (ascending)
      return a.joinedAt.getTime() - b.joinedAt.getTime();
    });

    // Assign sequential ranks
    const standings: LeagueStandingsEntry[] = rawEntries.map((entry, idx) => ({
      rank: idx + 1,
      ...entry,
    }));

    const prizeDistribution = PrizeService.calculatePrizeDistribution(
      league.currentMembers,
      Number(league.entryFee)
    );

    return {
      league: {
        id: league.id,
        name: league.name,
        status: league.status,
        entryFee: Number(league.entryFee),
        prizePool: Number(league.prizePool),
        startGameweek: {
          id: league.startGameweek.id,
          name: league.startGameweek.name,
        },
        endGameweek: {
          id: league.endGameweek.id,
          name: league.endGameweek.name,
        },
      },
      standings,
      prizeDistribution,
    };
  }

  /**
   * Transitions a league through its lifecycle state machine.
   */
  public async transitionStatus(leagueId: string, targetStatus: LeagueStatus) {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: { startGameweek: true, endGameweek: true },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }

    const currentStatus = league.status;

    // Validate state machine rules
    if (currentStatus === targetStatus) {
      return league;
    }

    if (currentStatus === LeagueStatus.COMPLETED || currentStatus === LeagueStatus.CANCELLED) {
      throw new LeagueValidationError(
        `Cannot transition from terminal state ${currentStatus}`
      );
    }

    if (targetStatus === LeagueStatus.ACTIVE) {
      if (currentStatus !== LeagueStatus.UPCOMING) {
        throw new LeagueValidationError(
          `Cannot transition to ACTIVE from ${currentStatus}`
        );
      }
      if (league.currentMembers < league.minMembers) {
        throw new LeagueValidationError(
          `Cannot activate league: Minimum participants not met (${league.currentMembers}/${league.minMembers})`
        );
      }
    }

    if (targetStatus === LeagueStatus.COMPLETED) {
      if (currentStatus !== LeagueStatus.ACTIVE) {
        throw new LeagueValidationError(
          `Cannot transition to COMPLETED from ${currentStatus}`
        );
      }
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.league.update({
        where: { id: leagueId },
        data: { status: targetStatus },
      });

      // If cancelling, mark all members as REFUNDED and queue confirmed deposits for refund
      if (targetStatus === LeagueStatus.CANCELLED) {
        await tx.leagueMember.updateMany({
          where: { leagueId },
          data: { status: MembershipStatus.REFUNDED },
        });
        await tx.leagueMember.updateMany({
          where: { leagueId, paymentStatus: PaymentStatus.PAYMENT_CONFIRMED },
          data: { paymentStatus: PaymentStatus.REFUND_PENDING },
        });
      }

      // Head-to-head leagues get their round-robin schedule on activation
      if (
        targetStatus === LeagueStatus.ACTIVE &&
        league.scoringType === ScoringType.HEAD_TO_HEAD
      ) {
        const members = await tx.leagueMember.findMany({
          where: { leagueId, status: MembershipStatus.ACTIVE },
          orderBy: { joinedAt: "asc" },
          select: { id: true },
        });
        const gameweeks = await tx.gameweek.findMany({
          where: { id: { gte: league.startGameweekId, lte: league.endGameweekId } },
          orderBy: { id: "asc" },
          select: { id: true },
        });

        const pairings = LeagueService.generateRoundRobinSchedule(
          members.map((m) => m.id),
          gameweeks.map((g) => g.id)
        );
        await tx.leagueFixture.createMany({
          data: pairings.map((p) => ({ leagueId, ...p })),
        });
      }

      return updated;
    });
  }

  /**
   * Generates a balanced round-robin H2H schedule using the circle method.
   * Every member meets every other member once per cycle and plays exactly once
   * per gameweek. With an odd member count a dummy 'Average' team (null) is added.
   * When there are more gameweeks than rounds the cycle repeats with home/away reversed.
   */
  public static generateRoundRobinSchedule(
    memberIds: string[],
    gameweekIds: number[]
  ): H2HPairing[] {
    if (memberIds.length < 2) {
      return [];
    }
    const teams: Array<string | null> = [...memberIds];
    if (teams.length % 2 === 1) {
      teams.push(null);
    }
    const n = teams.length;

    // Build one full cycle of n-1 rounds
    const rounds: Array<Array<[string | null, string | null]>> = [];
    let rotation = [...teams];
    for (let r = 0; r < n - 1; r++) {
      const round: Array<[string | null, string | null]> = [];
      for (let i = 0; i < n / 2; i++) {
        const a = rotation[i];
        const b = rotation[n - 1 - i];
        // Alternate home advantage each round
        round.push(r % 2 === 0 ? [a, b] : [b, a]);
      }
      rounds.push(round);
      // Keep the first team fixed, rotate the rest clockwise
      rotation = [rotation[0], rotation[n - 1], ...rotation.slice(1, n - 1)];
    }

    const pairings: H2HPairing[] = [];
    gameweekIds.forEach((gameweekId, idx) => {
      const round = rounds[idx % rounds.length];
      const reversed = Math.floor(idx / rounds.length) % 2 === 1;

      for (const [first, second] of round) {
        let home = reversed ? second : first;
        let away = reversed ? first : second;
        // The Average team is always recorded as the away side
        if (home === null) {
          [home, away] = [away, home];
        }
        pairings.push({ gameweekId, homeMemberId: home as string, awayMemberId: away });
      }
    });

    return pairings;
  }

  /**
   * Orders an H2H table by h2hPoints DESC, pointsFor DESC, pointsDifference DESC.
   */
  public static sortH2HStandings(
    entries: Array<Omit<H2HStandingsEntry, "rank" | "pointsDifference">>
  ): H2HStandingsEntry[] {
    return entries
      .map((e) => ({ ...e, pointsDifference: e.pointsFor - e.pointsAgainst }))
      .sort(
        (a, b) =>
          b.h2hPoints - a.h2hPoints ||
          b.pointsFor - a.pointsFor ||
          b.pointsDifference - a.pointsDifference
      )
      .map((e, idx) => ({ rank: idx + 1, ...e }));
  }

  /**
   * Resolves all unfinished H2H fixtures of a league for a completed gameweek,
   * updates member H2H statistics and refreshes table ranks.
   * The 'Average' team scores the rounded mean of all active members that gameweek.
   */
  public async settleH2HGameweek(leagueId: string, gameweekId: number) {
    const fixtures = await this.db.leagueFixture.findMany({
      where: { leagueId, gameweekId, isFinished: false },
    });
    if (fixtures.length === 0) {
      return { settled: 0 };
    }

    const members = await this.db.leagueMember.findMany({
      where: { leagueId, status: MembershipStatus.ACTIVE },
    });
    const scores = await this.db.squadGameweekScore.findMany({
      where: { gameweekId, squadId: { in: members.map((m: any) => m.squadId) } },
    });

    const pointsBySquad = new Map<string, number>(
      scores.map((s: any) => [s.squadId, s.points])
    );
    const pointsByMember = new Map<string, number>(
      members.map((m: any) => [m.id, pointsBySquad.get(m.squadId) ?? 0])
    );
    const memberPoints = [...pointsByMember.values()];
    const averageScore =
      memberPoints.length > 0
        ? Math.round(memberPoints.reduce((a, b) => a + b, 0) / memberPoints.length)
        : 0;

    const outcomeData = (points: number, scored: number, conceded: number) => ({
      matchesWon: { increment: points === 3 ? 1 : 0 },
      matchesDrawn: { increment: points === 1 ? 1 : 0 },
      matchesLost: { increment: points === 0 ? 1 : 0 },
      pointsFor: { increment: scored },
      pointsAgainst: { increment: conceded },
      h2hPoints: { increment: points },
    });

    await this.db.$transaction(async (tx: any) => {
      for (const fixture of fixtures) {
        const homeScore = pointsByMember.get(fixture.homeMemberId) ?? 0;
        const awayScore = fixture.awayMemberId
          ? pointsByMember.get(fixture.awayMemberId) ?? 0
          : averageScore;
        const result = ScoringService.resolveHeadToHead(homeScore, awayScore);

        await tx.leagueFixture.update({
          where: { id: fixture.id },
          data: { homeScore, awayScore, isFinished: true },
        });
        await tx.leagueMember.update({
          where: { id: fixture.homeMemberId },
          data: outcomeData(result.homePoints, homeScore, awayScore),
        });
        if (fixture.awayMemberId) {
          await tx.leagueMember.update({
            where: { id: fixture.awayMemberId },
            data: outcomeData(result.awayPoints, awayScore, homeScore),
          });
        }
      }

      const updatedMembers = await tx.leagueMember.findMany({
        where: { leagueId, status: MembershipStatus.ACTIVE },
      });
      const table = LeagueService.sortH2HStandings(
        updatedMembers.map((m: any) => ({
          memberId: m.id,
          userId: m.userId,
          username: "",
          squadName: "",
          matchesWon: m.matchesWon,
          matchesDrawn: m.matchesDrawn,
          matchesLost: m.matchesLost,
          pointsFor: m.pointsFor,
          pointsAgainst: m.pointsAgainst,
          h2hPoints: m.h2hPoints,
        }))
      );
      for (const row of table) {
        await tx.leagueMember.update({
          where: { id: row.memberId },
          data: { rank: row.rank },
        });
      }
    });

    return { settled: fixtures.length };
  }

  /**
   * Returns the official H2H table for a head-to-head league.
   */
  public async getH2HStandings(leagueId: string): Promise<H2HStandingsEntry[]> {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: {
        members: {
          where: { status: MembershipStatus.ACTIVE },
          include: {
            user: { select: { username: true } },
            squad: { select: { name: true } },
          },
        },
      },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }
    if (league.scoringType !== ScoringType.HEAD_TO_HEAD) {
      throw new LeagueValidationError("League does not use head-to-head scoring");
    }

    return LeagueService.sortH2HStandings(
      league.members.map((m: any) => ({
        memberId: m.id,
        userId: m.userId,
        username: m.user.username,
        squadName: m.squad.name,
        matchesWon: m.matchesWon,
        matchesDrawn: m.matchesDrawn,
        matchesLost: m.matchesLost,
        pointsFor: m.pointsFor,
        pointsAgainst: m.pointsAgainst,
        h2hPoints: m.h2hPoints,
      }))
    );
  }

  /**
   * True when a league missed its minimum member threshold and its start
   * gameweek has kicked off (falls back to the deadline when no kickoff is known).
   */
  public static isUnderfilledAfterKickoff(
    league: { currentMembers: number; minMembers: number },
    startGameweek: { deadline: Date; firstKickoff?: Date | null },
    now: Date = new Date()
  ): boolean {
    const kickoff = startGameweek.firstKickoff ?? startGameweek.deadline;
    return (
      league.currentMembers < league.minMembers &&
      now.getTime() >= kickoff.getTime()
    );
  }

  /**
   * Cancels every UPCOMING league that did not reach minMembers by its start
   * gameweek kickoff. Returns the IDs of the cancelled leagues.
   */
  public async cancelUnderfilledLeagues(now: Date = new Date()): Promise<string[]> {
    const leagues = await this.db.league.findMany({
      where: { status: LeagueStatus.UPCOMING },
      include: {
        startGameweek: {
          include: {
            fixtures: {
              where: { kickoffTime: { not: null } },
              orderBy: { kickoffTime: "asc" },
              take: 1,
            },
          },
        },
      },
    });

    const cancelled: string[] = [];
    for (const league of leagues) {
      const firstKickoff = league.startGameweek.fixtures[0]?.kickoffTime ?? null;
      if (
        LeagueService.isUnderfilledAfterKickoff(
          league,
          { deadline: league.startGameweek.deadline, firstKickoff },
          now
        )
      ) {
        await this.transitionStatus(league.id, LeagueStatus.CANCELLED);
        cancelled.push(league.id);
      }
    }
    return cancelled;
  }

  /**
   * Cancels an upcoming league. Only the creator is authorized to do so.
   */
  public async cancelLeague(leagueId: string, requesterUserId: string) {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }

    if (league.creatorId !== requesterUserId) {
      throw new LeagueForbiddenError(
        "Only the league creator has permission to cancel this league"
      );
    }

    if (league.status !== LeagueStatus.UPCOMING) {
      throw new LeagueValidationError(
        `Cannot cancel league: League status is ${league.status} (only UPCOMING leagues can be cancelled)`
      );
    }

    return this.transitionStatus(leagueId, LeagueStatus.CANCELLED);
  }

  /**
  * Retrieves a single league with gameweeks and creator info.
   */
  public async getLeagueById(leagueId: string) {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: {
        creator: { select: { id: true, username: true } },
        startGameweek: true,
        endGameweek: true,
      },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }

    const prizeDistribution = PrizeService.calculatePrizeDistribution(
      league.currentMembers,
      Number(league.entryFee)
    );

    return {
      ...league,
      prizeDistribution,
    };
  }

  /** Retrieves one page without loading the full membership relation. */
  public async getLeagueMembers(leagueId: string, page: number, limit: number) {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      select: { id: true },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }

    const skip = (page - 1) * limit;
    const [members, total] = await Promise.all([
      this.db.leagueMember.findMany({
        where: { leagueId },
        include: {
          user: { select: { id: true, username: true } },
          squad: { select: { id: true, name: true } },
        },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        skip,
        take: limit,
      }),
      this.db.leagueMember.count({ where: { leagueId } }),
    ]);

    return {
      members,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Retrieves all public leagues with optional status filtering.
   */
  public async getLeagues(filters?: { status?: LeagueStatus; creatorId?: string }) {
    const where: any = {};
    if (filters?.status) {
      where.status = filters.status;
    }
    if (filters?.creatorId) {
      where.creatorId = filters.creatorId;
    }

    return prisma.league.findMany({
      where,
      include: {
        creator: { select: { id: true, username: true } },
        startGameweek: { select: { id: true, name: true, deadline: true } },
        endGameweek: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }
}

export const leagueService = new LeagueService();
