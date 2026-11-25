import type { Redis } from "ioredis";
import { getRedisClient } from "../../config/redis.js";
import { prisma } from "../../config/db.js";

export interface LiveMatchEvent {
  eventId: string;
  fixtureId: number;
  playerId: number;
  eventType: "GOAL" | "ASSIST" | "YELLOW_CARD" | "RED_CARD" | "SAVE" | "CLEAN_SHEET" | "BONUS";
  points: number;
  minute: number;
  timestamp: number;
}

export interface AffectedSquad {
  squadId: string;
  squadName: string;
  userId: string;
  username: string;
  leagueIds: string[];
  scoresDelta: number;
}

export const SLIDING_WINDOW_BUFFER_SIZE = 1000;

export class LiveMatchEventAggregator {
  private redis: Redis | null;

  constructor(redis: Redis | null = null) {
    this.redis = redis;
  }

  async initialize(): Promise<void> {
    if (!this.redis) {
      this.redis = getRedisClient();
    }
  }

  async processLiveEvent(event: LiveMatchEvent): Promise<AffectedSquad[]> {
    if (!this.redis) await this.initialize();

    const fixtureKey = `match:${event.fixtureId}:events`;

    await this.redis!.lpush(fixtureKey, JSON.stringify(event));
    await this.redis!.ltrim(fixtureKey, 0, SLIDING_WINDOW_BUFFER_SIZE - 1);
    await this.redis!.expire(fixtureKey, 86400);

    const player = await prisma.player.findUnique({
      where: { fplId: event.playerId },
    });

    if (!player) {
      throw new Error(`Player ${event.playerId} not found`);
    }

    const affectedSquads = await this.identifyAffectedSquads(
      event.fixtureId,
      event.playerId
    );

    for (const squad of affectedSquads) {
      await this.updateSquadRank(squad.squadId, event.fixtureId);
    }

    return affectedSquads;
  }

  private async identifyAffectedSquads(
    fixtureId: number,
    playerId: number
  ): Promise<AffectedSquad[]> {
    const fixture = await prisma.fixture.findUnique({
      where: { id: fixtureId },
      include: { gameweek: true },
    });

    if (!fixture || !fixture.gameweekId) {
      return [];
    }

    const playersInSquads = await prisma.squadLineupPlayer.findMany({
      where: {
        playerId,
        squadLineup: { gameweekId: fixture.gameweekId },
      },
      include: {
        squadLineup: {
          select: {
            squad: {
              select: {
                id: true,
                name: true,
                user: { select: { id: true, username: true } },
                leagues: { select: { id: true } },
              },
            },
          },
        },
      },
    });

    return playersInSquads.map((p) => ({
      squadId: p.squadLineup.squad.id,
      squadName: p.squadLineup.squad.name,
      userId: p.squadLineup.squad.user.id,
      username: p.squadLineup.squad.user.username,
      leagueIds: p.squadLineup.squad.leagues.map((l) => l.id),
      scoresDelta: 0,
    }));
  }

  private async updateSquadRank(squadId: string, fixtureId: number): Promise<void> {
    const squad = await prisma.squad.findUnique({
      where: { id: squadId },
      include: { gameweekScores: { orderBy: { gameweek: { number: "desc" } }, take: 1 } },
    });

    if (!squad || !squad.gameweekScores.length) {
      return;
    }

    const sortedKey = `league:rank:${fixtureId}`;

    await this.redis!.zadd(sortedKey, {
      [squadId]: squad.gameweekScores[0]!.points,
    });

    await this.redis!.expire(sortedKey, 3600);
  }

  async getLeagueRanks(leagueId: string, fixtureId: number): Promise<Array<{ rank: number; squadId: string; points: number }>> {
    if (!this.redis) await this.initialize();

    const sortedKey = `league:rank:${fixtureId}`;
    const rankings = await this.redis!.zrevrange(sortedKey, 0, -1, "WITHSCORES");

    const result: Array<{ rank: number; squadId: string; points: number }> = [];

    for (let i = 0; i < rankings.length; i += 2) {
      const squadId = rankings[i]!;
      const points = parseInt(rankings[i + 1]!, 10);
      result.push({
        rank: Math.floor(i / 2) + 1,
        squadId,
        points,
      });
    }

    return result;
  }

  async getEventHistory(fixtureId: number): Promise<LiveMatchEvent[]> {
    if (!this.redis) await this.initialize();

    const fixtureKey = `match:${fixtureId}:events`;
    const events = await this.redis!.lrange(fixtureKey, 0, -1);

    return events.map((e) => JSON.parse(e) as LiveMatchEvent).reverse();
  }
}

export const liveMatchEventAggregator = new LiveMatchEventAggregator();
