import { prisma } from "../../config/db.js";
import { fplClient } from "./fplClient.js";
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

export interface SyncBootstrapResult {
  teamsCount: number;
  gameweeksCount: number;
  playersCount: number;
}

export interface SyncFixturesResult {
  fixturesCount: number;
}

export interface SyncStatsResult {
  gameweekId: number;
  gameweekFplId: number;
  statsCount: number;
}

export class FplSyncService {
  /**
   * Synchronizes Teams, Gameweeks, and Players from FPL bootstrap-static.
   */
  public async syncBootstrap(): Promise<SyncBootstrapResult> {
    console.log("🔄 Starting FPL bootstrap sync...");
    const raw = await fplClient.getBootstrapStatic();

    // 1. Sync Teams
    console.log(`Synchronizing ${raw.teams.length} teams...`);
    const existingTeams = await prisma.team.findMany();
    const existingTeamHashes = new Map(
      existingTeams.map(t => [
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
        })
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
          prisma.team.upsert({
            where: { fplId: team.fplId },
            update: payload,
            create: { fplId: team.fplId, ...payload },
          })
        );
      }
    }

    if (teamOps.length > 0) {
      console.log(`Executing ${teamOps.length} team updates...`);
      await prisma.$transaction(teamOps);
    }
    
    // Fetch all teams again to build the map for players
    const syncedTeams = await prisma.team.findMany();

    // Build map of team FPL ID -> Local Database ID
    const teamMap = new Map<number, number>();
    for (const team of syncedTeams) {
      teamMap.set(team.fplId, team.id);
    }

    // 2. Sync Gameweeks
    console.log(`Synchronizing ${raw.events.length} gameweeks...`);
    const existingGameweeks = await prisma.gameweek.findMany();
    const existingGwHashes = new Map(
      existingGameweeks.map(gw => [
        gw.fplId,
        generateHash({
          name: gw.name,
          deadline: gw.deadline,
          isCurrent: gw.isCurrent,
          isFinished: gw.isFinished,
          season: gw.season,
        })
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
          prisma.gameweek.upsert({
            where: { fplId: gw.fplId },
            update: payload,
            create: { fplId: gw.fplId, ...payload },
          })
        );
      }
    }

    if (gwOps.length > 0) {
      console.log(`Executing ${gwOps.length} gameweek updates...`);
      await prisma.$transaction(gwOps);
    }
    
    const syncedGameweeks = await prisma.gameweek.findMany();

    // 3. Sync Players
    console.log(`Synchronizing ${raw.elements.length} players...`);
    const existingPlayers = await prisma.player.findMany();
    const existingPlayerHashes = new Map(
      existingPlayers.map(p => [
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
        })
      ])
    );

    let playersCount = 0;
    const playerOps = [];
    
    for (const rawPlayer of raw.elements) {
      const localTeamId = teamMap.get(rawPlayer.team);
      if (!localTeamId) {
        console.warn(`Skipping player ${rawPlayer.id}: Unknown team ${rawPlayer.team}`);
        continue;
      }

      const p = normalizePlayer(rawPlayer);
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
          prisma.player.upsert({
            where: { fplId: p.fplId },
            update: payload,
            create: { fplId: p.fplId, ...payload },
          })
        );
        playersCount++;

        // Batch execution for Players (chunk of 100)
        if (playerOps.length >= 100) {
          await prisma.$transaction(playerOps);
          playerOps.length = 0;
        }
      }
    }

    // Flush remaining players
    if (playerOps.length > 0) {
      await prisma.$transaction(playerOps);
    }

    console.log(
      `✅ FPL Bootstrap sync complete: ${syncedTeams.length} teams, ${syncedGameweeks.length} gameweeks, ${playersCount} players.`
    );

    return {
      teamsCount: syncedTeams.length,
      gameweeksCount: syncedGameweeks.length,
      playersCount,
    };
  }

  /**
   * Synchronizes fixtures from FPL.
   */
  public async syncFixtures(): Promise<SyncFixturesResult> {
    console.log("🔄 Starting FPL fixtures sync...");
    const rawFixtures = await fplClient.getFixtures();

    // Preload team and gameweek lookups
    const teams = await prisma.team.findMany({ select: { id: true, fplId: true } });
    const teamMap = new Map<number, number>(teams.map((t) => [t.fplId, t.id]));

    const gameweeks = await prisma.gameweek.findMany({
      select: { id: true, fplId: true },
    });
    const gwMap = new Map<number, number>(gameweeks.map((g) => [g.fplId, g.id]));

    const existingFixtures = await prisma.fixture.findMany();
    const existingFixtureHashes = new Map(
      existingFixtures.map(f => [
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
        })
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
          prisma.fixture.upsert({
            where: { fplId: f.fplId },
            update: payload,
            create: { fplId: f.fplId, ...payload },
          })
        );
        fixturesCount++;
        
        if (fixtureOps.length >= 100) {
          await prisma.$transaction(fixtureOps);
          fixtureOps.length = 0;
        }
      }
    }

    if (fixtureOps.length > 0) {
      await prisma.$transaction(fixtureOps);
    }

    console.log(`✅ FPL Fixtures sync complete: ${fixturesCount} fixtures.`);
    return { fixturesCount };
  }

  /**
   * Synchronizes PlayerGameweekStats for a specified gameweek from live event data.
   */
  public async syncGameweekLiveStats(gameweekFplId: number): Promise<SyncStatsResult> {
    console.log(`🔄 Starting FPL live stats sync for Gameweek ${gameweekFplId}...`);
    const gameweek = await prisma.gameweek.findUnique({
      where: { fplId: gameweekFplId },
    });

    if (!gameweek) {
      throw new Error(`Gameweek with fplId ${gameweekFplId} not found in database.`);
    }

    const liveData = await fplClient.getGameweekLive(gameweekFplId);

    // Preload player map
    const players = await prisma.player.findMany({
      select: { id: true, fplId: true },
    });
    const playerMap = new Map<number, number>(players.map((p) => [p.fplId, p.id]));

    const fixtures = await prisma.fixture.findMany({
      select: { id: true, fplId: true },
      where: { gameweekId: gameweek.id }
    });
    const fixtureMap = new Map<number, number>(fixtures.map((f) => [f.fplId, f.id]));

    const existingStats = await prisma.playerGameweekStats.findMany({
      where: { gameweekId: gameweek.id }
    });
    const existingStatsHashes = new Map(
      existingStats.map(s => [
        `${s.playerId}_${s.fixtureId}`,
        generateHash({
          minutes: s.minutes,
          goals: s.goals,
          assists: s.assists,
          cleanSheet: s.cleanSheet,
          yellowCards: s.yellowCards,
          redCards: s.redCards,
          saves: s.saves,
          bonus: s.bonus,
          totalPoints: s.totalPoints,
        })
      ])
    );

    let statsCount = 0;
    const statsOps = [];
    
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
          bonus: stats.bonus,
          totalPoints: stats.totalPoints,
        };

        const incomingHash = generateHash(payload);
        const existingHash = existingStatsHashes.get(`${localPlayerId}_${localFixtureId}`);

        if (incomingHash !== existingHash) {
          statsOps.push(
            prisma.playerGameweekStats.upsert({
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
          
          if (statsOps.length >= 100) {
            await prisma.$transaction(statsOps);
            statsOps.length = 0;
          }
        }
      }
    }

    if (statsOps.length > 0) {
      await prisma.$transaction(statsOps);
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
