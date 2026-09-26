/**
 * Soroban Escrow Event Indexer Worker
 *
 * Polls Soroban RPC getEvents for the escrow contract (created, deposit, settle, refund)
 * and reconciles deposits into the database, so a payment is confirmed even if the
 * user's browser never called the verify endpoint.
 *
 * - Cursor persistence: the RPC paging cursor and last ledger are stored in
 *   IndexerCursor and saved only after a batch is processed, so restarts resume
 *   where they left off (events may be replayed, never skipped).
 * - Idempotency: replayed deposits upsert the Transaction by tx hash and re-apply
 *   the same member state, so processing an event twice has no extra effect.
 * - Resilience: RPC errors (rate limits, disconnects) back off exponentially.
 *   Stellar ledgers are final once closed (no re-orgs); a cursor that fell out of the
 *   RPC retention window restarts from the oldest retained ledger.
 */

import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { prisma } from "../config/db.js";
import { stellarConfig } from "../config/stellar.js";
import { StellarService, stellarService } from "../services/financial/stellarService.js";
import { leagueIdPrefixFromContractId } from "../services/financial/contractLeagueId.js";
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

export const INDEXER_CURSOR_ID = "escrow-events";

export interface EventIndexerOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  stellar?: StellarService;
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
  private readonly stellar: StellarService;
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
    this.stellar = options.stellar ?? stellarService;
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
   * Fetches and processes one page of events, then persists the cursor.
   * Returns the number of events processed.
   */
  public async pollOnce(): Promise<number> {
    const saved = await this.db.indexerCursor.findUnique({
      where: { id: INDEXER_CURSOR_ID },
    });

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
    await this.db.indexerCursor.upsert({
      where: { id: INDEXER_CURSOR_ID },
      create: { id: INDEXER_CURSOR_ID, lastLedger, cursor: response.cursor },
      update: { lastLedger, cursor: response.cursor },
    });

    return response.events.length;
  }

  /**
   * Applies a single escrow event. Returns true when an event was processed.
   */
  public async handleEvent(event: rpc.Api.EventResponse): Promise<boolean> {
    const name = String(scValToNative(event.topic[0]));
    const contractLeagueId = BigInt(scValToNative(event.topic[1]));

    if (!event.inSuccessfulContractCall) {
      return false;
    }

    const league = await this.db.league.findFirst({
      where: { id: { startsWith: leagueIdPrefixFromContractId(contractLeagueId) } },
    });

    // Persist ContractEvent for audit trail and replay recovery
    if (this.db.contractEvent) {
      try {
        let serializedValue: unknown;
        try {
          const raw = scValToNative(event.value);
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
              (event as { contractId?: string }).contractId ??
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

    const confirmedAt = new Date(event.ledgerClosedAt);

    switch (name) {
      case "deposit": {
        const [participant, amountStroops] = scValToNative(event.value) as [string, bigint];

        if (!league) {
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
        });
        if (!member) {
          console.warn(
            `[indexer] No member of league ${league.id} for ${participant} (tx ${event.txHash})`
          );
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

        await this.db.$transaction([
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
              amount: Number(amountStroops) / 10_000_000,
              asset: stellarConfig.usdcAssetCode,
              assetIssuer: stellarConfig.usdcIssuer,
              stellarTxHash: event.txHash,
              ledgerSeq: event.ledger,
              status: TransactionStatus.CONFIRMED,
              confirmedAt,
            },
          }),
        ]);

        // Replayed events re-apply the same state; only audit the first confirmation
        if (!wasConfirmed) {
          this.audit.record({
            action: FinancialAuditAction.DEPOSIT_CONFIRMED,
            userId: member.userId,
            actorId: SYSTEM_ACTOR,
            leagueId: league.id,
            amount: Number(amountStroops) / 10_000_000,
            asset: stellarConfig.usdcAssetCode,
            stellarTxHash: event.txHash,
            metadata: { memberId: member.id, participant, ledgerSeq: event.ledger, source: "indexer" },
          });
        }

        console.log(
          `[indexer] Confirmed deposit of member ${member.id} in league ${league.id} (tx ${event.txHash})`
        );
        return true;
      }

      case "settle": {
        const [totalPayoutStroops, platformFeeStroops] = scValToNative(event.value) as [bigint, bigint];
        console.log(
          `[indexer] Settle event for league ${contractLeagueId} (payout: ${totalPayoutStroops}, fee: ${platformFeeStroops})`
        );

        if (!league) {
          console.warn(`[indexer] Settle for unknown league ${contractLeagueId} (tx ${event.txHash})`);
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

      case "refund": {
        const count = Number(scValToNative(event.value));
        console.log(`[indexer] Refund event for league ${contractLeagueId} (${count} participants)`);

        if (!league) {
          console.warn(`[indexer] Refund for unknown league ${contractLeagueId} (tx ${event.txHash})`);
          return false;
        }

        const membersToRefund = await this.db.leagueMember.findMany({
          where: {
            leagueId: league.id,
            paymentStatus: { in: [PaymentStatus.PAYMENT_CONFIRMED, PaymentStatus.REFUND_PENDING] },
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

      case "claimed": {
        const [winner, amountStroops] = scValToNative(event.value) as [string, bigint];
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
      await this.db.indexerCursor.upsert({
        where: { id: INDEXER_CURSOR_ID },
        create: { id: INDEXER_CURSOR_ID, lastLedger: startLedger - 1, cursor: null },
        update: { lastLedger: startLedger - 1, cursor: null },
      });
    } else {
      await this.db.indexerCursor.deleteMany({
        where: { id: INDEXER_CURSOR_ID },
      });
    }
  }

  /**
   * Retrieves stored contract events for a league or event type.
   */
  public async getIndexedEvents(query: { leagueId?: string; eventType?: string; limit?: number } = {}) {
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
      const delay = EscrowEventIndexer.backoffDelay(this.failures, this.baseBackoffMs, this.maxBackoffMs);
      console.error(
        `[indexer] Poll failed (attempt ${this.failures}), retrying in ${delay}ms:`,
        (error as Error).message
      );
      this.schedule(delay);
    }
  }
}
