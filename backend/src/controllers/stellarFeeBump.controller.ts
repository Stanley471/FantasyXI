/**
 * Stellar Fee-Bump Sponsor Controller (Issue #549)
 *
 * Exposes POST /api/stellar/sponsor-fee and /api/v1/stellar/sponsor-fee to wrap
 * user-signed league deposit transactions into FeeBumpTransactions sponsored
 * by the platform keypair.
 */

import { Request, Response } from "express";
import { stellarFeeBumpSponsorService } from "../services/financial/stellarFeeBumpSponsorService.js";
import { logger } from "../config/logger.js";

export async function sponsorStellarFeeHandler(req: Request, res: Response): Promise<void> {
  const { innerTxXdr } = req.body;

  if (!innerTxXdr || typeof innerTxXdr !== "string") {
    res.status(400).json({
      success: false,
      error: "Missing required parameter 'innerTxXdr' (must be a valid base64 transaction envelope).",
    });
    return;
  }

  // Derive user identifier for daily rate limiting / quota tracking
  const userIdentifier =
    req.user?.id ||
    (typeof req.body.stellarAddress === "string" ? req.body.stellarAddress.trim() : null) ||
    req.ip ||
    "anonymous";

  const submitToNetwork =
    req.body.submitToNetwork !== undefined
      ? Boolean(req.body.submitToNetwork)
      : process.env.NODE_ENV !== "test";

  try {
    const result = await stellarFeeBumpSponsorService.sponsorAndBroadcast(
      innerTxXdr,
      userIdentifier,
      submitToNetwork
    );

    if (!result.success) {
      const isRateLimit = result.error?.includes("Daily sponsorship quota exceeded");
      const statusCode = isRateLimit ? 429 : 400;

      res.status(statusCode).json({
        success: false,
        error: result.error,
        remainingDailyQuota: result.remainingDailyQuota,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Transaction successfully sponsored and broadcast to Stellar network.",
      feeBumpTxHash: result.feeBumpTxHash,
      innerTxHash: result.innerTxHash,
      sponsoredFeeStroops: result.sponsoredFeeStroops,
      remainingDailyQuota: result.remainingDailyQuota,
      signedFeeBumpXdr: result.signedFeeBumpXdr,
      ledgerSeq: result.ledgerSeq,
    });
  } catch (err) {
    logger.error("[fee-bump-controller] Unexpected error sponsoring transaction:", err);
    res.status(500).json({
      success: false,
      error: (err as Error).message || "Internal server error sponsoring transaction.",
    });
  }
}
