import { prisma } from "../../config/db.js";
import {
  LeagueStatus,
  MembershipStatus,
  ScoringType,
  UserRole,
} from "../../types/index.js";
import { computeSwissStandings } from "./swissPairingEngine.js";

export class SeasonRolloverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonRolloverError";
  }
}

export class SeasonRolloverNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonRolloverNotFoundError";
  }
}

export class SeasonRolloverForbiddenError extends Error {
  constructor(message = "Only the league creator or an admin can roll the league over") {
    super(message);
    this.name = "SeasonRolloverForbiddenError";
  }
}

export class SeasonRolloverConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonRolloverConflictError";
  }
}

export interface SeasonRolloverInput {
  startGameweekId: number;
  endGameweekId: number;
  /** Label of the new season; defaults to the new end gameweek's season */
  season?: string;
}

export interface RolloverRequester {
  id: string;
  role?: string | null;
}

interface ArchivedStandingRow {
  userId: string;
  squadId: string;
  username: string;
  squadName: string;
  rank: number;
  totalPoints: number;
  bestGameweekPoints: number;
  matchesWon: number;
  matchesDrawn: number;
  matchesLost: number;
  pointsFor: number;
  pointsAgainst: number;
  h2hPoints: number;
}

interface ArchivedMatchRow {
  gameweekId: number;
  homeUserId: string;
  awayUserId: string | null;
  homeScore: number | null;
  awayScore: number | null;
  isPlayoff: boolean;
  playoffRound: number | null;
  format: "H2H" | "SWISS";
}

const TROPHIES = [
  { rank: 1, type: "CHAMPION", title: "Champion" },
  { rank: 2, type: "RUNNER_UP", title: "Runner-up" },
  { rank: 3, type: "THIRD_PLACE", title: "Third place" },
] as const;

/**
 * Season rollover and historical archive pipeline (issue #271).
 *
 * In one database transaction (any failure rolls everything back):
 *  1. snapshots the final standings, champion, points and head-to-head / Swiss
 *     results of the finished season into the cold league_season_archive* tables;
 *  2. awards trophies (top three) and participation badges to member profiles;
 *  3. resets league progression for the new campaign: gameweek window, status,
 *     prize pool, and member ranks and records;
 *  4. records the new campaign as a LeagueSeason linked to the previous one.
 *
 * Member rosters and their squad links are kept. Nothing historical is
 * deleted: last season's fixtures and Swiss pairings stay attached to their
 * (past) gameweeks, and the archive is the frozen, queryable copy.
 *
 * Only free leagues can be rolled over for now: a paid league's escrow is
 * keyed by its league id and cannot be reused for a second season.
 */
export class SeasonRolloverService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  public async rolloverLeague(
    leagueId: string,
    requester: RolloverRequester,
    input: SeasonRolloverInput
  ) {
    const startGameweekId = Number(input?.startGameweekId);
    const endGameweekId = Number(input?.endGameweekId);
    if (!Number.isInteger(startGameweekId) || !Number.isInteger(endGameweekId)) {
      throw new SeasonRolloverError("startGameweekId and endGameweekId must be integers");
    }
    if (startGameweekId > endGameweekId) {
      throw new SeasonRolloverError("startGameweekId must not be after endGameweekId");
    }

    try {
      return await this.db.$transaction(async (tx: any) => {
        const league = await tx.league.findUnique({
          where: { id: leagueId },
          include: { endGameweek: true },
        });
        if (!league) throw new SeasonRolloverNotFoundError(`League with ID ${leagueId} was not found`);
        if (league.creatorId !== requester.id && requester.role !== UserRole.ADMIN) {
          throw new SeasonRolloverForbiddenError();
        }
        if (league.status !== LeagueStatus.COMPLETED) {
          throw new SeasonRolloverError(
            `Only a COMPLETED league can be rolled over (league is ${league.status})`
          );
        }
        // The escrow contract keys a league by an id derived from the league UUID
        // (financial/contractLeagueId.ts) and rejects re-creating or re-settling it,
        // so a paid league cannot reuse it for a second season. Paid rollovers need a
        // per-season escrow instance first, which is on-chain work outside this pipeline.
        if (Number(league.entryFee) > 0) {
          throw new SeasonRolloverError(
            "Paid leagues cannot be rolled over yet: each season needs its own escrow instance"
          );
        }

        const [newStart, newEnd] = await Promise.all([
          tx.gameweek.findUnique({ where: { id: startGameweekId } }),
          tx.gameweek.findUnique({ where: { id: endGameweekId } }),
        ]);
        if (!newStart || !newEnd) {
          throw new SeasonRolloverError("The new season's start and end gameweeks must exist");
        }
        if (startGameweekId <= league.endGameweekId) {
          throw new SeasonRolloverError("The new season must start after the previous season's last gameweek");
        }
        if (new Date(newStart.deadline).getTime() <= Date.now()) {
          throw new SeasonRolloverError("The new season's start gameweek deadline has already passed");
        }

        const seasonNumber = league.seasonNumber ?? 1;
        const previousSeason = await tx.leagueSeason.findFirst({
          where: { leagueId },
          orderBy: { createdAt: "desc" },
        });
        const currentLabel: string = previousSeason?.season ?? league.endGameweek?.season ?? `Season ${seasonNumber}`;
        let nextLabel = input.season?.trim() || newEnd.season || `Season ${seasonNumber + 1}`;
        if (!input.season?.trim() && nextLabel === currentLabel) {
          // Several competitions inside one Premier League season
          nextLabel = `${nextLabel} (campaign ${seasonNumber + 1})`;
        }
        if (nextLabel === currentLabel) {
          throw new SeasonRolloverConflictError(`The league already has a season named "${nextLabel}"`);
        }

        // 1. Archive the finished season
        const members = await tx.leagueMember.findMany({
          where: { leagueId, status: MembershipStatus.ACTIVE },
          orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
          include: {
            user: { select: { username: true } },
            squad: { select: { name: true } },
          },
        });
        const standings = await this.finalStandings(tx, league, members);
        const matches = await this.seasonMatches(tx, league, members);
        const champion = standings.find((s) => s.rank === 1) ?? null;

        const archive = await tx.leagueSeasonArchive.create({
          data: {
            leagueId,
            seasonNumber,
            season: currentLabel,
            scoringType: league.scoringType,
            startGameweekId: league.startGameweekId,
            endGameweekId: league.endGameweekId,
            memberCount: standings.length,
            prizePool: league.prizePool,
            entryFee: league.entryFee,
            championUserId: champion?.userId ?? null,
            totalPoints: standings.reduce((sum, s) => sum + s.totalPoints, 0),
            archivedById: requester.id,
          },
        });
        if (standings.length > 0) {
          await tx.leagueSeasonArchiveStanding.createMany({
            data: standings.map((s) => ({ archiveId: archive.id, ...s })),
          });
        }
        if (matches.length > 0) {
          await tx.leagueSeasonArchiveMatch.createMany({
            data: matches.map((m) => ({ archiveId: archive.id, ...m })),
          });
        }

        // 2. Trophies and participation badges for member profiles
        const trophies = standings.flatMap((s: ArchivedStandingRow) => {
          const podium = TROPHIES.find((t) => t.rank === s.rank);
          const awards = [
            {
              userId: s.userId,
              leagueId,
              archiveId: archive.id,
              type: "PARTICIPANT",
              season: currentLabel,
              title: `${league.name} ${currentLabel} - finished #${s.rank}`,
              rank: s.rank,
            },
          ];
          if (podium && standings.length > 1) {
            awards.push({
              userId: s.userId,
              leagueId,
              archiveId: archive.id,
              type: podium.type,
              season: currentLabel,
              title: `${league.name} ${currentLabel} ${podium.title}`,
              rank: s.rank,
            });
          }
          return awards;
        });
        if (trophies.length > 0) {
          await tx.userTrophy.createMany({ data: trophies });
        }

        // 3. Reset progression; rosters and squad links are kept
        await tx.leagueMember.updateMany({
          where: { leagueId, status: MembershipStatus.ACTIVE },
          data: {
            rank: null,
            totalPoints: 0,
            matchesWon: 0,
            matchesDrawn: 0,
            matchesLost: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            h2hPoints: 0,
          },
        });
        const rosterSize = await tx.leagueMember.count({
          where: { leagueId, status: { in: [MembershipStatus.ACTIVE, MembershipStatus.PENDING] } },
        });

        const updatedLeague = await tx.league.update({
          where: { id: leagueId },
          data: {
            seasonNumber: seasonNumber + 1,
            startGameweekId,
            endGameweekId,
            status: LeagueStatus.UPCOMING,
            currentMembers: rosterSize,
            prizePool: 0,
          },
        });

        // 4. New campaign entry linked to the archived one
        const archivedSeason =
          previousSeason?.season === currentLabel
            ? previousSeason
            : await tx.leagueSeason.create({ data: { leagueId, season: currentLabel } });
        const newSeason = await tx.leagueSeason.create({
          data: {
            leagueId,
            season: nextLabel,
            previousSeasonId: archivedSeason.id,
            tierGroupId: archivedSeason.tierGroupId ?? null,
            tierId: archivedSeason.tierId ?? null,
          },
        });

        return {
          archive: { ...archive, standingsCount: standings.length, matchesCount: matches.length },
          league: updatedLeague,
          season: newSeason,
          trophiesAwarded: trophies.length,
        };
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "P2002") {
        throw new SeasonRolloverConflictError(
          "This season has already been archived, or a season with that name already exists"
        );
      }
      throw error;
    }
  }

  /** Final table of the season, ranked by the league's scoring format. */
  private async finalStandings(tx: any, league: any, members: any[]): Promise<ArchivedStandingRow[]> {
    const scores = await tx.squadGameweekScore.findMany({
      where: {
        squadId: { in: members.map((m: any) => m.squadId) },
        gameweekId: { gte: league.startGameweekId, lte: league.endGameweekId },
      },
    });
    const totals = new Map<string, { total: number; best: number }>();
    for (const score of scores) {
      const entry = totals.get(score.squadId) ?? { total: 0, best: 0 };
      entry.total += score.points;
      entry.best = Math.max(entry.best, score.points);
      totals.set(score.squadId, entry);
    }

    const rows = members.map((m: any) => ({
      member: m,
      row: {
        userId: m.userId,
        squadId: m.squadId,
        username: m.user?.username ?? "",
        squadName: m.squad?.name ?? "",
        rank: 0,
        totalPoints: totals.get(m.squadId)?.total ?? 0,
        bestGameweekPoints: totals.get(m.squadId)?.best ?? 0,
        matchesWon: m.matchesWon ?? 0,
        matchesDrawn: m.matchesDrawn ?? 0,
        matchesLost: m.matchesLost ?? 0,
        pointsFor: m.pointsFor ?? 0,
        pointsAgainst: m.pointsAgainst ?? 0,
        h2hPoints: m.h2hPoints ?? 0,
      } as ArchivedStandingRow,
    }));

    if (league.scoringType === ScoringType.SWISS) {
      const tournament = await tx.swissTournament.findUnique({
        where: { leagueId_seasonNumber: { leagueId: league.id, seasonNumber: league.seasonNumber ?? 1 } },
      });
      const pairings = tournament
        ? await tx.swissPairing.findMany({ where: { tournamentId: tournament.id } })
        : [];
      const order = computeSwissStandings(
        members.map((m: any) => m.id),
        pairings,
        new Map(members.map((m: any, idx: number) => [m.id, idx]))
      );
      const rankOf = new Map(order.map((s) => [s.memberId, s.rank]));
      rows.sort((a, b) => rankOf.get(a.member.id)! - rankOf.get(b.member.id)!);
    } else if (league.scoringType === ScoringType.HEAD_TO_HEAD) {
      rows.sort(
        (a, b) =>
          b.row.h2hPoints - a.row.h2hPoints ||
          b.row.pointsFor - a.row.pointsFor ||
          (b.row.pointsFor - b.row.pointsAgainst) - (a.row.pointsFor - a.row.pointsAgainst) ||
          new Date(a.member.joinedAt).getTime() - new Date(b.member.joinedAt).getTime()
      );
    } else {
      // Same hierarchy as LeagueService.getLeagueStandings
      rows.sort(
        (a, b) =>
          b.row.totalPoints - a.row.totalPoints ||
          b.row.bestGameweekPoints - a.row.bestGameweekPoints ||
          new Date(a.member.joinedAt).getTime() - new Date(b.member.joinedAt).getTime()
      );
    }

    return rows.map(({ row }, idx) => ({ ...row, rank: idx + 1 }));
  }

  /** Head-to-head fixtures or Swiss pairings played during the season. */
  private async seasonMatches(tx: any, league: any, members: any[]): Promise<ArchivedMatchRow[]> {
    const userByMember = new Map<string, string>(members.map((m: any) => [m.id, m.userId]));
    // Members who left mid-season still appear in the match history
    const resolveUsers = async (memberIds: string[]) => {
      const missing = memberIds.filter((id) => id && !userByMember.has(id));
      if (missing.length > 0) {
        const extra = await tx.leagueMember.findMany({ where: { id: { in: missing } } });
        for (const m of extra) userByMember.set(m.id, m.userId);
      }
    };

    if (league.scoringType === ScoringType.HEAD_TO_HEAD) {
      const fixtures = await tx.leagueFixture.findMany({
        where: {
          leagueId: league.id,
          gameweekId: { gte: league.startGameweekId, lte: league.endGameweekId },
        },
        orderBy: [{ gameweekId: "asc" }],
      });
      await resolveUsers(fixtures.flatMap((f: any) => [f.homeMemberId, f.awayMemberId]));
      return fixtures.map((f: any) => ({
        gameweekId: f.gameweekId,
        homeUserId: userByMember.get(f.homeMemberId)!,
        awayUserId: f.awayMemberId ? userByMember.get(f.awayMemberId) ?? null : null,
        homeScore: f.homeScore ?? null,
        awayScore: f.awayScore ?? null,
        isPlayoff: Boolean(f.isPlayoff),
        playoffRound: f.playoffRound ?? null,
        format: "H2H",
      }));
    }

    if (league.scoringType === ScoringType.SWISS) {
      const tournament = await tx.swissTournament.findUnique({
        where: { leagueId_seasonNumber: { leagueId: league.id, seasonNumber: league.seasonNumber ?? 1 } },
      });
      if (!tournament) return [];
      const pairings = await tx.swissPairing.findMany({
        where: { tournamentId: tournament.id },
        orderBy: [{ round: "asc" }, { tableNumber: "asc" }],
      });
      await resolveUsers(pairings.flatMap((p: any) => [p.playerAId, p.playerBId]));
      return pairings.map((p: any) => ({
        gameweekId: p.gameweekId,
        homeUserId: userByMember.get(p.playerAId)!,
        awayUserId: p.playerBId ? userByMember.get(p.playerBId) ?? null : null,
        homeScore: p.scoreA ?? null,
        awayScore: p.scoreB ?? null,
        isPlayoff: false,
        playoffRound: null,
        format: "SWISS",
      }));
    }

    return [];
  }

  /**
   * Whether `viewerId` may read a league's archives: public leagues are open;
   * private ones are limited to the creator, current or past members, and admins.
   */
  public async canViewHistory(leagueId: string, viewer?: RolloverRequester | null): Promise<boolean> {
    const league = await this.db.league.findUnique({ where: { id: leagueId } });
    if (!league) throw new SeasonRolloverNotFoundError(`League with ID ${leagueId} was not found`);
    if (!league.isPrivate) return true;
    if (!viewer) return false;
    if (viewer.role === UserRole.ADMIN || league.creatorId === viewer.id) return true;

    const membership = await this.db.leagueMember.count({ where: { leagueId, userId: viewer.id } });
    if (membership > 0) return true;
    const archives = await this.db.leagueSeasonArchive.findMany({ where: { leagueId }, select: { id: true } });
    if (archives.length === 0) return false;
    const archived = await this.db.leagueSeasonArchiveStanding.count({
      where: { userId: viewer.id, archiveId: { in: archives.map((a: any) => a.id) } },
    });
    return archived > 0;
  }

  /** Every archived season of a league, newest first. */
  public async listSeasons(leagueId: string) {
    const archives = await this.db.leagueSeasonArchive.findMany({
      where: { leagueId },
      orderBy: { seasonNumber: "desc" },
    });
    const championIds = archives.map((a: any) => a.championUserId).filter(Boolean);
    const champions = championIds.length
      ? await this.db.user.findMany({ where: { id: { in: championIds } }, select: { id: true, username: true } })
      : [];
    const nameOf = new Map<string, string>(champions.map((u: any) => [u.id, u.username]));
    return archives.map((a: any) => ({
      ...a,
      prizePool: Number(a.prizePool),
      entryFee: Number(a.entryFee),
      championUsername: a.championUserId ? nameOf.get(a.championUserId) ?? null : null,
    }));
  }

  /** One archived season with its final leaderboard and match history. */
  public async getSeason(leagueId: string, seasonNumber: number) {
    const archive = await this.db.leagueSeasonArchive.findUnique({
      where: { leagueId_seasonNumber: { leagueId, seasonNumber } },
      include: {
        standings: { orderBy: { rank: "asc" } },
        matches: { orderBy: [{ gameweekId: "asc" }] },
      },
    });
    if (!archive) {
      throw new SeasonRolloverNotFoundError(`Season ${seasonNumber} of league ${leagueId} has not been archived`);
    }
    return { ...archive, prizePool: Number(archive.prizePool), entryFee: Number(archive.entryFee) };
  }

  /** Trophies and badges on a user's profile, newest first. */
  public async getUserTrophies(userId: string) {
    return this.db.userTrophy.findMany({
      where: { userId },
      orderBy: [{ awardedAt: "desc" }, { rank: "asc" }],
      include: { league: { select: { id: true, name: true } } },
    });
  }
}

export const seasonRolloverService = new SeasonRolloverService();
