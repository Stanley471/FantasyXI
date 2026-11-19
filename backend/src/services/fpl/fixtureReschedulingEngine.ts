import { prisma } from "../../config/db.js";
import { scoringService } from "../scoring/scoringService.js";
import { eventFanout } from "../live/eventFanout.js";

export interface GameweekReschedulePayload {
  fixtureId: number;
  fplFixtureId: number;
  fromGameweekFplId: number | null;
  toGameweekFplId: number | null;
  kickoffTime?: Date | string | null;
  postponed?: boolean;
}

export interface BlankGameweekAnalysis {
  gameweekFplId: number;
  affectedTeamCount: number;
  totalFixturesPostponed: number;
  rescheduledFixtures: GameweekReschedulePayload[];
}

export interface DoubleGameweekTeam {
  gameweekFplId: number;
  teamFplId: number;
  fixtureCount: number;
  fixtures: Array<{ fplId: number; opponent: string }>;
}

export interface DynamicDeadlineAdjustment {
  gameweekFplId: number;
  originalDeadline: Date;
  adjustedDeadline: Date;
  reason: "DOUBLE_GAMEWEEK" | "POSTPONEMENT" | "RESCHEDULED_KICKOFF";
}

export class FixtureReschedulingEngine {
  async parseRescheduleAnnouncement(
    incomingFixtures: GameweekReschedulePayload[]
  ): Promise<BlankGameweekAnalysis> {
    const analysis: BlankGameweekAnalysis = {
      gameweekFplId: 0,
      affectedTeamCount: 0,
      totalFixturesPostponed: 0,
      rescheduledFixtures: [],
    };

    const postponedCount = new Map<number, number>();
    const teamsAffected = new Set<number>();

    for (const fixture of incomingFixtures) {
      if (fixture.postponed || fixture.toGameweekFplId === null) {
        const gwId = fixture.fromGameweekFplId ?? fixture.toGameweekFplId ?? 0;
        postponedCount.set(gwId, (postponedCount.get(gwId) ?? 0) + 1);
        analysis.totalFixturesPostponed++;

        const dbFixture = await prisma.fixture.findUnique({
          where: { fplId: fixture.fplFixtureId },
        });

        if (dbFixture) {
          teamsAffected.add(dbFixture.homeTeamFplId);
          teamsAffected.add(dbFixture.awayTeamFplId);
        }
      }

      analysis.rescheduledFixtures.push(fixture);
    }

    analysis.affectedTeamCount = teamsAffected.size;

    if (postponedCount.size > 0) {
      analysis.gameweekFplId = Array.from(postponedCount.entries()).sort(
        (a, b) => b[1] - a[1]
      )[0]![0];
    }

    return analysis;
  }

  async identifyDoubleGameweeks(
    incomingFixtures: GameweekReschedulePayload[]
  ): Promise<DoubleGameweekTeam[]> {
    const teamFixturesPerGw = new Map<string, GameweekReschedulePayload[]>();

    for (const fixture of incomingFixtures) {
      if (!fixture.toGameweekFplId || fixture.postponed) continue;

      const dbFixture = await prisma.fixture.findUnique({
        where: { fplId: fixture.fplFixtureId },
        include: { homeTeam: true, awayTeam: true },
      });

      if (!dbFixture) continue;

      const homeKey = `${fixture.toGameweekFplId}:${dbFixture.homeTeamFplId}`;
      const awayKey = `${fixture.toGameweekFplId}:${dbFixture.awayTeamFplId}`;

      teamFixturesPerGw.set(
        homeKey,
        [...(teamFixturesPerGw.get(homeKey) ?? []), fixture]
      );
      teamFixturesPerGw.set(
        awayKey,
        [...(teamFixturesPerGw.get(awayKey) ?? []), fixture]
      );
    }

    const dgwTeams: DoubleGameweekTeam[] = [];

    for (const [key, fixtures] of teamFixturesPerGw.entries()) {
      if (fixtures.length < 2) continue;

      const [gwStr, teamStr] = key.split(":");
      const gwFplId = Number(gwStr);
      const teamFplId = Number(teamStr);

      const fixtureDetails = await Promise.all(
        fixtures.map(async (f) => {
          const dbFixture = await prisma.fixture.findUnique({
            where: { fplId: f.fplFixtureId },
            include: { homeTeam: true, awayTeam: true },
          });

          if (!dbFixture) return { fplId: f.fplFixtureId, opponent: "Unknown" };

          const opponent =
            dbFixture.homeTeamFplId === teamFplId
              ? dbFixture.awayTeam.name
              : dbFixture.homeTeam.name;

          return { fplId: f.fplFixtureId, opponent };
        })
      );

      dgwTeams.push({
        gameweekFplId: gwFplId,
        teamFplId,
        fixtureCount: fixtures.length,
        fixtures: fixtureDetails,
      });
    }

    return dgwTeams;
  }

  async applyDynamicDeadlineAdjustments(
    reschedules: GameweekReschedulePayload[]
  ): Promise<DynamicDeadlineAdjustment[]> {
    const adjustments: DynamicDeadlineAdjustment[] = [];

    const affectedGameweeks = new Set<number>();
    const dgwTeams = await this.identifyDoubleGameweeks(reschedules);

    for (const dgw of dgwTeams) {
      affectedGameweeks.add(dgw.gameweekFplId);
    }

    for (const gwId of affectedGameweeks) {
      const gw = await prisma.gameweek.findUnique({
        where: { fplId: gwId },
      });

      if (!gw) continue;

      const latestKickoff = await this.getLatestFixtureKickoff(gwId);

      if (latestKickoff && latestKickoff > gw.deadline) {
        const adjustment: DynamicDeadlineAdjustment = {
          gameweekFplId: gwId,
          originalDeadline: gw.deadline,
          adjustedDeadline: new Date(latestKickoff.getTime() + 300000),
          reason: "DOUBLE_GAMEWEEK",
        };

        await prisma.gameweek.update({
          where: { id: gw.id },
          data: { deadline: adjustment.adjustedDeadline },
        });

        adjustments.push(adjustment);

        eventFanout.publish("gameweek:deadlines", `gw:${gwId}`, {
          type: "deadline_adjusted",
          gameweekId: gwId,
          originalDeadline: gw.deadline,
          newDeadline: adjustment.adjustedDeadline,
          reason: adjustment.reason,
        });
      }
    }

    return adjustments;
  }

  async applyRescheduledFixtures(
    reschedules: GameweekReschedulePayload[]
  ): Promise<number> {
    let count = 0;

    const gameweeks = await prisma.gameweek.findMany();
    const gwFplToLocal = new Map(gameweeks.map((g) => [g.fplId, g]));

    for (const reschedule of reschedules) {
      const dbFixture = await prisma.fixture.findUnique({
        where: { fplId: reschedule.fplFixtureId },
      });

      if (!dbFixture) continue;

      const newLocalGw = reschedule.toGameweekFplId
        ? gwFplToLocal.get(reschedule.toGameweekFplId)
        : null;

      if (dbFixture.gameweekId === newLocalGw?.id) {
        continue;
      }

      const oldGwId = dbFixture.gameweekId;

      await prisma.fixture.update({
        where: { id: dbFixture.id },
        data: {
          gameweekId: newLocalGw?.id ?? null,
          kickoffTime: reschedule.kickoffTime
            ? new Date(reschedule.kickoffTime)
            : dbFixture.kickoffTime,
        },
      });

      if (dbFixture.playerGameweekStats && dbFixture.playerGameweekStats.length > 0) {
        await prisma.playerGameweekStats.updateMany({
          where: { fixtureId: dbFixture.id },
          data: { gameweekId: newLocalGw?.id ?? null },
        });
      }

      await this.recalculateSquadScores(oldGwId, newLocalGw?.id ?? null);

      count++;

      eventFanout.publish("fixtures:rescheduled", `fixture:${dbFixture.fplId}`, {
        type: "fixture_moved",
        fixtureId: dbFixture.fplId,
        fromGameweekId: oldGwId,
        toGameweekId: newLocalGw?.id,
        kickoffTime: reschedule.kickoffTime,
      });
    }

    return count;
  }

  private async getLatestFixtureKickoff(gameweekFplId: number): Promise<Date | null> {
    const gw = await prisma.gameweek.findUnique({
      where: { fplId: gameweekFplId },
    });

    if (!gw) return null;

    const fixtures = await prisma.fixture.findMany({
      where: { gameweekId: gw.id },
      orderBy: { kickoffTime: "desc" },
      take: 1,
    });

    return fixtures[0]?.kickoffTime ?? null;
  }

  private async recalculateSquadScores(
    oldGameweekId: number | null,
    newGameweekId: number | null
  ): Promise<void> {
    const affectedGwIds = new Set<number>();

    if (oldGameweekId) affectedGwIds.add(oldGameweekId);
    if (newGameweekId) affectedGwIds.add(newGameweekId);

    for (const gwId of affectedGwIds) {
      const gw = await prisma.gameweek.findUnique({
        where: { id: gwId },
      });

      if (!gw || gw.isFinished || gw.settledAt) {
        continue;
      }

      const squads = await prisma.squad.findMany({
        select: { id: true },
        take: 1000,
      });

      for (const squad of squads) {
        await scoringService.calculateAndPersistSquadScore(squad.id, gwId);
      }
    }
  }
}

export const fixtureReschedulingEngine = new FixtureReschedulingEngine();
