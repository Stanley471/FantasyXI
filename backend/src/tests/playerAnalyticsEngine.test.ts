import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Request, Response, NextFunction } from "express";
import { PlayerAnalyticsEngine } from "../services/analytics/playerAnalyticsEngine.js";
import { getPlayerAnalytics } from "../controllers/player.controller.js";
import { Position } from "../types/index.js";

describe("PlayerAnalyticsEngine & FDR Calculator (Issue #232)", () => {
  it("computes FDR on a 1 to 5 scale incorporating home/away offensive and defensive strengths", () => {
    const engine = new PlayerAnalyticsEngine(null, null);

    const eliteTeam = {
      id: 1,
      name: "Manchester City",
      shortName: "MCI",
      strength: 5,
      strengthAttackHome: 1340,
      strengthAttackAway: 1320,
      strengthDefenceHome: 1330,
      strengthDefenceAway: 1310,
      strengthOverallHome: 1340,
      strengthOverallAway: 1320,
    };

    const promotedTeam = {
      id: 2,
      name: "Ipswich Town",
      shortName: "IPS",
      strength: 2,
      strengthAttackHome: 1030,
      strengthAttackAway: 1010,
      strengthDefenceHome: 1020,
      strengthDefenceAway: 1000,
      strengthOverallHome: 1025,
      strengthOverallAway: 1005,
    };

    // Elite team at home vs weak opponent -> Very Easy (FDR 1 or 2)
    const easyHome = engine.calculateFixtureDifficulty({
      isHome: true,
      playerTeam: eliteTeam,
      opponentTeam: promotedTeam,
    });
    assert.ok(easyHome.fdr <= 2, `Expected easy home FDR <= 2, got ${easyHome.fdr}`);

    // Promoted team away at Elite team -> Very Hard (FDR 5)
    const hardAway = engine.calculateFixtureDifficulty({
      isHome: false,
      playerTeam: promotedTeam,
      opponentTeam: eliteTeam,
    });
    assert.equal(hardAway.fdr, 5);
    assert.ok(hardAway.rawDifficultyScore > easyHome.rawDifficultyScore);
  });

  it("calculates expected points (xP) within expected range for an in-form forward and 0 for injured players", () => {
    const engine = new PlayerAnalyticsEngine(null, null);

    const strongTeam = {
      id: 1,
      name: "Arsenal",
      shortName: "ARS",
      strength: 5,
      strengthAttackHome: 1310,
      strengthAttackAway: 1290,
      strengthDefenceHome: 1320,
      strengthDefenceAway: 1300,
      strengthOverallHome: 1315,
      strengthOverallAway: 1295,
    };

    const weakOpponent = {
      id: 20,
      name: "Southampton",
      shortName: "SOU",
      strength: 2,
      strengthAttackHome: 1040,
      strengthAttackAway: 1015,
      strengthDefenceHome: 1030,
      strengthDefenceAway: 1005,
      strengthOverallHome: 1035,
      strengthOverallAway: 1010,
    };

    const eliteForwardPrediction = engine.predictPlayerAnalytics({
      playerId: 10,
      displayName: "Haaland",
      position: Position.FWD,
      price: 15.0,
      form: 8.5,
      status: "a",
      chanceOfPlayingNextRound: 100,
      isAvailable: true,
      recentStats: [
        { gameweekId: 5, minutes: 90, totalPoints: 12, goals: 2, assists: 0, bonus: 3 },
        { gameweekId: 4, minutes: 90, totalPoints: 7, goals: 1, assists: 0, bonus: 1 },
        { gameweekId: 3, minutes: 88, totalPoints: 9, goals: 1, assists: 1, bonus: 2 },
        { gameweekId: 2, minutes: 90, totalPoints: 6, goals: 1, assists: 0, bonus: 0 },
        { gameweekId: 1, minutes: 90, totalPoints: 8, goals: 1, assists: 0, bonus: 2 },
      ],
      upcomingFixture: {
        fixtureId: 55,
        gameweekId: 6,
        isHome: true,
        playerTeam: strongTeam,
        opponentTeam: weakOpponent,
      },
    });

    assert.ok(
      eliteForwardPrediction.expectedPoints >= 6.0 &&
        eliteForwardPrediction.expectedPoints <= 9.5,
      `Expected elite forward xP between 6.0 and 9.5, got ${eliteForwardPrediction.expectedPoints}`
    );
    assert.ok(eliteForwardPrediction.fdr <= 2);

    // Injured player with 0% chance of playing -> 0 xP
    const injuredPrediction = engine.predictPlayerAnalytics({
      playerId: 11,
      displayName: "Injured Striker",
      position: Position.FWD,
      price: 7.5,
      form: 6.0,
      status: "i",
      chanceOfPlayingNextRound: 0,
      isAvailable: false,
      recentStats: [{ gameweekId: 5, minutes: 90, totalPoints: 8 }],
      upcomingFixture: {
        isHome: true,
        playerTeam: strongTeam,
        opponentTeam: weakOpponent,
      },
    });

    assert.equal(injuredPrediction.expectedPoints, 0);
    assert.equal(injuredPrediction.breakdown.minutesProbability, 0);
  });

  it("caches player analytics in Redis and serves subsequent requests from cache", async () => {
    const redisStore = new Map<string, string>();
    const mockRedis = {
      get: async (key: string) => redisStore.get(key) ?? null,
      set: async (key: string, value: string) => {
        redisStore.set(key, value);
        return "OK";
      },
      del: async (...keys: string[]) => {
        keys.forEach((k) => redisStore.delete(k));
        return keys.length;
      },
      keys: async () => Array.from(redisStore.keys()),
    };

    let dbQueryCount = 0;
    const mockDb = {
      player: {
        findUnique: async ({ where }: any) => {
          dbQueryCount += 1;
          return {
            id: where.id,
            displayName: "Saka",
            position: Position.MID,
            teamId: 1,
            price: 10.5,
            totalPoints: 95,
            minutesPlayed: 900,
            form: 7.8,
            status: "a",
            chanceOfPlayingNextRound: 100,
            isAvailable: true,
            team: {
              id: 1,
              name: "Arsenal",
              shortName: "ARS",
              strength: 5,
              strengthAttackHome: 1310,
              strengthAttackAway: 1280,
              strengthDefenceHome: 1320,
              strengthDefenceAway: 1290,
              strengthOverallHome: 1315,
              strengthOverallAway: 1285,
            },
            gameweekStats: [
              { gameweekId: 10, minutes: 90, totalPoints: 10, goals: 1, assists: 1, cleanSheet: true, saves: 0, bonus: 2 },
              { gameweekId: 9, minutes: 90, totalPoints: 7, goals: 1, assists: 0, cleanSheet: false, saves: 0, bonus: 1 },
            ],
          };
        },
      },
      fixture: {
        findFirst: async () => ({
          id: 200,
          gameweekId: 11,
          homeTeamId: 1,
          awayTeamId: 2,
          finished: false,
          homeTeam: {
            id: 1,
            name: "Arsenal",
            shortName: "ARS",
            strength: 5,
            strengthAttackHome: 1310,
            strengthDefenceHome: 1320,
          },
          awayTeam: {
            id: 2,
            name: "Everton",
            shortName: "EVE",
            strength: 3,
            strengthAttackAway: 1090,
            strengthDefenceAway: 1110,
          },
        }),
      },
    };

    const engine = new PlayerAnalyticsEngine(mockDb, mockRedis);

    const first = await engine.getPlayerAnalytics(7, 11);
    assert.ok(first);
    assert.equal(first.cached, false);
    assert.equal(dbQueryCount, 1);
    assert.ok(first.prediction.expectedPoints > 0);

    const second = await engine.getPlayerAnalytics(7, 11);
    assert.ok(second);
    assert.equal(second.cached, true);
    assert.equal(dbQueryCount, 1); // Served from Redis cache without hitting DB
    assert.equal(second.prediction.expectedPoints, first.prediction.expectedPoints);
  });

  it("validates player ID in GET /api/v1/players/:id/analytics controller", async () => {
    let statusCode = 200;
    let bodyPayload: any = null;
    const req = {
      params: { id: "invalid" },
      query: {},
    } as unknown as Request;
    const res = {
      status: (c: number) => {
        statusCode = c;
        return res;
      },
      json: (data: any) => {
        bodyPayload = data;
        return res;
      },
    } as unknown as Response;
    const next: NextFunction = () => {};

    await getPlayerAnalytics(req, res, next);
    assert.equal(statusCode, 400);
    assert.equal(bodyPayload.success, false);
  });
});
