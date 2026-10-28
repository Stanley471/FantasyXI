import { getRedisClient } from "./redis.js";

export const READ_YOUR_WRITES_MS = 5_000;
export interface MutationWindow {
  mark(userId: string): Promise<void>;
  recent(userId: string): Promise<boolean>;
}

/** Shared across API instances. Store outages fail closed to primary reads. */
export const mutationWindow: MutationWindow = {
  async mark(userId) {
    const redis = getRedisClient();
    if (!redis) throw new Error("Mutation consistency store unavailable");
    await redis.set(`db:recent-mutation:${userId}`, "1", "PX", READ_YOUR_WRITES_MS);
  },
  async recent(userId) {
    const redis = getRedisClient();
    if (!redis) return true;
    try { return (await redis.get(`db:recent-mutation:${userId}`)) !== null; }
    catch { return true; }
  },
};
