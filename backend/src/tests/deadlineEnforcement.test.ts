import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SquadService } from "../services/squad/squadService.js";
import { SquadLockedError, SquadValidator } from "../services/squad/squadValidator.js";
import { isPastDeadline } from "../services/squad/deadlineGuard.js";
import { Position, SquadPlayerSelection } from "../types/index.js";

/**
 * Concurrency tests for gameweek deadline enforcement.
 *
 * The fake database below models the parts of PostgreSQL the deadline guard
 * relies on: `SELECT ... FOR UPDATE` on a squad is an exclusive lock held until
 * the transaction ends, a failed transaction rolls back, and `clock_timestamp()`
 * is a database clock that can differ from the application clock. Every call
 * yields to the event loop so concurrent requests genuinely interleave.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const POSITIONS: Position[] = [
  Position.GKP, Position.GKP,
  Position.DEF, Position.DEF, Position.DEF, Position.DEF, Position.DEF,
  Position.MID, Position.MID, Position.MID, Position.MID, Position.MID,
  Position.FWD, Position.FWD, Position.FWD,
];

/** 1 GKP, 4 DEF, 4 MID, 2 FWD start; players 2, 7, 12 and 15 are on the bench. */
const BENCH = new Set([2, 7, 12, 15]);
/** Unowned midfielder used as the incoming transfer. */
const SPARE_MID = 16;

function lineup(ids: number[]): SquadPlayerSelection[] {
  return ids.map((playerId, i) => ({
    playerId,
    isStarter: !BENCH.has(playerId),
    isCaptain: playerId === 8,
    isViceCaptain: playerId === 9,
    positionOrder: i + 1,
  }));
}

const ORIGINAL_IDS = Array.from({ length: 15 }, (_, i) => i + 1);
/** Sell starting midfielder 11 and buy the spare midfielder in his place. */
const TRANSFER_IDS = ORIGINAL_IDS.map((id) => (id === 11 ? SPARE_MID : id));

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const acquired = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return acquired;
  }
}

interface FakeOptions {
  deadline: Date;
  dbNow: () => Date;
  /** Called after each write so a test can move the database clock mid-transaction. */
  afterWrite?: () => void;
}

function createFakeDb(options: FakeOptions) {
  const players = new Map(
    [...ORIGINAL_IDS, SPARE_MID].map((id) => [
      id,
      {
        id,
        teamId: id,
        position: id === SPARE_MID ? Position.MID : POSITIONS[id - 1],
        price: 5,
        displayName: `Player ${id}`,
      },
    ])
  );

  const state = {
    squad: {
      id: "squad_1",
      userId: "user_1",
      name: "Deadline XI",
      budgetRemaining: 25,
      freeTransfers: 1,
      freeTransfersGameweekId: 5 as number | null,
    },
    squadPlayers: lineup(ORIGINAL_IDS).map((sel) => ({ ...sel, squadId: "squad_1", purchasePrice: 5 })),
    transfers: [] as any[],
    gameweeks: [
      { id: 5, fplId: 5, name: "Gameweek 5", deadline: options.deadline, isCurrent: false, isFinished: false, isLocked: false, settledAt: null },
      { id: 6, fplId: 6, name: "Gameweek 6", deadline: new Date(options.deadline.getTime() + 7 * 86_400_000), isCurrent: false, isFinished: false, isLocked: false, settledAt: null },
    ],
  };

  const squadLock = new Mutex();
  const stats = { committed: 0, rolledBack: 0 };

  const matches = (gw: any, where: any = {}) =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (value && typeof value === "object" && "in" in value) return value.in.includes(gw[key]);
      return gw[key] === value;
    });

  const wrote = async () => {
    await tick();
    options.afterWrite?.();
  };

  const models = {
    squad: {
      findUnique: async ({ where }: any) => {
        await tick();
        if (where.id !== state.squad.id) return null;
        return {
          ...state.squad,
          players: state.squadPlayers.map((sp) => ({ ...sp, player: players.get(sp.playerId) })),
        };
      },
      update: async ({ data }: any) => {
        Object.assign(state.squad, data);
        await wrote();
      },
    },
    player: {
      findMany: async ({ where }: any) => {
        await tick();
        return where.id.in.map((id: number) => players.get(id)).filter(Boolean);
      },
    },
    gameweek: {
      findFirst: async ({ where, orderBy }: any = {}) => {
        await tick();
        const found = state.gameweeks.filter((gw) => matches(gw, where));
        if (orderBy?.deadline === "asc") found.sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
        return found[0] ? { ...found[0] } : null;
      },
      findUnique: async ({ where }: any) => {
        await tick();
        const gw = state.gameweeks.find((g) => g.id === where.id);
        return gw ? { ...gw } : null;
      },
      findMany: async ({ where }: any) => {
        await tick();
        return state.gameweeks.filter((gw) => matches(gw, where)).map((gw) => ({ ...gw }));
      },
    },
    squadPlayer: {
      deleteMany: async ({ where }: any) => {
        state.squadPlayers = state.squadPlayers.filter(
          (sp) => !(sp.squadId === where.squadId && where.playerId.in.includes(sp.playerId))
        );
        await wrote();
      },
      update: async ({ where, data }: any) => {
        const { squadId, playerId } = where.squadId_playerId;
        Object.assign(state.squadPlayers.find((sp) => sp.squadId === squadId && sp.playerId === playerId)!, data);
        await wrote();
      },
      createMany: async ({ data }: any) => {
        for (const row of data) {
          if (state.squadPlayers.some((sp) => sp.squadId === row.squadId && sp.playerId === row.playerId)) {
            throw Object.assign(new Error("Unique constraint failed on squadId_playerId"), { code: "P2002" });
          }
          state.squadPlayers.push({ ...row, purchasePrice: Number(row.purchasePrice) });
        }
        await wrote();
      },
    },
    squadTransfer: {
      createMany: async ({ data }: any) => {
        state.transfers.push(...data);
        await wrote();
      },
    },
  };

  const db: any = {
    ...models,
    state,
    stats,
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const releases: Array<() => void> = [];
      let snapshot: string | null = null;
      const tx = {
        ...models,
        $queryRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join("?");
          if (sql.includes("clock_timestamp()")) {
            await tick();
            return [{ now: options.dbNow() }];
          }
          if (sql.includes("FROM squads") && sql.includes("FOR UPDATE")) {
            releases.push(await squadLock.acquire());
            // Snapshot for rollback once we hold the lock, so it includes earlier commits
            snapshot = JSON.stringify({ squad: state.squad, squadPlayers: state.squadPlayers, transfers: state.transfers });
          }
          await tick();
          return [];
        },
      };
      try {
        const result = await fn(tx);
        stats.committed++;
        return result;
      } catch (error) {
        if (snapshot) {
          const restored = JSON.parse(snapshot);
          state.squad = restored.squad;
          state.squadPlayers = restored.squadPlayers;
          state.transfers = restored.transfers;
        }
        stats.rolledBack++;
        throw error;
      } finally {
        releases.forEach((release) => release());
      }
    },
  };
  return db;
}

describe("Gameweek deadline enforcement", () => {
  describe("millisecond precision", () => {
    const deadline = new Date("2026-09-26T10:00:00.000Z");

    it("treats a request exactly at the deadline millisecond as late", () => {
      assert.equal(isPastDeadline(deadline, new Date("2026-09-26T10:00:00.000Z")), true);
      assert.throws(
        () => SquadValidator.validateDeadline(deadline, new Date("2026-09-26T10:00:00.000Z")),
        SquadLockedError
      );
    });

    it("accepts a request one millisecond before the deadline", () => {
      assert.equal(isPastDeadline(deadline, new Date("2026-09-26T09:59:59.999Z")), false);
      assert.doesNotThrow(() =>
        SquadValidator.validateDeadline(deadline, new Date("2026-09-26T09:59:59.999Z"))
      );
    });
  });

  describe("transactional enforcement", () => {
    it("accepts a transfer committed before the deadline and charges the free transfer", async () => {
      const deadline = new Date(Date.now() + 3_600_000);
      const db = createFakeDb({ deadline, dbNow: () => new Date(deadline.getTime() - 60_000) });

      await new SquadService(db).updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1");

      assert.equal(db.state.transfers.length, 1);
      assert.equal(db.state.transfers[0].gameweekId, 5);
      assert.equal(db.state.transfers[0].pointsCost, 0);
      assert.equal(db.state.squad.freeTransfers, 0);
    });

    it("rejects a transfer when the database clock has reached the deadline, even if the app clock has not", async () => {
      const deadline = new Date(Date.now() + 3_600_000); // app clock: an hour to go
      const db = createFakeDb({ deadline, dbNow: () => new Date(deadline.getTime()) });

      await assert.rejects(
        () => new SquadService(db).updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1"),
        SquadLockedError
      );
      assert.equal(db.state.transfers.length, 0);
      assert.deepEqual(db.state.squadPlayers.map((sp: any) => sp.playerId).sort((a: number, b: number) => a - b), ORIGINAL_IDS);
    });

    it("does not roll a transfer made at the deadline into the following gameweek", async () => {
      const deadline = new Date(Date.now() + 3_600_000);
      // Gameweek 5 has not been flagged as locked yet by the lock job
      const db = createFakeDb({ deadline, dbNow: () => new Date(deadline.getTime() + 1) });

      await assert.rejects(
        () => new SquadService(db).updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1"),
        SquadLockedError
      );
      assert.equal(db.state.transfers.length, 0);
    });

    it("rolls back a transfer whose transaction crosses the deadline before commit", async () => {
      const deadline = new Date(Date.now() + 3_600_000);
      let dbNow = new Date(deadline.getTime() - 5);
      const db = createFakeDb({
        deadline,
        dbNow: () => dbNow,
        // The deadline passes while the writes are in flight
        afterWrite: () => {
          dbNow = new Date(deadline.getTime());
        },
      });

      await assert.rejects(
        () => new SquadService(db).updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1"),
        SquadLockedError
      );

      assert.equal(db.stats.rolledBack, 1);
      assert.equal(db.state.transfers.length, 0);
      assert.equal(db.state.squad.freeTransfers, 1);
      assert.equal(db.state.squad.budgetRemaining, 25);
      assert.ok(db.state.squadPlayers.some((sp: any) => sp.playerId === 11));
      assert.ok(!db.state.squadPlayers.some((sp: any) => sp.playerId === SPARE_MID));
    });

    it("rejects the transfer when the lock job has already locked the gameweek", async () => {
      const deadline = new Date(Date.now() + 3_600_000);
      const db = createFakeDb({ deadline, dbNow: () => new Date(deadline.getTime() - 60_000) });
      db.state.gameweeks[0].isLocked = true;

      await assert.rejects(
        () => new SquadService(db).updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1"),
        SquadLockedError
      );
    });
  });

  describe("concurrent requests", () => {
    it("applies a double-submitted transfer exactly once", async () => {
      const deadline = new Date(Date.now() + 3_600_000);
      const db = createFakeDb({ deadline, dbNow: () => new Date(deadline.getTime() - 60_000) });
      const service = new SquadService(db);

      const results = await Promise.allSettled([
        service.updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1"),
        service.updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1"),
      ]);

      assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"]);
      assert.equal(db.state.transfers.length, 1, "the second request sees the first one's committed squad");
      assert.equal(db.state.squad.freeTransfers, 0);
      assert.equal(db.state.squad.budgetRemaining, 25);
      assert.equal(db.state.squadPlayers.length, 15);
    });

    it("serialises concurrent transfers so free transfers cannot be spent twice", async () => {
      const deadline = new Date(Date.now() + 3_600_000);
      const db = createFakeDb({ deadline, dbNow: () => new Date(deadline.getTime() - 60_000) });
      const service = new SquadService(db);

      // Two different single transfers submitted at the same time with one free transfer banked
      const other = TRANSFER_IDS.map((id) => (id === SPARE_MID ? 11 : id === 10 ? SPARE_MID : id));
      await Promise.allSettled([
        service.updateSquad("squad_1", { players: lineup(TRANSFER_IDS) }, "user_1"),
        service.updateSquad("squad_1", { players: lineup(other) }, "user_1"),
      ]);

      const costs = db.state.transfers.map((t: any) => t.pointsCost);
      assert.equal(costs.filter((c: number) => c === 0).length, 1, "only one transfer can use the free transfer");
      assert.ok(costs.slice(1).every((c: number) => c === 4));
      assert.equal(db.state.squad.freeTransfers, 0);
    });

    it("accepts requests that commit before the deadline and rejects every one after it", async () => {
      const deadline = new Date(Date.now() + 3_600_000);
      let dbNow = new Date(deadline.getTime() - 2);
      const db = createFakeDb({ deadline, dbNow: () => dbNow });
      const service = new SquadService(db);
      const original = db.$transaction;
      // Each committed transaction advances the database clock by 1ms
      db.$transaction = async (fn: any) => {
        try {
          return await original(fn);
        } finally {
          dbNow = new Date(dbNow.getTime() + 1);
        }
      };

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          service.updateSquad("squad_1", { players: lineup(i % 2 === 0 ? TRANSFER_IDS : ORIGINAL_IDS) }, "user_1")
        )
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter(
        (r) => r.status === "rejected" && r.reason instanceof SquadLockedError
      ).length;
      assert.equal(fulfilled, 2, "only the requests serialised before the deadline millisecond succeed");
      assert.equal(rejected, 4);
      assert.equal(db.stats.committed, 2);
    });
  });
});
