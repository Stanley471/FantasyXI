import { Keypair, StrKey, WebAuth } from "@stellar/stellar-sdk";
import { getRedisClient, type IRedisCacheClient } from "../../config/redis.js";
import { stellarConfig } from "../../config/stellar.js";

/**
 * SEP-0010 Stellar Web Authentication (issue #562).
 *
 *   1. GET  /auth/stellar/challenge?account=G...  -> server-signed challenge transaction
 *   2. The wallet signs the challenge with the account's key (nothing is submitted).
 *   3. POST /auth/stellar/verify { transaction }  -> the signed challenge is validated
 *
 * Validation (`WebAuth.verifyChallengeTxSigners`) rejects transactions that are
 * expired (time bounds), altered (server signature no longer matches), built for
 * another home domain / network / server key, or not signed by the client key.
 * On top of that every challenge nonce is stored server-side when issued and
 * consumed on first use, so a captured signed challenge can never be replayed
 * and a challenge the server never issued is refused.
 *
 * The challenge transaction has sequence number 0, so it can never be submitted
 * to the network.
 */

export class StellarAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 401 | 503 = 401
  ) {
    super(message);
    this.name = "StellarAuthError";
  }
}

export interface StellarAuthConfig {
  /** Secret key of the server's SEP-10 signing account (S...) */
  serverSecret?: string;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  /** Challenge lifetime in seconds */
  challengeTtlSeconds: number;
}

export function loadStellarAuthConfig(env: NodeJS.ProcessEnv = process.env): StellarAuthConfig {
  const frontendHost = (() => {
    try {
      return new URL(env.FRONTEND_URL || "http://localhost:3000").host;
    } catch {
      return "localhost:3000";
    }
  })();
  const homeDomain = env.SEP10_HOME_DOMAIN || frontendHost;
  const ttl = Number(env.SEP10_CHALLENGE_TTL_SECONDS);
  return {
    serverSecret: env.SEP10_SERVER_SIGNING_KEY || undefined,
    homeDomain,
    webAuthDomain: env.SEP10_WEB_AUTH_DOMAIN || homeDomain,
    networkPassphrase: stellarConfig.networkPassphrase,
    challengeTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 900) : 300,
  };
}

const NONCE_PREFIX = "sep10:nonce:";
const MEMORY_SWEEP_THRESHOLD = 5_000;

/** Single-use nonce registry: Redis when it answers, otherwise a per-process map. */
class NonceStore {
  private readonly memory = new Map<string, { account: string; expiresAt: number }>();

  constructor(private readonly redis: IRedisCacheClient | null) {}

  public async put(nonce: string, account: string, ttlSeconds: number): Promise<void> {
    const key = `${NONCE_PREFIX}${nonce}`;
    if (this.redis) {
      try {
        await this.redis.set(key, account, "EX", ttlSeconds);
        return;
      } catch (err) {
        console.warn("[sep10] Redis SET error, falling back to memory:", (err as Error).message);
      }
    }
    if (this.memory.size >= MEMORY_SWEEP_THRESHOLD) {
      const now = Date.now();
      for (const [k, v] of this.memory) if (v.expiresAt <= now) this.memory.delete(k);
    }
    this.memory.set(key, { account, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  /** Returns the account the nonce was issued for and removes it (atomic claim). */
  public async take(nonce: string): Promise<string | null> {
    const key = `${NONCE_PREFIX}${nonce}`;
    if (this.redis) {
      try {
        const account = await this.redis.get(key);
        if (account && (await this.redis.del(key)) === 1) return account;
      } catch (err) {
        console.warn("[sep10] Redis claim error, falling back to memory:", (err as Error).message);
      }
    }
    const entry = this.memory.get(key);
    if (!entry || !this.memory.delete(key) || entry.expiresAt <= Date.now()) return null;
    return entry.account;
  }
}

export interface StellarChallenge {
  transaction: string;
  networkPassphrase: string;
  expiresAt: string;
}

export class StellarAuthService {
  private readonly nonces: NonceStore;
  private readonly configOverride?: Partial<StellarAuthConfig>;

  constructor(options: { redis?: IRedisCacheClient | null; config?: Partial<StellarAuthConfig> } = {}) {
    this.nonces = new NonceStore(options.redis !== undefined ? options.redis : getRedisClient());
    this.configOverride = options.config;
  }

  private get config(): StellarAuthConfig {
    return { ...loadStellarAuthConfig(), ...this.configOverride };
  }

  private serverKeypair(config: StellarAuthConfig): Keypair {
    if (!config.serverSecret || !StrKey.isValidEd25519SecretSeed(config.serverSecret)) {
      throw new StellarAuthError("Stellar sign-in is not configured on this server", 503);
    }
    return Keypair.fromSecret(config.serverSecret);
  }

  /** Builds a server-signed SEP-10 challenge for `account`. */
  public async createChallenge(account: unknown): Promise<StellarChallenge> {
    if (typeof account !== "string" || !StrKey.isValidEd25519PublicKey(account)) {
      throw new StellarAuthError("A valid Stellar account (G...) is required", 400);
    }
    const config = this.config;
    const server = this.serverKeypair(config);

    const transaction = WebAuth.buildChallengeTx(
      server,
      account,
      config.homeDomain,
      config.challengeTtlSeconds,
      config.networkPassphrase,
      config.webAuthDomain
    );
    const { tx } = WebAuth.readChallengeTx(
      transaction,
      server.publicKey(),
      config.networkPassphrase,
      config.homeDomain,
      config.webAuthDomain
    );
    const nonce = this.nonceOf(tx);
    await this.nonces.put(nonce, account, config.challengeTtlSeconds);

    return {
      transaction,
      networkPassphrase: config.networkPassphrase,
      expiresAt: new Date(Date.now() + config.challengeTtlSeconds * 1000).toISOString(),
    };
  }

  /**
   * Verifies a client-signed challenge and returns the authenticated account.
   * Every failure is a 401 (400 for a missing transaction).
   */
  public async verifyChallenge(signedTransaction: unknown): Promise<{ account: string }> {
    if (typeof signedTransaction !== "string" || signedTransaction.length === 0 || signedTransaction.length > 20_000) {
      throw new StellarAuthError("A signed challenge transaction is required", 400);
    }
    const config = this.config;
    const server = this.serverKeypair(config);

    let account: string;
    let nonce: string;
    try {
      const read = WebAuth.readChallengeTx(
        signedTransaction,
        server.publicKey(),
        config.networkPassphrase,
        config.homeDomain,
        config.webAuthDomain
      );
      account = read.clientAccountID;
      nonce = this.nonceOf(read.tx);
      // Throws for expired time bounds, a missing/invalid server signature or no client signature
      const signers = WebAuth.verifyChallengeTxSigners(
        signedTransaction,
        server.publicKey(),
        config.networkPassphrase,
        [account],
        config.homeDomain,
        config.webAuthDomain
      );
      if (!signers.includes(account)) {
        throw new Error("Challenge is not signed by the client account");
      }
    } catch (err) {
      throw new StellarAuthError(`Invalid challenge: ${(err as Error).message}`, 401);
    }

    // Only challenges this server issued, for this account, and only once
    const issuedFor = await this.nonces.take(nonce);
    if (issuedFor !== account) {
      throw new StellarAuthError("Challenge was not issued by this server, has expired or was already used", 401);
    }
    return { account };
  }

  private nonceOf(tx: { operations: Array<{ type: string; value?: unknown }> }): string {
    const op = tx.operations[0];
    const value = op?.value;
    const nonce =
      value instanceof Uint8Array ? Buffer.from(value).toString("base64") : typeof value === "string" ? value : "";
    if (!nonce) throw new StellarAuthError("Challenge has no nonce", 401);
    return nonce;
  }
}

export const stellarAuthService = new StellarAuthService();
