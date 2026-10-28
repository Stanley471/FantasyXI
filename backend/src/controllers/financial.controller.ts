import { Request, Response, NextFunction } from "express";
import {
  financialService,
  FinancialValidationError,
  FinancialNotFoundError,
  FinancialForbiddenError,
  FinancialConflictError,
} from "../services/financial/financialService.js";
import { proofOfReserveService } from "../services/financial/proofOfReserveService.js";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";

/**
 * Financial Controller — Stellar Escrow & Payment Endpoints
 *
 * Laravel equivalent: app/Http/Controllers/FinancialController.php.
 * Coordinates payment requirement generation, transaction hash submission,
 * on-chain verification, and settlement manifests.
 */

export async function getPaymentRequirement(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const squadId = (req.query.squadId as string) || req.body.squadId;

    if (!squadId) {
      res.status(400).json({
        success: false,
        message: "A valid squadId is required to generate payment requirements",
      });
      return;
    }

    const requirement = await financialService.createPaymentRequirement(
      req.user.id,
      leagueId,
      squadId
    );

    res.status(200).json({
      success: true,
      data: requirement,
    });
  } catch (error) {
    if (error instanceof FinancialValidationError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

/** Read-only fee and footprint simulation for a Soroban league deposit. */
export async function simulateDeposit(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user?.id) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }

  const { publicKey, leagueId } = req.body ?? {};
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    res.status(400).json({ success: false, message: "A Stellar publicKey is required." });
    return;
  }
  if (
    (typeof leagueId !== "string" && typeof leagueId !== "number") ||
    String(leagueId).trim() === ""
  ) {
    res.status(400).json({ success: false, message: "A valid leagueId is required." });
    return;
  }

  try {
    const result = await new SorobanContractClient().simulateDepositTransaction(
      publicKey.trim(),
      leagueId
    );
    if (result.success) {
      res.status(200).json(result);
      return;
    }

    const isInputError = /valid Stellar public key|valid league ID/i.test(result.error);
    res.status(isInputError ? 400 : 422).json({ success: false, message: result.error });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown configuration error";
    res.status(503).json({
      success: false,
      message: `Deposit simulation is unavailable: ${message}`,
    });
  }
}

export async function submitPayment(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const { stellarTxHash, stellarAddress } = req.body;

    if (!stellarTxHash || !stellarAddress) {
      res.status(400).json({
        success: false,
        message: "Both stellarTxHash and stellarAddress are required",
      });
      return;
    }

    const result = await financialService.submitPayment(req.user.id, leagueId, {
      stellarTxHash,
      stellarAddress,
    });

    res.status(200).json({
      success: true,
      message: "Payment submitted successfully and queued for confirmation",
      data: result,
    });
  } catch (error) {
    if (error instanceof FinancialValidationError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialConflictError) {
      res.status(409).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

export async function verifyPayment(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const { stellarTxHash } = req.body;

    if (!stellarTxHash) {
      res.status(400).json({
        success: false,
        message: "stellarTxHash is required for verification",
      });
      return;
    }

    const verification = await financialService.verifyAndConfirmPayment(
      req.user.id,
      leagueId,
      stellarTxHash
    );

    if (!verification.success) {
      res.status(422).json({
        success: false,
        message: verification.error || "Payment verification failed",
        data: verification,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Payment verified successfully. Membership activated!",
      data: verification,
    });
  } catch (error) {
    if (error instanceof FinancialValidationError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

export async function reconcileDeposit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const result = await financialService.reconcileDeposit(req.user.id, leagueId);

    if (!result.success) {
      res.status(422).json({
        success: false,
        message: result.error || "No confirmed on-chain deposit was found",
        data: result,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Deposit reconciled from the Soroban escrow contract. Membership activated!",
      data: result,
    });
  } catch (error) {
    if (error instanceof FinancialValidationError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

export async function getSettlementPlan(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const plan = await financialService.prepareSettlement(
      leagueId,
      req.user.id
    );

    res.status(200).json({
      success: true,
      data: plan,
    });
  } catch (error) {
    if (error instanceof FinancialForbiddenError) {
      res.status(403).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

export async function executeSettlement(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const result = await financialService.executeSettlement(leagueId, req.user.id);
    res.status(200).json({
      success: true,
      message: "League settlement executed and confirmed",
      data: result,
    });
  } catch (error) {
    if (error instanceof FinancialValidationError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialForbiddenError) {
      res.status(403).json({ success: false, message: error.message });
      return;
    }
    if (error instanceof FinancialConflictError) {
      res.status(409).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

export async function reconcileLeague(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const leagueId = (req.params.leagueId || req.params.id) as string;
    const report = await financialService.reconcileLeague(leagueId);

    res.status(200).json({
      success: true,
      data: report,
    });
  } catch (error) {
    if (error instanceof FinancialNotFoundError) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}

import { ReferralService } from "../services/auth/referralService.js";

export async function getAffiliateDashboard(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const data = await ReferralService.getAffiliateDashboard(req.user.id);
    res.json({
      success: true,
      data,
    });
  } catch (error) {
    next(error);
  }
}


/**
 * Public proof-of-reserve snapshot: Merkle roots of the ledger and on-chain
 * deposit commitments, total liabilities and the escrow's token reserve.
 */
export async function getProofOfReserve(_req: Request, res: Response): Promise<void> {
  const snapshot = proofOfReserveService.getPublicSnapshot();
  if (!snapshot) {
    res.status(503).json({ success: false, message: "No proof-of-reserve snapshot has been generated yet" });
    return;
  }
  res.status(200).json({ success: true, data: snapshot });
}

import { SorobanStateArchivalRecoveryService } from "../services/financial/sorobanStateArchivalRecovery.js";
import { disputeService } from "../services/financial/disputeService.js";
import { createSettlementMerkleTree } from "../services/financial/settlementProof.js";

const storageRecoveryService = new SorobanStateArchivalRecoveryService();

export async function getStorageRentStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const contractIds = req.query.contractId
      ? [req.query.contractId as string]
      : [];
    const inspection = await storageRecoveryService.inspectContractEntries(contractIds);
    const rentReserves = await storageRecoveryService.inspectRentReserves(
      contractIds.length > 0
        ? contractIds
        : [process.env.STELLAR_ESCROW_CONTRACT_ID || ""]
    );
    res.json({
      success: true,
      data: {
        currentLedger: inspection.currentLedger,
        entries: inspection.entries,
        rentReserves,
        thresholds: {
          warnThresholdLedgers: storageRecoveryService.warnThresholdLedgers,
          restoreThresholdLedgers: storageRecoveryService.restoreThresholdLedgers,
          extendTtlLedgers: storageRecoveryService.extendTtlLedgers,
          minSafeBalanceStroops: storageRecoveryService.minSafeBalanceStroops.toString(),
        },
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function triggerStorageRentRecovery(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const adminSecret =
      process.env.STELLAR_ADMIN_SECRET || (req.body.adminSecret as string);
    if (!adminSecret) {
      res.status(400).json({
        success: false,
        message: "No admin signing secret available to execute state recovery.",
      });
      return;
    }
    const contractIds = req.body.contractIds || [];
    const report = await storageRecoveryService.runRecoveryCycle(
      adminSecret,
      contractIds
    );
    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    next(error);
  }
}

export async function fileDisputeHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = (req.params.leagueId || req.params.id) as string;
    const { claimantAddress, reason, evidenceUrl } = req.body;

    if (!claimantAddress || !reason) {
      res.status(400).json({
        success: false,
        message: "claimantAddress and reason are required to file a dispute",
      });
      return;
    }

    const dispute = await disputeService.fileDispute({
      leagueId,
      claimantAddress,
      reason,
      evidenceUrl,
      autoFreeze: req.body.autoFreeze !== false,
    });

    res.status(201).json({
      success: true,
      data: dispute,
    });
  } catch (error) {
    next(error);
  }
}

export async function getLeagueDisputesHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = (req.params.leagueId || req.params.id) as string;
    const disputes = await disputeService.getDisputesForLeague(leagueId);

    res.status(200).json({
      success: true,
      data: disputes,
    });
  } catch (error) {
    next(error);
  }
}

export async function addEvidenceHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { disputeId } = req.params;
    const { submittedBy, description, evidenceUrl } = req.body;

    if (!submittedBy || !description) {
      res.status(400).json({
        success: false,
        message: "submittedBy and description are required",
      });
      return;
    }

    const updated = await disputeService.addEvidence(disputeId as string, {
      submittedBy,
      description,
      evidenceUrl,
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

export async function resolveDisputePayoutHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { disputeId } = req.params;
    const { winners, platformTreasury, platformFeeStroops, notes } = req.body;

    if (!winners || !Array.isArray(winners) || !platformTreasury) {
      res.status(400).json({
        success: false,
        message: "winners array and platformTreasury are required",
      });
      return;
    }

    const updated = await disputeService.resolveWithPayout(disputeId as string, {
      winners,
      platformTreasury,
      platformFeeStroops: BigInt(platformFeeStroops ?? "0"),
      notes,
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

export async function resolveDisputeRefundHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { disputeId } = req.params;
    const { participants, notes } = req.body;

    if (!participants || !Array.isArray(participants)) {
      res.status(400).json({
        success: false,
        message: "participants array is required",
      });
      return;
    }

    const updated = await disputeService.resolveWithRefund(disputeId as string, {
      participants,
      notes,
    });

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

export async function rejectDisputeHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { disputeId } = req.params;
    const { notes } = req.body;

    const updated = await disputeService.rejectDispute(disputeId as string, notes || "Dispute rejected by administrator");

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
}

export async function executeMerkleSettlementHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = (req.params.leagueId || req.params.id) as string;
    const plan = await financialService.prepareSettlement(leagueId);

    const merkleResult = createSettlementMerkleTree({
      leagueId,
      grossPool: plan.grossPool,
      platformFee: plan.platformFee,
      winners: plan.winners.map((w: any) => ({
        rank: w.rank,
        userId: w.userId,
        stellarAddress: w.stellarAddress,
        totalPoints: w.totalPoints,
        prizeAmount: w.prizeAmount,
      })),
    });

    res.status(200).json({
      success: true,
      data: {
        leagueId,
        merkleRoot: merkleResult.merkleRoot,
        totalWinners: merkleResult.claimProofs.size,
      },
    });
  } catch (error) {
    next(error);
  }
}
