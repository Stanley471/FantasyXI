import crypto from "node:crypto";
import { prisma } from "../../config/db.js";
import { getRedisClient } from "../../config/redis.js";

const BLOOM_KEY = "auth:revoked-sessions:bloom:v1";
const BLOOM_BITS = 8_388_608;
const HASH_COUNT = 6;

function offsets(value: string): number[] {
  const digest = crypto.createHash("sha256").update(value).digest();
  return Array.from({ length: HASH_COUNT }, (_, index) => digest.readUInt32BE(index * 4) % BLOOM_BITS);
}

export class SessionRevocationBloom {
  constructor(private readonly db: any = prisma, private readonly redis: any = getRedisClient()) {}

  async add(sessionId: string, userId: string | null, reason: string, expiresAt: Date): Promise<void> {
    await this.db.revokedSession.upsert({
      where: { sessionId },
      create: { sessionId, userId, reason, expiresAt },
      update: { userId, reason, expiresAt, revokedAt: new Date() },
    });
    if (!this.redis) return;
    const pipeline = this.redis.pipeline();
    offsets(sessionId).forEach((offset) => pipeline.setbit(BLOOM_KEY, offset, 1));
    await pipeline.exec();
  }

  async mightContain(sessionId: string): Promise<boolean> {
    if (!this.redis) return true;
    try {
      const pipeline = this.redis.pipeline();
      offsets(sessionId).forEach((offset) => pipeline.getbit(BLOOM_KEY, offset));
      const results = await pipeline.exec();
      const bits = results.map((result: [Error | null, number]) => result[1]);
      return bits.every((bit) => bit === 1);
    } catch {
      return true;
    }
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    if (!(await this.mightContain(sessionId))) return false;
    const record = await this.db.revokedSession.findUnique({ where: { sessionId }, select: { expiresAt: true } });
    return Boolean(record && record.expiresAt > new Date());
  }
}

export const sessionRevocationBloom = new SessionRevocationBloom();
