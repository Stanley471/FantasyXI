/**
 * Stellar Fee-Bump Transaction Sponsoring Service (Issue #549)
 *
 * Implements gasless user onboarding by wrapping user-signed Soroban league deposit
 * transactions into Stellar FeeBumpTransactions (SEP-0015) sponsored by the platform account.
 *
 * Enforces intent validation (disallowing prize claims or unauthorized operations)
 * and daily per-user sponsorship quotas to prevent abuse.
 */

import {
  BASE_FEE,
  FeeBumpTransaction,
  Horizon,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { logger } from "../../config/logger.js";
import { stellarConfig } from "../../config/stellar.js";

export const DEFAULT_MAX_SPONSOR_FEE_STROOPS = 100_000; // 0.01 XLM
export const DEFAULT_DAILY_SPONSORSHIP_QUOTA = 5; // 5 sponsored transactions per user per day

export interface SponsorFeeResult {
  success: boolean;
  innerTxHash: string;
  feeBumpTxHash: string;
  sponsoredFeeStroops: number;
  remainingDailyQuota: number;
  signedFeeBumpXdr: string;
  submittedToNetwork: boolean;
  ledgerSeq?: number;
  error?: string;
}

export interface SponsorServiceOptions {
  sponsorKeypair?: Keypair;
  networkPassphrase?: string;
  horizonServer?: any;
  maxFeeStroops?: number;
  dailyQuota?: number;
}

export class StellarFeeBumpSponsorService {
  private readonly sponsorKeypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly horizonServer: any;
  private readonly maxFeeStroops: number;
  public readonly dailyQuota: number;

  // In-memory quota store tracking [timestamp][] per userId/wallet
  private readonly userQuotaStore = new Map<string, number[]>();

  constructor(options: SponsorServiceOptions = {}) {
    this.networkPassphrase =
      options.networkPassphrase ??
      stellarConfig.networkPassphrase ??
      Networks.TESTNET;

    this.maxFeeStroops = options.maxFeeStroops ?? DEFAULT_MAX_SPONSOR_FEE_STROOPS;
    this.dailyQuota = options.dailyQuota ?? DEFAULT_DAILY_SPONSORSHIP_QUOTA;

    if (options.sponsorKeypair) {
      this.sponsorKeypair = options.sponsorKeypair;
    } else {
      const secret =
        process.env.STELLAR_SPONSOR_SECRET ||
        process.env.STELLAR_MAINTENANCE_SECRET ||
        process.env.STELLAR_ISSUER_SECRET ||
        Keypair.random().secret();
      this.sponsorKeypair = Keypair.fromSecret(secret);
    }

    if (options.horizonServer) {
      this.horizonServer = options.horizonServer;
    } else {
      const horizonUrl = stellarConfig.horizonUrl || "https://horizon-testnet.stellar.org";
      this.horizonServer = new Horizon.Server(horizonUrl);
    }
  }

  public getSponsorPublicKey(): string {
    return this.sponsorKeypair.publicKey();
  }

  /**
   * Checks and consumes a user's daily sponsorship quota.
   * Rolling 24-hour window.
   */
  public checkAndConsumeQuota(userIdentifier: string): {
    allowed: boolean;
    remaining: number;
    resetMs: number;
  } {
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000; // 24 hours

    let timestamps = this.userQuotaStore.get(userIdentifier) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);

    if (timestamps.length >= this.dailyQuota) {
      const oldest = timestamps[0];
      const resetMs = Math.max(0, windowMs - (now - oldest));
      return {
        allowed: false,
        remaining: 0,
        resetMs,
      };
    }

    timestamps.push(now);
    this.userQuotaStore.set(userIdentifier, timestamps);

    return {
      allowed: true,
      remaining: this.dailyQuota - timestamps.length,
      resetMs: windowMs,
    };
  }

  /**
   * Validates inner transaction intent:
   * - Must not be a FeeBumpTransaction itself
   * - Must have valid operations
   * - Must NOT be a prize claim withdrawal (out of scope per spec)
   */
  public validateIntent(innerTx: Transaction): { valid: boolean; reason?: string } {
    if (!innerTx || !innerTx.operations || innerTx.operations.length === 0) {
      return { valid: false, reason: "Inner transaction must contain at least one operation." };
    }

    // Inspect operations to reject claim withdrawals
    for (const op of innerTx.operations) {
      // Disallow claim claimable balance operations
      if (op.type === "claimClaimableBalance") {
        return {
          valid: false,
          reason: "Sponsoring prize claim withdrawals is not permitted. Users must pay withdrawal gas.",
        };
      }

      // If invoking contract, inspect method name if available
      const anyOp = op as any;
      if (anyOp.functionName === "claim" || anyOp.functionName === "withdraw_prize" || anyOp.functionName === "claim_prize") {
        return {
          valid: false,
          reason: "Sponsoring prize claim withdrawals is not permitted.",
        };
      }
    }

    return { valid: true };
  }

  /**
   * Wraps an inner transaction in a FeeBumpTransaction, signs it, and broadcasts.
   */
  public async sponsorAndBroadcast(
    innerTxXdr: string,
    userIdentifier: string,
    submitToNetwork: boolean = true
  ): Promise<SponsorFeeResult> {
    if (!innerTxXdr || typeof innerTxXdr !== "string") {
      throw new Error("Missing or invalid innerTxXdr parameter.");
    }

    // 1. Check and enforce daily quota
    const quota = this.checkAndConsumeQuota(userIdentifier);
    if (!quota.allowed) {
      return {
        success: false,
        innerTxHash: "",
        feeBumpTxHash: "",
        sponsoredFeeStroops: 0,
        remainingDailyQuota: 0,
        signedFeeBumpXdr: "",
        submittedToNetwork: false,
        error: `Daily sponsorship quota exceeded (${this.dailyQuota} max per day). Retry in ${Math.ceil(
          quota.resetMs / 60000
        )} minutes.`,
      };
    }

    // 2. Parse inner transaction
    let parsed: any;
    try {
      parsed = TransactionBuilder.fromXDR(innerTxXdr, this.networkPassphrase);
    } catch (err) {
      return {
        success: false,
        innerTxHash: "",
        feeBumpTxHash: "",
        sponsoredFeeStroops: 0,
        remainingDailyQuota: quota.remaining,
        signedFeeBumpXdr: "",
        submittedToNetwork: false,
        error: `Invalid inner transaction XDR: ${(err as Error).message}`,
      };
    }

    if (parsed instanceof FeeBumpTransaction) {
      return {
        success: false,
        innerTxHash: "",
        feeBumpTxHash: "",
        sponsoredFeeStroops: 0,
        remainingDailyQuota: quota.remaining,
        signedFeeBumpXdr: "",
        submittedToNetwork: false,
        error: "Cannot wrap an existing FeeBumpTransaction.",
      };
    }

    const innerTx = parsed as Transaction;
    const innerTxHash = Buffer.from(innerTx.hash()).toString("hex");

    // 3. Validate intent
    const intentValidation = this.validateIntent(innerTx);
    if (!intentValidation.valid) {
      return {
        success: false,
        innerTxHash,
        feeBumpTxHash: "",
        sponsoredFeeStroops: 0,
        remainingDailyQuota: quota.remaining,
        signedFeeBumpXdr: "",
        submittedToNetwork: false,
        error: intentValidation.reason || "Unauthorized transaction intent.",
      };
    }

    // 4. Calculate fee-bump fee (must be >= inner fee + BASE_FEE)
    const baseFeeNum = parseInt(BASE_FEE, 10);
    const innerFeeNum = parseInt(innerTx.fee, 10) || baseFeeNum;
    const bumpedFeeStroops = Math.min(
      this.maxFeeStroops,
      Math.max(innerFeeNum + baseFeeNum, baseFeeNum * 2)
    );

    // 5. Build FeeBumpTransaction
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      this.sponsorKeypair,
      bumpedFeeStroops.toString(),
      innerTx,
      this.networkPassphrase
    );

    // Sign with sponsor keypair
    feeBumpTx.sign(this.sponsorKeypair);
    const feeBumpTxHash = Buffer.from(feeBumpTx.hash()).toString("hex");
    const signedFeeBumpXdr = feeBumpTx.toXDR();

    // 6. Optionally submit to network
    let submitted = false;
    let ledgerSeq: number | undefined;

    if (submitToNetwork && this.horizonServer) {
      try {
        const response = await this.horizonServer.submitTransaction(feeBumpTx);
        submitted = true;
        ledgerSeq = response.ledger;
        logger.info(
          `[fee-bump-sponsor] Sponsored tx ${feeBumpTxHash} confirmed in ledger ${ledgerSeq} (Inner: ${innerTxHash}, User: ${userIdentifier})`
        );
      } catch (err: any) {
        logger.error(`[fee-bump-sponsor] Horizon broadcast failed for ${feeBumpTxHash}: ${err.message}`);
        return {
          success: false,
          innerTxHash,
          feeBumpTxHash,
          sponsoredFeeStroops: bumpedFeeStroops,
          remainingDailyQuota: quota.remaining,
          signedFeeBumpXdr,
          submittedToNetwork: false,
          error: `Stellar network submission failed: ${err.message}`,
        };
      }
    }

    return {
      success: true,
      innerTxHash,
      feeBumpTxHash,
      sponsoredFeeStroops: bumpedFeeStroops,
      remainingDailyQuota: quota.remaining,
      signedFeeBumpXdr,
      submittedToNetwork: submitted,
      ledgerSeq,
    };
  }
}

export const stellarFeeBumpSponsorService = new StellarFeeBumpSponsorService();
