import { prisma } from "../../config/db.js";
import { eventFanout } from "./eventFanout.js";

export interface RetroactiveEventAdjustment {
  eventId: string;
  eventType: "GOAL" | "ASSIST" | "CARD" | "BONUS_ADJUSTMENT" | "CLEAN_SHEET";
  playerId: number;
  fixtureId: number;
  originalPoints: number;
  retractionPoints: number;
  reason: "VAR_DISALLOWED" | "RED_CARD_RESCINDED" | "BPS_ADJUSTMENT";
  appliedAt: Date;
}

export interface RollbackReport {
  eventId: string;
  squadsAffected: number;
  scoreAdjustments: Array<{
    squadId: string;
    squadName: string;
    previousPoints: number;
    newPoints: number;
    delta: number;
  }>;
  auditTrail: RetroactiveEventAdjustment[];
}

export class VARRollbackRecalculator {
  async processRetroactiveAdjustment(
    fixtureId: number,
    playerId: number,
    adjustment: RetroactiveEventAdjustment
  ): Promise<RollbackReport> {
    const report: RollbackReport = {
      eventId: adjustment.eventId,
      squadsAffected: 0,
      scoreAdjustments: [],
      auditTrail: [adjustment],
    };

    const fixture = await prisma.fixture.findUnique({
      where: { id: fixtureId },
      include: { gameweek: true },
    });

    if (!fixture || !fixture.gameweekId) {
      throw new Error(`Fixture ${fixtureId} not found or not assigned to gameweek`);
    }

    const affectedSquads = await prisma.squadGameweekScore.findMany({
      where: { gameweekId: fixture.gameweekId },
      include: {
        squad: {
          select: {
            id: true,
            name: true,
            lineups: {
              where: { gameweekId: fixture.gameweekId },
              select: {
                players: {
                  where: { playerId },
                  select: { id: true, isCaptain: true, isViceCaptain: true },
                },
              },
            },
          },
        },
      },
    });

    for (const squadScore of affectedSquads) {
      const playerInLineup =
        squadScore.squad.lineups[0]?.players.length ?? 0;

      if (!playerInLineup) continue;

      report.squadsAffected++;
      const prevPoints = squadScore.points;

      const captainMultiplier = squadScore.squad.lineups[0]!.players.some(
        (p) => p.isCaptain
      )
        ? 2
        : squadScore.squad.lineups[0]!.players.some((p) => p.isViceCaptain)
          ? 1.5
          : 1;

      const pointsToRetract = adjustment.retractionPoints * captainMultiplier;
      const newPoints = Math.max(0, prevPoints - pointsToRetract);

      await prisma.squadGameweekScore.update({
        where: { squadId_gameweekId: { squadId: squadScore.squadId, gameweekId: fixture.gameweekId } },
        data: {
          points: newPoints,
        },
      });

      await prisma.scoreAdjustmentLog.create({
        data: {
          runId: adjustment.eventId,
          gameweekId: fixture.gameweekId,
          squadId: squadScore.squadId,
          entityType: "VAR_ROLLBACK",
          entityId: playerId.toString(),
          previousPoints: prevPoints,
          newPoints,
          delta: newPoints - prevPoints,
          reason: adjustment.reason,
          details: {
            originalEventId: adjustment.eventId,
            playerId,
            fixtureId,
            captainMultiplier,
            eventType: adjustment.eventType,
          },
        },
      });

      report.scoreAdjustments.push({
        squadId: squadScore.squadId,
        squadName: squadScore.squad.name,
        previousPoints: prevPoints,
        newPoints,
        delta: newPoints - prevPoints,
      });

      eventFanout.publish(`gameweek:${fixture.gameweekId}`, `squad:${squadScore.squadId}`, {
        type: "score_adjustment",
        previousPoints: prevPoints,
        newPoints,
        delta: newPoints - prevPoints,
        reason: adjustment.reason,
        eventId: adjustment.eventId,
      });
    }

    return report;
  }

  async recalculateLeagueStandings(
    leagueId: string,
    affectedGameweekId: number
  ): Promise<void> {
    const league = await prisma.league.findUnique({
      where: { id: leagueId },
      include: {
        standings: {
          where: { gameweekId: affectedGameweekId },
        },
      },
    });

    if (!league) {
      throw new Error(`League ${leagueId} not found`);
    }

    const allScores = await prisma.squadGameweekScore.findMany({
      where: { gameweekId: affectedGameweekId },
      include: { squad: { select: { id: true, userId: true } } },
      orderBy: { points: "desc" },
    });

    let previousPoints = Number.MAX_SAFE_INTEGER;
    let rank = 1;
    let tiedCount = 0;

    for (const score of allScores) {
      if (score.points < previousPoints) {
        rank += tiedCount;
        tiedCount = 0;
      } else {
        tiedCount++;
      }

      await prisma.leagueStanding.update({
        where: {
          leagueId_squadId_gameweekId: {
            leagueId,
            squadId: score.squadId,
            gameweekId: affectedGameweekId,
          },
        },
        data: { rank },
      });

      previousPoints = score.points;
    }

    eventFanout.publish(`league:${leagueId}`, `standings:${affectedGameweekId}`, {
      type: "standings_recalculated",
      gameweekId: affectedGameweekId,
      updatedAt: new Date(),
    });
  }
}

export const varRollbackRecalculator = new VARRollbackRecalculator();
