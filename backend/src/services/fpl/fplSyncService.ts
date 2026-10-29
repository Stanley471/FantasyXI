import { liveService } from "../live/liveService.js";
import { prisma } from "../../config/db.js";
import { fplClient, FplClient } from "./fplClient.js";
import { emailService, EmailService } from "../email/emailService.js";
import { eventBus, EventBus } from "../events/eventBus.js";
import {
  CAPTAIN_INJURY_ALERT_EVENT,
  type CaptainInjuryAlertPayload,
} from "../events/domainEvents.js";
import crypto from "crypto";
import {
  normalizeTeam,
  normalizePlayer,
  normalizeGameweek,
  normalizeFixture,
  normalizePlayerStats,
} from "./fplNormalizer.js";

function generateHash(payload: any): string {
  const normalized = JSON.stringify(payload, (key, value) => {
    if (value instanceof Date) return value.getTime();
    if (value !== null && typeof value === "object" && typeof value.toNumber === "function") {
      return value.toNumber(); // Prisma Decimal
    }
    return value;
  });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * FPL Data Synchronization Service.
 *
 * Pulls external FPL data, normalizes it, and syncs into PostgreSQL via Prisma.
 *
 * Laravel equivalent: Like a scheduled Artisan command class:
 *   php artisan fpl:sync-bootstrap
 *   php artisan fpl:sync-fixtures
 *   php artisan fpl:sync-gameweek {id}
 */

export const CAPTAIN_ALERT_STATUSES = new Set(["i", "d", "s"]);

export interface SyncBootstrapResult {
  teamsCount: number;
  gameweeksCount: number;
  playersCount: number;
  captainAlertsDispatched?: number;
}

export interface SyncFixturesResult {
  fixturesCount: number;
}

export interface SyncStatsResult {
  gameweekId: number;
  gameweekFplId: number;
  statsCount: number;
}

export interface DetectedPlayerStatusTransition {
  fplId: number;
  playerId?: number;
  displayName: string;
  oldStatus: string;
  newStatus: string;
  news: string | null;
  chanceOfPlayingNextRound: number | null;
}

export interface FplSyncServiceOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  client?: FplClient;
  email?: EmailService;
  bus?: EventBus;
  teamManagementBaseUrl?: string;
}

export class FplSyncService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly client: FplClient;
  private readonly email: EmailService;
  private readonly bus: EventBus;
  private readonly teamManagementBaseUrl: string;

  constructor(options: FplSyncServiceOptions = {}) {
    this.db = options.db ?? prisma;
    this.client = options.client ?? fplClient;
    this.email = options.email ?? emailService;
    this.bus = options.bus ?? eventBus;
    this.teamManagementBaseUrl = (
      options.teamManagementBaseUrl ??
      process.env.FRONTEND_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, "");
  }

  /**
   * Synchronizes Teams, Gameweeks, and Players from FPL bootstrap-static.
   * Also detects when a player's status transitions to injured ('i'), doubtful ('d'),
   * or suspended ('s') prior to the gameweek deadline and triggers CaptainInjuryAlertEmail
   * notifications for all managers who have that player designated as captain.
   */
  public async syncBootstrap(): Promise<SyncBootstrapResult> {
    console.log("🔄 Starting FPL bootstrap sync...");
    const raw = await this.client.getBootstrapStatic();

    // 1. Sync Teams
    console.log(`Synchronizing ${raw.teams.length} teams...`);
    const existingTeams = await this.db.team.findMany();
    const existingTeamHashes = new Map(
      existingTeams.map((t: any) => [
        t.fplId,
        generateHash({
          name: t.name,
          shortName: t.shortName,
          logoUrl: t.logoUrl,
          strength: t.strength,
          strengthOverallHome: t.strengthOverallHome,
          strengthOverallAway: t.strengthOverallAway,
          strengthAttackHome: t.strengthAttackHome,
          strengthAttackAway: t.strengthAttackAway,
          strengthDefenceHome: t.strengthDefenceHome,
          strengthDefenceAway: t.strengthDefenceAway,
        }),
      ])
    );

    const teamOps = [];
    for (const rawTeam of raw.teams) {
      const team = normalizeTeam(rawTeam);
      const payload = {
        name: team.name,
        shortName: team.shortName,
        logoUrl: team.logoUrl,
        strength: team.strength,
        strengthOverallHome: team.strengthOverallHome,
        strengthOverallAway: team.strengthOverallAway,
        strengthAttackHome: team.strengthAttackHome,
        strengthAttackAway: team.strengthAttackAway,
        strengthDefenceHome: team.strengthDefenceHome,
        strengthDefenceAway: team.strengthDefenceAway,
      };

      const incomingHash = generateHash(payload);
      const existingHash = existingTeamHashes.get(team.fplId);

      if (incomingHash !== existingHash) {
        teamOps.push(
          this.db.team.upsert({
            where: { fplId: team.fplId },
            update: payload,
            create: { fplId: team.fplId, ...payload },
          })
        );
      }
    }

    if (teamOps.length > 0) {
      console.log(`Executing ${teamOps.length} team updates...`);
      await this.db.$transaction(teamOps);
    }

    // Fetch all teams again to build the map for players
    const syncedTeams = await this.db.team.findMany();

    // Build map of team FPL ID -> Local Database ID
    const teamMap = new Map<number, number>();
    for (const team of syncedTeams) {
      teamMap.set(team.fplId, team.id);
    }

    // 2. Sync Gameweeks
    console.log(`Synchronizing ${raw.events.length} gameweeks...`);
    const existingGameweeks = await this.db.gameweek.findMany();
    const existingGwHashes = new Map(
      existingGameweeks.map((gw: any) => [
        gw.fplId,
        generateHash({
          name: gw.name,
          deadline: gw.deadline,
          isCurrent: gw.isCurrent,
          isFinished: gw.isFinished,
          season: gw.season,
        }),
      ])
    );

    const gwOps = [];
    for (const rawEvent of raw.events) {
      const gw = normalizeGameweek(rawEvent);
      const payload = {
        name: gw.name,
        deadline: gw.deadline,
        isCurrent: gw.isCurrent,
        isFinished: gw.isFinished,
        season: gw.season,
      };

      const incomingHash = generateHash(payload);
      const existingHash = existingGwHashes.get(gw.fplId);

      if (incomingHash !== existingHash) {
        gwOps.push(
          this.db.gameweek.upsert({
            where: { fplId: gw.fplId },
            update: payload,
            create: { fplId: gw.fplId, ...payload },
          })
        );
      }
    }

    if (gwOps.length > 0) {
      console.log(`Executing ${gwOps.length} gameweek updates...`);
      await this.db.$transaction(gwOps);
    }

    const syncedGameweeks = await this.db.gameweek.findMany();

    // 3. Sync Players
    console.log(`Synchronizing ${raw.elements.length} players...`);
    const existingPlayers = await this.db.player.findMany();
    const existingPlayerByFplId = new Map<number, any>(
      existingPlayers.map((p: any) => [p.fplId, p])
    );
    const existingPlayerHashes = new Map(
      existingPlayers.map((p: any) => [
        p.fplId,
        generateHash({
          firstName: p.firstName,
          lastName: p.lastName,
          displayName: p.displayName,
          position: p.position,
          teamId: p.teamId,
          price: p.price,
          totalPoints: p.totalPoints,
          minutesPlayed: p.minutesPlayed,
          goalsScored: p.goalsScored,
          assists: p.assists,
          cleanSheets: p.cleanSheets,
          form: p.form,
          status: p.status,
          news: p.news,
          chanceOfPlayingNextRound: p.chanceOfPlayingNextRound,
          selectedByPercent: p.selectedByPercent,
          photoUrl: p.photoUrl,
          isAvailable: p.isAvailable,
        }),
      ])
    );

    let playersCount = 0;
    const playerOps = [];
    const statusTransitions: DetectedPlayerStatusTransition[] = [];

    for (const rawPlayer of raw.elements) {
      const localTeamId = teamMap.get(rawPlayer.team);
      if (!localTeamId) {
        console.warn(`Skipping player ${rawPlayer.id}: Unknown team ${rawPlayer.team}`);
        continue;
      }

      const p = normalizePlayer(rawPlayer);
      const existingPlayer = existingPlayerByFplId.get(p.fplId);
      const oldStatus = (existingPlayer?.status ?? "a").toLowerCase();
      const newStatus = (p.status ?? "a").toLowerCase();

      if (existingPlayer && newStatus !== oldStatus && CAPTAIN_ALERT_STATUSES.has(newStatus)) {
        statusTransitions.push({
          fplId: p.fplId,
          playerId: existingPlayer.id,
          displayName: p.displayName,
          oldStatus,
          newStatus,
          news: p.news,
          chanceOfPlayingNextRound: p.chanceOfPlayingNextRound,
        });
      }

      const payload = {
        firstName: p.firstName,
        lastName: p.lastName,
        displayName: p.displayName,
        position: p.position,
        teamId: localTeamId,
        price: p.price,
        totalPoints: p.totalPoints,
        minutesPlayed: p.minutesPlayed,
        goalsScored: p.goalsScored,
        assists: p.assists,
        cleanSheets: p.cleanSheets,
        form: p.form,
        status: p.status,
        news: p.news,
        chanceOfPlayingNextRound: p.chanceOfPlayingNextRound,
        selectedByPercent: p.selectedByPercent,
        photoUrl: p.photoUrl,
        isAvailable: p.isAvailable,
      };

      const incomingHash = generateHash(payload);
      const existingHash = existingPlayerHashes.get(p.fplId);

      if (incomingHash !== existingHash) {
        playerOps.push(
          this.db.player.upsert({
            where: { fplId: p.fplId },
            update: payload,
            create: { fplId: p.fplId, ...payload },
          })
        );
        playersCount++;

        // Batch execution for Players (chunk of 100)
        if (playerOps.length >= 100) {
          await this.db.$transaction(playerOps);
          playerOps.length = 0;
        }
      }
    }

    // Flush remaining players
    if (playerOps.length > 0) {
      await this.db.$transaction(playerOps);
    }

    // 4. Detect & dispatch CaptainInjuryAlertEmail notifications prior to deadline
    let captainAlertsDispatched = 0;
    if (statusTransitions.length > 0) {
      captainAlertsDispatched = await this.processCaptainInjuryTransitions(
        statusTransitions,
        syncedGameweeks
      );
    }

    console.log(
      `✅ FPL Bootstrap sync complete: ${syncedTeams.length} teams, ${syncedGameweeks.length} gameweeks, ${playersCount} players.`
    );

    return {
      teamsCount: syncedTeams.length,
      gameweeksCount: syncedGameweeks.length,
      playersCount,
      captainAlertsDispatched,
    };
  }

  /**
   * Resolves the upcoming or active pre-deadline gameweek and dispatches captain
   * injury alerts for any players whose status changed to 'i', 'd', or 's'.
   */
  public async processCaptainInjuryTransitions(
    transitions: DetectedPlayerStatusTransition[],
    gameweeks?: any[]
  ): Promise<number> {
    if (transitions.length === 0) return 0;

    const gwList = gameweeks ?? (await this.db.gameweek?.findMany?.()) ?? [];
    const now = new Date();

    // Find a gameweek prior to its deadline (or current unfinished gameweek)
    const targetGameweek =
      gwList.find(
        (gw: any) => !gw.isFinished && gw.deadline && new Date(gw.deadline) > now
      ) ??
      gwList.find((gw: any) => gw.isCurrent && !gw.isFinished) ??
      gwList[0] ?? { id: 1, name: "Gameweek 1", deadline: new Date(now.getTime() + 86_400_000) };

    // If a deadline is explicitly present and has already passed for a finished/locked gameweek, skip
    if (
      targetGameweek.isFinished ||
      targetGameweek.isLocked ||
      (targetGameweek.deadline && new Date(targetGameweek.deadline) <= now && !targetGameweek.isCurrent)
    ) {
      return 0;
    }

    let dispatchedCount = 0;

    for (const transition of transitions) {
      if (!CAPTAIN_ALERT_STATUSES.has(transition.newStatus.toLowerCase())) {
        continue;
      }

      let localPlayerId = transition.playerId;
      if (!localPlayerId && this.db.player?.findUnique) {
        const playerRecord = await this.db.player.findUnique({
          where: { fplId: transition.fplId },
          select: { id: true },
        });
        localPlayerId = playerRecord?.id;
      }
      if (!localPlayerId) continue;

      const eventPayload: CaptainInjuryAlertPayload = {
        playerId: localPlayerId,
        fplId: transition.fplId,
        playerName: transition.displayName,
        oldStatus: transition.oldStatus,
        newStatus: transition.newStatus,
        news: transition.news,
        chanceOfPlayingNextRound: transition.chanceOfPlayingNextRound,
        gameweekId: targetGameweek.id,
        gameweekName: targetGameweek.name,
        deadline: targetGameweek.deadline,
      };

      await this.bus.publish(CAPTAIN_INJURY_ALERT_EVENT, eventPayload);

      if (!this.db.squadPlayer?.findMany) continue;

      // Query all active squads where this player is designated as isCaptain: true
      const captainEntries = await this.db.squadPlayer.findMany({
        where: {
          playerId: localPlayerId,
          isCaptain: true,
        },
        include: {
          squad: {
            include: {
              user: true,
            },
          },
        },
      });

      for (const entry of captainEntries) {
        // Guard against any non-captain rows if a mock DB doesn't filter `where.isCaptain`
        if (!entry.isCaptain) continue;

        const squad = entry.squad;
        const user = squad?.user;
        if (!squad || !user?.email) continue;

        const managerName = user.name || user.username || "Manager";
        const teamManagementUrl = `${this.teamManagementBaseUrl}/team?squadId=${encodeURIComponent(squad.id)}`;

        const result = await this.email.enqueueCaptainInjuryAlertEmail({
          to: user.email,
          managerName,
          captainName: transition.displayName,
          squadId: squad.id,
          squadName: squad.name,
          playerId: localPlayerId,
          gameweekId: targetGameweek.id,
          gameweekName: targetGameweek.name,
          status: transition.newStatus,
          news: transition.news,
          chanceOfPlayingNextRound: transition.chanceOfPlayingNextRound,
          teamManagementUrl,
        });

        if (result.success && !result.skipped) {
          dispatchedCount++;
        }
      }
    }

    return dispatchedCount;
  }

  /**
   * Synchronizes fixtures from FPL.
   */
  public async syncFixtures(): Promise<SyncFixturesResult> {
    console.log("🔄 Starting FPL fixtures sync...");
    const rawFixtures = await this.client.getFixtures();

    // Preload team and gameweek lookups
    const teams = await this.db.team.findMany({ select: { id: true, fplId: true } });
    const teamMap = new Map<number, number>(teams.map((t: any) => [t.fplId, t.id]));

    const gameweeks = await this.db.gameweek.findMany({
      select: { id: true, fplId: true },
    });
    const gwMap = new Map<number, number>(gameweeks.map((g: any) => [g.fplId, g.id]));

    const existingFixtures = await this.db.fixture.findMany();
    const existingFixtureHashes = new Map(
      existingFixtures.map((f: any) => [
        f.fplId,
        generateHash({
          gameweekId: f.gameweekId,
          homeTeamId: f.homeTeamId,
          awayTeamId: f.awayTeamId,
          kickoffTime: f.kickoffTime,
          started: f.started,
          finished: f.finished,
          homeScore: f.homeScore,
          awayScore: f.awayScore,
          minutes: f.minutes,
        }),
      ])
    );

    let fixturesCount = 0;
    const fixtureOps = [];

    for (const raw of rawFixtures) {
      const homeTeamId = teamMap.get(raw.team_h);
      const awayTeamId = teamMap.get(raw.team_a);

      if (!homeTeamId || !awayTeamId) {
        continue;
      }

      const gameweekId = raw.event ? gwMap.get(raw.event) ?? null : null;
      const f = normalizeFixture(raw);
      const payload = {
        gameweekId,
        homeTeamId,
        awayTeamId,
        kickoffTime: f.kickoffTime,
        started: f.started,
        finished: f.finished,
        homeScore: f.homeScore,
        awayScore: f.awayScore,
        minutes: f.minutes,
      };

      const incomingHash = generateHash(payload);
      const existingHash = existingFixtureHashes.get(f.fplId);

      if (incomingHash !== existingHash) {
        fixtureOps.push(
          this.db.fixture.upsert({
            where: { fplId: f.fplId },
            update: payload,
            create: { fplId: f.fplId, ...payload },
          })
        );
        fixturesCount++;

        if (fixtureOps.length >= 100) {
          await this.db.$transaction(fixtureOps);
          fixtureOps.length = 0;
        }
      }
    }

    if (fixtureOps.length > 0) {
      await this.db.$transaction(fixtureOps);
    }

    console.log(`✅ FPL Fixtures sync complete: ${fixturesCount} fixtures.`);
    return { fixturesCount };
  }

  /**
   * Synchronizes PlayerGameweekStats for a specified gameweek from live event data.
   */
  public async syncGameweekLiveStats(gameweekFplId: number): Promise<SyncStatsResult> {
    console.log(`🔄 Starting FPL live stats sync for Gameweek ${gameweekFplId}...`);
    const gameweek = await this.db.gameweek.findUnique({
      where: { fplId: gameweekFplId },
    });

    if (!gameweek) {
      throw new Error(`Gameweek with fplId ${gameweekFplId} not found in database.`);
    }

    const liveData = await this.client.getGameweekLive(gameweekFplId);

    // Preload player map
    const players = await this.db.player.findMany({
      select: { id: true, fplId: true },
    });
    const playerMap = new Map<number, number>(players.map((p: any) => [p.fplId, p.id]));

    const fixtures = await this.db.fixture.findMany({
      select: { id: true, fplId: true },
      where: { gameweekId: gameweek.id },
    });
    const fixtureMap = new Map<number, number>(fixtures.map((f: any) => [f.fplId, f.id]));

    const existingStats = await this.db.playerGameweekStats.findMany({
      where: { gameweekId: gameweek.id },
    });
    const existingStatsHashes = new Map(
      existingStats.map((s: any) => [
        `${s.playerId}_${s.fixtureId}`,
        generateHash({
          minutes: s.minutes,
          goals: s.goals,
          assists: s.assists,
          cleanSheet: s.cleanSheet,
          yellowCards: s.yellowCards,
          redCards: s.redCards,
          saves: s.saves,
          goalsConceded: s.goalsConceded,
          ownGoals: s.ownGoals,
          penaltiesSaved: s.penaltiesSaved,
          penaltiesMissed: s.penaltiesMissed,
          bps: s.bps,
          bonus: s.bonus,
          totalPoints: s.totalPoints,
        }),
      ])
    );

    let statsCount = 0;
    const statsOps = [];
    const committedDeltas: Array<{
      playerId: number;
      fixtureId: number;
      data: Record<string, unknown>;
    }> = [];
    const publishDeltas = () => {
      for (const delta of committedDeltas)
        liveService.publishPlayerDelta(gameweek.id, delta.playerId, delta.fixtureId, delta.data);
      committedDeltas.length = 0;
    };

    for (const rawElement of liveData.elements) {
      const localPlayerId = playerMap.get(rawElement.id);
      if (!localPlayerId) {
        continue;
      }

      const statsArray = normalizePlayerStats(rawElement);

      for (const stats of statsArray) {
        const localFixtureId = fixtureMap.get(stats.fixtureFplId);
        if (!localFixtureId) continue;

        const payload = {
          minutes: stats.minutes,
          goals: stats.goals,
          assists: stats.assists,
          cleanSheet: stats.cleanSheet,
          yellowCards: stats.yellowCards,
          redCards: stats.redCards,
          saves: stats.saves,
          goalsConceded: stats.goalsConceded,
          ownGoals: stats.ownGoals,
          penaltiesSaved: stats.penaltiesSaved,
          penaltiesMissed: stats.penaltiesMissed,
          bps: stats.bps,
          bonus: stats.bonus,
          totalPoints: stats.totalPoints,
        };

        const incomingHash = generateHash(payload);
        const existingHash = existingStatsHashes.get(`${localPlayerId}_${localFixtureId}`);

        if (incomingHash !== existingHash) {
          statsOps.push(
            this.db.playerGameweekStats.upsert({
              where: {
                playerId_gameweekId_fixtureId: {
                  playerId: localPlayerId,
                  gameweekId: gameweek.id,
                  fixtureId: localFixtureId,
                },
              },
              update: payload,
              create: {
                playerId: localPlayerId,
                gameweekId: gameweek.id,
                fixtureId: localFixtureId,
                ...payload,
              },
            })
          );
          statsCount++;
          committedDeltas.push({
            playerId: localPlayerId,
            fixtureId: localFixtureId,
            data: payload,
          });

          if (statsOps.length >= 100) {
            await this.db.$transaction(statsOps);
            publishDeltas();
            statsOps.length = 0;
          }
        }
      }
    }

    if (statsOps.length > 0) {
      await this.db.$transaction(statsOps);
      publishDeltas();
    }

    console.log(
      `✅ FPL Gameweek ${gameweekFplId} live stats sync complete: ${statsCount} player stats recorded.`
    );

    return {
      gameweekId: gameweek.id,
      gameweekFplId,
      statsCount,
    };
  }
}

export const fplSyncService = new FplSyncService();
