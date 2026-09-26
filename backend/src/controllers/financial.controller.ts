import { Request, Response, NextFunction } from "express";
import {
  financialService,
  FinancialValidationError,
  FinancialNotFoundError,
  FinancialForbiddenError,
  FinancialConflictError,
} from "../services/financial/financialService.js";

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

