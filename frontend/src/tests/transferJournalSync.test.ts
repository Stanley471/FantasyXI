import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/api.js";
import { Player, Position } from "../types/index.js";
import {
  MemoryJournalStorage,
  setCustomJournalStorageForTest,
  appendJournalEntry,
  clearJournalEntries,
  ensureJournalBase,
  getJournalEntries,
  type JournalPlayer,
} from "../lib/transferJournal.js";
import { journalPlayersToMergePlayers } from "../lib/mergeResolver.js";
import {
  resolveTransferConflicts,
  subscribeTransferConflicts,
  syncTransferJournal,
  type RemoteSquadState,
} from "../lib/transferJournalSync.js";

/** Issue #457: journal sync — clean commits, held conflicts, resolution. */

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

function journalPlayer(id: number, position: Position, overrides: Partial<JournalPlayer> = {}): JournalPlayer {
  return {
    playerId: id,
    player: makePlayer(id, position, (id % 5) + 1),
    isStarter: true,
    isCaptain: id === 7,
    isViceCaptain: id === 8,
    positionOrder: id,
    ...overrides,
  };
}

function baseSquad(): JournalPlayer[] {
  return [
    journalPlayer(7, Position.MID),
    journalPlayer(8, Position.MID),
    journalPlayer(9, Position.MID),
  ];
}

function remoteFrom(players: JournalPlayer[], extra: Partial<RemoteSquadState> = {}): RemoteSquadState {
  const merged = journalPlayersToMergePlayers(players);
  return {
    squadId: "squad-1",
    name: "Draft XI",
    revision: "rev-1",
    players: merged,
    unavailablePlayerIds: merged.filter((p) => !p.isAvailable).map((p) => p.playerId),
    ...extra,
  };
}

interface CommitCall {
  name: string;
  players: Array<{ playerId: number; isStarter: boolean; isCaptain: boolean; isViceCaptain: boolean; positionOrder: number }>;
  expectedUpdatedAt?: string;
}

describe("Transfer journal sync (Issue #457)", () => {
  let storage: MemoryJournalStorage;
  let commits: CommitCall[];

  beforeEach(async () => {
    storage = new MemoryJournalStorage();
    setCustomJournalStorageForTest(storage);
    await clearJournalEntries();
    commits = [];
  });

  const commit = async (payload: CommitCall) => {
    commits.push(payload);
    return { success: true };
  };

  it("is idle when the journal is empty", async () => {
    const outcome = await syncTransferJournal({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      fetchRemote: async () => remoteFrom(baseSquad()),
      commit,
    });
    assert.equal(outcome.status, "idle");
    assert.equal(commits.length, 0);
  });

  it("commits non-conflicting changes to the backend API and marks entries synced", async () => {
    await ensureJournalBase("squad-1", baseSquad(), "rev-1");
    await appendJournalEntry({ squadId: "squad-1", userId: "u1", kind: "captain", playerId: 9 });
    // Untouched player's price moved on the server: adopted, not a conflict.
    const remotePlayers = baseSquad().map((p) =>
      p.playerId === 7 ? { ...p, player: { ...p.player, price: 65 } } : p
    );
    const outcome = await syncTransferJournal({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      fetchRemote: async () => remoteFrom(remotePlayers),
      commit,
    });
    assert.equal(outcome.status, "synced");
    assert.equal(commits.length, 1);
    assert.equal(commits[0].expectedUpdatedAt, "rev-1");
    assert.equal(commits[0].players.find((p) => p.isCaptain)?.playerId, 9);
    assert.equal((await getJournalEntries("squad-1"))[0].status, "synced");
    assert.equal(await getJournalEntries("squad-1").then((e) => e.filter((x) => x.status === "pending").length), 0);
  });

  it("holds price-change conflicts: nothing is committed until resolved", async () => {
    await ensureJournalBase("squad-1", baseSquad(), "rev-1");
    await appendJournalEntry({ squadId: "squad-1", userId: "u1", kind: "captain", playerId: 9 });
    const remotePlayers = baseSquad().map((p) =>
      p.playerId === 9 ? { ...p, player: { ...p.player, price: 80 } } : p
    );
    let notified: unknown = null;
    const unsubscribe = subscribeTransferConflicts((o) => {
      notified = o;
    });
    const outcome = await syncTransferJournal({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      fetchRemote: async () => remoteFrom(remotePlayers),
      commit,
    });
    unsubscribe();
    assert.equal(outcome.status, "conflicts");
    if (outcome.status !== "conflicts") assert.fail("expected a conflicts outcome");
    assert.equal(commits.length, 0, "no commit while conflicts are unresolved");
    assert.equal(outcome.conflicts[0].kind, "price-changed");
    assert.equal((await getJournalEntries("squad-1"))[0].status, "conflicted");
    assert.ok(notified, "subscribers are told about the conflict");
  });

  it("resumes the sync after the manager resolves: keep mine commits at the new price", async () => {
    await ensureJournalBase("squad-1", baseSquad(), "rev-1");
    await appendJournalEntry({ squadId: "squad-1", userId: "u1", kind: "captain", playerId: 9 });
    const remotePlayers = baseSquad().map((p) =>
      p.playerId === 9 ? { ...p, player: { ...p.player, price: 80 } } : p
    );
    const outcome = await syncTransferJournal({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      fetchRemote: async () => remoteFrom(remotePlayers),
      commit,
    });
    assert.equal(outcome.status, "conflicts");
    if (outcome.status !== "conflicts") assert.fail("expected a conflicts outcome");
    const resolved = await resolveTransferConflicts({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      conflicts: outcome.conflicts,
      resolutions: { [`price-changed-9`]: "mine" },
      base: outcome.base,
      local: outcome.local,
      remote: outcome.remote,
      merged: outcome.merged,
      commit,
    });
    assert.equal(resolved.status, "synced");
    assert.equal(commits.length, 1);
    assert.equal(commits[0].players.find((p) => p.isCaptain)?.playerId, 9);
    assert.equal(resolved.players?.find((p) => p.playerId === 9)?.price, 80);
    assert.equal((await getJournalEntries("squad-1"))[0].status, "synced");
  });

  it("resolving a transferred-out player with 'server' drops them from the commit", async () => {
    const base = baseSquad();
    await ensureJournalBase("squad-1", base, "rev-1");
    await appendJournalEntry({
      squadId: "squad-1",
      userId: "u1",
      kind: "transfer",
      playerId: 20,
      outgoingPlayerId: 9,
      playerSnapshot: makePlayer(20, Position.MID, 2, 60),
    });
    const outcome = await syncTransferJournal({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      fetchRemote: async () => remoteFrom(base, { unavailablePlayerIds: [20] }),
      commit,
    });
    assert.equal(outcome.status, "conflicts");
    if (outcome.status !== "conflicts") assert.fail("expected a conflicts outcome");
    assert.equal(outcome.conflicts[0].kind, "player-transferred-out");
    const resolved = await resolveTransferConflicts({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      conflicts: outcome.conflicts,
      resolutions: { [`transferred-out-20`]: "server" },
      base: outcome.base,
      local: outcome.local,
      remote: outcome.remote,
      merged: outcome.merged,
      commit,
    });
    assert.equal(resolved.status, "synced");
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0].players.map((p) => p.playerId).sort((a, b) => a - b), [7, 8]);
  });

  it("a deadline that locked mid-sync holds the draft instead of dropping it", async () => {
    await ensureJournalBase("squad-1", baseSquad(), "rev-1");
    await appendJournalEntry({ squadId: "squad-1", userId: "u1", kind: "captain", playerId: 9 });
    const failingCommit = async () => {
      throw new ApiError(403, "Gameweek deadline has passed", { deadline: "2026-11-20T17:30:00Z" });
    };
    const outcome = await syncTransferJournal({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      fetchRemote: async () => remoteFrom(baseSquad()),
      commit: failingCommit,
    });
    assert.equal(outcome.status, "conflicts");
    if (outcome.status !== "conflicts") assert.fail("expected a conflicts outcome");
    assert.equal(outcome.conflicts[0].kind, "deadline-locked");
    assert.equal((await getJournalEntries("squad-1"))[0].status, "conflicted");

    // "Keep my draft saved" holds the entries for a later gameweek.
    const held = await resolveTransferConflicts({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      conflicts: outcome.conflicts,
      resolutions: { "deadline-locked": "mine" },
      base: outcome.base,
      local: outcome.local,
      remote: outcome.remote,
      merged: outcome.merged,
      commit: failingCommit,
    });
    assert.equal(held.status, "held");
    assert.equal((await getJournalEntries("squad-1"))[0].status, "pending");

    // "Discard my draft" drops the entries.
    const discarded = await resolveTransferConflicts({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      conflicts: outcome.conflicts,
      resolutions: { "deadline-locked": "server" },
      base: outcome.base,
      local: outcome.local,
      remote: outcome.remote,
      merged: outcome.merged,
      commit: failingCommit,
    });
    assert.equal(discarded.status, "discarded");
    assert.equal((await getJournalEntries("squad-1"))[0].status, "discarded");
  });

  it("falls back to the remote squad as the merge base when no base was stored", async () => {
    await appendJournalEntry({ squadId: "squad-1", userId: "u1", kind: "captain", playerId: 9 });
    const outcome = await syncTransferJournal({
      squadId: "squad-1",
      userId: "u1",
      squadName: "Draft XI",
      fetchRemote: async () => remoteFrom(baseSquad()),
      commit,
    });
    assert.equal(outcome.status, "synced");
    assert.equal(outcome.status === "synced" && outcome.committed, 1);
    assert.equal(commits[0].players.find((p) => p.isCaptain)?.playerId, 9);
  });
});
