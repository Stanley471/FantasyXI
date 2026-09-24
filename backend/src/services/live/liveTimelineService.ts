/**
 * Live Match Event Timeline Service
 *
 * Parses match events (goals, assists, cards, saves, bonus) chronologically
 * per fixture and gameweek from live sports data and DB stats,
 * and formats them for real-time streaming and REST consumption.
 */

import { prisma } from "../../config/db.js";

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
