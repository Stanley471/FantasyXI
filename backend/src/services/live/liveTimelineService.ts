/**
 * Live Match Event Timeline Service
 *
 * Parses match events (goals, assists, cards, saves, bonus) chronologically
 * per fixture and gameweek from live sports data and DB stats,
 * and formats them for real-time streaming and REST consumption.
 */

import { prisma } from "../../config/db.js";
import { getRedisClient, type IRedisCacheClient } from "../../config/redis.js";
import { ScoringService } from "../scoring/scoringService.js";
import type { Position } from "../../types/index.js";

export type MatchEventType =
  | "GOAL"
  | "ASSIST"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "SAVE"
  | "BONUS"
  | "PENALTY_SAVED"
  | "OWN_GOAL";

export interface TimelineEvent {
  id: string;
  fixtureId: number;
  fixtureName: string;
  gameweekId: number;
  playerId: number;
  fplId: number;
  playerName: string;
  teamShortName: string;
  teamId: number;
  type: MatchEventType;
  minute: number;
  detail: string;
  pointsAwarded: number;
  timestamp: string;
}

export interface FixtureTimelineSummary {
  id: number;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  minutes: number;
  started: boolean;
  finished: boolean;
  kickoffTime: Date | null;
  events: TimelineEvent[];
}

export interface GameweekTimeline {
  gameweek: {
    id: number;
    name: string;
    isCurrent: boolean;
    isFinished: boolean;
  } | null;
  fixtures: FixtureTimelineSummary[];
  events: TimelineEvent[];
  summary: {
    totalGoals: number;
    totalAssists: number;
    totalYellowCards: number;
    totalRedCards: number;
    totalSaves: number;
    totalBonus: number;
  };
  generatedAt: string;
}

export class LiveTimelineService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  /**
   * Builds a unified, chronological timeline of match events for a gameweek.
   */
  public async getGameweekTimeline(gameweekId: number): Promise<GameweekTimeline | null> {
    const gameweek = await this.db.gameweek.findFirst({
      where: { OR: [{ id: gameweekId }, { fplId: gameweekId }] },
    });

    if (!gameweek) {
      return null;
    }

    const [fixtures, playerStats] = await Promise.all([
      this.db.fixture.findMany({
        where: { gameweekId: gameweek.id },
        include: { homeTeam: true, awayTeam: true },
        orderBy: { kickoffTime: "asc" },
      }),
      this.db.playerGameweekStats.findMany({
        where: { gameweekId: gameweek.id },
        include: {
          player: {
            include: { team: true },
          },
        },
      }),
    ]);

    // Build map of teamId to fixture
    const teamFixtureMap = new Map<number, any>();
    for (const fix of fixtures) {
      teamFixtureMap.set(fix.homeTeamId, fix);
      teamFixtureMap.set(fix.awayTeamId, fix);
    }

    const events: TimelineEvent[] = [];
    let totalGoals = 0;
    let totalAssists = 0;
    let totalYellowCards = 0;
    let totalRedCards = 0;
    let totalSaves = 0;
    let totalBonus = 0;

    for (const stat of playerStats) {
      const player = stat.player;
      if (!player) continue;
      const fixture = teamFixtureMap.get(player.teamId);
      const fixtureId = fixture?.id ?? 0;
      const fixtureName = fixture
        ? `${fixture.homeTeam.shortName} vs ${fixture.awayTeam.shortName}`
        : "Match";
      const fixtureMinute = fixture?.minutes ?? stat.minutes ?? 90;

      // Goals
      for (let i = 0; i < stat.goals; i++) {
        totalGoals++;
        // Distribute event minutes realistically within fixture duration
        const minute = Math.min(90, Math.max(1, Math.round((fixtureMinute / (stat.goals + 1)) * (i + 1))));
        events.push({
          id: `${fixtureId}-${player.id}-goal-${i + 1}`,
          fixtureId,
          fixtureName,
          gameweekId: gameweek.id,
          playerId: player.id,
          fplId: player.fplId,
          playerName: player.displayName,
          teamShortName: player.team.shortName,
          teamId: player.teamId,
          type: "GOAL",
          minute,
          detail: `Goal scored by ${player.displayName}`,
          pointsAwarded: player.position === "FWD" ? 4 : player.position === "MID" ? 5 : 6,
          timestamp: new Date().toISOString(),
        });
      }

      // Assists
      for (let i = 0; i < stat.assists; i++) {
        totalAssists++;
        const minute = Math.min(90, Math.max(1, Math.round((fixtureMinute / (stat.assists + 1)) * (i + 1))));
        events.push({
          id: `${fixtureId}-${player.id}-assist-${i + 1}`,
          fixtureId,
          fixtureName,
          gameweekId: gameweek.id,
          playerId: player.id,
          fplId: player.fplId,
          playerName: player.displayName,
          teamShortName: player.team.shortName,
          teamId: player.teamId,
          type: "ASSIST",
          minute,
          detail: `Assist by ${player.displayName}`,
          pointsAwarded: 3,
          timestamp: new Date().toISOString(),
        });
      }

      // Yellow Cards
      for (let i = 0; i < stat.yellowCards; i++) {
        totalYellowCards++;
        events.push({
          id: `${fixtureId}-${player.id}-yc-${i + 1}`,
          fixtureId,
          fixtureName,
          gameweekId: gameweek.id,
          playerId: player.id,
          fplId: player.fplId,
          playerName: player.displayName,
          teamShortName: player.team.shortName,
          teamId: player.teamId,
          type: "YELLOW_CARD",
          minute: Math.min(88, Math.max(10, fixtureMinute - 15)),
          detail: `Yellow card: ${player.displayName}`,
          pointsAwarded: -1,
          timestamp: new Date().toISOString(),
        });
      }

      // Red Cards
      for (let i = 0; i < stat.redCards; i++) {
        totalRedCards++;
        events.push({
          id: `${fixtureId}-${player.id}-rc-${i + 1}`,
          fixtureId,
          fixtureName,
          gameweekId: gameweek.id,
          playerId: player.id,
          fplId: player.fplId,
          playerName: player.displayName,
          teamShortName: player.team.shortName,
          teamId: player.teamId,
          type: "RED_CARD",
          minute: Math.min(90, Math.max(20, fixtureMinute - 5)),
          detail: `Red card: ${player.displayName}`,
          pointsAwarded: -3,
          timestamp: new Date().toISOString(),
        });
      }

      // Saves (every 3 saves = 1 pt)
      if (stat.saves >= 3) {
        totalSaves += stat.saves;
        events.push({
          id: `${fixtureId}-${player.id}-saves`,
          fixtureId,
          fixtureName,
          gameweekId: gameweek.id,
          playerId: player.id,
          fplId: player.fplId,
          playerName: player.displayName,
          teamShortName: player.team.shortName,
          teamId: player.teamId,
          type: "SAVE",
          minute: fixtureMinute,
          detail: `${stat.saves} saves by ${player.displayName}`,
          pointsAwarded: Math.floor(stat.saves / 3),
          timestamp: new Date().toISOString(),
        });
      }

      // Bonus
      if (stat.bonus > 0) {
        totalBonus += stat.bonus;
        events.push({
          id: `${fixtureId}-${player.id}-bonus`,
          fixtureId,
          fixtureName,
          gameweekId: gameweek.id,
          playerId: player.id,
          fplId: player.fplId,
          playerName: player.displayName,
          teamShortName: player.team.shortName,
          teamId: player.teamId,
          type: "BONUS",
          minute: 90,
          detail: `${stat.bonus} bonus points awarded to ${player.displayName}`,
          pointsAwarded: stat.bonus,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Sort chronologically by minute descending (most recent first)
    events.sort((a, b) => b.minute - a.minute);

    // Group events into fixtures
    const fixtureEventsMap = new Map<number, TimelineEvent[]>();
    for (const evt of events) {
      const list = fixtureEventsMap.get(evt.fixtureId) ?? [];
      list.push(evt);
      fixtureEventsMap.set(evt.fixtureId, list);
    }

    const fixtureSummaries: FixtureTimelineSummary[] = fixtures.map((f: any) => ({
      id: f.id,
      homeTeam: f.homeTeam.shortName,
      awayTeam: f.awayTeam.shortName,
      homeScore: f.homeScore,
      awayScore: f.awayScore,
      minutes: f.minutes,
      started: f.started,
      finished: f.finished,
      kickoffTime: f.kickoffTime,
      events: fixtureEventsMap.get(f.id) ?? [],
    }));

    return {
      gameweek: {
        id: gameweek.id,
        name: gameweek.name,
        isCurrent: gameweek.isCurrent,
        isFinished: gameweek.isFinished,
      },
      fixtures: fixtureSummaries,
      events,
      summary: {
        totalGoals,
        totalAssists,
        totalYellowCards,
        totalRedCards,
        totalSaves,
        totalBonus,
      },
      generatedAt: new Date().toISOString(),
    };
  }
}

export const liveTimelineService = new LiveTimelineService();

export interface LiveStatsPollPlayer {
  playerId: number;
  gameweekId: number;
  fixtureId?: number;
  fixtureName?: string;
  minutes: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  saves: number;
  bonus: number;
  totalPoints: number;
  player?: {
    id?: number;
    displayName?: string;
    fplId?: number;
    position?: string | Position;
    teamId?: number;
    team?: {
      id?: number;
      name?: string;
      shortName?: string;
    };
  };
}

export interface LiveWebSocketGateway {
  broadcast(event: string, payload: any): void | Promise<void>;
  broadcastToLeague?(leagueId: string, event: string, payload: any): void | Promise<void>;
}

export interface SquadScorePayload {
  squadId: string;
  gameweekId: number;
  totalPoints: number;
  startingPoints: number;
  benchPoints: number;
  captainPoints: number;
  transferCost: number;
  lineupDetails: any[];
  updatedAt: string;
}

export interface IngestionDeltaResult {
  matchEvents: TimelineEvent[];
  updatedSquadIds: string[];
  processedCount: number;
  errors?: string[];
}

export interface LiveScoreDaemonOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  redis?: IRedisCacheClient | null;
  gateway?: LiveWebSocketGateway;
  pollIntervalMs?: number;
}

export class LiveScoreIngestionDaemon {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private redis: IRedisCacheClient | null;
  private gateway: LiveWebSocketGateway | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private pollIntervalMs: number;

  // Key: `${gameweekId}:${playerId}`
  private lastStats: Map<string, LiveStatsPollPlayer> = new Map();
  // Set of emitted event IDs for deduplication
  private processedEventIds: Set<string> = new Set();

  constructor(options: LiveScoreDaemonOptions = {}) {
    this.db = options.db ?? prisma;
    this.redis = options.redis !== undefined ? options.redis : getRedisClient();
    this.gateway = options.gateway ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  public setGateway(gateway: LiveWebSocketGateway): void {
    this.gateway = gateway;
  }

  public getGateway(): LiveWebSocketGateway | null {
    return this.gateway;
  }

  public setRedis(redis: IRedisCacheClient | null): void {
    this.redis = redis;
  }

  public getProcessedEventIds(): Set<string> {
    return this.processedEventIds;
  }

  public reset(): void {
    this.stop();
    this.lastStats.clear();
    this.processedEventIds.clear();
  }

  public async cacheSquadScore(
    squadId: string,
    gameweekId: number,
    payload: SquadScorePayload
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const key = `live:squad:${squadId}:${gameweekId}`;
      await this.redis.set(key, JSON.stringify(payload), "EX", 3600);
    } catch (err) {
      console.warn(`[LiveScoreIngestionDaemon] Redis cache write failed: ${err}`);
    }
  }

  public async getCachedSquadScore(
    squadId: string,
    gameweekId: number
  ): Promise<SquadScorePayload | null> {
    if (!this.redis) return null;
    try {
      const key = `live:squad:${squadId}:${gameweekId}`;
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`[LiveScoreIngestionDaemon] Redis cache read failed: ${err}`);
      return null;
    }
  }

  /**
   * Processes a live stats poll batch for a gameweek:
   * 1. Detects deltas in goals, assists, yellow/red cards, saves, bonus
   * 2. Formats and deduplicates events
   * 3. Dispatches MATCH_EVENT_OCCURRED over the WebSocket gateway
   * 4. Identifies affected squads, recomputes live scores, caches in Redis
   * 5. Dispatches SQUAD_SCORE_UPDATED over the WebSocket gateway
   */
  public async processStatsUpdate(
    gameweekId: number,
    freshStats: LiveStatsPollPlayer[]
  ): Promise<IngestionDeltaResult> {
    const newEvents: TimelineEvent[] = [];
    const affectedPlayerIds = new Set<number>();

    for (const stat of freshStats) {
      const key = `${gameweekId}:${stat.playerId}`;
      const prev = this.lastStats.get(key);

      const playerId = stat.playerId;
      const fixtureId = stat.fixtureId ?? 0;
      const fixtureName = stat.fixtureName ?? "";
      const playerName = stat.player?.displayName ?? `Player #${playerId}`;
      const teamShortName = stat.player?.team?.shortName ?? "";
      const teamId = stat.player?.teamId ?? stat.player?.team?.id ?? 0;
      const fplId = stat.player?.fplId ?? playerId;
      const position = stat.player?.position ?? "MID";

      const fixtureMinute = Math.min(90, Math.max(1, stat.minutes || 1));

      // Calculate deltas
      const prevGoals = prev ? prev.goals : 0;
      const prevAssists = prev ? prev.assists : 0;
      const prevYellowCards = prev ? prev.yellowCards : 0;
      const prevRedCards = prev ? prev.redCards : 0;
      const prevSaves = prev ? prev.saves : 0;
      const prevBonus = prev ? prev.bonus : 0;

      let playerChanged = false;

      // 1. Goals delta
      if (stat.goals > prevGoals) {
        playerChanged = true;
        for (let g = prevGoals + 1; g <= stat.goals; g++) {
          const eventId = `${fixtureId}-${playerId}-goal-${g}`;
          if (!this.processedEventIds.has(eventId)) {
            this.processedEventIds.add(eventId);
            const pointsAwarded = position === "FWD" ? 4 : position === "MID" ? 5 : 6;
            newEvents.push({
              id: eventId,
              fixtureId,
              fixtureName,
              gameweekId,
              playerId,
              fplId,
              playerName,
              teamShortName,
              teamId,
              type: "GOAL",
              minute: fixtureMinute,
              detail: `Goal scored by ${playerName}`,
              pointsAwarded,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // 2. Assists delta
      if (stat.assists > prevAssists) {
        playerChanged = true;
        for (let a = prevAssists + 1; a <= stat.assists; a++) {
          const eventId = `${fixtureId}-${playerId}-assist-${a}`;
          if (!this.processedEventIds.has(eventId)) {
            this.processedEventIds.add(eventId);
            newEvents.push({
              id: eventId,
              fixtureId,
              fixtureName,
              gameweekId,
              playerId,
              fplId,
              playerName,
              teamShortName,
              teamId,
              type: "ASSIST",
              minute: fixtureMinute,
              detail: `Assist by ${playerName}`,
              pointsAwarded: 3,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // 3. Yellow Cards delta
      if (stat.yellowCards > prevYellowCards) {
        playerChanged = true;
        for (let y = prevYellowCards + 1; y <= stat.yellowCards; y++) {
          const eventId = `${fixtureId}-${playerId}-yc-${y}`;
          if (!this.processedEventIds.has(eventId)) {
            this.processedEventIds.add(eventId);
            newEvents.push({
              id: eventId,
              fixtureId,
              fixtureName,
              gameweekId,
              playerId,
              fplId,
              playerName,
              teamShortName,
              teamId,
              type: "YELLOW_CARD",
              minute: fixtureMinute,
              detail: `Yellow card: ${playerName}`,
              pointsAwarded: -1,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // 4. Red Cards delta
      if (stat.redCards > prevRedCards) {
        playerChanged = true;
        for (let r = prevRedCards + 1; r <= stat.redCards; r++) {
          const eventId = `${fixtureId}-${playerId}-rc-${r}`;
          if (!this.processedEventIds.has(eventId)) {
            this.processedEventIds.add(eventId);
            newEvents.push({
              id: eventId,
              fixtureId,
              fixtureName,
              gameweekId,
              playerId,
              fplId,
              playerName,
              teamShortName,
              teamId,
              type: "RED_CARD",
              minute: fixtureMinute,
              detail: `Red card: ${playerName}`,
              pointsAwarded: -3,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // 5. Saves delta (every 3 saves)
      if (stat.saves >= 3 && stat.saves > prevSaves) {
        playerChanged = true;
        const currentPoints = Math.floor(stat.saves / 3);
        const prevPoints = Math.floor(prevSaves / 3);
        if (currentPoints > prevPoints) {
          const eventId = `${fixtureId}-${playerId}-saves-${stat.saves}`;
          if (!this.processedEventIds.has(eventId)) {
            this.processedEventIds.add(eventId);
            newEvents.push({
              id: eventId,
              fixtureId,
              fixtureName,
              gameweekId,
              playerId,
              fplId,
              playerName,
              teamShortName,
              teamId,
              type: "SAVE",
              minute: fixtureMinute,
              detail: `${stat.saves} saves by ${playerName}`,
              pointsAwarded: currentPoints - prevPoints,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // 6. Bonus delta
      if (stat.bonus > prevBonus) {
        playerChanged = true;
        const eventId = `${fixtureId}-${playerId}-bonus`;
        if (!this.processedEventIds.has(eventId)) {
          this.processedEventIds.add(eventId);
          newEvents.push({
            id: eventId,
            fixtureId,
            fixtureName,
            gameweekId,
            playerId,
            fplId,
            playerName,
            teamShortName,
            teamId,
            type: "BONUS",
            minute: 90,
            detail: `${stat.bonus} bonus points awarded to ${playerName}`,
            pointsAwarded: stat.bonus - prevBonus,
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (
        playerChanged ||
        !prev ||
        prev.minutes !== stat.minutes ||
        prev.totalPoints !== stat.totalPoints
      ) {
        affectedPlayerIds.add(playerId);
      }

      // Update in-memory state
      this.lastStats.set(key, { ...stat });
    }

    // Dispatch MATCH_EVENT_OCCURRED events over gateway
    if (this.gateway && newEvents.length > 0) {
      for (const evt of newEvents) {
        try {
          await this.gateway.broadcast("MATCH_EVENT_OCCURRED", evt);
        } catch (err) {
          console.warn(`[LiveScoreIngestionDaemon] Failed to broadcast MATCH_EVENT_OCCURRED: ${err}`);
        }
      }
    }

    // Persist after broadcasting so storage latency never delays live updates
    await this.persistMatchEvents(gameweekId, newEvents);

    // Now recompute squad scores for squads owning affected players
    const updatedSquadIds: string[] = [];
    if (affectedPlayerIds.size > 0 && this.db?.squadPlayer?.findMany) {
      try {
        const squadMemberships = await this.db.squadPlayer.findMany({
          where: { playerId: { in: Array.from(affectedPlayerIds) } },
          select: { squadId: true },
          distinct: ["squadId"],
        });

        const targetSquadIds = squadMemberships.map((m: any) => m.squadId);

        if (targetSquadIds.length > 0 && this.db?.squad?.findMany) {
          const squads = await this.db.squad.findMany({
            where: { id: { in: targetSquadIds } },
            include: {
              players: {
                include: {
                  player: {
                    include: { team: true },
                  },
                },
              },
            },
          });

          // Build statsMap for scoring service
          const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
          for (const s of freshStats) {
            statsMap.set(s.playerId, { minutes: s.minutes, totalPoints: s.totalPoints });
          }

          for (const squad of squads) {
            const calculated = ScoringService.calculateLineupScore(
              squad.players.map((sp: any) => ({
                playerId: sp.playerId,
                position: sp.player?.position as Position,
                isStarter: sp.isStarter,
                isCaptain: sp.isCaptain,
                isViceCaptain: sp.isViceCaptain,
                positionOrder: sp.positionOrder,
              })),
              statsMap
            );

            const payload: SquadScorePayload = {
              squadId: squad.id,
              gameweekId,
              totalPoints: calculated.totalPoints,
              startingPoints: calculated.startingPoints,
              benchPoints: calculated.benchPoints,
              captainPoints: calculated.captainPoints,
              transferCost: calculated.transferCost,
              lineupDetails: calculated.details,
              updatedAt: new Date().toISOString(),
            };

            await this.cacheSquadScore(squad.id, gameweekId, payload);
            updatedSquadIds.push(squad.id);

            if (this.gateway) {
              try {
                await this.gateway.broadcast("SQUAD_SCORE_UPDATED", payload);
              } catch (err) {
                console.warn(`[LiveScoreIngestionDaemon] Failed to broadcast SQUAD_SCORE_UPDATED: ${err}`);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[LiveScoreIngestionDaemon] Failed to update squad scores: ${err}`);
      }
    }

    return {
      matchEvents: newEvents,
      updatedSquadIds,
      processedCount: freshStats.length,
    };
  }

  /**
   * Appends new events to the gameweek-partitioned live_match_events log
   * (issue #263). Event ids are deterministic, so (gameweekId, eventKey)
   * makes the write idempotent across daemon restarts. Best-effort: a storage
   * failure (e.g. a missing partition) must never stop live broadcasting.
   */
  private async persistMatchEvents(gameweekId: number, events: TimelineEvent[]): Promise<void> {
    if (events.length === 0 || !this.db?.liveMatchEvent?.createMany) return;
    try {
      await this.db.liveMatchEvent.createMany({
        data: events.map((evt) => ({
          gameweekId,
          eventKey: evt.id,
          fixtureId: evt.fixtureId,
          playerId: evt.playerId,
          type: evt.type,
          minute: evt.minute,
          pointsAwarded: evt.pointsAwarded,
          payload: {
            detail: evt.detail,
            playerName: evt.playerName,
            fplId: evt.fplId,
            teamId: evt.teamId,
            teamShortName: evt.teamShortName,
            fixtureName: evt.fixtureName,
          },
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      console.warn(`[LiveScoreIngestionDaemon] Failed to persist match events: ${err}`);
    }
  }

  public async pollAndIngest(gameweekId: number): Promise<IngestionDeltaResult | null> {
    if (!this.db?.playerGameweekStats?.findMany) return null;
    const freshStats = await this.db.playerGameweekStats.findMany({
      where: { gameweekId },
      include: {
        player: {
          include: { team: true },
        },
      },
    });

    return this.processStatsUpdate(gameweekId, freshStats);
  }

  public start(gameweekId: number, intervalMs?: number): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const interval = intervalMs ?? this.pollIntervalMs;
    this.timer = setInterval(() => {
      this.pollAndIngest(gameweekId).catch((err) => {
        console.error(`[LiveScoreIngestionDaemon] Polling error: ${err}`);
      });
    }, interval);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }
}

export const liveScoreIngestionDaemon = new LiveScoreIngestionDaemon();
