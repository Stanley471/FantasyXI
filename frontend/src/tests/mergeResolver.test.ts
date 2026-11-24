import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Position } from "../types/index.js";
import {
  applyMergeResolutions,
  defaultResolution,
  formatPrice,
  threeWayMerge,
  type MergeConflict,
  type MergePlayer,
  type MergeResolutionMap,
} from "../lib/mergeResolver.js";

/** Issue #457: 3-way merge conflict resolver (base / local draft / remote). */

function player(
  id: number,
  overrides: Partial<MergePlayer> = {}
): MergePlayer {
  return {
    playerId: id,
    displayName: `Player${id}`,
    position: Position.MID,
    teamId: (id % 5) + 1,
    price: 50,
    isStarter: true,
    isCaptain: false,
    isViceCaptain: false,
    positionOrder: id,
    isAvailable: true,
    ...overrides,
  };
}

/** Base squad of three midfielders: 7 is captain, 8 vice-captain. */
function baseSquad(): MergePlayer[] {
  return [
    player(7, { isCaptain: true, positionOrder: 1 }),
    player(8, { isViceCaptain: true, positionOrder: 2 }),
    player(9, { positionOrder: 3 }),
  ];
}

describe("3-way merge resolver (Issue #457)", () => {
  describe("clean merge", () => {
    it("commits a local-only captain change with no conflicts", () => {
      const base = baseSquad();
      const local = base.map((p) =>
        p.playerId === 7 ? { ...p, isCaptain: false } : p.playerId === 8 ? { ...p, isCaptain: true, isViceCaptain: false } : p
      );
      const result = threeWayMerge({ base, local, remote: base });
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.merged.find((p) => p.isCaptain)?.playerId, 8);
      assert.ok(result.autoMerged.some((m) => m.includes("Player8")));
    });

    it("adopts a remote price change on a player the draft never touched", () => {
      const base = baseSquad();
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, price: 65 } : p));
      const result = threeWayMerge({ base, local: base, remote, touchedPlayerIds: [] });
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.merged.find((p) => p.playerId === 9)?.price, 65);
      assert.ok(result.autoMerged.some((m) => m.includes("£6.5m")));
    });

    it("merges a local change and a remote change to different players", () => {
      const base = baseSquad();
      const local = base.map((p) => (p.playerId === 7 ? { ...p, isCaptain: false } : p.playerId === 8 ? { ...p, isCaptain: true, isViceCaptain: false } : p));
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, price: 70, isViceCaptain: true } : p));
      const result = threeWayMerge({ base, local, remote, touchedPlayerIds: [7, 8] });
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.merged.find((p) => p.isCaptain)?.playerId, 8);
      assert.equal(result.merged.find((p) => p.playerId === 9)?.price, 70);
    });

    it("takes a server-side addition and keeps a local transfer-in", () => {
      const base = baseSquad();
      const local = [...base, player(20, { isStarter: false, positionOrder: 4 })];
      const remote = [...base, player(21, { isStarter: false, positionOrder: 4 })];
      const result = threeWayMerge({ base, local, remote, touchedPlayerIds: [20] });
      assert.equal(result.conflicts.length, 0);
      assert.deepEqual(result.merged.map((p) => p.playerId).sort((a, b) => a - b), [7, 8, 9, 20, 21]);
    });
  });

  describe("price changes", () => {
    it("conflicts when a touched player's price changed upstream", () => {
      const base = baseSquad();
      const local = base.map((p) => (p.playerId === 9 ? { ...p, isCaptain: true } : p.playerId === 7 ? { ...p, isCaptain: false } : p));
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, price: 80 } : p));
      const result = threeWayMerge({ base, local, remote, touchedPlayerIds: [9] });
      assert.equal(result.conflicts.length, 1);
      const [conflict] = result.conflicts;
      assert.equal(conflict.kind, "price-changed");
      assert.equal(conflict.playerId, 9);
      assert.equal(conflict.basePrice, 50);
      assert.equal(conflict.remotePrice, 80);
      assert.match(conflict.message, /£5\.0m.*£8\.0m/);
      // The merged view still carries the draft's choice, at the new price.
      assert.equal(result.merged.find((p) => p.playerId === 9)?.isCaptain, true);
      assert.equal(result.merged.find((p) => p.playerId === 9)?.price, 80);
    });

    it("keeping mine on a price change keeps the player at the new price", () => {
      const base = baseSquad();
      const local = base;
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, price: 80 } : p));
      const merge = threeWayMerge({ base, local, remote, touchedPlayerIds: [9] });
      const resolved = applyMergeResolutions({
        base,
        local,
        remote,
        merged: merge.merged,
        conflicts: merge.conflicts,
        resolutions: { [`price-changed-9`]: "mine" },
      });
      assert.equal(resolved.find((p) => p.playerId === 9)?.price, 80);
    });

    it("taking server on a price change undoes a local transfer-in", () => {
      const base = baseSquad();
      const incoming = player(20, { price: 60, isStarter: false, positionOrder: 4 });
      const local = [...base, incoming];
      const remote = [...base, { ...incoming, price: 95 }];
      const merge = threeWayMerge({ base, local, remote, touchedPlayerIds: [20] });
      assert.equal(merge.conflicts[0]?.kind, "price-changed");
      const resolved = applyMergeResolutions({
        base,
        local,
        remote,
        merged: merge.merged,
        conflicts: merge.conflicts,
        resolutions: { [`price-changed-20`]: "server" },
      });
      assert.equal(resolved.find((p) => p.playerId === 20), undefined);
    });
  });

  describe("player transferred out upstream", () => {
    it("conflicts when a drafted player is no longer available", () => {
      const base = baseSquad();
      const local = [...base, player(20, { isStarter: false, positionOrder: 4 })];
      const remote = base;
      const result = threeWayMerge({
        base,
        local,
        remote,
        touchedPlayerIds: [20],
        unavailablePlayerIds: [20],
      });
      assert.equal(result.conflicts.length, 1);
      assert.equal(result.conflicts[0].kind, "player-transferred-out");
      assert.equal(result.conflicts[0].playerId, 20);
      assert.equal(defaultResolution(result.conflicts[0]), "server");
    });

    it("taking server drops the transferred-out player; keeping mine keeps them", () => {
      const base = baseSquad();
      const local = [...base, player(20, { isStarter: false, positionOrder: 4 })];
      const merge = threeWayMerge({
        base,
        local,
        remote: base,
        touchedPlayerIds: [20],
        unavailablePlayerIds: [20],
      });
      const drop = applyMergeResolutions({
        base,
        local,
        remote: base,
        merged: merge.merged,
        conflicts: merge.conflicts,
        resolutions: { [`transferred-out-20`]: "server" },
      });
      assert.equal(drop.find((p) => p.playerId === 20), undefined);
      const keep = applyMergeResolutions({
        base,
        local,
        remote: base,
        merged: merge.merged,
        conflicts: merge.conflicts,
        resolutions: { [`transferred-out-20`]: "mine" },
      });
      assert.ok(keep.find((p) => p.playerId === 20));
    });

    it("also conflicts when a base player the draft kept was transferred out", () => {
      const base = baseSquad();
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, isAvailable: false } : p));
      const result = threeWayMerge({ base, local: base, remote, touchedPlayerIds: [9] });
      assert.equal(result.conflicts[0]?.kind, "player-transferred-out");
      assert.equal(result.conflicts[0]?.playerId, 9);
    });
  });

  describe("deadline locked", () => {
    it("produces a single deadline conflict and the server squad as the merged view", () => {
      const base = baseSquad();
      const local = base.map((p) => (p.playerId === 7 ? { ...p, isCaptain: false } : p.playerId === 8 ? { ...p, isCaptain: true, isViceCaptain: false } : p));
      const result = threeWayMerge({
        base,
        local,
        remote: base,
        deadlineLocked: true,
        deadline: "2026-11-20T17:30:00Z",
      });
      assert.equal(result.conflicts.length, 1);
      assert.equal(result.conflicts[0].kind, "deadline-locked");
      assert.match(result.conflicts[0].message, /2026-11-20T17:30:00Z/);
      assert.equal(defaultResolution(result.conflicts[0]), "server");
      assert.deepEqual(result.merged.map((p) => p.playerId), [7, 8, 9]);
    });
  });

  describe("both sides changed the same player", () => {
    it("conflicts when both sides reordered the same player differently", () => {
      const base = baseSquad();
      const local = base.map((p) => (p.playerId === 9 ? { ...p, positionOrder: 1 } : p.playerId === 7 ? { ...p, positionOrder: 3 } : p));
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, positionOrder: 2 } : p.playerId === 8 ? { ...p, positionOrder: 1 } : p));
      const result = threeWayMerge({ base, local, remote, touchedPlayerIds: [9] });
      assert.equal(result.conflicts.length, 1);
      assert.equal(result.conflicts[0].kind, "both-changed");
      assert.equal(result.conflicts[0].playerId, 9);
    });

    it("conflicts when the draft removed a player the server changed", () => {
      const base = baseSquad();
      const local = base.filter((p) => p.playerId !== 9);
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, isViceCaptain: true } : p));
      const result = threeWayMerge({ base, local, remote, touchedPlayerIds: [9] });
      assert.equal(result.conflicts.length, 1);
      assert.equal(result.conflicts[0].kind, "both-changed");
    });

    it("resolves both-changed per side: mine keeps the removal, server takes the remote player", () => {
      const base = baseSquad();
      const local = base.filter((p) => p.playerId !== 9);
      const remote = base.map((p) => (p.playerId === 9 ? { ...p, isViceCaptain: true } : p));
      const merge = threeWayMerge({ base, local, remote, touchedPlayerIds: [9] });
      const conflictId = merge.conflicts[0].id;
      const mine = applyMergeResolutions({
        base,
        local,
        remote,
        merged: merge.merged,
        conflicts: merge.conflicts,
        resolutions: { [conflictId]: "mine" },
      });
      assert.equal(mine.find((p) => p.playerId === 9), undefined, "mine keeps the draft's removal");
      const server = applyMergeResolutions({
        base,
        local,
        remote,
        merged: merge.merged,
        conflicts: merge.conflicts,
        resolutions: { [conflictId]: "server" },
      });
      assert.equal(server.find((p) => p.playerId === 9)?.isViceCaptain, true, "server takes the remote player");
    });

    it("auto-merges a remote removal the draft did not touch", () => {
      const base = baseSquad();
      const remote = base.filter((p) => p.playerId !== 9);
      const result = threeWayMerge({ base, local: base, remote, touchedPlayerIds: [] });
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.merged.find((p) => p.playerId === 9), undefined);
    });
  });

  describe("helpers", () => {
    it("formats prices in £m from tenths", () => {
      assert.equal(formatPrice(65), "£6.5m");
      assert.equal(formatPrice(100), "£10.0m");
    });

    it("defaults to mine except transferred-out and deadline-locked", () => {
      const mine: MergeConflict = { id: "a", kind: "price-changed", message: "", baseLabel: "", localLabel: "", remoteLabel: "" };
      const server: MergeConflict = { id: "b", kind: "player-transferred-out", message: "", baseLabel: "", localLabel: "", remoteLabel: "" };
      assert.equal(defaultResolution(mine), "mine");
      assert.equal(defaultResolution(server), "server");
      const map: MergeResolutionMap = Object.fromEntries(
        [mine, server].map((c) => [c.id, defaultResolution(c)])
      );
      assert.deepEqual(map, { a: "mine", b: "server" });
    });
  });
});
