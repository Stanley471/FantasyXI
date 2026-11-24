/**
 * Cryptographic audit anchoring for settled gameweeks (issue #559).
 *
 * After a gameweek settles, the standings, member points and prize allocations
 * of every league that played it are hashed into one 32-byte digest, and that
 * digest is committed on Stellar as the MEMO_HASH of a zero-value transaction
 * (a no-op `bumpSequence`, so only the network fee is spent). The resulting
 * transaction hash is stored as a public, immutable audit receipt.
 *
 * Digest construction (version 1):
 *   leaf(league) = sha256(canonicalJson(league snapshot))
 *   root         = Merkle root over leaves sorted by league ID, pairs hashed
 *                  with the same sorted-pair rule as merkleTree.ts
 *   digest       = sha256(canonicalJson({ v: 1, gameweek: <FPL id>, root }))
 *
 * The snapshot the digest was computed from is stored with the receipt, so a
 * verifier can recompute the digest and compare it with the memo read back from
 * Horizon without trusting the database row alone. Live standings keep changing
 * after the gameweek, which is why verification is against the stored snapshot.
 *
 * Keys: the anchor account's secret is read from STELLAR_AUDIT_ANCHOR_SECRET
 * and is never logged or stored.
 */

import { createHash } from "node:crypto";
import { BASE_FEE, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { hashPair } from "./merkleTree.js";

export const AUDIT_DIGEST_VERSION = 1;

export type AnchorStatus = "PENDING" | "CONFIRMED" | "FAILED";

export interface MemberSnapshot {
  userId: string;
  squadId: string;
  gameweekPoints: number;
  totalPoints: number;
  rank: number | null;
}

export interface PrizeSnapshot {
  userId: string;
  amount: string;
}

export interface LeagueSnapshot {
  leagueId: string;
  members: MemberSnapshot[];
  prizes: PrizeSnapshot[];
}

export interface GameweekAuditSnapshot {
  version: number;
  gameweekFplId: number;
  leagues: LeagueSnapshot[];
}

// ------------------------------------------------------------
// Pure digest computation
// ------------------------------------------------------------

/** JSON with object keys sorted, so the digest survives a JSONB round trip. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const sha256 = (data: string | Buffer): Buffer => createHash("sha256").update(data).digest();

/** Orders members, prizes and leagues so the same data always hashes the same. */
export function normalizeSnapshot(snapshot: GameweekAuditSnapshot): GameweekAuditSnapshot {
  const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    version: snapshot.version,
    gameweekFplId: snapshot.gameweekFplId,
    leagues: [...snapshot.leagues]
      .map((league) => ({
        leagueId: league.leagueId,
        members: [...league.members].sort((a, b) => byString(a.userId, b.userId)),
        prizes: [...league.prizes].sort(
          (a, b) => byString(a.userId, b.userId) || byString(a.amount, b.amount)
        ),
      }))
      .sort((a, b) => byString(a.leagueId, b.leagueId)),
  };
}

export function computeAuditDigest(input: GameweekAuditSnapshot): string {
  const snapshot = normalizeSnapshot(input);
  let level = snapshot.leagues.map((league) => sha256(canonicalJson(league)));
  if (level.length === 0) level = [sha256("")];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return sha256(
    canonicalJson({ v: snapshot.version, gameweek: snapshot.gameweekFplId, root: level[0].toString("hex") })
  ).toString("hex");
}

// ------------------------------------------------------------
// Service
// ------------------------------------------------------------

/** The slice of Horizon the anchor service uses. */
export interface AnchorHorizon {
  loadAccount(address: string): Promise<any>;
  submitTransaction(tx: any): Promise<{ hash: string; ledger?: number }>;
  /** Reads a transaction back, e.g. server.transactions().transaction(hash).call(). */
  getTransaction(hash: string): Promise<{
    successful?: boolean;
    memo_type?: string;
    memo?: string;
    ledger?: number;
  } | null>;
}

export interface GameweekAuditAnchorOptions {
  db: any;
  horizon: () => AnchorHorizon;
  networkPassphrase: string;
  /** Anchor account secret; anchoring is skipped when absent. */
  signerSecret?: string;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

export interface AnchorReceipt {
  gameweekFplId: number;
  digest: string;
  status: AnchorStatus;
  stellarTxHash: string | null;
  ledgerSeq: number | null;
  leagueCount: number;
  memberCount: number;
  anchoredAt: Date | null;
}

export interface AnchorVerification {
  anchored: boolean;
  gameweekFplId: number;
  status?: AnchorStatus;
  stellarTxHash?: string | null;
  /** Digest stored with the receipt. */
  digest?: string;
  /** Digest recomputed from the stored snapshot. */
  recomputedDigest?: string;
  /** Digest read from the MEMO_HASH of the on-chain transaction. */
  onChainDigest?: string | null;
  snapshotIntact?: boolean;
  onChainMatches?: boolean;
  /** True only when the snapshot is intact and matches the on-chain memo. */
  verified: boolean;
  reason?: string;
}

function toReceipt(row: any, gameweekFplId: number): AnchorReceipt {
  return {
    gameweekFplId,
    digest: row.digest,
    status: row.status,
    stellarTxHash: row.stellarTxHash ?? null,
    ledgerSeq: row.ledgerSeq ?? null,
    leagueCount: row.leagueCount,
    memberCount: row.memberCount,
    anchoredAt: row.anchoredAt ?? null,
  };
}

export class GameweekAuditAnchorService {
  private readonly db: any;
  private readonly horizon: () => AnchorHorizon;
  private readonly networkPassphrase: string;
  private readonly signerSecret?: string;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly now: () => Date;

  constructor(options: GameweekAuditAnchorOptions) {
    this.db = options.db;
    this.horizon = options.horizon;
    this.networkPassphrase = options.networkPassphrase;
    this.signerSecret = options.signerSecret;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
  }

  public isConfigured(): boolean {
    return Boolean(this.signerSecret);
  }

  /** Collects standings, member points and prize allocations for a gameweek. */
  public async buildSnapshot(gameweekId: number): Promise<GameweekAuditSnapshot> {
    const gameweek = await this.db.gameweek.findUnique({ where: { id: gameweekId } });
    if (!gameweek) throw new Error(`Gameweek ${gameweekId} not found`);

    const leagues: Array<{ id: string }> = await this.db.league.findMany({
      where: {
        startGameweekId: { lte: gameweekId },
        endGameweekId: { gte: gameweekId },
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
      select: { id: true },
    });
    const leagueIds = leagues.map((l) => l.id);
    if (leagueIds.length === 0) {
      return { version: AUDIT_DIGEST_VERSION, gameweekFplId: gameweek.fplId, leagues: [] };
    }

    const members: any[] = await this.db.leagueMember.findMany({
      where: { leagueId: { in: leagueIds }, status: "ACTIVE" },
      select: { leagueId: true, userId: true, squadId: true, rank: true, totalPoints: true },
    });
    const squadIds = [...new Set(members.map((m) => m.squadId))];
    const [leagueScores, squadScores, prizes]: any[][] = await Promise.all([
      this.db.leagueGameweekScore.findMany({
        where: { gameweekId, leagueId: { in: leagueIds } },
        select: { leagueId: true, squadId: true, points: true },
      }),
      this.db.squadGameweekScore.findMany({
        where: { gameweekId, squadId: { in: squadIds } },
        select: { squadId: true, points: true },
      }),
      this.db.transaction.findMany({
        where: { leagueId: { in: leagueIds }, type: "PRIZE_PAYOUT", status: "CONFIRMED" },
        select: { leagueId: true, userId: true, amount: true },
      }),
    ]);

    // Leagues with custom scoring keep their own per-league scores.
    const leagueScore = new Map(leagueScores.map((s) => [`${s.leagueId}:${s.squadId}`, s.points]));
    const squadScore = new Map(squadScores.map((s) => [s.squadId, s.points]));

    const snapshot: GameweekAuditSnapshot = {
      version: AUDIT_DIGEST_VERSION,
      gameweekFplId: gameweek.fplId,
      leagues: leagueIds.map((leagueId) => ({
        leagueId,
        members: members
          .filter((m) => m.leagueId === leagueId)
          .map((m) => ({
            userId: m.userId,
            squadId: m.squadId,
            gameweekPoints: leagueScore.get(`${leagueId}:${m.squadId}`) ?? squadScore.get(m.squadId) ?? 0,
            totalPoints: m.totalPoints ?? 0,
            rank: m.rank ?? null,
          })),
        prizes: prizes
          .filter((p) => p.leagueId === leagueId)
          .map((p) => ({ userId: p.userId, amount: Number(p.amount).toFixed(2) })),
      })),
    };
    return normalizeSnapshot(snapshot);
  }

  /**
   * Anchors a settled gameweek. Idempotent: a confirmed receipt is returned
   * as-is; a pending or failed one is rebuilt and resubmitted. Returns null
   * when there is nothing to anchor or no signing key is configured.
   */
  public async anchorGameweek(gameweekId: number): Promise<AnchorReceipt | null> {
    if (!this.signerSecret) {
      this.logger.info("[audit-anchor] STELLAR_AUDIT_ANCHOR_SECRET not set; skipping anchoring");
      return null;
    }

    const existing = await this.db.gameweekAuditAnchor.findUnique({ where: { gameweekId } });
    const gameweek = await this.db.gameweek.findUnique({ where: { id: gameweekId } });
    if (!gameweek) throw new Error(`Gameweek ${gameweekId} not found`);
    if (existing?.status === "CONFIRMED") return toReceipt(existing, gameweek.fplId);

    const snapshot = await this.buildSnapshot(gameweekId);
    if (snapshot.leagues.length === 0) {
      this.logger.info(`[audit-anchor] Gameweek ${gameweek.fplId} has no leagues; nothing to anchor`);
      return null;
    }
    const digest = computeAuditDigest(snapshot);
    const memberCount = snapshot.leagues.reduce((n, l) => n + l.members.length, 0);
    const data = {
      digest,
      snapshot,
      leagueCount: snapshot.leagues.length,
      memberCount,
      status: "PENDING",
      errorMessage: null,
    };
    await this.db.gameweekAuditAnchor.upsert({
      where: { gameweekId },
      create: { gameweekId, ...data },
      update: { ...data, attempts: { increment: 1 } },
    });

    try {
      const { hash, ledger } = await this.submitAnchor(digest);
      const confirmed = await this.db.gameweekAuditAnchor.update({
        where: { gameweekId },
        data: {
          status: "CONFIRMED",
          stellarTxHash: hash,
          ledgerSeq: ledger ?? null,
          anchoredAt: this.now(),
        },
      });
      this.logger.info(
        `[audit-anchor] Anchored gameweek ${gameweek.fplId}: digest ${digest}, tx ${hash}, ` +
          `${snapshot.leagues.length} league(s), ${memberCount} member(s)`
      );
      return toReceipt(confirmed, gameweek.fplId);
    } catch (error) {
      await this.db.gameweekAuditAnchor.update({
        where: { gameweekId },
        data: { status: "FAILED", errorMessage: (error as Error).message.slice(0, 500) },
      });
      throw error;
    }
  }

  /** Never throws: used by the settlement job, where anchoring must not block settlement. */
  public async anchorGameweekSafely(gameweekId: number): Promise<AnchorReceipt | null> {
    try {
      return await this.anchorGameweek(gameweekId);
    } catch (error) {
      this.logger.error(
        `[audit-anchor] Failed to anchor gameweek ${gameweekId}; it will be retried: ${(error as Error).message}`
      );
      return null;
    }
  }

  /** Retries settled gameweeks that have no confirmed receipt yet. */
  public async retryUnanchored(limit = 5): Promise<number> {
    if (!this.signerSecret) return 0;
    const settled: Array<{ id: number }> = await this.db.gameweek.findMany({
      where: { settledAt: { not: null }, OR: [{ auditAnchor: null }, { auditAnchor: { status: { not: "CONFIRMED" } } }] },
      select: { id: true },
      orderBy: { id: "desc" },
      take: limit,
    });
    let anchored = 0;
    for (const gw of settled) {
      if (await this.anchorGameweekSafely(gw.id)) anchored++;
    }
    return anchored;
  }

  private async submitAnchor(digest: string): Promise<{ hash: string; ledger?: number }> {
    const keypair = Keypair.fromSecret(this.signerSecret!);
    const horizon = this.horizon();
    const account = await horizon.loadAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      // Zero-value: a no-op bump (sequence 0 never lowers the sequence) that only carries the memo.
      .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
      .addMemo(Memo.hash(digest))
      .setTimeout(60)
      .build();
    tx.sign(keypair);
    return horizon.submitTransaction(tx);
  }

  /** Public receipt without any member data. */
  public async getReceipt(gameweekFplId: number): Promise<AnchorReceipt | null> {
    const gameweek = await this.db.gameweek.findUnique({ where: { fplId: gameweekFplId } });
    if (!gameweek) return null;
    const row = await this.db.gameweekAuditAnchor.findUnique({ where: { gameweekId: gameweek.id } });
    return row ? toReceipt(row, gameweekFplId) : null;
  }

  public async listReceipts(limit = 50): Promise<AnchorReceipt[]> {
    const rows: any[] = await this.db.gameweekAuditAnchor.findMany({
      where: { status: "CONFIRMED" },
      include: { gameweek: { select: { fplId: true } } },
      orderBy: { gameweekId: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map((row) => toReceipt(row, row.gameweek.fplId));
  }

  /**
   * Checks the stored snapshot against the digest on-chain: recomputes the
   * digest from the snapshot and compares it with the memo of the anchoring
   * transaction as returned by Horizon.
   */
  public async verify(gameweekFplId: number): Promise<AnchorVerification> {
    const gameweek = await this.db.gameweek.findUnique({ where: { fplId: gameweekFplId } });
    const row = gameweek
      ? await this.db.gameweekAuditAnchor.findUnique({ where: { gameweekId: gameweek.id } })
      : null;
    if (!row || row.status !== "CONFIRMED" || !row.stellarTxHash) {
      return { anchored: false, gameweekFplId, verified: false, reason: "No confirmed audit anchor for this gameweek" };
    }

    const recomputedDigest = computeAuditDigest(row.snapshot as GameweekAuditSnapshot);
    const snapshotIntact = recomputedDigest === row.digest;

    let onChainDigest: string | null = null;
    let reason: string | undefined;
    try {
      const tx = await this.horizon().getTransaction(row.stellarTxHash);
      if (!tx) reason = "Anchoring transaction not found on Horizon";
      else if (tx.successful === false) reason = "Anchoring transaction failed on-chain";
      else if (tx.memo_type !== "hash" || !tx.memo) reason = "Anchoring transaction has no hash memo";
      else onChainDigest = Buffer.from(tx.memo, "base64").toString("hex");
    } catch (error) {
      reason = `Could not read the anchoring transaction: ${(error as Error).message}`;
    }

    const onChainMatches = onChainDigest !== null && onChainDigest === row.digest;
    if (!reason && !snapshotIntact) reason = "Stored snapshot does not hash to the anchored digest";
    if (!reason && !onChainMatches) reason = "On-chain memo does not match the anchored digest";

    return {
      anchored: true,
      gameweekFplId,
      status: row.status,
      stellarTxHash: row.stellarTxHash,
      digest: row.digest,
      recomputedDigest,
      onChainDigest,
      snapshotIntact,
      onChainMatches,
      verified: snapshotIntact && onChainMatches,
      ...(reason ? { reason } : {}),
    };
  }
}

/** Builds the service from the shared Prisma client and Stellar config. */
export async function createGameweekAuditAnchorService(): Promise<GameweekAuditAnchorService> {
  const [{ prisma }, { getHorizonServer, stellarConfig }] = await Promise.all([
    import("../../config/db.js"),
    import("../../config/stellar.js"),
  ]);
  return new GameweekAuditAnchorService({
    db: prisma,
    networkPassphrase: stellarConfig.networkPassphrase,
    signerSecret: process.env.STELLAR_AUDIT_ANCHOR_SECRET,
    horizon: () => {
      const server = getHorizonServer();
      return {
        loadAccount: (address: string) => server.loadAccount(address),
        submitTransaction: async (tx: any) => {
          const result = await server.submitTransaction(tx);
          return { hash: result.hash, ledger: result.ledger };
        },
        getTransaction: async (hash: string) => {
          try {
            return (await server.transactions().transaction(hash).call()) as any;
          } catch (error) {
            if ((error as { response?: { status?: number } }).response?.status === 404) return null;
            throw error;
          }
        },
      };
    },
  });
}
