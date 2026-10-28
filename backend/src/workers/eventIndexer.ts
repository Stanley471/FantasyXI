/**
 * Soroban Escrow Event Indexer & Streaming Subscriber Daemon (Issue #403)
 *
 * Polls Soroban RPC getEvents for the escrow contract (created, deposit, settle,
 * m_settle, refund, DepositRefunded, EmergencyRefund, LeagueRefundClaimed, claimed,
 * m_claimed) and reconciles deposits/claims/refunds into the database while
 * dispatching confirmed events to `depositQueue` with idempotency deduplication.
 *
 * - Cursor persistence: the RPC paging cursor and last ledger are stored in both
 *   Redis (`soroban:indexer:cursor:escrow-events`) and PostgreSQL (`IndexerCursor`)
 *   and saved only after a batch is processed, so restarts resume where they left
 *   off without skipping event blocks.
 * - Idempotency: replayed deposits are deduplicated in `depositQueue` and upsert
 *   the Transaction by tx hash and re-apply the same member state, so processing
 *   an event twice has no extra effect.
 * - Resilience: RPC errors (rate limits, timeouts, disconnects) back off
 *   exponentially without advancing the cursor.
 */

import { rpc } from "@stellar/stellar-sdk";
import { prisma } from "../config/db.js";
import { getRedisClient, type IRedisCacheClient } from "../config/redis.js";
import { stellarConfig } from "../config/stellar.js";
import { StellarService, stellarService } from "../services/financial/stellarService.js";
import { leagueIdPrefixFromContractId } from "../services/financial/contractLeagueId.js";
import { EmailService, emailService } from "../services/email/emailService.js";
import {
  FinancialAuditAction,
  FinancialAuditRecorder,
  financialAuditLog,
  SYSTEM_ACTOR,
} from "../services/audit/financialAuditLog.js";
import {
  MembershipStatus,
  PaymentStatus,
  TransactionStatus,
  TransactionType,
} from "../types/index.js";
import {
  decodeSorobanEscrowEvent,
  DepositQueue,
  depositQueue,
  type DecodedSorobanEscrowEvent,
} from "../queues/depositQueue.js";

export const INDEXER_CURSOR_ID = "escrow-events";
export const REDIS_CURSOR_KEY = `soroban:indexer:cursor:${INDEXER_CURSOR_ID}`;

export interface PersistedIndexerCursor {
  id: string;
  lastLedger: number;
  cursor: string | null;
}

export interface EventIndexerOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  redis?: IRedisCacheClient | null;
  queue?: DepositQueue;
  stellar?: StellarService;
  email?: EmailService;
  audit?: FinancialAuditRecorder;
  pollIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  batchSize?: number;
  /** Ledger to start from when no cursor is stored (defaults to the latest ledger) */
  startLedger?: number;
}

export class EscrowEventIndexer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly redis: IRedisCacheClient | null;
  private readonly queue: DepositQueue;
  private readonly stellar: StellarService;
  private readonly email: EmailService;
  private readonly audit: FinancialAuditRecorder;
  private readonly pollIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly batchSize: number;
  private readonly startLedger?: number;
  private failures = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: EventIndexerOptions = {}) {
    this.db = options.db ?? prisma;
    this.redis =
      options.redis !== undefined
        ? options.redis
        : options.db
          ? null
          : getRedisClient();
    this.queue = options.queue ?? depositQueue;
    this.stellar = options.stellar ?? stellarService;
    this.email = options.email ?? emailService;
    this.audit = options.audit ?? financialAuditLog;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.batchSize = options.batchSize ?? 100;
    this.startLedger = options.startLedger;
  }

  /**
   * Exponential backoff delay after `failures` consecutive errors, capped at maxMs.
   */
  public static backoffDelay(failures: number, baseMs: number, maxMs: number): number {
    return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
  }

  private static isOutOfRetention(error: unknown): boolean {
    return /ledger range|startLedger must be|cursor/i.test((error as Error)?.message ?? "");
  }

  /**
   * Loads the saved cursor from Redis first (if configured), falling back to PostgreSQL (`IndexerCursor`).
   */
  public async loadSavedCursor(): Promise<PersistedIndexerCursor | null> {
    if (this.redis) {
      try {
        const cached = await this.redis.get(REDIS_CURSOR_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as PersistedIndexerCursor;
          if (parsed && typeof parsed.lastLedger === "number") {
            return parsed;
          }
        }
      } catch {
        // Fallback to PostgreSQL cursor
      }
    }

    const dbCursor = await this.db.indexerCursor?.findUnique?.({
      where: { id: INDEXER_CURSOR_ID },
    });
    if (dbCursor) {
      if (this.redis) {
        try {
          await this.redis.set(REDIS_CURSOR_KEY, JSON.stringify(dbCursor));
        } catch {
          // Non-fatal
        }
      }
      return dbCursor as PersistedIndexerCursor;
    }
    return null;
  }

  /**
   * Persists the pagination cursor to both PostgreSQL (`IndexerCursor`) and Redis.
   */
  public async saveCursor(lastLedger: number, cursor: string | null): Promise<void> {
    await this.db.indexerCursor.upsert({
      where: { id: INDEXER_CURSOR_ID },
      create: { id: INDEXER_CURSOR_ID, lastLedger, cursor },
      update: { lastLedger, cursor },
    });

    if (this.redis) {
      try {
        await this.redis.set(
          REDIS_CURSOR_KEY,
          JSON.stringify({ id: INDEXER_CURSOR_ID, lastLedger, cursor })
        );
      } catch {
        // Redis failure should not fail indexing once Postgres cursor is committed
      }
    }
  }

  /**
   * Fetches and processes one page of events, then persists the cursor.
   * Returns the number of events processed.
   */
  public async pollOnce(): Promise<number> {
    const saved = await this.loadSavedCursor();

    let response: rpc.Api.GetEventsResponse;
    try {
      if (saved?.cursor) {
        response = await this.stellar.getEscrowContractEvents({
          cursor: saved.cursor,
          limit: this.batchSize,
        });
      } else {
        const startLedger =
          (saved ? saved.lastLedger + 1 : undefined) ??
          this.startLedger ??
          (await this.stellar.getRpcLedgerRange()).latestLedger;
        response = await this.stellar.getEscrowContractEvents({
          startLedger,
          limit: this.batchSize,
        });
      }
    } catch (error) {
      if (!EscrowEventIndexer.isOutOfRetention(error)) throw error;
      const { oldestLedger } = await this.stellar.getRpcLedgerRange();
      console.warn(`[indexer] Cursor outside RPC retention, restarting at ledger ${oldestLedger}`);
      response = await this.stellar.getEscrowContractEvents({
        startLedger: oldestLedger,
        limit: this.batchSize,
      });
    }

    for (const event of response.events) {
      await this.handleEvent(event);
    }

    const lastLedger =
      response.events.at(-1)?.ledger ?? saved?.lastLedger ?? response.latestLedger;
    await this.saveCursor(lastLedger, response.cursor ?? null);

    return response.events.length;
  }

  /**
   * Applies a single escrow event. Returns true when an event was processed.
   */
  public async handleEvent(event: rpc.Api.EventResponse): Promise<boolean> {
    const decoded: DecodedSorobanEscrowEvent | null = decodeSorobanEscrowEvent(
      event as unknown as Parameters<typeof decodeSorobanEscrowEvent>[0]
    );
    if (!decoded) {
      return false;
    }

    const name = decoded.rawTopicName;
    const contractLeagueId = decoded.contractLeagueId;

    const league = await this.db.league.findFirst({
      where: { id: { startsWith: leagueIdPrefixFromContractId(contractLeagueId) } },
    });

    // Persist ContractEvent for audit trail and replay recovery
    if (this.db.contractEvent) {
      try {
        let serializedValue: unknown;
        try {
          const raw = decoded.rawValue;
          if (typeof raw === "bigint") {
            serializedValue = raw.toString();
          } else if (Array.isArray(raw)) {
            serializedValue = raw.map((v) => (typeof v === "bigint" ? v.toString() : v));
          } else {
            serializedValue = raw;
          }
        } catch {
          serializedValue = null;
        }

        await this.db.contractEvent.create({
          data: {
            contractId:
              decoded.contractId ??
              process.env.STELLAR_ESCROW_CONTRACT_ID ??
              stellarConfig.escrowContractId,
            eventType: name,
            leagueId: league?.id ?? null,
            txHash: event.txHash,
            ledgerSeq: event.ledger,
            payload: {
              contractLeagueId: contractLeagueId.toString(),
              value: serializedValue,
              closedAt: event.ledgerClosedAt,
            },
          },
        });
      } catch (err) {
        console.warn(`[indexer] Failed to record ContractEvent:`, (err as Error).message);
      }
    }

    // Dispatch decoded event to depositQueue with idempotency deduplication
    await this.queue.enqueue(decoded);

    const confirmedAt = new Date(event.ledgerClosedAt);

    switch (name) {
      case "deposit":
      case "Deposit": {
        const participant = decoded.participant!;
        const amountStroops = decoded.amountStroops ?? 0n;
        const amountUsdc = decoded.amountUsdc ?? Number(amountStroops) / 10_000_000;

        const flagDeposit = async (
          reason: string,
          leagueId: string | null,
          expectedAmount?: number
        ) => {
          if (!this.db.depositException) return;
          await this.db.depositException.upsert({
            where: { txHash: event.txHash },
            create: {
              txHash: event.txHash,
              leagueId,
              contractLeagueId: contractLeagueId.toString(),
              senderAddress: participant,
              amount: amountUsdc,
              expectedAmount: expectedAmount ?? null,
              reason,
            },
            update: {},
          });
        };

        if (!league) {
          await flagDeposit("UNKNOWN_LEAGUE", null);
          console.warn(`[indexer] Deposit for unknown league ${contractLeagueId} (tx ${event.txHash})`);
          return false;
        }

        const member = await this.db.leagueMember.findFirst({
          where: {
            leagueId: league.id,
            OR: [
              { stellarAddress: participant },
              { user: { wallet: { stellarAddress: participant } } },
            ],
          },
          include: {
            user: true,
          },
        });
        if (!member) {
          const occupiedSlots = await this.db.leagueMember.count({
            where: { leagueId: league.id },
          });
          await flagDeposit(
            occupiedSlots >= league.maxMembers ? "LEAGUE_OVER_CAPACITY" : "UNLINKED_SENDER",
            league.id
          );
          console.warn(
            `[indexer] No member of league ${league.id} for ${participant} (tx ${event.txHash})`
          );
          return false;
        }

        const expectedAmount = Number(league.entryFee);
        if (Math.abs(amountUsdc - expectedAmount) > 0.0000001) {
          await flagDeposit("AMOUNT_MISMATCH", league.id, expectedAmount);
          console.warn(
            `[indexer] Deposit amount mismatch for member ${member.id} (tx ${event.txHash})`
          );
          return false;
        }
        const memberCount = await this.db.leagueMember.count({
          where: { leagueId: league.id },
        });
        if (memberCount > league.maxMembers) {
          await flagDeposit("LEAGUE_OVER_CAPACITY", league.id, expectedAmount);
          return false;
        }

        // A replayed deposit must never undo a refund
        if (
          member.paymentStatus === PaymentStatus.REFUND_PENDING ||
          member.paymentStatus === PaymentStatus.REFUNDED
        ) {
          return false;
        }
        const wasConfirmed = member.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED;
        const isAlreadyConfirmed = member.paymentStatus === PaymentStatus.PAYMENT_CONFIRMED;

        const depositUpdates: Promise<unknown>[] = [
          this.db.leagueMember.update({
            where: { id: member.id },
            data: {
              paymentStatus: PaymentStatus.PAYMENT_CONFIRMED,
              status: MembershipStatus.ACTIVE,
              hasPaid: true,
              stellarAddress: participant,
            },
          }),
          this.db.transaction.upsert({
            where: { stellarTxHash: event.txHash },
            update: {
              status: TransactionStatus.CONFIRMED,
              ledgerSeq: event.ledger,
              confirmedAt,
              memberId: member.id,
            },
            create: {
              userId: member.userId,
              leagueId: league.id,
              memberId: member.id,
              type: TransactionType.ENTRY_FEE,
              amount: amountUsdc,
              asset: stellarConfig.usdcAssetCode,
              assetIssuer: stellarConfig.usdcIssuer,
              stellarTxHash: event.txHash,
              ledgerSeq: event.ledger,
              status: TransactionStatus.CONFIRMED,
              confirmedAt,
            },
          }),
        ];
        if (this.db.depositException?.deleteMany) {
          depositUpdates.push(
            this.db.depositException.deleteMany({ where: { txHash: event.txHash } })
          );
        }
        await this.db.$transaction(depositUpdates);

        if (!isAlreadyConfirmed && member.user?.email) {
          try {
            await this.email.sendDepositConfirmation({
              to: member.user.email,
              username: member.user.username || member.user.name || "Manager",
              leagueName: league.name,
              amount: amountUsdc,
              txHash: event.txHash,
            });
          } catch (err) {
            console.error("[indexer] Failed to send deposit email:", err);
          }
        }
        // Replayed events re-apply the same state; only audit the first confirmation
        if (!wasConfirmed) {
          this.audit.record({
            action: FinancialAuditAction.DEPOSIT_CONFIRMED,
            userId: member.userId,
            actorId: SYSTEM_ACTOR,
            leagueId: league.id,
            amount: amountUsdc,
            asset: stellarConfig.usdcAssetCode,
            stellarTxHash: event.txHash,
            metadata: {
              memberId: member.id,
              participant,
              ledgerSeq: event.ledger,
              source: "indexer",
            },
          });
        }

        console.log(
          `[indexer] Confirmed deposit of member ${member.id} in league ${league.id} (tx ${event.txHash})`
        );
        return true;
      }

      case "settle":
      case "m_settle": {
        const totalPayoutStroops = decoded.totalPayoutStroops ?? 0n;
        const platformFeeStroops = decoded.platformFeeStroops ?? 0n;
        console.log(
          `[indexer] Settle event for league ${contractLeagueId} (payout: ${totalPayoutStroops}, fee: ${platformFeeStroops})`
        );

        if (!league) {
          console.warn(
            `[indexer] Settle for unknown league ${contractLeagueId} (tx ${event.txHash})`
          );
          return false;
        }

        const wasCompleted = league.status === "COMPLETED";
        const updates: Promise<unknown>[] = [
          this.db.league.update({
            where: { id: league.id },
            data: { status: "COMPLETED" },
          }),
        ];

        if (platformFeeStroops > 0n && league.creatorId) {
          updates.push(
            this.db.transaction.upsert({
              where: { stellarTxHash: `${event.txHash}-fee` },
              update: {
                status: TransactionStatus.CONFIRMED,
                ledgerSeq: event.ledger,
                confirmedAt,
              },
              create: {
                userId: league.creatorId,
                leagueId: league.id,
                type: TransactionType.PLATFORM_FEE,
                amount: Number(platformFeeStroops) / 10_000_000,
                asset: stellarConfig.usdcAssetCode,
                assetIssuer: stellarConfig.usdcIssuer,
                stellarTxHash: `${event.txHash}-fee`,
                ledgerSeq: event.ledger,
                status: TransactionStatus.CONFIRMED,
                confirmedAt,
              },
            })
          );
        }

        await this.db.$transaction(updates);

        // Replayed settle events re-apply the same state; only audit the first one
        if (platformFeeStroops > 0n && !wasCompleted) {
          this.audit.record({
            action: FinancialAuditAction.FEE_EXTRACTION,
            actorId: SYSTEM_ACTOR,
            leagueId: league.id,
            amount: Number(platformFeeStroops) / 10_000_000,
            asset: stellarConfig.usdcAssetCode,
            stellarTxHash: `${event.txHash}-fee`,
            metadata: {
              totalPayoutStroops: totalPayoutStroops.toString(),
              platformFeeStroops: platformFeeStroops.toString(),
              ledgerSeq: event.ledger,
              source: "indexer",
            },
          });
        }
        return true;
      }

      case "refund":
      case "EmergencyRefund":
      case "LeagueRefundClaimed": {
        // Single-participant refund events (EmergencyRefund / LeagueRefundClaimed)
        if (
          (name === "EmergencyRefund" || name === "LeagueRefundClaimed") &&
          decoded.participant
        ) {
          if (!league) return false;
          const member = await this.db.leagueMember.findFirst({
            where: {
              leagueId: league.id,
              OR: [
                { stellarAddress: decoded.participant },
                { user: { wallet: { stellarAddress: decoded.participant } } },
              ],
            },
          });
          if (member) {
            const refundUsdc = decoded.amountUsdc ?? Number(league.entryFee ?? 0);
            await this.db.$transaction([
              this.db.leagueMember.update({
                where: { id: member.id },
                data: {
                  paymentStatus: PaymentStatus.REFUNDED,
                  status: MembershipStatus.REFUNDED,
                },
              }),
              this.db.transaction.upsert({
                where: { stellarTxHash: `${event.txHash}-${member.id}` },
                update: {
                  status: TransactionStatus.CONFIRMED,
                  ledgerSeq: event.ledger,
                  confirmedAt,
                },
                create: {
                  userId: member.userId,
                  leagueId: league.id,
                  memberId: member.id,
                  type: TransactionType.REFUND,
                  amount: refundUsdc,
                  asset: stellarConfig.usdcAssetCode,
                  assetIssuer: stellarConfig.usdcIssuer,
                  stellarTxHash: `${event.txHash}-${member.id}`,
                  ledgerSeq: event.ledger,
                  status: TransactionStatus.CONFIRMED,
                  confirmedAt,
                },
              }),
            ]);
          }
          return true;
        }

        const count = decoded.refundCount ?? 0;
        console.log(
          `[indexer] Refund event for league ${contractLeagueId} (${count} participants)`
        );

        if (!league) {
          console.warn(
            `[indexer] Refund for unknown league ${contractLeagueId} (tx ${event.txHash})`
          );
          return false;
        }

        const membersToRefund = await this.db.leagueMember.findMany({
          where: {
            leagueId: league.id,
            paymentStatus: {
              in: [PaymentStatus.PAYMENT_CONFIRMED, PaymentStatus.REFUND_PENDING],
            },
          },
        });

        const txOps: Promise<unknown>[] = [
          this.db.league.update({
            where: { id: league.id },
            data: { status: "CANCELLED" },
          }),
        ];

        for (const m of membersToRefund) {
          txOps.push(
            this.db.leagueMember.update({
              where: { id: m.id },
              data: {
                paymentStatus: PaymentStatus.REFUNDED,
                status: MembershipStatus.REFUNDED,
              },
            })
          );
          txOps.push(
            this.db.transaction.upsert({
              where: { stellarTxHash: `${event.txHash}-${m.id}` },
              update: {
                status: TransactionStatus.CONFIRMED,
                ledgerSeq: event.ledger,
                confirmedAt,
              },
              create: {
                userId: m.userId,
                leagueId: league.id,
                memberId: m.id,
                type: TransactionType.REFUND,
                amount: Number(league.entryFee ?? 0),
                asset: stellarConfig.usdcAssetCode,
                assetIssuer: stellarConfig.usdcIssuer,
                stellarTxHash: `${event.txHash}-${m.id}`,
                ledgerSeq: event.ledger,
                status: TransactionStatus.CONFIRMED,
                confirmedAt,
              },
            })
          );
        }

        await this.db.$transaction(txOps);

        for (const m of membersToRefund) {
          this.audit.record({
            action: FinancialAuditAction.REFUND,
            userId: m.userId,
            actorId: SYSTEM_ACTOR,
            leagueId: league.id,
            amount: Number(league.entryFee ?? 0),
            asset: stellarConfig.usdcAssetCode,
            stellarTxHash: `${event.txHash}-${m.id}`,
            metadata: { memberId: m.id, ledgerSeq: event.ledger, source: "indexer" },
          });
        }
        return true;
      }

      case "DepositRefunded": {
        const participant = decoded.participant!;
        if (this.db.depositRefundClaim) {
          const claim = await this.db.depositRefundClaim.findFirst({
            where: {
              exception: {
                contractLeagueId: contractLeagueId.toString(),
                senderAddress: participant,
              },
            },
          });
          if (claim && claim.status !== "PAID") {
            await this.db.depositRefundClaim.update({
              where: { id: claim.id },
              data: { status: "PAID", completedAt: confirmedAt },
            });
          }
        }
        return true;
      }

      case "claimed":
      case "m_claimed":
      case "claim":
      case "PrizeClaimed": {
        const winner = decoded.participant!;
        const amountStroops = decoded.amountStroops ?? 0n;
        console.log(
          `[indexer] Claimed prize for league ${contractLeagueId} by ${winner} (amount: ${amountStroops})`
        );

        if (!league) {
          return false;
        }

        const member = await this.db.leagueMember.findFirst({
          where: {
            leagueId: league.id,
            OR: [
              { stellarAddress: winner },
              { user: { wallet: { stellarAddress: winner } } },
            ],
          },
        });

        if (member) {
          await this.db.transaction.upsert({
            where: { stellarTxHash: `${event.txHash}-${winner}` },
            update: {
              status: TransactionStatus.CONFIRMED,
              ledgerSeq: event.ledger,
              confirmedAt,
              memberId: member.id,
            },
            create: {
              userId: member.userId,
              leagueId: league.id,
              memberId: member.id,
              type: TransactionType.PRIZE_PAYOUT,
              amount: Number(amountStroops) / 10_000_000,
              asset: stellarConfig.usdcAssetCode,
              assetIssuer: stellarConfig.usdcIssuer,
              stellarTxHash: `${event.txHash}-${winner}`,
              ledgerSeq: event.ledger,
              status: TransactionStatus.CONFIRMED,
              confirmedAt,
            },
          });

          this.audit.record({
            action: FinancialAuditAction.WITHDRAWAL,
            userId: member.userId,
            actorId: SYSTEM_ACTOR,
            leagueId: league.id,
            amount: Number(amountStroops) / 10_000_000,
            asset: stellarConfig.usdcAssetCode,
            stellarTxHash: `${event.txHash}-${winner}`,
            metadata: {
              memberId: member.id,
              winner,
              type: TransactionType.PRIZE_PAYOUT,
              ledgerSeq: event.ledger,
              source: "indexer",
            },
          });
        }
        return true;
      }

      case "created": {
        console.log(`[indexer] League created on-chain: ${contractLeagueId} (tx ${event.txHash})`);
        return true;
      }

      default:
        console.log(`[indexer] Unhandled event ${name} for league ${contractLeagueId}`);
        return false;
    }
  }

  /**
   * Resets the indexer cursor to replay events from a specific ledger or from the beginning.
   */
  public async resetCursor(startLedger?: number): Promise<void> {
    if (startLedger !== undefined) {
      await this.saveCursor(startLedger - 1, null);
    } else {
      await this.db.indexerCursor.deleteMany({
        where: { id: INDEXER_CURSOR_ID },
      });
      if (this.redis) {
        try {
          await this.redis.del(REDIS_CURSOR_KEY);
        } catch {
          // Ignore Redis delete error
        }
      }
    }
  }

  /**
   * Retrieves stored contract events for a league or event type.
   */
  public async getIndexedEvents(
    query: { leagueId?: string; eventType?: string; limit?: number } = {}
  ) {
    if (!this.db.contractEvent) return [];
    return this.db.contractEvent.findMany({
      where: {
        ...(query.leagueId ? { leagueId: query.leagueId } : {}),
        ...(query.eventType ? { eventType: query.eventType } : {}),
      },
      orderBy: { ledgerSeq: "desc" },
      take: query.limit ?? 50,
    });
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
    console.log("[indexer] Soroban escrow event indexer started");
  }

  public stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const processed = await this.pollOnce();
      this.failures = 0;
      // A full page means more events are waiting — fetch the next page right away
      this.schedule(processed >= this.batchSize ? 0 : this.pollIntervalMs);
    } catch (error) {
      this.failures++;
      const delay = EscrowEventIndexer.backoffDelay(
        this.failures,
        this.baseBackoffMs,
        this.maxBackoffMs
      );
      console.error(
        `[indexer] Poll failed (attempt ${this.failures}), retrying in ${delay}ms:`,
        (error as Error).message
      );
      this.schedule(delay);
    }
  }
}

export { EscrowEventIndexer as SorobanEventSubscriberDaemon };
