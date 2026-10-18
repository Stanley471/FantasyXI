import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Position, SQUAD_RULES } from "../types/index.js";
import {
  TransferOptimizerEngine,
  TransferOptimizerError,
  solveTransferPlan,
  type OptimizerFixture,
  type OptimizerPlayer,
  type TransferPlanInput,
} from "../services/fpl/transferOptimizer.js";
import {
  TransferPlanService,
  transferPlanCacheKey,
  expectedPointsPerMatch,
} from "../services/fpl/transferPlanService.js";
import { SquadForbiddenError } from "../services/squad/squadService.js";
import { SquadValidationError } from "../services/squad/squadValidator.js";

/**
 * Transfer planning solver (issue #267): rule compliance, free-transfer
 * rollover, hits, blank/double gameweeks, brute-force optimality checks and a
 * latency benchmark.
 */

const GW = [101, 102, 103, 104, 105];

/** Deterministic PRNG so benchmark pools are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Every team plays once per gameweek at FDR 3 unless overridden. */
function fixturesFor(teamIds: number[], gameweekIds: number[], override: OptimizerFixture[] = []): OptimizerFixture[] {
  const overridden = new Set(override.map((f) => `${f.teamId}:${f.gameweekId}`));
  const base = teamIds.flatMap((teamId) =>
    gameweekIds
      .filter((gameweekId) => !overridden.has(`${teamId}:${gameweekId}`))
      .map((gameweekId) => ({ gameweekId, teamId, difficulty: 3 }))
  );
  return [...base, ...override];
}

/**
 * A 15-player squad (ids 1-15) spread over clubs 1-12 so no club holds more
 * than 2 players, plus market players from id 100 upward.
 */
function baseSquad(): OptimizerPlayer[] {
  const p = (id: number, teamId: number, position: Position, price: number, xp: number): OptimizerPlayer => ({
    id,
    teamId,
    position,
    price,
    expectedPointsPerMatch: xp,
  });
  return [
    p(1, 1, Position.GKP, 4.5, 3.5),
    p(2, 2, Position.GKP, 4.0, 2),
    p(3, 3, Position.DEF, 5.0, 4),
    p(4, 4, Position.DEF, 4.5, 3.5),
    p(5, 5, Position.DEF, 4.5, 3.4),
    p(6, 6, Position.DEF, 4.0, 3),
    p(7, 7, Position.DEF, 4.0, 2),
    p(8, 8, Position.MID, 8.0, 5.5),
    p(9, 9, Position.MID, 7.0, 5),
    p(10, 10, Position.MID, 6.0, 4.5),
    p(11, 11, Position.MID, 5.5, 4),
    p(12, 12, Position.MID, 4.5, 2),
    p(13, 1, Position.FWD, 8.0, 5),
    p(14, 2, Position.FWD, 7.0, 4.5),
    p(15, 3, Position.FWD, 5.5, 3),
  ];
}

function buildInput(
  market: OptimizerPlayer[],
  overrides: Partial<TransferPlanInput> = {},
  squadPlayers: OptimizerPlayer[] = baseSquad()
): TransferPlanInput {
  const players = [...squadPlayers, ...market];
  const gameweekIds = overrides.gameweekIds ?? [GW[0]];
  const teamIds = [...new Set(players.map((p) => p.teamId))];
  return {
    squad: squadPlayers.map((p) => ({ playerId: p.id })),
    bank: 0.5,
    freeTransfers: 1,
    gameweekIds,
    players,
    fixtures: fixturesFor(teamIds, gameweekIds),
    ...overrides,
  };
}

function totalCost(input: TransferPlanInput, ids: number[]) {
  const byId = new Map(input.players.map((p) => [p.id, p]));
  return ids.reduce((s, id) => s + byId.get(id)!.price, 0);
}

function assertSquadRules(input: TransferPlanInput, xi: number[], bench: number[], bank: number) {
  const byId = new Map(input.players.map((p) => [p.id, p]));
  const ids = [...xi, ...bench];
  assert.equal(new Set(ids).size, SQUAD_RULES.TOTAL_PLAYERS);
  assert.equal(xi.length, SQUAD_RULES.STARTERS);
  const clubs = new Map<number, number>();
  const positions = new Map<Position, number>();
  for (const id of ids) {
    const p = byId.get(id)!;
    clubs.set(p.teamId, (clubs.get(p.teamId) ?? 0) + 1);
    positions.set(p.position, (positions.get(p.position) ?? 0) + 1);
  }
  for (const count of clubs.values()) assert.ok(count <= SQUAD_RULES.MAX_PER_TEAM, "club cap exceeded");
  assert.equal(positions.get(Position.GKP), 2);
  assert.equal(positions.get(Position.DEF), 5);
  assert.equal(positions.get(Position.MID), 5);
  assert.equal(positions.get(Position.FWD), 3);
  assert.ok(bank >= 0, "bank went negative");
}

describe("TransferOptimizerEngine (issue #267)", () => {
  describe("projections", () => {
    it("scales by fixture difficulty, doubles in a double gameweek and zeroes a blank", () => {
      const market: OptimizerPlayer[] = [];
      const input = buildInput(market, { gameweekIds: [GW[0], GW[1], GW[2]] });
      input.fixtures = [
        ...input.fixtures.filter((f) => f.teamId !== 8),
        { gameweekId: GW[0], teamId: 8, difficulty: 2 },
        { gameweekId: GW[1], teamId: 8, difficulty: 3 },
        { gameweekId: GW[1], teamId: 8, difficulty: 5 },
      ];
      const engine = new TransferOptimizerEngine(input);
      assert.equal(engine.projectedPoints(8, GW[0]), 5.5 * 1.1);
      assert.equal(engine.projectedPoints(8, GW[1]), 5.5 * 1.0 + 5.5 * 0.7);
      assert.equal(engine.projectedPoints(8, GW[2]), 0, "blank gameweek must project no points");
    });

    it("applies chance of playing and lets explicit projections override the model", () => {
      const squad = baseSquad();
      squad[8] = { ...squad[8], chanceOfPlaying: 50 };
      squad[9] = { ...squad[9], projectedPoints: { [GW[0]]: 11 } };
      const engine = new TransferOptimizerEngine(buildInput([], {}, squad));
      assert.equal(engine.projectedPoints(9, GW[0]), 2.5);
      assert.equal(engine.projectedPoints(10, GW[0]), 11);
    });
  });

  describe("rule compliance", () => {
    it("replaces an injured starter with the best affordable same-position player", () => {
      const squad = baseSquad();
      squad[7] = { ...squad[7], chanceOfPlaying: 0 }; // 8.0m MID, injured
      const market: OptimizerPlayer[] = [
        { id: 100, teamId: 13, position: Position.MID, price: 9.0, expectedPointsPerMatch: 7 }, // too expensive (8.5 available)
        { id: 101, teamId: 14, position: Position.MID, price: 8.5, expectedPointsPerMatch: 6 },
        { id: 102, teamId: 15, position: Position.MID, price: 6.0, expectedPointsPerMatch: 5 },
      ];
      const result = solveTransferPlan(buildInput(market, {}, squad));
      const best = result.plans[0];
      assert.deepEqual(
        best.gameweeks[0].transfers.map((t) => [t.playerOutId, t.playerInId]),
        [[8, 101]]
      );
      assert.equal(best.gameweeks[0].hitCost, 0);
      assert.equal(best.gameweeks[0].bankAfterTransfers, 0);
      assert.ok(best.projectedScoreDelta > 0);
    });

    it("never breaks the 3-per-club cap", () => {
      const squad = baseSquad(); // club 1 already has players 1 and 13; club 2 has 2 and 14
      squad[11] = { ...squad[11], teamId: 1 }; // club 1 now holds 3
      const market: OptimizerPlayer[] = [
        { id: 100, teamId: 1, position: Position.MID, price: 4.5, expectedPointsPerMatch: 9 }, // blocked by the cap
        { id: 101, teamId: 16, position: Position.MID, price: 4.5, expectedPointsPerMatch: 6 },
      ];
      const result = solveTransferPlan(buildInput(market, { bank: 0 }, squad));
      const ins = result.plans[0].gameweeks[0].transfers.map((t) => t.playerInId);
      // Buying 100 is only allowed if a club-1 player leaves in the same move
      if (ins.includes(100)) {
        const outs = result.plans[0].gameweeks[0].transfers.map((t) => t.playerOutId);
        assert.ok(outs.some((id) => [1, 12, 13].includes(id)));
      }
      for (const plan of result.plans) {
        for (const gw of plan.gameweeks) assertSquadRules(buildInput(market, {}, squad), gw.startingXI, gw.bench, gw.bankAfterTransfers);
      }
    });

    it("respects the budget: an unaffordable upgrade is never bought", () => {
      const market: OptimizerPlayer[] = [
        { id: 100, teamId: 13, position: Position.FWD, price: 12.0, expectedPointsPerMatch: 12 },
      ];
      const input = buildInput(market, { bank: 0 });
      const result = solveTransferPlan(input);
      // The most expensive sale is 8.0m, so a 12.0m forward is out of reach
      for (const plan of result.plans) {
        assert.ok(plan.gameweeks.every((g) => g.transfers.every((t) => t.playerInId !== 100)));
      }

      const affordable = solveTransferPlan(buildInput(market, { bank: 4.0 }));
      assert.deepEqual(affordable.plans[0].gameweeks[0].transfers.map((t) => t.playerInId), [100]);
      assert.equal(affordable.plans[0].gameweeks[0].bankAfterTransfers, 0);
    });

    it("uses selling prices, not market prices, for available funds", () => {
      const market: OptimizerPlayer[] = [
        { id: 100, teamId: 13, position: Position.FWD, price: 8.5, expectedPointsPerMatch: 9 },
      ];
      const input = buildInput(market, { bank: 0 });
      input.squad = input.squad.map((s) => (s.playerId === 13 ? { playerId: 13, sellingPrice: 8.4 } : s));
      // 8.4 sale + 0 bank cannot fund 8.5
      const result = solveTransferPlan(input);
      assert.ok(result.plans.every((p) => p.gameweeks[0].transfers.every((t) => t.playerInId !== 100)));
    });

    it("honours locked and excluded players", () => {
      const squad = baseSquad();
      squad[7] = { ...squad[7], chanceOfPlaying: 0 };
      const market: OptimizerPlayer[] = [
        { id: 101, teamId: 14, position: Position.MID, price: 8.0, expectedPointsPerMatch: 6 },
      ];
      const locked = solveTransferPlan(buildInput(market, { options: { lockedPlayerIds: [8] } }, squad));
      assert.ok(locked.plans.every((p) => p.gameweeks[0].transfers.every((t) => t.playerOutId !== 8)));
      const excluded = solveTransferPlan(buildInput(market, { options: { excludedPlayerIds: [101] } }, squad));
      assert.ok(excluded.plans.every((p) => p.gameweeks[0].transfers.every((t) => t.playerInId !== 101)));
    });
  });

  describe("transfer hits and free-transfer rollover", () => {
    it("takes a -4 hit only when the projected gain exceeds it", () => {
      const squad = baseSquad();
      squad[7] = { ...squad[7], chanceOfPlaying: 0 }; // 8.0m MID
      squad[12] = { ...squad[12], chanceOfPlaying: 0 }; // 8.0m FWD
      const smallGain = [
        { id: 101, teamId: 14, position: Position.MID, price: 8.0, expectedPointsPerMatch: 6 },
        { id: 102, teamId: 15, position: Position.FWD, price: 8.0, expectedPointsPerMatch: 2.5 },
      ];
      // The forward upgrade is free; the midfield upgrade adds under 4 points, so no hit
      const noHit = solveTransferPlan(buildInput(smallGain, { bank: 0 }, squad)).plans[0];
      assert.equal(noHit.gameweeks[0].transfers.length, 1);
      assert.equal(noHit.totalHitCost, 0);

      // Both replacements now clearly beat the weakest starters they displace
      const bigGain = [
        { ...smallGain[0], expectedPointsPerMatch: 9 },
        { ...smallGain[1], expectedPointsPerMatch: 9 },
      ];
      const hit = solveTransferPlan(buildInput(bigGain, { bank: 0 }, squad)).plans[0];
      assert.equal(hit.gameweeks[0].transfers.length, 2);
      assert.equal(hit.gameweeks[0].hitCost, SQUAD_RULES.TRANSFER_POINTS_COST);
    });

    it("waits for next gameweek's free transfer instead of taking a hit now", () => {
      const market: OptimizerPlayer[] = [
        { id: 101, teamId: 14, position: Position.MID, price: 4.5, expectedPointsPerMatch: 0, projectedPoints: { [GW[0]]: 0, [GW[1]]: 10 } },
      ];
      const result = solveTransferPlan(
        buildInput(market, { bank: 0, freeTransfers: 0, gameweekIds: [GW[0], GW[1]] })
      );
      const best = result.plans[0];
      assert.equal(best.gameweeks[0].transfers.length, 0);
      assert.equal(best.gameweeks[1].freeTransfersAvailable, 1);
      assert.deepEqual(best.gameweeks[1].transfers.map((t) => t.playerInId), [101]);
      assert.equal(best.totalHitCost, 0);
    });

    it("uses a rolled free transfer to make two upgrades without a hit", () => {
      const market: OptimizerPlayer[] = [
        { id: 101, teamId: 14, position: Position.MID, price: 4.5, expectedPointsPerMatch: 0, projectedPoints: { [GW[0]]: 0, [GW[1]]: 10 } },
        { id: 102, teamId: 15, position: Position.DEF, price: 4.0, expectedPointsPerMatch: 0, projectedPoints: { [GW[0]]: 0, [GW[1]]: 10 } },
      ];
      const result = solveTransferPlan(buildInput(market, { bank: 0, gameweekIds: [GW[0], GW[1]] }));
      const best = result.plans[0];
      assert.equal(best.totalTransfers, 2);
      assert.equal(best.totalHitCost, 0);
      assert.deepEqual(
        best.gameweeks.flatMap((g) => g.transfers.map((t) => t.playerInId)).sort(),
        [101, 102]
      );
    });

    it("tracks free transfers gameweek to gameweek on every plan", () => {
      const market: OptimizerPlayer[] = [
        { id: 101, teamId: 14, position: Position.MID, price: 4.5, expectedPointsPerMatch: 7 },
        { id: 102, teamId: 15, position: Position.DEF, price: 4.0, expectedPointsPerMatch: 6 },
        { id: 103, teamId: 16, position: Position.FWD, price: 5.5, expectedPointsPerMatch: 8 },
      ];
      const result = solveTransferPlan(buildInput(market, { bank: 1, gameweekIds: GW.slice(0, 4) }));
      for (const plan of result.plans) {
        let free = 1;
        for (const gw of plan.gameweeks) {
          assert.equal(gw.freeTransfersAvailable, free);
          assert.equal(gw.hitCost, Math.max(0, gw.transfers.length - free) * SQUAD_RULES.TRANSFER_POINTS_COST);
          free = Math.min(SQUAD_RULES.MAX_FREE_TRANSFERS, Math.max(0, free - gw.transfers.length) + 1);
        }
        assert.equal(plan.freeTransfersAfterHorizon, free);
      }
    });

    it("caps banked free transfers at the maximum", () => {
      const result = solveTransferPlan(
        buildInput([], { freeTransfers: SQUAD_RULES.MAX_FREE_TRANSFERS, gameweekIds: GW.slice(0, 3) })
      );
      for (const plan of result.plans) {
        for (const gw of plan.gameweeks) assert.ok(gw.freeTransfersAvailable <= SQUAD_RULES.MAX_FREE_TRANSFERS);
      }
      assert.equal(result.plans[0].freeTransfersAfterHorizon, SQUAD_RULES.MAX_FREE_TRANSFERS);
    });

    it("transfers out a player with a blank gameweek when the bench cannot cover", () => {
      const squad = baseSquad();
      const market: OptimizerPlayer[] = [
        { id: 101, teamId: 14, position: Position.FWD, price: 8.0, expectedPointsPerMatch: 5 },
      ];
      const input = buildInput(market, { bank: 0 }, squad);
      input.fixtures = input.fixtures.filter((f) => f.teamId !== 1); // club 1 (players 1, 13) blank
      const best = solveTransferPlan(input).plans[0];
      assert.deepEqual(best.gameweeks[0].transfers.map((t) => [t.playerOutId, t.playerInId]), [[13, 101]]);
      // The blanking first-choice keeper is benched for the playing back-up
      assert.ok(best.gameweeks[0].startingXI.includes(2));
      assert.ok(!best.gameweeks[0].startingXI.includes(1));
    });
  });

  describe("lineup and captaincy", () => {
    it("fields a valid XI and captains the top projected starter", () => {
      const result = solveTransferPlan(buildInput([]));
      const gw = result.plans[0].gameweeks[0];
      assert.equal(gw.captainId, 8);
      assert.notEqual(gw.viceCaptainId, gw.captainId);
      const [def, mid, fwd] = gw.formation.split("-").map(Number);
      assert.equal(def + mid + fwd, 10);
      assert.ok(def >= 3 && mid >= 2 && fwd >= 1);
      // Hold-squad baseline: XI points plus captain bonus
      assert.equal(result.baseline.projectedPoints, result.plans[0].projectedPoints);
    });

    it("reports team value change from predicted price moves", () => {
      const market: OptimizerPlayer[] = [
        {
          id: 101,
          teamId: 14,
          position: Position.MID,
          price: 4.5,
          expectedPointsPerMatch: 6,
          predictedPriceChangePerGameweek: 0.1,
        },
      ];
      const result = solveTransferPlan(buildInput(market, { bank: 0, gameweekIds: GW.slice(0, 2) }));
      const best = result.plans[0];
      assert.ok(best.gameweeks[0].transfers.some((t) => t.playerInId === 101));
      assert.equal(best.teamValueDelta, 0.2);
    });
  });

  describe("input validation", () => {
    it("rejects horizons outside 1-5 gameweeks", () => {
      assert.throws(() => solveTransferPlan(buildInput([], { gameweekIds: [] })), TransferOptimizerError);
      assert.throws(() => solveTransferPlan(buildInput([], { gameweekIds: [1, 2, 3, 4, 5, 6] })), TransferOptimizerError);
    });

    it("rejects incomplete squads, unknown players and invalid balances", () => {
      const input = buildInput([]);
      assert.throws(() => solveTransferPlan({ ...input, squad: input.squad.slice(1) }), /exactly 15/);
      assert.throws(
        () => solveTransferPlan({ ...input, squad: [...input.squad.slice(1), { playerId: 999 }] }),
        /missing from the player pool/
      );
      assert.throws(() => solveTransferPlan({ ...input, bank: -1 }), /bank/);
      const threeKeepers = buildInput([
        { id: 300, teamId: 13, position: Position.GKP, price: 4.0, expectedPointsPerMatch: 1 },
      ]);
      threeKeepers.squad = threeKeepers.squad.map((s) => (s.playerId === 7 ? { playerId: 300 } : s));
      assert.throws(() => solveTransferPlan(threeKeepers), /exactly 2 GKP/);
      const squad = baseSquad().map((p) => (p.id === 3 || p.id === 5 ? { ...p, teamId: 1 } : p));
      assert.throws(() => solveTransferPlan(buildInput([], {}, squad)), /at most 3/);
      assert.throws(() => solveTransferPlan({ ...input, freeTransfers: 6 }), /freeTransfers/);
      assert.throws(() => solveTransferPlan({ ...input, options: { maxTransfersPerGameweek: 4 } }), /maxTransfersPerGameweek/);
    });
  });

  describe("optimality against exhaustive search", () => {
    /** Brute-force best single-gameweek outcome over every 0/1/2-transfer combination. */
    function bruteForce(input: TransferPlanInput): number {
      const engine = new TransferOptimizerEngine({ ...input, options: { maxTransfersPerGameweek: 0 } });
      const byId = new Map(input.players.map((p) => [p.id, p]));
      const gwId = input.gameweekIds[0];
      const proj = (id: number) => engine.projectedPoints(id, gwId);
      const owned = input.squad.map((s) => s.playerId);
      const ownedSet = new Set(owned);
      const sell = (id: number) => input.squad.find((s) => s.playerId === id)!.sellingPrice ?? byId.get(id)!.price;

      const score = (ids: number[]) => {
        const by = (pos: Position) =>
          ids.filter((id) => byId.get(id)!.position === pos).sort((a, b) => proj(b) - proj(a));
        const xi = [by(Position.GKP)[0], ...by(Position.DEF).slice(0, 3), ...by(Position.MID).slice(0, 2), ...by(Position.FWD).slice(0, 1)];
        const rest = [...by(Position.DEF).slice(3), ...by(Position.MID).slice(2), ...by(Position.FWD).slice(1)]
          .sort((a, b) => proj(b) - proj(a))
          .slice(0, 4);
        const starters = [...xi, ...rest];
        return starters.reduce((s, id) => s + proj(id), 0) + Math.max(...starters.map(proj));
      };
      const valid = (ids: number[], bank: number) => {
        if (Math.round(bank * 10) < 0) return false;
        const clubs = new Map<number, number>();
        for (const id of ids) clubs.set(byId.get(id)!.teamId, (clubs.get(byId.get(id)!.teamId) ?? 0) + 1);
        return [...clubs.values()].every((c) => c <= 3);
      };

      const market = input.players.filter((p) => !ownedSet.has(p.id));
      const singles: Array<[number, number]> = [];
      for (const out of owned) for (const inP of market) if (byId.get(out)!.position === inP.position) singles.push([out, inP.id]);

      let best = score(owned);
      for (const [o, i] of singles) {
        const ids = owned.filter((id) => id !== o).concat(i);
        const bank = input.bank + sell(o) - byId.get(i)!.price;
        if (valid(ids, bank)) best = Math.max(best, score(ids) - (input.freeTransfers >= 1 ? 0 : 4));
      }
      for (let a = 0; a < singles.length; a++) {
        for (let b = a + 1; b < singles.length; b++) {
          const [o1, i1] = singles[a];
          const [o2, i2] = singles[b];
          if (o1 === o2 || i1 === i2) continue;
          const ids = owned.filter((id) => id !== o1 && id !== o2).concat(i1, i2);
          const bank = input.bank + sell(o1) + sell(o2) - byId.get(i1)!.price - byId.get(i2)!.price;
          const hits = Math.max(0, 2 - input.freeTransfers) * 4;
          if (valid(ids, bank)) best = Math.max(best, score(ids) - hits);
        }
      }
      return best;
    }

    for (const seed of [1, 7, 42, 99, 2024]) {
      it(`matches the exhaustive optimum on random market #${seed}`, () => {
        const rand = rng(seed);
        const positions = [Position.GKP, Position.DEF, Position.DEF, Position.MID, Position.MID, Position.FWD];
        const market: OptimizerPlayer[] = Array.from({ length: 30 }, (_, i) => {
          const price = Math.round((4 + rand() * 6) * 10) / 10;
          return {
            id: 200 + i,
            teamId: 1 + Math.floor(rand() * 16),
            position: positions[Math.floor(rand() * positions.length)],
            price,
            expectedPointsPerMatch: Math.round(rand() * price * 10) / 10,
          };
        });
        const input = buildInput(market, { bank: Math.round(rand() * 30) / 10, freeTransfers: 1 + Math.floor(rand() * 2) });
        const solved = solveTransferPlan({ ...input, options: { candidatesPerPosition: 30, beamWidth: 50 } });
        const optimum = bruteForce(input);
        assert.ok(
          Math.abs(solved.plans[0].projectedPoints - Math.round(optimum * 100) / 100) < 0.011,
          `solver ${solved.plans[0].projectedPoints} vs optimum ${optimum}`
        );
      });
    }
  });
});

describe("TransferOptimizerEngine benchmark (issue #267)", () => {
  function largePool(seed: number) {
    const rand = rng(seed);
    const players: OptimizerPlayer[] = [];
    const layout: Array<[Position, number]> = [
      [Position.GKP, 3],
      [Position.DEF, 9],
      [Position.MID, 10],
      [Position.FWD, 6],
    ];
    let id = 1;
    for (let team = 1; team <= 20; team++) {
      for (const [position, count] of layout) {
        for (let i = 0; i < count; i++) {
          const quality = rand();
          players.push({
            id: id++,
            teamId: team,
            position,
            price: Math.round((4 + quality * 9) * 10) / 10,
            expectedPointsPerMatch: Math.round((1 + quality * 6 + rand()) * 10) / 10,
            chanceOfPlaying: rand() < 0.05 ? 0 : null,
          });
        }
      }
    }
    // A valid starting squad of cheap players, max 1 per club
    const pick = (position: Position, n: number, offset: number) =>
      players
        .filter((p) => p.position === position && p.teamId > offset && p.teamId <= offset + n)
        .reduce<OptimizerPlayer[]>((acc, p) => (acc.some((a) => a.teamId === p.teamId) ? acc : [...acc, p]), []);
    const squad = [
      ...pick(Position.GKP, 2, 0),
      ...pick(Position.DEF, 5, 2),
      ...pick(Position.MID, 5, 7),
      ...pick(Position.FWD, 3, 12),
    ];
    return { players, squad };
  }

  for (const horizon of [1, 2, 3]) {
    it(`solves a ${horizon}-gameweek horizon over 560 players within 500ms`, () => {
      const { players, squad } = largePool(horizon * 13);
      assert.equal(squad.length, 15);
      const gameweekIds = GW.slice(0, horizon);
      const input: TransferPlanInput = {
        squad: squad.map((p) => ({ playerId: p.id })),
        bank: Math.max(0, Math.round((100 - totalCost({ players } as TransferPlanInput, squad.map((p) => p.id))) * 10) / 10),
        freeTransfers: 1,
        gameweekIds,
        players,
        fixtures: fixturesFor(
          Array.from({ length: 20 }, (_, i) => i + 1),
          gameweekIds,
          [{ gameweekId: gameweekIds[0], teamId: 3, difficulty: 2 }]
        ).map((f, i) => ({ ...f, difficulty: f.teamId === 3 ? f.difficulty : 1 + (i % 5) })),
      };
      // Process CPU time: test files run in parallel, so wall time would measure contention
      const started = process.cpuUsage();
      const result = solveTransferPlan(input);
      const used = process.cpuUsage(started);
      const elapsed = (used.user + used.system) / 1000;
      assert.ok(elapsed < 500, `solver took ${elapsed.toFixed(1)}ms of CPU`);
      assert.ok(result.plans.length > 0);
      assert.ok(result.plans[0].projectedPoints >= result.baseline.projectedPoints);
      for (const plan of result.plans) {
        for (const gw of plan.gameweeks) assertSquadRules(input, gw.startingXI, gw.bench, gw.bankAfterTransfers);
      }
    });
  }
});

describe("TransferPlanService (issue #267)", () => {
  class MockRedis {
    public store = new Map<string, string>();
    public sets = 0;
    public failing = false;
    async get(key: string) {
      if (this.failing) throw new Error("redis down");
      return this.store.get(key) ?? null;
    }
    async set(key: string, value: string) {
      if (this.failing) throw new Error("redis down");
      this.sets++;
      this.store.set(key, value);
      return "OK";
    }
    async del() {
      return 0;
    }
    async keys() {
      return [];
    }
  }

  it("caches solver results for identical squad states", async () => {
    const redis = new MockRedis();
    const service = new TransferPlanService({}, redis);
    const input = buildInput([{ id: 101, teamId: 14, position: Position.MID, price: 4.5, expectedPointsPerMatch: 6 }]);

    const first = await service.solve(input);
    const second = await service.solve(structuredClone(input));
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(redis.sets, 1);
    assert.deepEqual(second.plans, first.plans);
    assert.ok(redis.store.has(transferPlanCacheKey(input)));

    const changed = await service.solve({ ...input, bank: 1.5 });
    assert.equal(changed.cached, false, "a different squad state must not reuse the cached plan");
  });

  it("falls back to solving when Redis is unavailable", async () => {
    const redis = new MockRedis();
    redis.failing = true;
    const result = await new TransferPlanService({}, redis).solve(buildInput([]));
    assert.equal(result.cached, false);
    assert.ok(result.plans.length > 0);
  });

  describe("buildInput from the database", () => {
    const squadPlayers = baseSquad();
    function fakeDb(overrides: { userId?: string; freeTransfersGameweekId?: number | null; squad?: null } = {}) {
      return {
        squad: {
          findUnique: async () =>
            overrides.squad === null
              ? null
              : {
                  id: "sq1",
                  userId: overrides.userId ?? "u1",
                  budgetRemaining: "1.5",
                  freeTransfers: 1,
                  freeTransfersGameweekId: overrides.freeTransfersGameweekId ?? 9,
                  players: squadPlayers.map((p) => ({
                    playerId: p.id,
                    purchasePrice: (p.price - 0.4).toFixed(1),
                    player: { price: p.price.toFixed(1) },
                  })),
                },
        },
        gameweek: {
          findMany: async ({ take }: any) => [
            { id: 11, fplId: 11 },
            { id: 12, fplId: 12 },
            { id: 13, fplId: 13 },
          ].slice(0, take),
          findUnique: async () => ({ fplId: 9 }),
        },
        player: {
          findMany: async () =>
            squadPlayers.map((p) => ({
              id: p.id,
              teamId: p.teamId,
              position: p.position,
              price: p.price.toFixed(1),
              form: p.id === 8 ? null : String(p.expectedPointsPerMatch),
              totalPoints: 90,
              minutesPlayed: 900,
              status: p.id === 9 ? "i" : "a",
              chanceOfPlayingNextRound: null,
            })),
        },
        team: { findMany: async () => [{ id: 2, strength: 5 }, { id: 1, strength: 2 }] },
        fixture: {
          findMany: async () => [{ gameweekId: 11, homeTeamId: 1, awayTeamId: 2 }],
        },
      };
    }

    it("derives selling prices, rolled free transfers, FDR and availability", async () => {
      const input = await new TransferPlanService(fakeDb(), null).buildInput("sq1", "u1", { horizon: 2 });
      assert.deepEqual(input.gameweekIds, [11, 12]);
      assert.equal(input.bank, 1.5);
      // Last saved in GW 9, planning from GW 11: 1 + 2 rolled
      assert.equal(input.freeTransfers, 3);
      // Bought 0.4m cheaper: keeps half the 0.4 profit
      assert.equal(input.squad.find((s) => s.playerId === 3)!.sellingPrice, 4.8);
      assert.deepEqual(
        input.fixtures.find((f) => f.teamId === 1),
        { gameweekId: 11, teamId: 1, difficulty: 5 }
      );
      assert.deepEqual(input.fixtures.find((f) => f.teamId === 2), { gameweekId: 11, teamId: 2, difficulty: 2 });
      assert.equal(input.players.find((p) => p.id === 9)!.chanceOfPlaying, 0, "injured status means 0% availability");
      assert.equal(input.players.find((p) => p.id === 8)!.expectedPointsPerMatch, 9, "no form falls back to points per 90");
    });

    it("refuses to plan for someone else's squad", async () => {
      await assert.rejects(new TransferPlanService(fakeDb({ userId: "u2" }), null).buildInput("sq1", "u1"), SquadForbiddenError);
    });

    it("reports a missing squad", async () => {
      await assert.rejects(new TransferPlanService(fakeDb({ squad: null }), null).buildInput("sq1", "u1"), SquadValidationError);
    });

    it("rejects an out-of-range horizon", async () => {
      await assert.rejects(new TransferPlanService(fakeDb(), null).buildInput("sq1", "u1", { horizon: 6 }), TransferOptimizerError);
    });
  });

  it("estimates per-match points from form or points per 90", () => {
    assert.equal(expectedPointsPerMatch({ form: "6.5", totalPoints: 0, minutesPlayed: 0 }), 6.5);
    assert.equal(expectedPointsPerMatch({ form: null, totalPoints: 50, minutesPlayed: 900 }), 5);
    assert.equal(expectedPointsPerMatch({ form: null, totalPoints: 10, minutesPlayed: 90 }), 0);
  });
});
