/**
 * Stellar Fee-Bump Service (SEP-0015)
 *
 * Implements automated fee-bumping for platform settlement and payout transactions
 * stuck in the mempool during network surge pricing.
 *
 * Sponsoring keypair pays the escalated transaction fee without requiring the
 * original transaction signers to re-sign.
 */

import {
  TransactionBuilder,
  Keypair,
  Networks,
  BASE_FEE,
  Transaction,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { prisma } from "../../config/db.js";
import { stellarConfig, withHorizonFailover } from "../../config/stellar.js";
import { logger } from "../../config/logger.js";
import { FinancialAuditAction } from "@prisma/client";

export interface FeeBumpServiceOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: any;
  sponsorshipSecret?: string;
  sponsorshipKeypair?: Keypair;
  networkPassphrase?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  horizonClient?: any;
  pendingThresholdMs?: number;
  maxFeeCapStroops?: number;
  feeMultiplier?: number;
  minSponsorshipBalanceXlm?: number;
  now?: () => Date;
}

export interface FeeBumpResult {
  success: boolean;
  innerTxHash: string;
  feeBumpTxHash: string;
  originalFeeStroops: number;
  bumpedFeeStroops: number;
  sponsorshipAccount: string;
  ledgerSeq?: number;
  error?: string;
}

export interface StuckTransactionCandidate {
  id: string;
  txHash: string;
  envelopeXdr: string;
  submittedAt: Date;
  leagueId?: string | null;
  userId?: string | null;
  transactionId?: string | null;
}

export const DEFAULT_MAX_FEE_CAP_STROOPS = 100_000; // 0.01 XLM safety limit
export const DEFAULT_PENDING_THRESHOLD_MS = 30_000; // 30 seconds stuck in mempool
export const DEFAULT_FEE_MULTIPLIER = 1.5;
export const DEFAULT_MIN_SPONSORSHIP_BALANCE_XLM = 2.0;

export class FeeBumpService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: any;
  private readonly sponsorshipKeypair: Keypair;
  private readonly networkPassphrase: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly horizonOverride?: any;
  private readonly pendingThresholdMs: number;
  private readonly maxFeeCapStroops: number;
  private readonly feeMultiplier: number;
  private readonly minSponsorshipBalanceXlm: number;
  private readonly now: () => Date;

  constructor(options: FeeBumpServiceOptions = {}) {
    this.db = options.db ?? prisma;
    this.networkPassphrase = options.networkPassphrase ?? stellarConfig.networkPassphrase ?? Networks.TESTNET;
    this.horizonOverride = options.horizonClient;
    this.pendingThresholdMs = options.pendingThresholdMs ?? DEFAULT_PENDING_THRESHOLD_MS;
    this.maxFeeCapStroops = options.maxFeeCapStroops ?? DEFAULT_MAX_FEE_CAP_STROOPS;
    this.feeMultiplier = options.feeMultiplier ?? DEFAULT_FEE_MULTIPLIER;
    this.minSponsorshipBalanceXlm = options.minSponsorshipBalanceXlm ?? DEFAULT_MIN_SPONSORSHIP_BALANCE_XLM;
    this.now = options.now ?? (() => new Date());

    if (options.sponsorshipKeypair) {
      this.sponsorshipKeypair = options.sponsorshipKeypair;
    } else if (options.sponsorshipSecret) {
      this.sponsorshipKeypair = Keypair.fromSecret(options.sponsorshipSecret);
    } else if (process.env.STELLAR_FEE_BUMP_SECRET) {
      this.sponsorshipKeypair = Keypair.fromSecret(process.env.STELLAR_FEE_BUMP_SECRET);
    } else {
      // Fallback random keypair for testing when unconfigured
      this.sponsorshipKeypair = Keypair.random();
    }
  }

  public getSponsorshipPublicKey(): string {
    return this.sponsorshipKeypair.publicKey();
  }

  /**
   * Checks whether the sponsorship account has sufficient XLM reserves
   * to cover fee bumps.
   */
  public async checkSponsorshipBalance(): Promise<{ hasSufficientBalance: boolean; balanceXlm: number }> {
    if (this.horizonOverride?.loadAccount) {
      try {
        const account = await this.horizonOverride.loadAccount(this.sponsorshipKeypair.publicKey());
        const nativeBalance = account.balances.find((b: { asset_type: string }) => b.asset_type === "native");
        const balanceXlm = nativeBalance ? parseFloat(nativeBalance.balance) : 0;
        return {
          hasSufficientBalance: balanceXlm >= this.minSponsorshipBalanceXlm,
          balanceXlm,
        };
      } catch (err) {
        logger.warn({ err }, "[FeeBumpService] Failed to load sponsorship account from mock horizon");
        return { hasSufficientBalance: false, balanceXlm: 0 };
      }
    }

    try {
      const balanceXlm = await withHorizonFailover(async (server) => {
        const account = await server.loadAccount(this.sponsorshipKeypair.publicKey());
        const native = account.balances.find((b) => b.asset_type === "native");
        return native ? parseFloat(native.balance) : 0;
      });

      const hasSufficientBalance = balanceXlm >= this.minSponsorshipBalanceXlm;
      if (!hasSufficientBalance) {
        logger.warn(
          { balanceXlm, required: this.minSponsorshipBalanceXlm, account: this.sponsorshipKeypair.publicKey() },
          "[FeeBumpService] Sponsorship account balance below threshold"
        );
      }

      return { hasSufficientBalance, balanceXlm };
    } catch (error) {
      logger.error({ error }, "[FeeBumpService] Error querying sponsorship account balance");
      return { hasSufficientBalance: false, balanceXlm: 0 };
    }
  }

  /**
   * Calculates dynamic fee escalation, strictly enforcing safety cap limits.
   */
  public calculateBumpedFee(innerFeeStroops: number, networkBaseFeeStroops = Number(BASE_FEE)): number {
    // In SEP-0015, the fee-bump fee must be at least the inner transaction's fee + base fee
    const minRequiredFee = Math.max(innerFeeStroops + networkBaseFeeStroops, Number(BASE_FEE));

    if (minRequiredFee > this.maxFeeCapStroops) {
      throw new Error(
        `Fee bump rejected: required minimum fee (${minRequiredFee} stroops) exceeds safety cap (${this.maxFeeCapStroops} stroops)`
      );
    }

    // Dynamic escalation
    const escalatedFee = Math.ceil(innerFeeStroops * this.feeMultiplier);
    const candidateFee = Math.max(escalatedFee, minRequiredFee);

    // Strictly enforce safety cap
    return Math.min(candidateFee, this.maxFeeCapStroops);
  }

  /**
   * Constructs and signs a Stellar fee-bump transaction (SEP-0015).
   */
  public buildFeeBumpTransaction(
    innerTxInput: Transaction | string,
    customFeeStroops?: number
  ): { feeBumpTx: FeeBumpTransaction; bumpedFeeStroops: number; innerTxHash: string } {
    const innerTx: Transaction =
      typeof innerTxInput === "string"
        ? (TransactionBuilder.fromXDR(innerTxInput, this.networkPassphrase) as Transaction)
        : innerTxInput;

    const innerFeeStroops = Number(innerTx.fee);
    const feeRateStroops = customFeeStroops ?? this.calculateBumpedFee(innerFeeStroops);

    if (feeRateStroops > this.maxFeeCapStroops) {
      throw new Error(
        `Fee bump rejected: requested fee (${feeRateStroops} stroops) exceeds safety cap (${this.maxFeeCapStroops} stroops)`
      );
    }

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      this.sponsorshipKeypair.publicKey(),
      feeRateStroops.toString(),
      innerTx,
      this.networkPassphrase
    );

    feeBumpTx.sign(this.sponsorshipKeypair);

    return {
      feeBumpTx,
      bumpedFeeStroops: Number(feeBumpTx.fee),
      innerTxHash: Buffer.from(innerTx.hash()).toString("hex"),
    };
  }

  /**
   * Submits a fee-bump transaction and updates internal accounting audit records.
   */
  public async submitFeeBump(
    innerTxInput: Transaction | string,
    context: {
      leagueId?: string | null;
      userId?: string | null;
      transactionId?: string | null;
    } = {}
  ): Promise<FeeBumpResult> {
    const { hasSufficientBalance, balanceXlm } = await this.checkSponsorshipBalance();
    if (!hasSufficientBalance) {
      const msg = `Sponsorship account has insufficient balance (${balanceXlm} XLM < ${this.minSponsorshipBalanceXlm} XLM)`;
      logger.error({ account: this.sponsorshipKeypair.publicKey() }, msg);
      return {
        success: false,
        innerTxHash: typeof innerTxInput === "string" ? "" : Buffer.from(innerTxInput.hash()).toString("hex"),
        feeBumpTxHash: "",
        originalFeeStroops: 0,
        bumpedFeeStroops: 0,
        sponsorshipAccount: this.sponsorshipKeypair.publicKey(),
        error: msg,
      };
    }

    let built;
    try {
      built = this.buildFeeBumpTransaction(innerTxInput);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        innerTxHash: typeof innerTxInput === "string" ? "" : Buffer.from(innerTxInput.hash()).toString("hex"),
        feeBumpTxHash: "",
        originalFeeStroops: 0,
        bumpedFeeStroops: 0,
        sponsorshipAccount: this.sponsorshipKeypair.publicKey(),
        error: errorMsg,
      };
    }

    const { feeBumpTx, bumpedFeeStroops, innerTxHash } = built;
    const feeBumpTxHash = Buffer.from(feeBumpTx.hash()).toString("hex");
    const originalFeeStroops = Number((feeBumpTx.innerTransaction as Transaction).fee);

    try {
      let ledgerSeq: number | undefined;

      if (this.horizonOverride?.submitTransaction) {
        const res = await this.horizonOverride.submitTransaction(feeBumpTx);
        ledgerSeq = res?.ledger;
      } else {
        const res = await withHorizonFailover(async (server) => {
          return server.submitTransaction(feeBumpTx);
        });
        ledgerSeq = res.ledger;
      }

      // Record internal accounting entry
      await this.recordFeeBumpAuditLog({
        innerTxHash,
        feeBumpTxHash,
        originalFeeStroops,
        bumpedFeeStroops,
        leagueId: context.leagueId ?? null,
        userId: context.userId ?? null,
        transactionId: context.transactionId ?? null,
        ledgerSeq,
      });

      logger.info(
        {
          innerTxHash,
          feeBumpTxHash,
          originalFeeStroops,
          bumpedFeeStroops,
          ledgerSeq,
        },
        "[FeeBumpService] Fee bump successfully submitted and recorded"
      );

      return {
        success: true,
        innerTxHash,
        feeBumpTxHash,
        originalFeeStroops,
        bumpedFeeStroops,
        sponsorshipAccount: this.sponsorshipKeypair.publicKey(),
        ledgerSeq,
      };
    } catch (submitError: unknown) {
      const errorMsg = submitError instanceof Error ? submitError.message : String(submitError);
      logger.error(
        { innerTxHash, feeBumpTxHash, error: errorMsg },
        "[FeeBumpService] Submission of fee-bump transaction failed"
      );

      return {
        success: false,
        innerTxHash,
        feeBumpTxHash,
        originalFeeStroops,
        bumpedFeeStroops,
        sponsorshipAccount: this.sponsorshipKeypair.publicKey(),
        error: errorMsg,
      };
    }
  }

  /**
   * Scans candidates and triggers fee bumps for transactions stuck past threshold.
   */
  public async scanAndBumpStuckTransactions(
    candidates: StuckTransactionCandidate[]
  ): Promise<{ inspected: number; bumped: number; skipped: number; results: FeeBumpResult[] }> {
    const now = this.now().getTime();
    const results: FeeBumpResult[] = [];
    let bumped = 0;
    let skipped = 0;

    for (const tx of candidates) {
      const pendingDurationMs = now - new Date(tx.submittedAt).getTime();
      if (pendingDurationMs < this.pendingThresholdMs) {
        skipped++;
        continue;
      }

      const result = await this.submitFeeBump(tx.envelopeXdr, {
        leagueId: tx.leagueId,
        userId: tx.userId,
        transactionId: tx.transactionId,
      });

      results.push(result);
      if (result.success) {
        bumped++;
      }
    }

    return {
      inspected: candidates.length,
      bumped,
      skipped,
      results,
    };
  }

  /**
   * Records accurate internal accounting records in FinancialAuditLog.
   */
  private async recordFeeBumpAuditLog(entry: {
    innerTxHash: string;
    feeBumpTxHash: string;
    originalFeeStroops: number;
    bumpedFeeStroops: number;
    leagueId: string | null;
    userId: string | null;
    transactionId: string | null;
    ledgerSeq?: number;
  }): Promise<void> {
    if (!this.db?.financialAuditLog?.create) return;

    try {
      await this.db.financialAuditLog.create({
        data: {
          action: FinancialAuditAction.FEE_EXTRACTION,
          actorId: "system:fee_bump_service",
          userId: entry.userId,
          leagueId: entry.leagueId,
          transactionId: entry.transactionId,
          amount: (entry.bumpedFeeStroops / 10_000_000).toFixed(7), // Convert stroops to XLM
          asset: "XLM",
          stellarTxHash: entry.feeBumpTxHash,
          metadata: {
            reason: "FEE_BUMP",
            innerTxHash: entry.innerTxHash,
            originalFeeStroops: entry.originalFeeStroops,
            bumpedFeeStroops: entry.bumpedFeeStroops,
            feeDeltaStroops: entry.bumpedFeeStroops - entry.originalFeeStroops,
            sponsorshipAccount: this.sponsorshipKeypair.publicKey(),
            ledgerSeq: entry.ledgerSeq,
          },
        },
      });
    } catch (logError) {
      logger.error({ logError }, "[FeeBumpService] Failed to persist fee bump audit log");
    }
  }
}
