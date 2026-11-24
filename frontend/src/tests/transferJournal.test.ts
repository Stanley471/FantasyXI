import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Player, Position } from "../types/index.js";
import {
  MemoryJournalStorage,
  setCustomJournalStorageForTest,
  appendJournalEntry,
  getJournalEntries,
  getPendingJournalEntries,
  markJournalEntries,
  clearJournalEntries,
  ensureJournalBase,
  getJournalBase,
  clearJournalBase,
  replayJournal,
  computeDraftBudget,
  reviewDraft,
  getStateVector,
  entrySeenBy,
  summarizeJournal,
  type JournalPlayer,
  type TransferJournalEntry,
} from "../lib/transferJournal.js";

/** Issue #457: offline-first squad transfer journal (IndexedDB / memory). */

function makePlayer(id: number, position: Position, teamId = 1, price = 50): Player {
  return {
    id,
    fplId: id,
    firstName: `First${id}`,
    lastName: `Last${id}`,
    displayName: `Player${id}`,
    position,
    teamId,
    price,
    totalPoints: 0,
    minutesPlayed: 0,
    goalsScored: 0,
    assists: 0,
    cleanSheets: 0,
    photoUrl: null,
    isAvailable: true,
  } as Player;
}

function journalPlayer(
  id: number,
  position: Position,
  overrides: Partial<JournalPlayer> = {}
): JournalPlayer {
  return {
    playerId: id,
    player: makePlayer(id, position, overrides.player?.teamId ?? ((id % 5) + 1)),
    isStarter: true,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: id,
    ...overrides,
  };
}

/** A valid 15-man base squad: 2 GKP / 5 DEF / 5 MID / 3 FWD, 4-4-2, £75.0m. */
function validBaseSquad(): JournalPlayer[] {
  const players: JournalPlayer[] = [
    journalPlayer(1, Position.GKP, { isStarter: true, isCaptain: false, positionOrder: 1 }),
    journalPlayer(2, Position.DEF, { positionOrder: 2 }),
    journalPlayer(3, Position.DEF, { positionOrder: 3 }),
    journalPlayer(4, Position.DEF, { positionOrder: 4 }),
    journalPlayer(5, Position.DEF, { positionOrder: 5 }),
    journalPlayer(6, Position.MID, { isCaptain: true, positionOrder: 6 }),
    journalPlayer(7, Position.MID, { isViceCaptain: true, positionOrder: 7 }),
    journalPlayer(8, Position.MID, { positionOrder: 8 }),
    journalPlayer(9, Position.MID, { positionOrder: 9 }),
    journalPlayer(10, Position.FWD, { positionOrder: 10 }),
    journalPlayer(11, Position.FWD, { positionOrder: 11 }),
    journalPlayer(12, Position.GKP, { isStarter: false, positionOrder: 12 }),
    journalPlayer(13, Position.DEF, { isStarter: false, positionOrder: 13 }),
    journalPlayer(14, Position.MID, { isStarter: false, positionOrder: 14 }),
    journalPlayer(15, Position.FWD, { isStarter: false, positionOrder: 15 }),
  ];
  return players;
}

describe("Transfer journal (Issue #457)", () => {
  let storage: MemoryJournalStorage;

  beforeEach(async () => {
    storage = new MemoryJournalStorage();
    setCustomJournalStorageForTest(storage);
    await clearJournalEntries();
  });

  describe("append and persistence", () => {
    it("assigns increasing sequence numbers in append order", async () => {
      const first = await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "captain", playerId: 6 });
      const second = await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "vice-captain", playerId: 7 });
      assert.ok(second.seq > first.seq);
      assert.equal(first.clientId, second.clientId, "same device records both entries");
      assert.equal(first.status, "pending");
    });

    it("persists entries so a later read sees the same draft", async () => {
      await appendJournalEntry({
        squadId: "s1",
        userId: "u1",
        kind: "transfer",
        playerId: 20,
        outgoingPlayerId: 11,
        playerSnapshot: makePlayer(20, Position.FWD, 2, 85),
      });
      const entries = await getJournalEntries("s1");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, "transfer");
      assert.equal(entries[0].playerSnapshot?.price, 85);
      assert.equal(await getJournalEntries("other-squad").then((e) => e.length), 0);
    });

    it("tracks the state vector so replayed entries are recognised as seen", async () => {
      const a = await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "captain", playerId: 6 });
      const b = await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "captain", playerId: 7 });
      const vector = getStateVector([a, b]);
      assert.equal(vector[a.clientId], b.seq);
      assert.equal(entrySeenBy(vector, a), true);
      assert.equal(entrySeenBy(vector, { ...b, seq: b.seq + 1 }), false);
      assert.equal(entrySeenBy({}, a), false);
    });

    it("marks entries synced / conflicted / discarded and lists only pending work", async () => {
      const a = await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "captain", playerId: 6 });
      const b = await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "captain", playerId: 7 });
      await markJournalEntries([a.id], "synced");
      await markJournalEntries([b.id], "conflicted");
      assert.deepEqual((await getPendingJournalEntries("s1")).map((e) => e.id), [b.id]);
      await markJournalEntries([b.id], "discarded");
      assert.equal((await getPendingJournalEntries("s1")).length, 0);
    });

    it("summarises the journal by kind and touched players", async () => {
      await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "transfer", playerId: 20, outgoingPlayerId: 11, playerSnapshot: makePlayer(20, Position.FWD, 2) });
      await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "captain", playerId: 6 });
      await appendJournalEntry({ squadId: "s1", userId: "u1", kind: "formation", playerId: 5, otherPlayerId: 14 });
      const summary = summarizeJournal(await getJournalEntries("s1"));
      assert.equal(summary.total, 3);
      assert.equal(summary.byKind.transfer, 1);
      assert.equal(summary.byKind.captain, 1);
      assert.equal(summary.byKind.formation, 1);
      assert.deepEqual(summary.touched, [5, 6, 11, 14, 20]);
    });
  });

  describe("journal base snapshot", () => {
    it("records the base once and never overwrites it with a draft", async () => {
      const base = validBaseSquad();
      const first = await ensureJournalBase("s1", base, "rev-1");
      const draft = replayJournal(base, [
        { kind: "captain", playerId: 7 } as TransferJournalEntry,
      ]);
      const second = await ensureJournalBase("s1", draft, "rev-2");
      assert.equal(second.revision, "rev-1");
      assert.equal((await getJournalBase("s1"))?.players.find((p) => p.isCaptain)?.playerId, 6);
      assert.equal(first.savedAt, second.savedAt);
    });

    it("clears the base once the draft has synced", async () => {
      await ensureJournalBase("s1", validBaseSquad());
      await clearJournalBase("s1");
      assert.equal(await getJournalBase("s1"), undefined);
    });
  });

  describe("replay", () => {
    it("replays a transfer into the outgoing player's slot", async () => {
      const base = validBaseSquad();
      const entry = await appendJournalEntry({
        squadId: "s1",
        userId: "u1",
        kind: "transfer",
        playerId: 20,
        outgoingPlayerId: 11,
        playerSnapshot: makePlayer(20, Position.FWD, 2, 85),
      });
      const replayed = replayJournal(base, [entry]);
      assert.equal(replayed.length, 15);
      assert.equal(replayed.find((p) => p.playerId === 11), undefined);
      const incoming = replayed.find((p) => p.playerId === 20)!;
      assert.equal(incoming.isStarter, true, "takes over the starter slot");
      assert.equal(incoming.positionOrder, 11);
      assert.equal(incoming.player.price, 85);
    });

    it("replays a transfer-out by removing the player", () => {
      const replayed = replayJournal(validBaseSquad(), [
        { kind: "transfer-out", playerId: 15 } as TransferJournalEntry,
      ]);
      assert.equal(replayed.length, 14);
      assert.equal(replayed.find((p) => p.playerId === 15), undefined);
    });

    it("replays a transfer-in onto the bench", () => {
      const base = validBaseSquad().filter((p) => p.playerId !== 15);
      const replayed = replayJournal(base, [
        {
          kind: "transfer-in",
          playerId: 21,
          playerSnapshot: makePlayer(21, Position.FWD, 3, 60),
        } as TransferJournalEntry,
      ]);
      assert.equal(replayed.length, 15);
      assert.equal(replayed.find((p) => p.playerId === 21)?.isStarter, false);
    });

    it("replays captain and vice-captain changes, clearing the old armband", () => {
      const entries = [
        { kind: "captain", playerId: 7 },
        { kind: "vice-captain", playerId: 8 },
      ] as TransferJournalEntry[];
      const replayed = replayJournal(validBaseSquad(), entries);
      assert.equal(replayed.find((p) => p.isCaptain)?.playerId, 7);
      assert.equal(replayed.find((p) => p.isViceCaptain)?.playerId, 8);
      assert.equal(replayed.find((p) => p.playerId === 6)?.isCaptain, false);
    });

    it("replays a formation shift and moves the armband off the bench", () => {
      const base = validBaseSquad();
      // Bench midfielder 14 in for starting defender 5: 4-4-2 -> 3-5-2.
      // Defender 5 is not captain; use captain 6 instead: bench 14 in for 6.
      const replayed = replayJournal(base, [
        { kind: "formation", playerId: 6, otherPlayerId: 14 } as TransferJournalEntry,
      ]);
      assert.equal(replayed.find((p) => p.playerId === 6)?.isStarter, false);
      assert.equal(replayed.find((p) => p.playerId === 14)?.isStarter, true);
      assert.equal(replayed.find((p) => p.playerId === 14)?.isCaptain, true, "armband follows the starter");
      assert.equal(replayed.find((p) => p.playerId === 6)?.isCaptain, false);
    });

    it("ignores discarded entries on replay", () => {
      const replayed = replayJournal(validBaseSquad(), [
        { kind: "captain", playerId: 7, status: "discarded" } as TransferJournalEntry,
      ]);
      assert.equal(replayed.find((p) => p.isCaptain)?.playerId, 6);
    });
  });

  describe("draft review: budget and formation while offline", () => {
    it("recalculates the budget and formation for a draft", async () => {
      const base = validBaseSquad();
      const entries: TransferJournalEntry[] = [
        {
          kind: "transfer",
          playerId: 20,
          outgoingPlayerId: 11,
          playerSnapshot: makePlayer(20, Position.FWD, 2, 85),
        } as TransferJournalEntry,
        { kind: "formation", playerId: 5, otherPlayerId: 14 } as TransferJournalEntry,
      ];
      const review = reviewDraft(base, entries);
      assert.equal(review.formationBefore, "4-4-2");
      assert.equal(review.formationAfter, "3-5-2");
      assert.equal(review.budgetBefore.spentM, 75);
      assert.equal(review.budgetAfter.spentM, 78.5);
      assert.equal(review.netSpendM, 3.5);
      assert.equal(review.budgetAfter.remainingM, 21.5);
      assert.equal(review.valid, true);
      assert.equal(review.entryCount, 2);
    });

    it("flags a draft that busts the budget", () => {
      const review = reviewDraft(validBaseSquad(), [
        {
          kind: "transfer",
          playerId: 20,
          outgoingPlayerId: 11,
          playerSnapshot: makePlayer(20, Position.FWD, 2, 400),
        } as TransferJournalEntry,
      ]);
      assert.equal(review.budgetAfter.spentM, 110);
      assert.equal(review.budgetAfter.overBudget, true);
      assert.equal(review.budgetAfter.overByM, 10);
      assert.equal(review.valid, false);
      assert.ok(review.errors.some((e) => e.includes("exceeds available budget")));
    });

    it("computeDraftBudget honours live price overrides", () => {
      const players = validBaseSquad();
      const budget = computeDraftBudget(players, new Map([[6, 90]]));
      assert.equal(budget.spentM, 79, "captain repriced 5.0 -> 9.0");
      assert.equal(budget.remainingM, 21);
    });
  });
});
