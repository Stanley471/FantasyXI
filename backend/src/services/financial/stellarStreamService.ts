/**
 * Horizon SSE payment listener (issue #557).
 *
 * Streams `/payments` for the league escrow accounts and, when a payment's
 * transaction hash matches a pending league deposit, pushes a
 * `deposit.confirmed` notification to the depositor over the existing
 * notification WebSocket (UserNotificationHub). Horizon only streams payments
 * from closed ledgers, so every message is already on-chain.
 *
 * - The listener never changes financial state; the transaction coordinator /
 *   FinancialService stay the source of truth for confirming deposits.
 * - Disconnects reconnect with exponential backoff. After the first message
 *   the stream resumes from the last paging token, so payments that landed
 *   during an outage are replayed rather than lost.
 * - A notification is sent once per transaction hash.
 */

import { StrKey } from "@stellar/stellar-sdk";
import {
  userNotificationHub as defaultHub,
  type UserNotificationHub,
} from "../notifications/userNotificationHub.js";

export const DEPOSIT_CONFIRMED_NOTIFICATION = "deposit.confirmed";

/** The fields of a Horizon payment record the listener uses. */
export interface HorizonPaymentRecord {
  id?: string;
  type?: string;
  paging_token: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  created_at?: string;
  to?: string;
  amount?: string;
}

export interface PendingDeposit {
  userId: string;
  leagueId: string | null;
  amount: string;
}

/** Looks up a pending league deposit by Stellar transaction hash. */
export interface PendingDepositLookup {
  findPendingDeposit(txHash: string): Promise<PendingDeposit | null>;
}

export interface PaymentStreamHandlers {
  onmessage: (record: HorizonPaymentRecord) => void;
  onerror: (error: unknown) => void;
}

/** Opens a stream for one account and returns a function that closes it. */
export type PaymentStreamFactory = (
  account: string,
  cursor: string,
  handlers: PaymentStreamHandlers
) => () => void;

export interface StellarStreamServiceOptions {
  accounts: string[];
  lookup: PendingDepositLookup;
  streamFactory: PaymentStreamFactory;
  hub?: Pick<UserNotificationHub, "publish">;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

const PAYMENT_TYPES = new Set(["payment", "path_payment_strict_receive", "path_payment_strict_send"]);
const MAX_SEEN_HASHES = 5_000;

interface AccountStream {
  account: string;
  cursor: string;
  close: (() => void) | null;
  failures: number;
  timer: NodeJS.Timeout | null;
}

export class StellarStreamService {
  private readonly accounts: string[];
  private readonly lookup: PendingDepositLookup;
  private readonly streamFactory: PaymentStreamFactory;
  private readonly hub: Pick<UserNotificationHub, "publish">;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly streams = new Map<string, AccountStream>();
  private readonly notified = new Set<string>();
  private running = false;

  constructor(options: StellarStreamServiceOptions) {
    this.accounts = [...new Set(options.accounts)];
    this.lookup = options.lookup;
    this.streamFactory = options.streamFactory;
    this.hub = options.hub ?? defaultHub;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  public static backoffDelay(failures: number, baseMs: number, maxMs: number): number {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
  }

  public isRunning(): boolean {
    return this.running;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    for (const account of this.accounts) {
      this.streams.set(account, { account, cursor: "now", close: null, failures: 0, timer: null });
      this.connect(account);
    }
    this.logger.info(`[stellar-stream] Listening for deposits to ${this.accounts.length} account(s)`);
  }

  public stop(): void {
    this.running = false;
    for (const stream of this.streams.values()) {
      if (stream.timer) clearTimeout(stream.timer);
      stream.close?.();
      stream.close = null;
    }
    this.streams.clear();
  }

  private connect(account: string): void {
    const stream = this.streams.get(account);
    if (!this.running || !stream) return;
    stream.timer = null;
    try {
      stream.close = this.streamFactory(account, stream.cursor, {
        onmessage: (record) => void this.handleRecord(account, record),
        onerror: (error) => this.handleError(account, error),
      });
    } catch (error) {
      this.handleError(account, error);
    }
  }

  private handleError(account: string, error: unknown): void {
    const stream = this.streams.get(account);
    if (!this.running || !stream || stream.timer) return;
    stream.close?.();
    stream.close = null;
    stream.failures++;
    const delay = StellarStreamService.backoffDelay(stream.failures, this.baseBackoffMs, this.maxBackoffMs);
    this.logger.warn(
      `[stellar-stream] Stream for ${account} dropped (attempt ${stream.failures}), ` +
        `reconnecting in ${delay}ms from cursor ${stream.cursor}: ${(error as Error)?.message ?? error}`
    );
    stream.timer = setTimeout(() => this.connect(account), delay);
    stream.timer.unref?.();
  }

  /** Processes one streamed payment. Returns true when a notification was sent. */
  public async handleRecord(account: string, record: HorizonPaymentRecord): Promise<boolean> {
    const stream = this.streams.get(account);
    if (stream) {
      stream.failures = 0;
      if (record.paging_token) stream.cursor = record.paging_token;
    }

    if (!PAYMENT_TYPES.has(record.type ?? "payment")) return false;
    if (record.to !== account) return false;
    if (record.transaction_successful === false) return false;
    const txHash = record.transaction_hash;
    if (!txHash || this.notified.has(txHash)) return false;

    try {
      const deposit = await this.lookup.findPendingDeposit(txHash);
      if (!deposit) return false;

      this.remember(txHash);
      const delivered = this.hub.publish(deposit.userId, DEPOSIT_CONFIRMED_NOTIFICATION, {
        txHash,
        leagueId: deposit.leagueId,
        amount: record.amount ?? deposit.amount,
        ledgerClosedAt: record.created_at ?? null,
      });
      const closedAt = record.created_at ? Date.parse(record.created_at) : NaN;
      const latency = Number.isFinite(closedAt)
        ? `${Math.max(0, this.now() - closedAt)}ms after ledger close`
        : "unknown latency";
      this.logger.info(
        `[stellar-stream] Deposit ${txHash} matched for user ${deposit.userId}; ` +
          `delivered to ${delivered} socket(s), ${latency}`
      );
      return true;
    } catch (error) {
      this.logger.error(`[stellar-stream] Failed to process payment ${txHash}: ${(error as Error).message}`);
      return false;
    }
  }

  private remember(txHash: string): void {
    this.notified.add(txHash);
    if (this.notified.size > MAX_SEEN_HASHES) {
      this.notified.delete(this.notified.values().next().value as string);
    }
  }
}

/** Prisma-backed lookup of pending entry-fee transactions. */
export class PrismaPendingDepositLookup implements PendingDepositLookup {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any) {}

  public async findPendingDeposit(txHash: string): Promise<PendingDeposit | null> {
    const row = await this.db.transaction.findFirst({
      where: { stellarTxHash: txHash, type: "ENTRY_FEE", status: { in: ["PENDING", "SUBMITTED"] } },
      select: { userId: true, leagueId: true, amount: true },
    });
    return row ? { userId: row.userId, leagueId: row.leagueId ?? null, amount: String(row.amount) } : null;
  }
}

/** Escrow accounts to watch: STELLAR_STREAM_ACCOUNTS, else the treasury account. */
export function resolveStreamAccounts(env: NodeJS.ProcessEnv = process.env, treasury?: string): string[] {
  const configured = (env.STELLAR_STREAM_ACCOUNTS ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const candidates = configured.length > 0 ? configured : treasury ? [treasury] : [];
  return candidates.filter((a) => StrKey.isValidEd25519PublicKey(a));
}

/**
 * Builds the service from environment config. Returns null when there is no
 * valid escrow account to watch.
 */
export async function createStellarStreamService(): Promise<StellarStreamService | null> {
  const [{ prisma }, { getHorizonServer, stellarConfig }] = await Promise.all([
    import("../../config/db.js"),
    import("../../config/stellar.js"),
  ]);
  const accounts = resolveStreamAccounts(process.env, stellarConfig.treasuryAddress);
  if (accounts.length === 0) return null;
  return new StellarStreamService({
    accounts,
    lookup: new PrismaPendingDepositLookup(prisma),
    streamFactory: (account, cursor, handlers) =>
      getHorizonServer()
        .payments()
        .forAccount(account)
        .cursor(cursor)
        .stream({
          onmessage: (record) => handlers.onmessage(record as unknown as HorizonPaymentRecord),
          onerror: handlers.onerror,
          // Reconnection is handled by StellarStreamService (backoff + cursor resume).
          reconnectTimeout: 2_147_483_647,
        }) as () => void,
  });
}
