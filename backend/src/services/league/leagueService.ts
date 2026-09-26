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
  LeagueSearchFilters,
  LeagueSortField,
} from "../../types/index.js";
import { PrizeService } from "./prizeService.js";
import { ScoringService } from "../scoring/scoringService.js";

/** A scheduled H2H pairing. awayMemberId null = the league 'Average' team. */
export interface H2HPairing {
  gameweekId: number;
  homeMemberId: string;
  awayMemberId: string | null;
}

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

/** Raised for invitation links that are unknown, expired, revoked or already used. */
export class LeagueInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeagueInvitationError";
  }
}

/** Default and maximum lifetime of a private league invitation link. */
export const INVITATION_DEFAULT_TTL_HOURS = 72;
export const INVITATION_MAX_TTL_HOURS = 24 * 30;

export const LEAGUE_SEARCH_MAX_PAGE_SIZE = 50;
const LEAGUE_SEARCH_DEFAULT_PAGE_SIZE = 20;
const LEAGUE_SORT_FIELDS: Record<LeagueSortField, string> = {
  newest: "createdAt",
  entryFee: "entryFee",
  size: "maxMembers",
  prizePool: "prizePool",
  members: "currentMembers",
};

export interface LeagueSearchResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
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

    if (input.isPrivate !== undefined && typeof input.isPrivate !== "boolean") {
      throw new LeagueValidationError("isPrivate must be a boolean");
    }

    const maxMembers = input.maxMembers ?? 20;
    const minMembers = input.minMembers ?? 2;

    if (maxMembers < 2 || maxMembers > 100) {
      throw new LeagueValidationError("Maximum participants must be between 2 and 100");
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
          isPrivate: input.isPrivate ?? false,
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
   *
   * Private leagues require a valid invitation token. The invitation is consumed in
   * the same transaction that creates the membership, so a link can never admit
   * more than one user, even under concurrent requests.
   */
  public async joinLeague(
    leagueId: string,
    userId: string,
    squadId: string,
    options: { invitationToken?: string } = {}
  ) {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: { startGameweek: true },
    });

    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }

    // 0. Private leagues are invitation-only
    let invitationId: string | null = null;
    if (league.isPrivate) {
      if (!options.invitationToken) {
        throw new LeagueForbiddenError(
          "This league is private. A valid invitation link is required to join."
        );
      }
      const invitation = await this.findUsableInvitation(options.invitationToken);
      if (invitation.leagueId !== league.id) {
        throw new LeagueInvitationError("This invitation is not valid for this league");
      }
      invitationId = invitation.id;
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
    const existingMember = await this.db.leagueMember.findUnique({
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
    const squad = await this.db.squad.findFirst({
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

    return this.db.$transaction(async (tx: any) => {
      if (invitationId) {
        // Conditional update = atomic single-use check; loses the race if already consumed
        const now = new Date();
        const consumed = await tx.leagueInvitation.updateMany({
          where: {
            id: invitationId,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now, usedById: userId },
        });
        if (consumed.count !== 1) {
          throw new LeagueInvitationError("This invitation link has already been used or has expired");
        }
      }

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

  // ============================================================
  // Private league invitations
  // ============================================================

  /** SHA-256 of a raw invitation token; only the hash is ever persisted. */
  public static hashInvitationToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /** 256-bit URL-safe random token. */
  public static generateInvitationToken(): string {
    return crypto.randomBytes(32).toString("base64url");
  }

  /**
   * Creates a single-use invitation link for a private league. Creator only.
   * The raw token is returned exactly once and cannot be recovered later.
   */
  public async createInvitation(
    leagueId: string,
    requesterUserId: string,
    expiresInHours: number = INVITATION_DEFAULT_TTL_HOURS
  ) {
    if (
      !Number.isFinite(expiresInHours) ||
      expiresInHours < 1 ||
      expiresInHours > INVITATION_MAX_TTL_HOURS
    ) {
      throw new LeagueValidationError(
        `expiresInHours must be between 1 and ${INVITATION_MAX_TTL_HOURS}`
      );
    }

    const league = await this.requireOwnedLeague(leagueId, requesterUserId);
    if (!league.isPrivate) {
      throw new LeagueValidationError(
        "Invitation links are only available for private leagues. Public leagues can be joined directly."
      );
    }
    if (league.status !== LeagueStatus.UPCOMING) {
      throw new LeagueValidationError(
        `Cannot invite members to a league in '${league.status}' status`
      );
    }

    const token = LeagueService.generateInvitationToken();
    const invitation = await this.db.leagueInvitation.create({
      data: {
        leagueId,
        tokenHash: LeagueService.hashInvitationToken(token),
        createdById: requesterUserId,
        expiresAt: new Date(Date.now() + Math.round(expiresInHours * 3_600_000)),
      },
    });

    return {
      id: invitation.id,
      leagueId,
      token,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    };
  }

  /**
   * Lists a private league's invitations (never the tokens). Creator only.
   */
  public async listInvitations(leagueId: string, requesterUserId: string) {
    await this.requireOwnedLeague(leagueId, requesterUserId);
    const invitations = await this.db.leagueInvitation.findMany({
      where: { leagueId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        expiresAt: true,
        usedAt: true,
        revokedAt: true,
        createdAt: true,
        usedBy: { select: { id: true, username: true } },
      },
    });

    const now = Date.now();
    return invitations.map((inv: any) => ({
      ...inv,
      state: LeagueService.invitationState(inv, now),
    }));
  }

  /**
   * Revokes an unused invitation. Creator only.
   */
  public async revokeInvitation(leagueId: string, invitationId: string, requesterUserId: string) {
    await this.requireOwnedLeague(leagueId, requesterUserId);
    const revoked = await this.db.leagueInvitation.updateMany({
      where: { id: invitationId, leagueId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) {
      throw new LeagueInvitationError("Invitation not found, already used or already revoked");
    }
  }

  /**
   * Public preview of the league behind an invitation link, so the invitee can
   * see what they are joining before picking a squad.
   */
  public async previewInvitation(token: string) {
    const invitation = await this.findUsableInvitation(token);
    const league = await this.db.league.findUnique({
      where: { id: invitation.leagueId },
      select: {
        id: true,
        name: true,
        description: true,
        entryFee: true,
        prizePool: true,
        maxMembers: true,
        currentMembers: true,
        status: true,
        scoringType: true,
        creator: { select: { id: true, username: true } },
        startGameweek: { select: { id: true, name: true, deadline: true } },
        endGameweek: { select: { id: true, name: true } },
      },
    });
    if (!league) {
      throw new LeagueInvitationError("This invitation link is invalid");
    }
    return { league, expiresAt: invitation.expiresAt };
  }

  /**
   * Redeems an invitation link: joins its league and consumes the invitation.
   */
  public async acceptInvitation(token: string, userId: string, squadId: string) {
    const invitation = await this.findUsableInvitation(token);
    return this.joinLeague(invitation.leagueId, userId, squadId, { invitationToken: token });
  }

  private static invitationState(
    inv: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
    now: number = Date.now()
  ): "ACTIVE" | "USED" | "REVOKED" | "EXPIRED" {
    if (inv.usedAt) return "USED";
    if (inv.revokedAt) return "REVOKED";
    if (new Date(inv.expiresAt).getTime() <= now) return "EXPIRED";
    return "ACTIVE";
  }

  private async findUsableInvitation(token: string) {
    if (typeof token !== "string" || token.length < 16 || token.length > 128) {
      throw new LeagueInvitationError("This invitation link is invalid");
    }

    const invitation = await this.db.leagueInvitation.findUnique({
      where: { tokenHash: LeagueService.hashInvitationToken(token) },
    });
    if (!invitation) {
      throw new LeagueInvitationError("This invitation link is invalid");
    }

    switch (LeagueService.invitationState(invitation)) {
      case "USED":
        throw new LeagueInvitationError("This invitation link has already been used");
      case "REVOKED":
        throw new LeagueInvitationError("This invitation link has been revoked");
      case "EXPIRED":
        throw new LeagueInvitationError("This invitation link has expired");
      default:
        return invitation;
    }
  }

  private async requireOwnedLeague(leagueId: string, requesterUserId: string) {
    const league = await this.db.league.findUnique({ where: { id: leagueId } });
    if (!league) {
      throw new LeagueNotFoundError(leagueId);
    }
    if (league.creatorId !== requesterUserId) {
      throw new LeagueForbiddenError("Only the league creator can manage invitations");
    }
    return league;
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
   * Retrieves a single league with members, gameweeks, and creator info.
   * The invite code of a private league is only revealed to its creator.
   */
  public async getLeagueById(leagueId: string, viewerId?: string) {
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: {
        creator: { select: { id: true, username: true } },
        startGameweek: true,
        endGameweek: true,
        members: {
          include: {
            user: { select: { id: true, username: true } },
            squad: { select: { id: true, name: true } },
          },
          orderBy: { joinedAt: "asc" },
        },
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
      ...LeagueService.redactForViewer(league, viewerId),
      prizeDistribution,
    };
  }

  /**
   * Hides the static invite code of private leagues from everyone but the creator,
   * so it can never be used to bypass single-use invitations.
   */
  public static redactForViewer<T extends { isPrivate?: boolean; creatorId: string; inviteCode?: string | null }>(
    league: T,
    viewerId?: string
  ): T {
    if (league.isPrivate && league.creatorId !== viewerId) {
      return { ...league, inviteCode: null };
    }
    return league;
  }

  /**
   * Parses and validates raw query-string filters for league search.
   * Throws LeagueValidationError on malformed input.
   */
  public static parseSearchFilters(query: Record<string, unknown>): LeagueSearchFilters {
    const str = (key: string): string | undefined => {
      const value = query[key];
      if (value === undefined || value === "") return undefined;
      if (typeof value !== "string") {
        throw new LeagueValidationError(`${key} must be a single value`);
      }
      return value.trim();
    };
    const num = (key: string, { integer = false, min = 0 } = {}): number | undefined => {
      const raw = str(key);
      if (raw === undefined) return undefined;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
        throw new LeagueValidationError(
          `${key} must be ${integer ? "an integer" : "a number"} greater than or equal to ${min}`
        );
      }
      return value;
    };
    const bool = (key: string): boolean | undefined => {
      const raw = str(key);
      if (raw === undefined) return undefined;
      if (raw !== "true" && raw !== "false") {
        throw new LeagueValidationError(`${key} must be 'true' or 'false'`);
      }
      return raw === "true";
    };

    const q = str("q");
    if (q && q.length > 60) {
      throw new LeagueValidationError("Search query must not exceed 60 characters");
    }

    const code = str("code");
    if (code && !/^[A-Za-z0-9]{4,12}$/.test(code)) {
      throw new LeagueValidationError("code must be 4-12 alphanumeric characters");
    }

    const status = str("status");
    if (status && !Object.values(LeagueStatus).includes(status as LeagueStatus)) {
      throw new LeagueValidationError(`Invalid status: ${status}`);
    }
    const scoringType = str("scoringType");
    if (scoringType && !Object.values(ScoringType).includes(scoringType as ScoringType)) {
      throw new LeagueValidationError(`Invalid scoring type: ${scoringType}`);
    }
    const sortBy = str("sortBy");
    if (sortBy && !(sortBy in LEAGUE_SORT_FIELDS)) {
      throw new LeagueValidationError(
        `sortBy must be one of: ${Object.keys(LEAGUE_SORT_FIELDS).join(", ")}`
      );
    }
    const sortOrder = str("sortOrder");
    if (sortOrder && sortOrder !== "asc" && sortOrder !== "desc") {
      throw new LeagueValidationError("sortOrder must be 'asc' or 'desc'");
    }

    const filters: LeagueSearchFilters = {
      q: q || undefined,
      code: code?.toUpperCase(),
      status: status as LeagueStatus | undefined,
      scoringType: scoringType as ScoringType | undefined,
      creatorId: str("creatorId"),
      minEntryFee: num("minEntryFee"),
      maxEntryFee: num("maxEntryFee"),
      minSize: num("minSize", { integer: true, min: 2 }),
      maxSize: num("maxSize", { integer: true, min: 2 }),
      hasOpenSlots: bool("hasOpenSlots"),
      sortBy: sortBy as LeagueSortField | undefined,
      sortOrder: sortOrder as "asc" | "desc" | undefined,
      page: num("page", { integer: true, min: 1 }),
      pageSize: num("pageSize", { integer: true, min: 1 }),
    };

    if (
      filters.minEntryFee !== undefined &&
      filters.maxEntryFee !== undefined &&
      filters.minEntryFee > filters.maxEntryFee
    ) {
      throw new LeagueValidationError("minEntryFee cannot be greater than maxEntryFee");
    }
    if (filters.minSize !== undefined && filters.maxSize !== undefined && filters.minSize > filters.maxSize) {
      throw new LeagueValidationError("minSize cannot be greater than maxSize");
    }
    if (filters.pageSize !== undefined && filters.pageSize > LEAGUE_SEARCH_MAX_PAGE_SIZE) {
      throw new LeagueValidationError(`pageSize must not exceed ${LEAGUE_SEARCH_MAX_PAGE_SIZE}`);
    }

    return filters;
  }

  /**
   * Builds the Prisma `where` clause for a league search. Private leagues are only
   * visible to their creator and members.
   */
  public buildSearchWhere(filters: LeagueSearchFilters = {}, viewerId?: string) {
    const and: Record<string, unknown>[] = [];

    and.push({
      OR: [
        { isPrivate: false },
        ...(viewerId
          ? [{ creatorId: viewerId }, { members: { some: { userId: viewerId } } }]
          : []),
      ],
    });

    if (filters.q) {
      and.push({ name: { contains: filters.q, mode: "insensitive" } });
    }
    if (filters.code) and.push({ inviteCode: filters.code });
    if (filters.status) and.push({ status: filters.status });
    if (filters.scoringType) and.push({ scoringType: filters.scoringType });
    if (filters.creatorId) and.push({ creatorId: filters.creatorId });

    if (filters.minEntryFee !== undefined || filters.maxEntryFee !== undefined) {
      and.push({
        entryFee: {
          ...(filters.minEntryFee !== undefined ? { gte: filters.minEntryFee } : {}),
          ...(filters.maxEntryFee !== undefined ? { lte: filters.maxEntryFee } : {}),
        },
      });
    }
    if (filters.minSize !== undefined || filters.maxSize !== undefined) {
      and.push({
        maxMembers: {
          ...(filters.minSize !== undefined ? { gte: filters.minSize } : {}),
          ...(filters.maxSize !== undefined ? { lte: filters.maxSize } : {}),
        },
      });
    }
    if (filters.hasOpenSlots) {
      // Column-to-column comparison: currentMembers < maxMembers
      and.push({ currentMembers: { lt: this.db.league.fields.maxMembers } });
    }

    return { AND: and };
  }

  /**
   * Searches leagues by name, entry fee, size and more, with pagination.
   * Private leagues only appear for their creator and members.
   */
  public async getLeagues(
    filters: LeagueSearchFilters = {},
    viewerId?: string
  ): Promise<LeagueSearchResult<any>> {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? LEAGUE_SEARCH_DEFAULT_PAGE_SIZE, LEAGUE_SEARCH_MAX_PAGE_SIZE);
    const sortField = LEAGUE_SORT_FIELDS[filters.sortBy ?? "newest"];
    const sortOrder = filters.sortOrder ?? "desc";
    const where = this.buildSearchWhere(filters, viewerId);

    const [items, total] = await Promise.all([
      this.db.league.findMany({
        where,
        include: {
          creator: { select: { id: true, username: true } },
          startGameweek: { select: { id: true, name: true, deadline: true } },
          endGameweek: { select: { id: true, name: true } },
        },
        // Secondary key keeps pagination stable when the primary sort ties
        orderBy: [{ [sortField]: sortOrder }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.league.count({ where }),
    ]);

    return {
      items: items.map((league: any) => LeagueService.redactForViewer(league, viewerId)),
      total,
      page,
      pageSize,
    };
  }
}

export const leagueService = new LeagueService();
