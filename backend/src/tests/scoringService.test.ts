import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ScoringService,
  AutoSubstitutionEngine,
  FormationCounts,
} from "../services/scoring/scoringService.js";
import { Position, SQUAD_RULES } from "../types/index.js";
import {
  LEAGUE_SCORING_PRESETS,
  parseLeagueScoringConfig,
} from "../models/leagueScoringConfig.js";

describe("ScoringService Domain Rules", () => {
  // Lineup helper: 4-4-2 setup
  function createLineup() {
    return [
      // Starters (1-11)
      { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
      { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
      { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
      { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
      { playerId: 5, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 },
      { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 6 },
      { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
      { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
      { playerId: 9, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 },
      { playerId: 10, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
      { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },

      // Bench (12-15)
      { playerId: 12, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
      { playerId: 13, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 }, // 1st bench outfield
      { playerId: 14, position: Position.DEF, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 }, // 2nd bench outfield
      { playerId: 15, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 }, // 3rd bench outfield
    ];
  }

  it("calculates parallel leagues independently using their selected rule sets", async () => {
    const lineup = createLineup();
    const statsMap = new Map([
      [
        1,
        {
          minutes: 90,
          totalPoints: 99,
          goals: 1,
          assists: 1,
          saves: 3,
          penaltiesSaved: 1,
          yellowCards: 1,
          bonus: 3,
        },
      ],
    ]);

    const [classic, allAttack] = await Promise.all([
      Promise.resolve(
        ScoringService.calculateLineupScore(lineup, statsMap, {
          scoringConfig: LEAGUE_SCORING_PRESETS.CLASSIC_FPL,
        })
      ),
      Promise.resolve(
        ScoringService.calculateLineupScore(lineup, statsMap, {
          scoringConfig: LEAGUE_SCORING_PRESETS.ALL_ATTACK,
        })
      ),
    ]);

    assert.equal(classic.details.find((detail) => detail.playerId === 1)?.rawPoints, 19);
    assert.equal(classic.totalPoints, 38);
    assert.equal(allAttack.details.find((detail) => detail.playerId === 1)?.rawPoints, 23);
    assert.equal(allAttack.totalPoints, 46);
  });

  it("rejects negative attacking rewards and accepts preset configs", () => {
    const invalidConfig = structuredClone(LEAGUE_SCORING_PRESETS.CLASSIC_FPL);
    invalidConfig.goals[Position.FWD] = -1;
    assert.throws(
      () => parseLeagueScoringConfig(invalidConfig),
      /goals\.FWD must be an integer between 0 and 100/
    );
    assert.equal(
      parseLeagueScoringConfig(LEAGUE_SCORING_PRESETS.DEFENSIVE_MASTERMIND)
        .cleanSheets[Position.GKP],
      8
    );

    invalidConfig.goals[Position.FWD] = 4;
    invalidConfig.yellowCards = 1;
    assert.throws(
      () => parseLeagueScoringConfig(invalidConfig),
      /yellowCards must be an integer between -100 and 0/
    );
  });

  it("applies appearance, defensive, and disciplinary event weights", () => {
    const lineup = createLineup();
    const statsMap = new Map([
      [
        1,
        {
          minutes: 45,
          totalPoints: 100,
          goals: 1,
          cleanSheet: true,
          goalsConceded: 2,
          saves: 3,
          penaltiesSaved: 1,
          penaltiesMissed: 1,
          yellowCards: 1,
          redCards: 1,
          ownGoals: 1,
          bonus: 1,
        },
      ],
    ]);

    const result = ScoringService.calculateLineupScore(lineup, statsMap, {
      scoringConfig: LEAGUE_SCORING_PRESETS.CLASSIC_FPL,
    });
    assert.equal(result.details.find((detail) => detail.playerId === 1)?.rawPoints, 9);
    assert.equal(result.totalPoints, 18);
  });

  it("retains the existing precomputed-total-points path without a config", () => {
    const lineup = createLineup();
    const statsMap = new Map<number, { minutes: number; totalPoints: number }>([
      [1, { minutes: 90, totalPoints: 6 }],
    ]);
    const result = ScoringService.calculateLineupScore(lineup, statsMap);
    assert.equal(result.details.find((detail) => detail.playerId === 1)?.rawPoints, 6);
    assert.equal(result.totalPoints, 12);
  });

  it("should calculate standard player points and apply 2x captain multiplier", () => {
    const lineup = createLineup();
    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();

    // Captain (Player 1) scores 6 points (should double to 12)
    statsMap.set(1, { minutes: 90, totalPoints: 6 });
    // Vice-captain (Player 6) scores 8 points (no multiplier since captain played)
    statsMap.set(6, { minutes: 90, totalPoints: 8 });

    // Other starters score 2 points each
    for (let id = 2; id <= 11; id++) {
      if (id !== 6) {
        statsMap.set(id, { minutes: 90, totalPoints: 2 });
      }
    }

    // Bench players score 1 point each
    for (let id = 12; id <= 15; id++) {
      statsMap.set(id, { minutes: 90, totalPoints: 1 });
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // Starting XI: 12 (C) + 8 (VC) + 9 starters * 2 = 12 + 8 + 18 = 38 points
    assert.equal(result.startingPoints, 38);
    assert.equal(result.captainPoints, 6);
    assert.equal(result.benchPoints, 4); // 4 bench players * 1 point
    assert.equal(result.totalPoints, 38);
  });

  it("should transfer 2x multiplier to vice-captain when captain plays 0 minutes", () => {
    const lineup = createLineup();
    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();

    // Captain (Player 1) did not play (0 minutes, 0 points)
    statsMap.set(1, { minutes: 0, totalPoints: 0 });
    // Bench GKP (Player 12) played and got 4 points
    statsMap.set(12, { minutes: 90, totalPoints: 4 });
    // Vice-captain (Player 6) scored 7 points (should double to 14)
    statsMap.set(6, { minutes: 90, totalPoints: 7 });

    // Other starters get 2 points each
    for (let id = 2; id <= 11; id++) {
      if (id !== 6) {
        statsMap.set(id, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // Vice-captain gets doubled: 14 points
    const vcDetail = result.details.find((d) => d.playerId === 6)!;
    assert.equal(vcDetail.multiplier, 2);
    assert.equal(vcDetail.effectivePoints, 14);

    // Bench GKP subbed in for Player 1
    const subGkp = result.details.find((d) => d.playerId === 12)!;
    assert.equal(subGkp.subbedIn, true);
  });

  it("should perform auto-substitution with first eligible bench player", () => {
    const lineup = createLineup();
    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();

    // Forward 10 played 0 minutes
    statsMap.set(10, { minutes: 0, totalPoints: 0 });
    // Bench priority 1 (Player 13, MID) played and scored 5 points
    statsMap.set(13, { minutes: 90, totalPoints: 5 });

    // All other starters played
    for (let id = 1; id <= 11; id++) {
      if (id !== 10) {
        statsMap.set(id, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // Player 10 subbed out
    const fwd10 = result.details.find((d) => d.playerId === 10)!;
    assert.equal(fwd10.subbedOut, true);

    // Player 13 (MID) subbed in (formation shifts from 4-4-2 to 4-5-1, which is legal)
    const mid13 = result.details.find((d) => d.playerId === 13)!;
    assert.equal(mid13.subbedIn, true);
  });

  it("should preserve minimum 3 defenders rule during auto-substitution", () => {
    // Setup a 3-5-2 lineup (minimum 3 defenders starting)
    const lineup = [
      { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
      { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
      { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
      { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 }, // Only 3 DEF!
      { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 5 },
      { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 6 },
      { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
      { playerId: 9, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
      { playerId: 10, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 },
      { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
      { playerId: 12, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },

      // Bench: GKP, MID (pos 13), DEF (pos 14), FWD (pos 15)
      { playerId: 5, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
      { playerId: 13, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 }, // 1st bench (MID)
      { playerId: 14, position: Position.DEF, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 }, // 2nd bench (DEF)
      { playerId: 15, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 },
    ];

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();

    // Starter DEF 4 played 0 minutes
    statsMap.set(4, { minutes: 0, totalPoints: 0 });
    // Bench MID 13 played and got 6 points
    statsMap.set(13, { minutes: 90, totalPoints: 6 });
    // Bench DEF 14 played and got 4 points
    statsMap.set(14, { minutes: 90, totalPoints: 4 });

    // Other starters played
    for (const p of lineup) {
      if (![4, 13, 14].includes(p.playerId)) {
        statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // Even though MID 13 was 1st on bench, bringing on a midfielder would leave only 2 defenders (illegal!).
    // Therefore, DEF 14 MUST be subbed in instead to keep 3 defenders!
    const mid13 = result.details.find((d) => d.playerId === 13)!;
    const def14 = result.details.find((d) => d.playerId === 14)!;

    assert.equal(mid13.subbedIn, false);
    assert.equal(def14.subbedIn, true);
  });

  it("should skip multiple bench players that would invalidate formation until an eligible one is found", () => {
    // 3-4-3 formation; only 3 DEF starting.
    const lineup = [
      { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
      { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
      { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
      { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
      { playerId: 5, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 },
      { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 6 },
      { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
      { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
      { playerId: 9, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 },
      { playerId: 10, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
      { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },

      // Bench: MID (pos 12 = first), FWD (pos 13), DEF (pos 14), GKP (pos 15)
      { playerId: 15, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
      { playerId: 12, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 }, // 1st
      { playerId: 13, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 }, // 2nd
      { playerId: 14, position: Position.DEF, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 }, // 3rd
    ];

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    // DEF starter 4 didn't play.
    statsMap.set(4, { minutes: 0, totalPoints: 0 });
    // Bench MID 12 played (8 pts), bench FWD 13 played (6 pts), bench DEF 14 played (4 pts).
    statsMap.set(12, { minutes: 90, totalPoints: 8 });
    statsMap.set(13, { minutes: 90, totalPoints: 6 });
    statsMap.set(14, { minutes: 90, totalPoints: 4 });

    for (const p of lineup) {
      if (![4, 12, 13, 14].includes(p.playerId)) {
        statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // Bringing on MID 12 or FWD 13 would leave 2 DEF (illegal) — both skipped.
    // The algorithm must reach the 3rd bench player (DEF 14) to keep formation valid.
    const mid12 = result.details.find((d) => d.playerId === 12)!;
    const fwd13 = result.details.find((d) => d.playerId === 13)!;
    const def14 = result.details.find((d) => d.playerId === 14)!;

    assert.equal(mid12.subbedIn, false);
    assert.equal(fwd13.subbedIn, false);
    assert.equal(def14.subbedIn, true);
    assert.equal(def14.subbedIn, true);

    // Resulting formation stays 3-4-3.
    const startingDetails = result.details.filter((d) => d.isStarter);
    const defCount = startingDetails.filter((d) => d.position === Position.DEF).length;
    assert.equal(defCount, 3);
  });

  it("should not sub when no bench candidate keeps the formation valid", () => {
    // 3-5-2 with a non-playing DEF and only MID/FWD bench options.
    const lineup = [
      { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
      { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
      { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
      { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
      { playerId: 5, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 },
      { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 6 },
      { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
      { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
      { playerId: 9, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 },
      { playerId: 10, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
      { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },

      { playerId: 12, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
      { playerId: 13, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 },
      { playerId: 14, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 },
      { playerId: 15, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 },
    ];

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    statsMap.set(4, { minutes: 0, totalPoints: 0 });
    statsMap.set(13, { minutes: 90, totalPoints: 6 });
    statsMap.set(14, { minutes: 90, totalPoints: 5 });
    statsMap.set(15, { minutes: 90, totalPoints: 4 });

    for (const p of lineup) {
      if (![4, 13, 14, 15].includes(p.playerId)) {
        statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // No bench DEF exists — every outfield swap would drop DEF below 3.
    const def4 = result.details.find((d) => d.playerId === 4)!;
    assert.equal(def4.subbedOut, false);
    assert.equal(result.details.find((d) => d.playerId === 13)!.subbedIn, false);
    assert.equal(result.details.find((d) => d.playerId === 14)!.subbedIn, false);
    assert.equal(result.details.find((d) => d.playerId === 15)!.subbedIn, false);
  });

  it("should only replace a goalkeeper with the bench goalkeeper", () => {
    const lineup = [
      { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
      { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
      { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
      { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
      { playerId: 5, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 },
      { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 6 },
      { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
      { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
      { playerId: 9, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 },
      { playerId: 10, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
      { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },

      { playerId: 12, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
      { playerId: 13, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 },
      { playerId: 14, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 },
      { playerId: 15, position: Position.DEF, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 },
    ];

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    // GKP starter 1 did not play; bench GKP 12 played.
    statsMap.set(1, { minutes: 0, totalPoints: 0 });
    statsMap.set(12, { minutes: 90, totalPoints: 4 });

    for (const p of lineup) {
      if (p.playerId !== 1 && p.playerId !== 12) {
        statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    const gkp1 = result.details.find((d) => d.playerId === 1)!;
    const gkp12 = result.details.find((d) => d.playerId === 12)!;

    assert.equal(gkp1.subbedOut, true);
    assert.equal(gkp12.subbedIn, true);
    // Outfield bench players must NOT replace the keeper.
    assert.equal(result.details.find((d) => d.playerId === 13)!.subbedIn, false);
    assert.equal(result.details.find((d) => d.playerId === 14)!.subbedIn, false);
    assert.equal(result.details.find((d) => d.playerId === 15)!.subbedIn, false);
  });

  it("should skip bench players who played 0 minutes", () => {
    const lineup = createLineup();
    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();

    // Forward 10 did not play.
    statsMap.set(10, { minutes: 0, totalPoints: 0 });
    // First two bench outfielders (13 MID, 14 DEF) also did not play.
    statsMap.set(13, { minutes: 0, totalPoints: 0 });
    statsMap.set(14, { minutes: 0, totalPoints: 0 });
    // 3rd bench outfield (15 FWD) played.
    statsMap.set(15, { minutes: 90, totalPoints: 6 });

    for (const p of lineup) {
      if (![10, 13, 14, 15].includes(p.playerId)) {
        statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // Only the eligible FWD 15 replaces the non-playing FWD 10 (4-4-2 -> 4-4-2 formation valid).
    const fwd10 = result.details.find((d) => d.playerId === 10)!;
    assert.equal(fwd10.subbedOut, true);
    assert.equal(result.details.find((d) => d.playerId === 15)!.subbedIn, true);
    assert.equal(result.details.find((d) => d.playerId === 13)!.subbedIn, false);
    assert.equal(result.details.find((d) => d.playerId === 14)!.subbedIn, false);
  });

  it("should process multiple non-playing starters with live formation recomputation", () => {
    // 4-4-2. A DEF (2) and an FWD (11) are both out. Bench DEF is last priority.
    const lineup = [
      { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
      { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
      { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
      { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
      { playerId: 5, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 },
      { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 6 },
      { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
      { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
      { playerId: 9, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 },
      { playerId: 10, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
      { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },

      { playerId: 12, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
      { playerId: 13, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 },
      { playerId: 14, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 },
      { playerId: 15, position: Position.DEF, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 },
    ];

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    statsMap.set(2, { minutes: 0, totalPoints: 0 });
    statsMap.set(11, { minutes: 0, totalPoints: 0 });
    statsMap.set(13, { minutes: 90, totalPoints: 6 });
    statsMap.set(14, { minutes: 90, totalPoints: 5 });
    statsMap.set(15, { minutes: 90, totalPoints: 4 });

    for (const p of lineup) {
      if (![2, 11, 13, 14, 15].includes(p.playerId)) {
        statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // DEF 2: bench MID 13 is first priority and the swap (DEF -> MID) leaves
    // 3 DEF (still valid), so MID 13 is brought on first.
    const def2 = result.details.find((d) => d.playerId === 2)!;
    assert.equal(def2.subbedOut, true);
    assert.equal(result.details.find((d) => d.playerId === 13)!.subbedIn, true);

    // FWD 11: with DEF count now at 3, bringing on FWD 14 keeps the formation
    // valid (3 DEF, 5 MID, 3 FWD), so the directly matching FWD is used.
    const fwd11 = result.details.find((d) => d.playerId === 11)!;
    assert.equal(fwd11.subbedOut, true);
    assert.equal(result.details.find((d) => d.playerId === 14)!.subbedIn, true);

    // DEF 15 remains on the bench — it was never required to keep formation valid.
    assert.equal(result.details.find((d) => d.playerId === 15)!.subbedIn, false);
  });

  it("should protect formation when two defenders are out and the bench DEF is shared", () => {
    // 3-5-2 with exactly 3 DEF starting. Two of them don't play.
    const lineup = [
      { playerId: 1, position: Position.GKP, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
      { playerId: 2, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 2 },
      { playerId: 3, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 3 },
      { playerId: 4, position: Position.DEF, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 4 },
      { playerId: 5, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 5 },
      { playerId: 6, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 6 },
      { playerId: 7, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 7 },
      { playerId: 8, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 8 },
      { playerId: 9, position: Position.MID, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 9 },
      { playerId: 10, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 10 },
      { playerId: 11, position: Position.FWD, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 11 },

      { playerId: 12, position: Position.GKP, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 12 },
      { playerId: 13, position: Position.MID, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 13 },
      { playerId: 14, position: Position.FWD, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 14 },
      { playerId: 15, position: Position.DEF, isStarter: false, isCaptain: false, isViceCaptain: false, positionOrder: 15 },
    ];

    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    statsMap.set(2, { minutes: 0, totalPoints: 0 });
    statsMap.set(3, { minutes: 0, totalPoints: 0 });
    statsMap.set(13, { minutes: 90, totalPoints: 6 });
    statsMap.set(14, { minutes: 90, totalPoints: 5 });
    statsMap.set(15, { minutes: 90, totalPoints: 4 });

    for (const p of lineup) {
      if (![2, 3, 13, 14, 15].includes(p.playerId)) {
        statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
      }
    }

    const result = ScoringService.calculateLineupScore(lineup, statsMap);

    // DEF 2: MID 13 / FWD 14 would each drop DEF to 2 (illegal) — skipped.
    // Only the shared bench DEF 15 keeps the 3-DEF floor, so it is used.
    const def2 = result.details.find((d) => d.playerId === 2)!;
    assert.equal(def2.subbedOut, true);
    assert.equal(result.details.find((d) => d.playerId === 15)!.subbedIn, true);

    // DEF 3: DEF 15 has now been consumed and no other bench DEF exists — the
    // engine correctly refuses to break the formation, leaving this slot empty.
    const def3 = result.details.find((d) => d.playerId === 3)!;
    assert.equal(def3.subbedOut, false);
    assert.equal(result.details.find((d) => d.playerId === 13)!.subbedIn, false);
    assert.equal(result.details.find((d) => d.playerId === 14)!.subbedIn, false);
  });

  it("AutoSubstitutionEngine should expose formation counts and validity checks", () => {
    const lineup = createLineup();
    const statsMap = new Map<number, { minutes: number; totalPoints: number }>();
    for (const p of lineup) {
      statsMap.set(p.playerId, { minutes: 90, totalPoints: 2 });
    }

    const starterDetails = lineup
      .filter((p) => p.isStarter)
      .map((p) => {
        const stats = statsMap.get(p.playerId)!;
        return {
          playerId: p.playerId,
          position: p.position,
          isStarter: true,
          isCaptain: p.isCaptain,
          isViceCaptain: p.isViceCaptain,
          positionOrder: p.positionOrder,
          minutesPlayed: stats.minutes,
          rawPoints: stats.totalPoints,
          multiplier: 1,
          effectivePoints: stats.totalPoints,
          subbedIn: false,
          subbedOut: false,
        };
      });

    const counts: FormationCounts = AutoSubstitutionEngine.countFormation(starterDetails);
    assert.equal(counts.gkp, 1);
    assert.equal(counts.def, 4);
    assert.equal(counts.mid, 4);
    assert.equal(counts.fwd, 2);

    // A DEF -> MID swap leaves 3 DEF (valid); a DEF -> FWD swap also valid.
    const starterDef = starterDetails.find((s) => s.position === Position.DEF)!;
    const benchMid = {
      playerId: 99,
      position: Position.MID,
      isStarter: false,
      isCaptain: false,
      isViceCaptain: false,
      positionOrder: 13,
      minutesPlayed: 90,
      rawPoints: 5,
      multiplier: 1,
      effectivePoints: 5,
      subbedIn: false,
      subbedOut: false,
    };

    assert.equal(
      AutoSubstitutionEngine.swapKeepsFormationValid(starterDef, benchMid, counts),
      true
    );

    // The minimum formation floor must match SQUAD_RULES constants.
    assert.equal(counts.def >= SQUAD_RULES.MIN_STARTERS.DEF, true);
    assert.equal(counts.mid >= SQUAD_RULES.MIN_STARTERS.MID, true);
    assert.equal(counts.fwd >= SQUAD_RULES.MIN_STARTERS.FWD, true);
  });
});
