import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  FplTrackingDaemon,
  PriceChangeEvent,
  InjuryUpdateEvent,
  StatusChangeEvent,
} from "../workers/fplTrackingDaemon.js";

function createMockDb(players: any[] = []) {
  const state = {
    players: [...players],
    priceChanges: [] as any[],
    statusHistory: [] as any[],
  };

  const db: any = {
    state,
    player: {
      findMany: async () => state.players,
      update: async ({ where, data }: any) => {
        const idx = state.players.findIndex((p) => p.id === where.id);
        if (idx !== -1) {
          state.players[idx] = { ...state.players[idx], ...data };
          return state.players[idx];
        }
        return null;
      },
    },
    playerPriceChange: {
      create: async ({ data }: any) => {
        state.priceChanges.push(data);
        return data;
      },
      findMany: async ({ where }: any) =>
        state.priceChanges.filter((p) => !where?.playerId || p.playerId === where.playerId),
    },
    playerStatusHistory: {
      create: async ({ data }: any) => {
        state.statusHistory.push(data);
        return data;
      },
      findMany: async ({ where }: any) =>
        state.statusHistory.filter((s) => !where?.playerId || s.playerId === where.playerId),
    },
  };

  return db;
}

function createMockFplClient(elements: any[]) {
  return {
    getBootstrapStatic: async () => ({
      elements,
      events: [],
      teams: [],
    }),
  } as any;
}

describe("FPL Injury, Suspension, and Price Tracking Daemon", () => {
  it("detects player price increases and emits player:price_change event", async () => {
    const db = createMockDb([
      {
        id: 1,
        fplId: 101,
        displayName: "Saka",
        price: 9.8,
        status: "a",
        news: null,
        chanceOfPlayingNextRound: null,
        isAvailable: true,
      },
    ]);

    const fplClient = createMockFplClient([
      {
        id: 101,
        web_name: "Saka",
        now_cost: 100, // 10.0m (was 9.8m)
        status: "a",
        news: "",
      },
    ]);

    const emitter = new EventEmitter();
    const emittedPriceChanges: PriceChangeEvent[] = [];
    emitter.on("player:price_change", (evt) => emittedPriceChanges.push(evt));

    const daemon = new FplTrackingDaemon({ db, fplClient, emitter });
    const result = await daemon.pollOnce();

    assert.equal(result.priceChanges.length, 1);
    assert.equal(result.priceChanges[0].diff, 0.2);
    assert.equal(result.priceChanges[0].newPrice, 10.0);
    assert.equal(result.priceChanges[0].oldPrice, 9.8);
    assert.equal(emittedPriceChanges.length, 1);
    assert.equal(emittedPriceChanges[0].webName, "Saka");

    // Database check
    assert.equal(db.state.players[0].price, 10.0);
    assert.equal(db.state.priceChanges.length, 1);
    assert.equal(db.state.priceChanges[0].diff, 0.2);
  });

  it("detects player injury status change to 'i' and emits events", async () => {
    const db = createMockDb([
      {
        id: 2,
        fplId: 102,
        displayName: "Haaland",
        price: 15.2,
        status: "a",
        news: null,
        chanceOfPlayingNextRound: null,
        isAvailable: true,
      },
    ]);

    const fplClient = createMockFplClient([
      {
        id: 102,
        web_name: "Haaland",
        now_cost: 152, // 15.2m unchanged
        status: "i",
        news: "Hamstring injury - 3 weeks",
        chance_of_playing_next_round: 0,
      },
    ]);

    const emitter = new EventEmitter();
    const statusChanges: StatusChangeEvent[] = [];
    const injuryUpdates: InjuryUpdateEvent[] = [];

    emitter.on("player:status_change", (evt) => statusChanges.push(evt));
    emitter.on("player:injury_update", (evt) => injuryUpdates.push(evt));

    const daemon = new FplTrackingDaemon({ db, fplClient, emitter });
    const result = await daemon.pollOnce();

    assert.equal(result.priceChanges.length, 0);
    assert.equal(result.statusChanges.length, 1);
    assert.equal(result.injuryUpdates.length, 1);

    assert.equal(statusChanges[0].oldStatus, "a");
    assert.equal(statusChanges[0].newStatus, "i");
    assert.equal(statusChanges[0].isAvailable, false);
    assert.equal(statusChanges[0].news, "Hamstring injury - 3 weeks");

    assert.equal(injuryUpdates[0].status, "i");
    assert.equal(injuryUpdates[0].chanceOfPlayingNextRound, 0);

    // Database state updated
    assert.equal(db.state.players[0].status, "i");
    assert.equal(db.state.players[0].isAvailable, false);
    assert.equal(db.state.players[0].news, "Hamstring injury - 3 weeks");
    assert.equal(db.state.statusHistory.length, 1);
  });

  it("detects suspension status flag 's'", async () => {
    const db = createMockDb([
      {
        id: 3,
        fplId: 103,
        displayName: "Romero",
        price: 5.1,
        status: "a",
        news: null,
        chanceOfPlayingNextRound: 100,
        isAvailable: true,
      },
    ]);

    const fplClient = createMockFplClient([
      {
        id: 103,
        web_name: "Romero",
        now_cost: 51,
        status: "s",
        news: "Suspended for 3 matches",
        chance_of_playing_next_round: 0,
      },
    ]);

    const daemon = new FplTrackingDaemon({ db, fplClient });
    const result = await daemon.pollOnce();

    assert.equal(result.statusChanges.length, 1);
    assert.equal(result.statusChanges[0].newStatus, "s");
    assert.equal(result.statusChanges[0].isAvailable, false);
    assert.equal(result.injuryUpdates.length, 1);
    assert.equal(result.injuryUpdates[0].status, "s");
  });

  it("detects doubtful flag 'd' with 75% chance", async () => {
    const db = createMockDb([
      {
        id: 4,
        fplId: 104,
        displayName: "Palmer",
        price: 11.0,
        status: "a",
        news: null,
        chanceOfPlayingNextRound: 100,
        isAvailable: true,
      },
    ]);

    const fplClient = createMockFplClient([
      {
        id: 104,
        web_name: "Palmer",
        now_cost: 110,
        status: "d",
        news: "Knock - 75% chance of playing",
        chance_of_playing_next_round: 75,
      },
    ]);

    const daemon = new FplTrackingDaemon({ db, fplClient });
    const result = await daemon.pollOnce();

    assert.equal(result.statusChanges.length, 1);
    assert.equal(result.statusChanges[0].newStatus, "d");
    assert.equal(result.statusChanges[0].isAvailable, false);
    assert.equal(result.statusChanges[0].news, "Knock - 75% chance of playing");
    assert.equal(result.injuryUpdates[0].chanceOfPlayingNextRound, 75);
  });

  it("handles player recovery back to available ('a')", async () => {
    const db = createMockDb([
      {
        id: 5,
        fplId: 105,
        displayName: "De Bruyne",
        price: 9.5,
        status: "i",
        news: "Groin Strain",
        chanceOfPlayingNextRound: 0,
        isAvailable: false,
      },
    ]);

    const fplClient = createMockFplClient([
      {
        id: 105,
        web_name: "De Bruyne",
        now_cost: 95,
        status: "a",
        news: "",
        chance_of_playing_next_round: 100,
      },
    ]);

    const daemon = new FplTrackingDaemon({ db, fplClient });
    const result = await daemon.pollOnce();

    assert.equal(result.statusChanges.length, 1);
    assert.equal(result.statusChanges[0].oldStatus, "i");
    assert.equal(result.statusChanges[0].newStatus, "a");
    assert.equal(result.statusChanges[0].isAvailable, true);
    assert.equal(db.state.players[0].isAvailable, true);
    assert.equal(db.state.players[0].status, "a");
  });

  it("queries price history and status history correctly", async () => {
    const db = createMockDb([
      {
        id: 6,
        fplId: 106,
        displayName: "Watkins",
        price: 8.9,
        status: "a",
        news: null,
        chanceOfPlayingNextRound: null,
        isAvailable: true,
      },
    ]);

    const fplClient = createMockFplClient([
      {
        id: 106,
        web_name: "Watkins",
        now_cost: 91, // +0.2m
        status: "d",
        news: "Illness",
        chance_of_playing_next_round: 75,
      },
    ]);

    const daemon = new FplTrackingDaemon({ db, fplClient });
    await daemon.pollOnce();

    const priceHistory = await daemon.getPriceChangeHistory(6);
    assert.equal(priceHistory.length, 1);
    assert.equal(priceHistory[0].newPrice, 9.1);

    const statusHistory = await daemon.getStatusHistory(6);
    assert.equal(statusHistory.length, 1);
    assert.equal(statusHistory[0].newStatus, "d");
  });
});
