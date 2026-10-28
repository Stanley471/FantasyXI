import crypto, { KeyObject } from "crypto";
import { prisma } from "../../config/db.js";
import { createRedisClient, getRedisClient } from "../../config/redis.js";
import { getJwtLifetimeSeconds, getJwtSecret, jwtKeyRing } from "../../config/jwt.js";
import {
  generateSigningKeyPair,
  JWT_SIGNING_ALGORITHM,
  JwtKeyRing,
  JwtSigningKey,
  PublicSigningJwk,
  toPublicJwk,
} from "./jwtKeyRing.js";

/**
 * JWT signing-key rotation (issue #332).
 *
 * Key lifecycle, all driven by timestamps stored on each key so every node
 * reaches the same decision without coordinating:
 *
 *   created ──(published in JWKS, verify-only)──> activatesAt ──(signs new
 *   tokens)──> successor activates ──(verify-only grace window)──> retiresAt
 *
 * - A successor key is created PRE_PUBLISH_MS before it activates. Nodes
 *   refresh every REFRESH_INTERVAL_MS (and immediately on a pub/sub event), so
 *   every node already holds the new key when the first token signed with it
 *   arrives: rotation never produces an "unknown key" rejection.
 * - The previous key keeps verifying until retiresAt = successor activation +
 *   token lifetime + clock skew, so no token it signed expires early.
 * - Revocation deletes the key from every node's ring at once via Redis
 *   pub/sub (and within one refresh interval if Redis is down). Revoking the
 *   signing key creates a replacement that activates immediately.
 *
 * Private keys are stored AES-256-GCM encrypted with a key derived (HKDF) from
 * JWT_SECRET, with the kid as additional authenticated data.
 */

const REFRESH_INTERVAL_MS = 60_000;
const PRE_PUBLISH_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000;
/** Minimum gap between refreshes triggered by tokens naming an unknown kid. */
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 5_000;
/** Revoked rows are kept this long for audit, then pruned. */
const REVOKED_KEY_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_ROTATION_INTERVAL_HOURS = 30 * 24;
const EVENT_CHANNEL = "auth:jwt-keys";

export interface JwtKeyRecord {
  kid: string;
  algorithm: string;
  publicJwk: PublicSigningJwk;
  encryptedPrivateKey: string;
  activatesAt: Date;
  retiresAt: Date | null;
  revokedAt: Date | null;
}

/** Durable storage shared by every backend node. */
export interface JwtKeyStore {
  /** Keys that are neither revoked nor past retiresAt. */
  listUsable(now: Date): Promise<JwtKeyRecord[]>;
  find(kid: string): Promise<JwtKeyRecord | null>;
  insert(record: JwtKeyRecord): Promise<void>;
  setRetiresAt(kids: string[], retiresAt: Date): Promise<void>;
  revoke(kid: string, revokedAt: Date, reason: string): Promise<void>;
  /** Deletes retired keys and revoked keys older than the retention period. */
  prune(now: Date): Promise<number>;
}

export type JwtKeyEvent = { type: "revoked"; kid: string } | { type: "changed" };

/** Cross-node notification channel. */
export interface JwtKeyEventChannel {
  publish(event: JwtKeyEvent): Promise<void>;
  subscribe(handler: (event: JwtKeyEvent) => void): Promise<void>;
  close(): Promise<void>;
}

export class PrismaJwtKeyStore implements JwtKeyStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = prisma) {}

  async listUsable(now: Date): Promise<JwtKeyRecord[]> {
    return this.db.jwtSigningKey.findMany({
      where: { revokedAt: null, OR: [{ retiresAt: null }, { retiresAt: { gt: now } }] },
    });
  }

  async find(kid: string): Promise<JwtKeyRecord | null> {
    return this.db.jwtSigningKey.findUnique({ where: { kid } });
  }

  async insert(record: JwtKeyRecord): Promise<void> {
    await this.db.jwtSigningKey.create({ data: record });
  }

  async setRetiresAt(kids: string[], retiresAt: Date): Promise<void> {
    await this.db.jwtSigningKey.updateMany({ where: { kid: { in: kids } }, data: { retiresAt } });
  }

  async revoke(kid: string, revokedAt: Date, reason: string): Promise<void> {
    await this.db.jwtSigningKey.update({ where: { kid }, data: { revokedAt, revokedReason: reason } });
  }

  async prune(now: Date): Promise<number> {
    const { count } = await this.db.jwtSigningKey.deleteMany({
      where: {
        OR: [
          { retiresAt: { lte: now } },
          { revokedAt: { lte: new Date(now.getTime() - REVOKED_KEY_RETENTION_MS) } },
        ],
      },
    });
    return count;
  }
}

/** Redis pub/sub channel; the subscriber needs its own connection (RESP2 subscriber mode). */
export class RedisJwtKeyEventChannel implements JwtKeyEventChannel {
  private subscriber: ReturnType<typeof createRedisClient> = null;

  async publish(event: JwtKeyEvent): Promise<void> {
    const client = getRedisClient();
    if (!client) return;
    try {
      // The shared client is lazy and has no offline queue, so connect first
      if (client.status === "wait") await client.connect();
      await client.publish(EVENT_CHANNEL, JSON.stringify(event));
    } catch (error) {
      console.warn("[jwt-keys] Failed to publish key event; nodes will catch up on refresh:", error);
    }
  }

  async subscribe(handler: (event: JwtKeyEvent) => void): Promise<void> {
    const client = createRedisClient();
    if (!client) return;
    try {
      await client.connect();
      client.on("message", (channel: string, message: string) => {
        if (channel !== EVENT_CHANNEL) return;
        try {
          handler(JSON.parse(message) as JwtKeyEvent);
        } catch {
          // Ignore malformed messages
        }
      });
      await client.subscribe(EVENT_CHANNEL);
      this.subscriber = client;
    } catch (error) {
      client.disconnect();
      console.warn("[jwt-keys] Redis subscription unavailable; relying on periodic refresh:", error);
    }
  }

  async close(): Promise<void> {
    this.subscriber?.disconnect();
    this.subscriber = null;
  }
}

function deriveKeyEncryptionKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, "fantasyxi-jwt-signing-keys", "aes-256-gcm", 32));
}

export function encryptPrivateKey(privateKey: KeyObject, kid: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKeyEncryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(kid));
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const ciphertext = Buffer.concat([cipher.update(der), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function decryptPrivateKey(encrypted: string, kid: string, secret: string): KeyObject {
  const raw = Buffer.from(encrypted, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKeyEncryptionKey(secret), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(kid));
  decipher.setAuthTag(raw.subarray(12, 28));
  const der = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export interface JwtKeyRotationOptions {
  store?: JwtKeyStore;
  ring?: JwtKeyRing;
  channel?: JwtKeyEventChannel | null;
  now?: () => number;
  rotationIntervalMs?: number;
  tokenLifetimeSeconds?: () => number;
  encryptionSecret?: () => string;
}

export interface RotationResult {
  createdKid: string | null;
  pruned: number;
}

export class JwtKeyRotationService {
  private readonly store: JwtKeyStore;
  private readonly ring: JwtKeyRing;
  private readonly channel: JwtKeyEventChannel | null;
  private readonly now: () => number;
  private readonly rotationIntervalMs: number;
  private readonly tokenLifetimeSeconds: () => number;
  private readonly encryptionSecret: () => string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastUnknownKidRefreshAt = 0;
  /** Bumped by every revocation event, so a refresh that read the store before it is discarded. */
  private revocationEpoch = 0;

  constructor(options: JwtKeyRotationOptions = {}) {
    this.store = options.store ?? new PrismaJwtKeyStore();
    this.ring = options.ring ?? jwtKeyRing;
    this.channel = options.channel !== undefined ? options.channel : new RedisJwtKeyEventChannel();
    this.now = options.now ?? Date.now;
    this.rotationIntervalMs =
      options.rotationIntervalMs ??
      Number(process.env.JWT_KEY_ROTATION_INTERVAL_HOURS || DEFAULT_ROTATION_INTERVAL_HOURS) * 60 * 60_000;
    this.tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? getJwtLifetimeSeconds;
    this.encryptionSecret = options.encryptionSecret ?? getJwtSecret;
  }

  /** Bootstraps the first key if needed, loads the ring and starts listening for changes. */
  public async start(): Promise<void> {
    await this.rotate();
    await this.refresh();
    this.ring.onUnknownKid(() => this.refreshForUnknownKid());
    await this.channel?.subscribe((event) => this.handleEvent(event));
    this.refreshTimer = setInterval(() => {
      this.refresh().catch((error) => console.error("[jwt-keys] Periodic refresh failed:", error));
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  public async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.ring.onUnknownKid(null);
    await this.channel?.close();
  }

  /** Reloads the ring from the store. O(k) for k usable keys. */
  public async refresh(): Promise<void> {
    for (;;) {
      const epoch = this.revocationEpoch;
      const records = await this.store.listUsable(new Date(this.now()));
      if (epoch !== this.revocationEpoch) continue; // a revocation landed mid-read: re-read
      this.ring.replaceAll(records.map((record) => this.toSigningKey(record)));
      return;
    }
  }

  /**
   * Scheduled key-generation step (run by the `jwt-key-rotation` job and at
   * start-up). Creates the first key, pre-publishes a successor when the
   * current key is due, and prunes dead keys. Concurrent runs are harmless:
   * an extra successor just becomes another valid key.
   */
  public async rotate(): Promise<RotationResult> {
    const now = this.now();
    const usable = await this.store.listUsable(new Date(now));
    const active = usable.filter((record) => record.activatesAt.getTime() <= now);
    const hasPending = usable.length > active.length;
    const current = active.reduce<JwtKeyRecord | null>(
      (latest, record) => (!latest || record.activatesAt > latest.activatesAt ? record : latest),
      null
    );

    let createdKid: string | null = null;
    if (!current) {
      createdKid = await this.createKey(now);
    } else if (!hasPending && now >= current.activatesAt.getTime() + this.rotationIntervalMs - PRE_PUBLISH_MS) {
      const activatesAt = now + PRE_PUBLISH_MS;
      createdKid = await this.createKey(activatesAt);
      const graceEndsAt = activatesAt + this.tokenLifetimeSeconds() * 1000 + CLOCK_SKEW_MS;
      const outgoing = active.filter((record) => record.retiresAt === null).map((record) => record.kid);
      await this.store.setRetiresAt(outgoing, new Date(graceEndsAt));
    }

    const pruned = await this.store.prune(new Date(now));
    if (createdKid || pruned > 0) {
      await this.refresh();
      await this.channel?.publish({ type: "changed" });
    }
    return { createdKid, pruned };
  }

  /**
   * Revokes a (compromised) key everywhere. Returns null for an unknown kid;
   * revoking an already-revoked key is a no-op that still re-broadcasts.
   */
  public async revoke(kid: string, reason: string): Promise<{ kid: string; replacementKid: string | null } | null> {
    const record = await this.store.find(kid);
    if (!record) return null;

    if (!record.revokedAt) {
      await this.store.revoke(kid, new Date(this.now()), reason);
    }
    this.revocationEpoch++;
    this.ring.remove(kid);
    await this.channel?.publish({ type: "revoked", kid });

    // Creates an immediately active replacement when the signing key was revoked
    const { createdKid } = await this.rotate();
    await this.refresh();
    console.warn(`[jwt-keys] Signing key ${kid} revoked (${reason})`);
    return { kid, replacementKid: createdKid };
  }

  /** JWK Set (RFC 7517 section 5) of keys that are, or are about to be, valid. */
  public getJwks(): { keys: PublicSigningJwk[] } {
    return { keys: this.ring.publicJwks() };
  }

  private handleEvent(event: JwtKeyEvent): void {
    if (event.type === "revoked") {
      this.revocationEpoch++;
      this.ring.remove(event.kid);
    }
    this.refresh().catch((error) => console.error("[jwt-keys] Refresh after key event failed:", error));
  }

  /** Bounded so tokens with random kids cannot turn into a database query each. */
  private refreshForUnknownKid(): void {
    const now = this.now();
    if (now - this.lastUnknownKidRefreshAt < UNKNOWN_KID_REFRESH_COOLDOWN_MS) return;
    this.lastUnknownKidRefreshAt = now;
    this.refresh().catch((error) => console.error("[jwt-keys] Refresh for unknown kid failed:", error));
  }

  private async createKey(activatesAt: number): Promise<string> {
    const { kid, publicKey, privateKey } = generateSigningKeyPair();
    await this.store.insert({
      kid,
      algorithm: JWT_SIGNING_ALGORITHM,
      publicJwk: toPublicJwk(kid, publicKey),
      encryptedPrivateKey: encryptPrivateKey(privateKey, kid, this.encryptionSecret()),
      activatesAt: new Date(activatesAt),
      retiresAt: null,
      revokedAt: null,
    });
    return kid;
  }

  private toSigningKey(record: JwtKeyRecord): JwtSigningKey {
    let privateKey: KeyObject | null = null;
    try {
      privateKey = decryptPrivateKey(record.encryptedPrivateKey, record.kid, this.encryptionSecret());
    } catch (error) {
      // Still usable for verification; signing falls back to another key
      console.error(`[jwt-keys] Cannot decrypt private key ${record.kid} (was JWT_SECRET changed?):`, error);
    }
    return {
      kid: record.kid,
      publicKey: crypto.createPublicKey({ key: { ...record.publicJwk }, format: "jwk" }),
      privateKey,
      activatesAt: record.activatesAt.getTime(),
      retiresAt: record.retiresAt?.getTime() ?? null,
    };
  }
}

export const jwtKeyRotationService = new JwtKeyRotationService();
