import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ScoringService } from "../services/scoring/scoringService.js";
import {
  SquadService,
  ChipUnavailableError,
  SquadForbiddenError,
} from "../services/squad/squadService.js";
import { SquadLockedError } from "../services/squad/squadValidator.js";
import { ChipType, Position } from "../types/index.js";

// 4-4-2: captain = player 10 (FWD), vice = player 6 (MID)
function createLineup() {
  const positions = [
    Position.GKP, Position.DEF, Position.DEF, Position.DEF, Position.DEF,
    Position.MID, Position.MID, Position.MID, Position.MID, Position.FWD, Position.FWD,
    Position.GKP, Position.MID, Position.DEF, Position.FWD,
  ];
  return positions.map((position, i) => ({
    playerId: i + 1,
    position,
    isStarter: i < 11,
    isCaptain: i + 1 === 10,
    isViceCaptain: i + 1 === 6,
    positionOrder: i + 1,
  }));
}

// Everyone plays 90 mins for 2 points, captain scores 10, bench players 3 each
function createStats() {
  const stats = new Map<number, { minutes: number; totalPoints: number }>();
  for (let id = 1; id <= 15; id++) {
    stats.set(id, { minutes: 90, totalPoints: id > 11 ? 3 : 2 });
  }
  stats.set(10, { minutes: 90, totalPoints: 10 });
  return stats;
}

describe("Chips Engine — Scoring", () => {
  it("applies the standard 2x captain multiplier without a chip", () => {
    const result = ScoringService.calculateLineupScore(createLineup(), createStats());
    // 10 starters * 2 + captain 10 * 2
    assert.equal(result.totalPoints, 40);
    assert.equal(result.captainPoints, 10);
  });

  it("Triple Captain multiplies the captain by 3", () => {
    const result = ScoringService.calculateLineupScore(createLineup(), createStats(), {
      chip: ChipType.TRIPLE_CAPTAIN,
    });
    const captain = result.details.find((d) => d.playerId === 10)!;
    assert.equal(captain.multiplier, 3);
    assert.equal(result.captainPoints, 20);
    assert.equal(result.totalPoints, 50);
  });

  it("Triple Captain falls back to the vice-captain when the captain does not play", () => {
    const stats = createStats();
    stats.set(10, { minutes: 0, totalPoints: 0 });
    stats.set(6, { minutes: 90, totalPoints: 5 });
    const result = ScoringService.calculateLineupScore(createLineup(), stats, {
      chip: ChipType.TRIPLE_CAPTAIN,
    });
    const vice = result.details.find((d) => d.playerId === 6)!;
    assert.equal(vice.multiplier, 3);
    assert.equal(vice.effectivePoints, 15);
  });

  it("Bench Boost adds all 4 bench players' points", () => {
    const result = ScoringService.calculateLineupScore(createLineup(), createStats(), {
      chip: ChipType.BENCH_BOOST,
    });
    assert.equal(result.benchPoints, 12);
    assert.equal(result.totalPoints, 40 + 12);
  });

  it("Bench Boost bypasses auto-substitutions", () => {
    const stats = createStats();
    stats.set(11, { minutes: 0, totalPoints: 0 });
    const result = ScoringService.calculateLineupScore(createLineup(), stats, {
      chip: ChipType.BENCH_BOOST,
    });
    assert.ok(result.details.every((d) => !d.subbedIn && !d.subbedOut));
    // 9 starters * 2 + captain 20 + non-playing starter 0 + bench 12
    assert.equal(result.totalPoints, 18 + 20 + 12);
  });

  it("deducts transfer points without a chip", () => {
    const result = ScoringService.calculateLineupScore(createLineup(), createStats(), {
      transferCost: 8,
    });
    assert.equal(result.transferCost, 8);
    assert.equal(result.totalPoints, 32);
  });

  it("Wildcard waives transfer point deductions", () => {
    const result = ScoringService.calculateLineupScore(createLineup(), createStats(), {
      chip: ChipType.WILDCARD,
      transferCost: 8,
    });
    assert.equal(result.transferCost, 0);
    assert.equal(result.totalPoints, 40);
  });

  it("Free Hit waives transfer point deductions", () => {
    const result = ScoringService.calculateLineupScore(createLineup(), createStats(), {
      chip: ChipType.FREE_HIT,
      transferCost: 4,
    });
    assert.equal(result.totalPoints, 40);
  });
});

describe("Chips Engine — Activation & Deadline Locking", () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 60_000);

  function createMockDb(options: { deadline?: Date; isLocked?: boolean } = {}) {
    const state = {
      usages: [] as any[],
      squadPlayers: [
        { playerId: 1, isCaptain: true, isViceCaptain: false, isStarter: true, positionOrder: 1, purchasePrice: 5.5 },
        { playerId: 2, isCaptain: false, isViceCaptain: true, isStarter: false, positionOrder: 12, purchasePrice: 4.0 },
      ],
      budgetRemaining: 1.5,
    };
    const gameweek5 = () => ({
      id: 5,
      name: "Gameweek 5",
      season: "2026/27",
      deadline: options.deadline ?? future,
      isLocked: options.isLocked ?? false,
    });
    const db: any = {
      state,
      squad: {
        findUnique: async ({ where }: any) =>
          where.id === "squad_1"
            ? { id: "squad_1", userId: "user_1", budgetRemaining: state.budgetRemaining, players: state.squadPlayers }
            : null,
        update: async ({ data }: any) => {
          state.budgetRemaining = Number(data.budgetRemaining);
        },
      },
      gameweek: {
        findUnique: async ({ where }: any) => (where.id === 5 ? gameweek5() : null),
        findMany: async ({ where }: any) => (where.id.in.includes(5) ? [gameweek5()] : []),
      },
      squadChipUsage: {
        findUnique: async ({ where }: any) => {
          if (where.squadId_gameweekId) {
            const { squadId, gameweekId } = where.squadId_gameweekId;
            return state.usages.find((u) => u.squadId === squadId && u.gameweekId === gameweekId) || null;
          }
          const { squadId, season, chipType } = where.squadId_season_chipType;
          return (
            state.usages.find(
              (u) => u.squadId === squadId && u.season === season && u.chipType === chipType
            ) || null
          );
        },
        create: async ({ data }: any) => {
          const usage = { id: state.usages.length + 1, revertedAt: null, ...data };
          state.usages.push(usage);
          return usage;
        },
        update: async ({ where, data }: any) => {
          Object.assign(state.usages.find((u) => u.id === where.id), data);
        },
      },
      squadPlayer: {
        deleteMany: async () => {
          state.squadPlayers = [];
        },
        createMany: async ({ data }: any) => {
          state.squadPlayers = data.map(({ squadId: _s, ...p }: any) => p);
        },
      },
      // Row locks are no-ops here; clock_timestamp() reads the real clock
      $queryRaw: async () => [{ now: new Date() }],
      $transaction: async (fn: any) => fn(db),
    };
    return db;
  }

  it("activates a chip before the deadline", async () => {
    const db = createMockDb();
    const usage = await new SquadService(db).activateChip("squad_1", ChipType.BENCH_BOOST, 5, "user_1");
    assert.equal(usage.chipType, ChipType.BENCH_BOOST);
    assert.equal(usage.season, "2026/27");
    assert.equal(usage.previousLineup, undefined);
  });

  it("rejects chip activation after the gameweek deadline", async () => {
    const db = createMockDb({ deadline: past });
    await assert.rejects(
      () => new SquadService(db).activateChip("squad_1", ChipType.WILDCARD, 5, "user_1"),
      SquadLockedError
    );
    assert.equal(db.state.usages.length, 0);
  });

  it("rejects chip activation when the gameweek is locked", async () => {
    const db = createMockDb({ isLocked: true });
    await assert.rejects(
      () => new SquadService(db).activateChip("squad_1", ChipType.WILDCARD, 5, "user_1"),
      SquadLockedError
    );
  });

  it("allows only one chip per gameweek", async () => {
    const db = createMockDb();
    const service = new SquadService(db);
    await service.activateChip("squad_1", ChipType.TRIPLE_CAPTAIN, 5, "user_1");
    await assert.rejects(
      () => service.activateChip("squad_1", ChipType.BENCH_BOOST, 5, "user_1"),
      ChipUnavailableError
    );
  });

  it("allows each chip only once per season", async () => {
    const db = createMockDb();
    db.state.usages.push({ id: 99, squadId: "squad_1", gameweekId: 2, season: "2026/27", chipType: ChipType.WILDCARD });
    await assert.rejects(
      () => new SquadService(db).activateChip("squad_1", ChipType.WILDCARD, 5, "user_1"),
      ChipUnavailableError
    );
  });

  it("rejects chips on squads owned by another user", async () => {
    await assert.rejects(
      () => new SquadService(createMockDb()).activateChip("squad_1", ChipType.WILDCARD, 5, "intruder"),
      SquadForbiddenError
    );
  });

  it("Free Hit snapshots the lineup and reverts it after the gameweek", async () => {
    const db = createMockDb();
    const service = new SquadService(db);
    const original = structuredClone(db.state.squadPlayers);

    await service.activateChip("squad_1", ChipType.FREE_HIT, 5, "user_1");

    // Temporary Free Hit lineup for the gameweek
    db.state.squadPlayers = [{ playerId: 7, isCaptain: true, isViceCaptain: false, isStarter: true, positionOrder: 1, purchasePrice: 9 }];
    db.state.budgetRemaining = 0;

    assert.equal(await service.revertFreeHit("squad_1", 5), true);
    assert.deepEqual(
      db.state.squadPlayers.map((p: any) => ({ ...p, purchasePrice: Number(p.purchasePrice) })),
      original
    );
    assert.equal(db.state.budgetRemaining, 1.5);

    // Idempotent: a second revert is a no-op
    assert.equal(await service.revertFreeHit("squad_1", 5), false);
  });
});
