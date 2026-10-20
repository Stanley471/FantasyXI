import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  QueuedSquadMutation,
  MemoryQueueStorage,
  setCustomStorageForTest,
  serializeMutation,
  deserializeMutation,
  detectMutationConflict,
  enqueueSquadMutation,
  getQueuedMutations,
  getQueuedMutationCount,
  removeQueuedMutation,
  incrementMutationRetry,
  clearQueuedMutations,
  syncQueuedMutations,
  MAX_QUEUE_RETRIES,
} from "../lib/offlineQueue.js";

describe("Offline Squad Mutation Queue & Background Sync (Issue #214)", () => {
  let memoryStorage: MemoryQueueStorage;

  beforeEach(async () => {
    memoryStorage = new MemoryQueueStorage();
    setCustomStorageForTest(memoryStorage);
    await clearQueuedMutations();
  });

  describe("Queue Serialization and Deserialization", () => {
    it("should accurately serialize a squad mutation to JSON string", () => {
      const mutation: QueuedSquadMutation = {
        id: "mut_test_123",
        squadId: 42,
        userId: "user_abc",
        action: "update",
        payload: {
          name: "Thunder Strikers",
          players: [
            { playerId: 1, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 },
            { playerId: 2, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 2 },
          ],
        },
        timestamp: 1700000000000,
        retryCount: 0,
        status: "pending",
      };

      const serialized = serializeMutation(mutation);
      assert.equal(typeof serialized, "string");
      assert.ok(serialized.includes("Thunder Strikers"));
      assert.ok(serialized.includes("mut_test_123"));
    });

    it("should cleanly deserialize a valid JSON string back into QueuedSquadMutation", () => {
      const mutation: QueuedSquadMutation = {
        id: "mut_test_456",
        squadId: 99,
        userId: "user_xyz",
        action: "update",
        payload: {
          name: "Apex XI",
          players: [
            { playerId: 10, isStarter: true, isCaptain: false, isViceCaptain: false, positionOrder: 1 },
          ],
        },
        timestamp: 1700000005000,
        retryCount: 1,
        status: "pending",
      };

      const raw = serializeMutation(mutation);
      const deserialized = deserializeMutation(raw);

      assert.equal(deserialized.id, "mut_test_456");
      assert.equal(deserialized.squadId, 99);
      assert.equal(deserialized.userId, "user_xyz");
      assert.equal(deserialized.payload.name, "Apex XI");
      assert.equal(deserialized.payload.players.length, 1);
      assert.equal(deserialized.payload.players[0].playerId, 10);
      assert.equal(deserialized.timestamp, 1700000005000);
      assert.equal(deserialized.retryCount, 1);
      assert.equal(deserialized.status, "pending");
    });

    it("should throw an error when deserializing invalid or corrupt mutation payload", () => {
      assert.throws(() => deserializeMutation("not-json"), /Unexpected token|JSON/);
      assert.throws(() => deserializeMutation("{}"), /Invalid serialized squad mutation/);
      assert.throws(
        () => deserializeMutation(JSON.stringify({ id: "123", action: "update" })),
        /Invalid serialized squad mutation/
      );
    });
  });

  describe("Conflict Detection", () => {
    it("should detect conflict when mutations share the same squadId", () => {
      const existing: QueuedSquadMutation = {
        id: "mut_1",
        squadId: 100,
        userId: "manager_1",
        action: "update",
        payload: { name: "Squad A", players: [] },
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending",
      };

      const incomingSameSquad = { squadId: 100, userId: "manager_1" };
      const incomingDifferentSquad = { squadId: 101, userId: "manager_1" };

      assert.equal(detectMutationConflict(existing, incomingSameSquad), true);
      assert.equal(detectMutationConflict(existing, incomingDifferentSquad), false);
    });

    it("should detect conflict when mutations without squadId share the same userId", () => {
      const existing: QueuedSquadMutation = {
        id: "mut_create_1",
        squadId: null,
        userId: "manager_99",
        action: "create",
        payload: { name: "New Squad", players: [] },
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending",
      };

      const incomingSameManager = { squadId: null, userId: "manager_99" };
      const incomingDifferentManager = { squadId: null, userId: "manager_100" };

      assert.equal(detectMutationConflict(existing, incomingSameManager), true);
      assert.equal(detectMutationConflict(existing, incomingDifferentManager), false);
    });

    it("should resolve conflict by updating existing pending mutation with latest tactics", async () => {
      const initial = await enqueueSquadMutation({
        squadId: 77,
        userId: "manager_77",
        payload: {
          name: "Original Name",
          players: [{ playerId: 5, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 1 }],
        },
      });

      assert.equal(initial.payload.name, "Original Name");
      assert.equal(await getQueuedMutationCount(), 1);

      // Enqueue updated mutation for the same squad while offline
      const updated = await enqueueSquadMutation({
        squadId: 77,
        userId: "manager_77",
        payload: {
          name: "Updated Tactics",
          players: [
            { playerId: 5, isStarter: true, isCaptain: false, isViceCaptain: true, positionOrder: 1 },
            { playerId: 8, isStarter: true, isCaptain: true, isViceCaptain: false, positionOrder: 2 },
          ],
        },
      });

      // Should keep the same mutation id or replace the older pending entry without accumulating duplicate backlog
      assert.equal(updated.id, initial.id);
      assert.equal(updated.payload.name, "Updated Tactics");
      assert.equal(updated.payload.players.length, 2);

      const all = await getQueuedMutations();
      assert.equal(all.length, 1);
      assert.equal(all[0].payload.name, "Updated Tactics");
    });
  });

  describe("Retry Logic and Backoff Limits", () => {
    it("should increment retry count and track error message", async () => {
      const mutation = await enqueueSquadMutation({
        squadId: 88,
        userId: "manager_88",
        payload: { name: "Warriors", players: [] },
      });

      assert.equal(mutation.retryCount, 0);
      assert.equal(mutation.status, "pending");

      const afterFirstRetry = await incrementMutationRetry(mutation.id, "Network timeout 504");
      assert.ok(afterFirstRetry);
      assert.equal(afterFirstRetry.retryCount, 1);
      assert.equal(afterFirstRetry.status, "pending");
      assert.equal(afterFirstRetry.lastError, "Network timeout 504");
    });

    it(`should mark status as failed when retry count reaches MAX_QUEUE_RETRIES (${MAX_QUEUE_RETRIES})`, async () => {
      const mutation = await enqueueSquadMutation({
        squadId: 99,
        userId: "manager_99",
        payload: { name: "Failed Queue", players: [] },
      });

      for (let i = 1; i < MAX_QUEUE_RETRIES; i++) {
        const res = await incrementMutationRetry(mutation.id, `Attempt ${i} failed`);
        assert.equal(res?.retryCount, i);
        assert.equal(res?.status, "pending");
      }

      // 5th retry attempt exceeds max allowed
      const finalRes = await incrementMutationRetry(mutation.id, "Final attempt failed");
      assert.equal(finalRes?.retryCount, MAX_QUEUE_RETRIES);
      assert.equal(finalRes?.status, "failed");
      assert.equal(finalRes?.lastError, "Final attempt failed");

      // Failed items should not count towards active pending queue count
      const activeCount = await getQueuedMutationCount();
      assert.equal(activeCount, 0);
    });
  });

  describe("Queue Sync Dispatcher", () => {
    it("should sync pending mutations and remove them from queue upon success", async () => {
      await enqueueSquadMutation({
        squadId: 501,
        userId: "mgr_1",
        payload: { name: "Squad 501", players: [] },
      });
      await enqueueSquadMutation({
        squadId: 502,
        userId: "mgr_2",
        payload: { name: "Squad 502", players: [] },
      });

      assert.equal(await getQueuedMutationCount(), 2);

      const putCalls: Array<{ url: string; data?: Record<string, unknown> }> = [];
      const mockApi = {
        get: async () => ({ success: true, data: [] }),
        put: async (url: string, data?: Record<string, unknown>) => {
          putCalls.push({ url, data });
          return { success: true };
        },
        post: async () => ({ success: true }),
        patch: async () => ({ success: true }),
        del: async () => ({ success: true }),
      } as Parameters<typeof syncQueuedMutations>[0];

      const result = await syncQueuedMutations(mockApi);

      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);
      assert.equal(putCalls.length, 2);
      assert.equal(putCalls[0].url, "/api/v1/squads/501");
      assert.equal(putCalls[1].url, "/api/v1/squads/502");

      // Queue should now be empty
      assert.equal(await getQueuedMutationCount(), 0);
    });

    it("should handle partial sync failures gracefully and increment retry count", async () => {
      await enqueueSquadMutation({
        squadId: 601,
        userId: "mgr_1",
        payload: { name: "Squad Will Succeed", players: [] },
      });
      await enqueueSquadMutation({
        squadId: 602,
        userId: "mgr_2",
        payload: { name: "Squad Will Fail", players: [] },
      });

      const mockApi = {
        get: async () => ({ success: true, data: [] }),
        put: async (url: string) => {
          if (url.includes("602")) {
            throw new Error("HTTP 500 Internal Server Error");
          }
          return { success: true };
        },
        post: async () => ({ success: true }),
        patch: async () => ({ success: true }),
        del: async () => ({ success: true }),
      } as Parameters<typeof syncQueuedMutations>[0];

      const result = await syncQueuedMutations(mockApi);

      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 1);

      const remaining = await getQueuedMutations();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].squadId, 602);
      assert.equal(remaining[0].retryCount, 1);
      assert.equal(remaining[0].lastError, "HTTP 500 Internal Server Error");
    });
  });

  describe("Queue Management Methods", () => {
    it("should remove individual items via removeQueuedMutation", async () => {
      const item1 = await enqueueSquadMutation({
        squadId: 1,
        userId: "u1",
        payload: { name: "One", players: [] },
      });
      const item2 = await enqueueSquadMutation({
        squadId: 2,
        userId: "u2",
        payload: { name: "Two", players: [] },
      });

      assert.equal(await getQueuedMutationCount(), 2);
      await removeQueuedMutation(item1.id);

      const remaining = await getQueuedMutations();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, item2.id);
    });

    it("should clear all items via clearQueuedMutations", async () => {
      await enqueueSquadMutation({ squadId: 1, payload: { name: "A", players: [] } });
      await enqueueSquadMutation({ squadId: 2, payload: { name: "B", players: [] } });

      assert.equal(await getQueuedMutationCount(), 2);
      await clearQueuedMutations();
      assert.equal(await getQueuedMutationCount(), 0);
    });
  });
});
