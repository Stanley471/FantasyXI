import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../lib/api.js";
import {
  MemoryQueueStorage,
  setCustomStorageForTest,
  clearQueuedMutations,
  enqueueSquadMutation,
  getQueuedMutations,
  hasUnsyncedMutations,
  syncQueuedMutations,
  classifySyncError,
  runExclusive,
  MAX_QUEUE_RETRIES,
} from "../lib/offlineQueue.js";
import { describeRejection } from "../lib/offlineSyncCoordinator.js";

/**
 * Issue #334: causal ordering, cross-tab exclusion and deterministic conflict
 * resolution for the offline squad mutation queue.
 */

const lineup = (name: string) => ({
  name,
  players: [{ playerId: 1, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 }],
});

interface Call {
  method: "PUT" | "POST";
  url: string;
  body: { name: string };
}

/** API double that records calls and answers each according to `respond`. */
function recordingApi(respond: (call: Call) => unknown = () => ({ success: true })) {
  const calls: Call[] = [];
  const handle = async (call: Call) => {
    calls.push(call);
    const outcome = respond(call);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return {
    calls,
    client: {
      put: (url: string, body: Call["body"]) => handle({ method: "PUT", url, body }),
      post: (url: string, body: Call["body"]) => handle({ method: "POST", url, body }),
    } as never,
  };
}

describe("Offline sync conflict resolution (#334)", () => {
  let storage: MemoryQueueStorage;

  beforeEach(async () => {
    storage = new MemoryQueueStorage();
    setCustomStorageForTest(storage);
    await clearQueuedMutations();
  });

  describe("causal ordering", () => {
    it("replays mutations in the order they were made, not by squad or timestamp", async () => {
      await enqueueSquadMutation({ squadId: "b", userId: "u1", payload: lineup("first") });
      await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("second") });
      await enqueueSquadMutation({ squadId: "c", userId: "u1", payload: lineup("third") });

      const { calls, client } = recordingApi();
      await syncQueuedMutations(client);
      assert.deepEqual(calls.map((c) => c.body.name), ["first", "second", "third"]);
    });

    it("assigns increasing sequence numbers that survive coalescing", async () => {
      const first = await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a1") });
      const second = await enqueueSquadMutation({ squadId: "b", userId: "u1", payload: lineup("b1") });
      const merged = await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a2") });

      assert.equal(merged.id, first.id, "same squad coalesces into one entry");
      assert.ok(merged.seq! > second.seq!, "the newest lineup state replays last");
      assert.deepEqual((await getQueuedMutations()).map((m) => m.payload.name), ["b1", "a2"]);
    });

    it("serializes concurrent enqueues so none is lost or duplicated", async () => {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          enqueueSquadMutation({ squadId: `s${i % 4}`, userId: "u1", payload: lineup(`edit-${i}`) })
        )
      );
      const queued = await getQueuedMutations();
      assert.equal(queued.length, 4, "one coalesced entry per squad");
      assert.deepEqual(new Set(queued.map((m) => m.seq)).size, 4, "sequence numbers are unique");
      assert.deepEqual(
        queued.map((m) => m.payload.name).sort(),
        ["edit-16", "edit-17", "edit-18", "edit-19"],
        "each squad keeps its latest lineup"
      );
    });
  });

  describe("error classification", () => {
    it("separates connectivity, session, transient and permanent failures", () => {
      assert.equal(classifySyncError(new TypeError("Failed to fetch")), "offline");
      assert.equal(classifySyncError(new ApiError(503, "offline", { offline: true })), "offline");
      assert.equal(classifySyncError(new ApiError(401, "expired")), "unauthorized");
      for (const status of [408, 425, 429, 500, 502, 503]) {
        assert.equal(classifySyncError(new ApiError(status, "busy")), "transient", String(status));
      }
      for (const status of [400, 403, 404, 409, 422]) {
        assert.equal(classifySyncError(new ApiError(status, "no")), "rejected", String(status));
      }
      assert.equal(classifySyncError(new Error("unknown")), "transient");
    });
  });

  describe("flush behaviour", () => {
    it("drops a mutation refused for an expired deadline, reports it, and keeps flushing later ones", async () => {
      await enqueueSquadMutation({ squadId: "late", userId: "u1", payload: lineup("late") });
      await enqueueSquadMutation({ squadId: "ok", userId: "u1", payload: lineup("ok") });

      const { calls, client } = recordingApi((call) =>
        call.url.endsWith("/late")
          ? new ApiError(403, "Gameweek 5 deadline has passed", { deadline: "2026-10-18T17:30:00Z" })
          : { success: true }
      );
      const result = await syncQueuedMutations(client);

      assert.equal(calls.length, 2);
      assert.equal(result.succeeded, 1);
      assert.equal(result.rejected.length, 1);
      assert.equal(result.rejected[0].reason, "DEADLINE_PASSED");
      assert.equal(result.halted, null);
      assert.equal((await getQueuedMutations()).length, 0, "rejected mutations are not retried");
      assert.match(describeRejection(result.rejected[0]), /deadline passed.*restored/i);
    });

    it("drops an invalid formation with a user-facing explanation", async () => {
      await enqueueSquadMutation({ squadId: "s1", userId: "u1", payload: lineup("bad") });
      const { client } = recordingApi(() => new ApiError(400, "At least 3 defenders must start"));
      const result = await syncQueuedMutations(client);
      assert.equal(result.rejected[0].reason, "INVALID_SQUAD");
      assert.match(describeRejection(result.rejected[0]), /At least 3 defenders must start/);
    });

    it("stops at a transient failure so later mutations never overtake it", async () => {
      await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a") });
      await enqueueSquadMutation({ squadId: "b", userId: "u1", payload: lineup("b") });

      const { calls, client } = recordingApi(() => new ApiError(502, "Bad gateway"));
      const result = await syncQueuedMutations(client);

      assert.equal(calls.length, 1, "b was not sent ahead of a");
      assert.equal(result.halted, "transient");
      const queued = await getQueuedMutations();
      assert.deepEqual(queued.map((m) => [m.payload.name, m.status, m.retryCount]), [
        ["a", "pending", 1],
        ["b", "pending", 0],
      ]);
    });

    it("does not charge a retry when the network drops mid-flush", async () => {
      await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a") });
      const { client } = recordingApi(() => new TypeError("Failed to fetch"));
      const result = await syncQueuedMutations(client);
      assert.equal(result.halted, "offline");
      const [queued] = await getQueuedMutations();
      assert.equal(queued.status, "pending");
      assert.equal(queued.retryCount, 0);
    });

    it("keeps changes queued when the session has expired", async () => {
      await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a") });
      const { client } = recordingApi(() => new ApiError(401, "Token has expired"));
      const result = await syncQueuedMutations(client);
      assert.equal(result.halted, "unauthorized");
      assert.equal(await hasUnsyncedMutations("u1"), true);
    });

    it("gives up and rolls back after repeated transient failures", async () => {
      await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a") });
      const { client } = recordingApi(() => new ApiError(500, "Internal error"));
      let result;
      for (let i = 0; i < MAX_QUEUE_RETRIES; i++) result = await syncQueuedMutations(client);
      assert.equal(result!.rejected.length, 1);
      assert.equal(result!.rejected[0].reason, "RETRIES_EXHAUSTED");
      assert.equal(await hasUnsyncedMutations("u1"), false);
    });

    it("recovers a mutation stranded in 'syncing' by a closed tab", async () => {
      const queued = await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a") });
      await storage.put({ ...queued, status: "syncing" });

      const { calls, client } = recordingApi();
      const result = await syncQueuedMutations(client);
      assert.equal(calls.length, 1);
      assert.equal(result.succeeded, 1);
    });

    it("lets only one flush run at a time", async () => {
      await enqueueSquadMutation({ squadId: "a", userId: "u1", payload: lineup("a") });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { calls, client } = recordingApi();
      const slowClient = {
        put: async (url: string, body: Call["body"]) => {
          await gate;
          return (client as { put: (u: string, b: Call["body"]) => Promise<unknown> }).put(url, body);
        },
        post: async () => ({}),
      } as never;

      const first = syncQueuedMutations(slowClient);
      const second = await syncQueuedMutations(client);
      assert.equal(second.halted, "busy");

      release();
      assert.equal((await first).succeeded, 1);
      assert.equal(calls.length, 1, "the mutation was sent exactly once");
    });
  });

  describe("runExclusive", () => {
    it("runs tasks for the same lock one after another", async () => {
      const order: string[] = [];
      const task = (label: string, ms: number) => async () => {
        order.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`${label}:end`);
      };
      await Promise.all([runExclusive("t", task("a", 20)), runExclusive("t", task("b", 1))]);
      assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
    });
  });
});
