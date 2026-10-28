import { eventFanout } from "./eventFanout.js";
import { prisma } from "../../config/db.js";
import { getRedisClient, type IRedisCacheClient } from "../../config/redis.js";
import { MembershipStatus, Position } from "../../types/index.js";
import { ScoringService, PlayerScoreDetail } from "../scoring/scoringService.js";
import { allocateProvisionalBonus } from "../scoring/provisionalBps.js";
export {
  LiveProvisionalLeaderboardService,
  liveProvisionalLeaderboardService,
  type LiveMatchEvent,
  type LiveLeaderboardDeltaDiff,
  type ProvisionalSquadRecord,
  type ProvisionalLeaderboardRankEntry,
} from "./liveProvisionalLeaderboardService.js";

/**
 * Live Matchday Service.
 *
 * Builds a point-in-time snapshot of the current gameweek for a league: active
 * fixtures, player events (goals, assists, cards, saves, bonus) and live standings
 * where each manager's current-gameweek points come from the live scoring engine
 * (auto-subs and captain multipliers applied). Streamed to clients over SSE.
 */

export interface LivePlayerPoints extends PlayerScoreDetail {
  name: string;
  teamShortName: string;
}

export interface LiveStandingsEntry {
  rank: number;
  userId: string;
  username: string;
  squadId: string;
  squadName: string;
  membershipStatus: MembershipStatus;
  totalPoints: number;
  livePoints: number;
  lineup: LivePlayerPoints[];
}

export interface LiveSnapshot {
  leagueId: string;
  gameweek: { id: number; name: string } | null;
  fixtures: Array<{
    id: number;
    homeTeam: string;
    awayTeam: string;
    homeScore: number | null;
    awayScore: number | null;
    minutes: number;
    started: boolean;
    finished: boolean;
    kickoffTime: Date | null;
  }>;
  events: Array<{
    playerId: number;
    playerName: string;
    teamShortName: string;
    goals: number;
    assists: number;
    yellowCards: number;
    redCards: number;
    saves: number;
    bonus: number;
    bps: number;
    provisionalBonus: number;
    totalPoints: number;
  }>;
  standings: LiveStandingsEntry[];
  generatedAt: string;
}

/**
 * Ranks managers by total points (completed gameweeks + live), then live points,
 * then earliest join.
 */
export function rankLiveStandings(
  entries: Array<Omit<LiveStandingsEntry, "rank"> & { joinedAt: Date }>
): LiveStandingsEntry[] {
  return [...entries]
    .sort(
      (a, b) =>
        b.totalPoints - a.totalPoints ||
        b.livePoints - a.livePoints ||
        a.joinedAt.getTime() - b.joinedAt.getTime()
    )
    .map(({ joinedAt: _joinedAt, ...entry }, idx) => ({ rank: idx + 1, ...entry }));
}

export class LiveService {
  /** Called only after the corresponding stats transaction commits. */
  public publishPlayerDelta(gameweekId: number, playerId: number, fixtureId: number, data: Record<string, unknown>): boolean {
    return eventFanout.publish(`matchday:${gameweekId}`, `${playerId}:${fixtureId}`, { playerId, fixtureId, ...data });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(
    private readonly db: any = prisma,
    private readonly redis: IRedisCacheClient | null = db === prisma ? getRedisClient() : null
  ) {}

  public async getLeagueSnapshot(leagueId: string): Promise<LiveSnapshot | null> {
    const cacheKey = `live:bps:snapshot:${leagueId}`;
    if (this.redis) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as LiveSnapshot;
      } catch {
        // Redis is an optimization; compute the snapshot directly when unavailable.
      }
    }
    const league = await this.db.league.findUnique({
      where: { id: leagueId },
      include: {
        members: {
          include: {
            user: { select: { username: true } },
            squad: {
              include: {
                players: { include: { player: { include: { team: true } } } },
              },
            },
          },
        },
      },
    });
    if (!league) {
      return null;
    }

    const gameweek = await this.db.gameweek.findFirst({ where: { isCurrent: true } });
    const inWindow =
      gameweek &&
      gameweek.id >= league.startGameweekId &&
      gameweek.id <= league.endGameweekId;

    const squadIds = league.members.map((m: any) => m.squadId);
    const [fixtures, stats, completedScores, transferHits] = await Promise.all([
      gameweek
        ? this.db.fixture.findMany({
            where: { gameweekId: gameweek.id },
            include: { homeTeam: true, awayTeam: true },
            orderBy: { kickoffTime: "asc" },
          })
        : [],
      gameweek
        ? this.db.playerGameweekStats.findMany({
            where: { gameweekId: gameweek.id },
            include: { player: { include: { team: true } } },
          })
        : [],
      this.db.squadGameweekScore.findMany({
        where: {
          squadId: { in: squadIds },
          gameweekId: {
            gte: league.startGameweekId,
            lte: league.endGameweekId,
            ...(gameweek ? { not: gameweek.id } : {}),
          },
        },
      }),
      gameweek
        ? this.db.squadTransfer.groupBy({
            by: ["squadId"],
            where: { gameweekId: gameweek.id, squadId: { in: squadIds } },
            _sum: { pointsCost: true },
          })
        : [],
    ]);

    const hitsBySquad = new Map<string, number>(
      transferHits.map((h: any) => [h.squadId, h._sum.pointsCost ?? 0])
    );

    const provisionalBonuses = allocateProvisionalBonus(stats.map((stat: any) => ({
      playerId: stat.playerId,
      fixtureId: stat.fixtureId,
      bps: stat.bps ?? 0,
      minutes: stat.minutes,
    })));

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    for (const stat of stats) {
      const current = statsMap.get(stat.playerId) ?? { minutes: 0, totalPoints: 0 };
      statsMap.set(stat.playerId, {
        minutes: current.minutes + stat.minutes,
        totalPoints: current.totalPoints + stat.totalPoints - (stat.bonus ?? 0) +
          (provisionalBonuses.get(`${stat.fixtureId}:${stat.playerId}`) ?? 0),
      });
    }
    const completedBySquad = new Map<string, number>();
    for (const score of completedScores) {
      completedBySquad.set(score.squadId, (completedBySquad.get(score.squadId) ?? 0) + score.points);
    }

    const entries = league.members.map((m: any) => {
      const squadPlayers = m.squad.players;
      const live = ScoringService.calculateLineupScore(
        squadPlayers.map((sp: any) => ({
          playerId: sp.playerId,
          position: sp.player.position as Position,
          isStarter: sp.isStarter,
          isCaptain: sp.isCaptain,
          isViceCaptain: sp.isViceCaptain,
          positionOrder: sp.positionOrder,
        })),
        statsMap,
        { transferCost: hitsBySquad.get(m.squadId) ?? 0 }
      );
      const byId = new Map<number, any>(squadPlayers.map((sp: any) => [sp.playerId, sp.player]));
      const livePoints = inWindow ? live.totalPoints : 0;

      return {
        userId: m.userId,
        username: m.user.username,
        squadId: m.squadId,
        squadName: m.squad.name,
        membershipStatus: m.status,
        totalPoints: (completedBySquad.get(m.squadId) ?? 0) + livePoints,
        livePoints,
        lineup: live.details.map((d) => ({
          ...d,
          name: byId.get(d.playerId)?.displayName ?? "",
          teamShortName: byId.get(d.playerId)?.team?.shortName ?? "",
        })),
        joinedAt: m.joinedAt,
      };
    });

    const snapshot: LiveSnapshot = {
      leagueId: league.id,
      gameweek: gameweek ? { id: gameweek.id, name: gameweek.name } : null,
      fixtures: fixtures.map((f: any) => ({
        id: f.id,
        homeTeam: f.homeTeam.shortName,
        awayTeam: f.awayTeam.shortName,
        homeScore: f.homeScore,
        awayScore: f.awayScore,
        minutes: f.minutes,
        started: f.started,
        finished: f.finished,
        kickoffTime: f.kickoffTime,
      })),
      events: stats
        .filter(
          (s: any) =>
            s.goals || s.assists || s.yellowCards || s.redCards || s.saves || s.bonus || s.bps
        )
        .map((s: any) => ({
          playerId: s.playerId,
          playerName: s.player.displayName,
          teamShortName: s.player.team.shortName,
          goals: s.goals,
          assists: s.assists,
          yellowCards: s.yellowCards,
          redCards: s.redCards,
          saves: s.saves,
          bonus: s.bonus,
          bps: s.bps ?? 0,
          provisionalBonus: provisionalBonuses.get(`${s.fixtureId}:${s.playerId}`) ?? 0,
          totalPoints: s.totalPoints - (s.bonus ?? 0) + (provisionalBonuses.get(`${s.fixtureId}:${s.playerId}`) ?? 0),
        })),
      standings: rankLiveStandings(entries),
      generatedAt: new Date().toISOString(),
    };
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(snapshot), "PX", 900);
      } catch {
        // A cache write failure must not interrupt live updates.
      }
    }
    return snapshot;
  }
}

export const liveService = new LiveService();
