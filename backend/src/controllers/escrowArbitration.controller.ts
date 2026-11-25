import type { Request, Response, NextFunction } from "express";
import {
  escrowArbitrationService,
  type ArbitrationRole,
  type ParticipantDeposit,
} from "../services/financial/escrowArbitrationService.js";

function sanitizeProposal(proposal: ReturnType<typeof escrowArbitrationService.getProposal>) {
  if (!proposal) return null;
  return {
    ...proposal,
    contractLeagueId: proposal.contractLeagueId.toString(),
    onChainProposalId: proposal.onChainProposalId?.toString(),
    participants: proposal.participants.map((p) => ({
      address: p.address,
      amountStroops: p.amountStroops.toString(),
    })),
    signatures: proposal.signatures.map(({ signerSecret: _secret, ...rest }) => rest),
  };
}

export async function inspectLeagueDisputeArbitrationHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = String(req.params.leagueId || "");
    if (!leagueId) {
      res.status(400).json({ success: false, message: "leagueId is required" });
      return;
    }

    const escrowState = escrowArbitrationService.getLeagueEscrowState(leagueId);
    const proposals = escrowArbitrationService
      .getProposalsForLeague(leagueId)
      .map((p) => sanitizeProposal(p));
    const auditTrail = escrowArbitrationService.getAuditTrail(leagueId);

    res.status(200).json({
      success: true,
      data: {
        leagueId,
        escrowState,
        proposals,
        auditTrail,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function inspectRefundProposalHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const proposalId = String(req.params.proposalId || "");
    const proposal = escrowArbitrationService.getProposal(proposalId);
    if (!proposal) {
      res.status(404).json({ success: false, message: "Refund proposal not found" });
      return;
    }

    const auditTrail = escrowArbitrationService
      .getAuditTrail(proposal.leagueId)
      .filter((entry) => entry.proposalId === proposalId);

    res.status(200).json({
      success: true,
      data: {
        proposal: sanitizeProposal(proposal),
        auditTrail,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function initiateRefundProposalHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const leagueId = String(req.params.leagueId || "");
    const { reason, participants, threshold, lockWindowMs } = req.body ?? {};
    const operatorId = req.user?.id || "unknown-operator";

    if (!leagueId || !reason || !Array.isArray(participants) || participants.length === 0) {
      res.status(400).json({
        success: false,
        message: "leagueId, reason, and non-empty participants array are required",
      });
      return;
    }

    const parsedParticipants: ParticipantDeposit[] = participants.map(
      (p: { address: string; amountStroops: string | number | bigint }) => ({
        address: String(p.address),
        amountStroops: BigInt(p.amountStroops),
      })
    );

    const proposal = escrowArbitrationService.initiateRefundProposal({
      leagueId,
      reason: String(reason),
      participants: parsedParticipants,
      operatorId,
      threshold: threshold !== undefined ? Number(threshold) : undefined,
      lockWindowMs: lockWindowMs !== undefined ? Number(lockWindowMs) : undefined,
    });

    res.status(201).json({
      success: true,
      data: sanitizeProposal(proposal),
    });
  } catch (err) {
    next(err);
  }
}

export async function signRefundProposalHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const proposalId = String(req.params.proposalId || "");
    const { signerPublicKey, signerSecret, signatureHex, role } = req.body ?? {};
    const operatorId = req.user?.id || "unknown-operator";

    if (!proposalId || !signerPublicKey || !role) {
      res.status(400).json({
        success: false,
        message: "proposalId, signerPublicKey, and role are required",
      });
      return;
    }

    const proposal = escrowArbitrationService.collectSignature(proposalId, {
      signerPublicKey: String(signerPublicKey),
      signerSecret: signerSecret ? String(signerSecret) : undefined,
      signatureHex: signatureHex ? String(signatureHex) : undefined,
      operatorId,
      role: role as ArbitrationRole,
    });

    res.status(200).json({
      success: true,
      data: sanitizeProposal(proposal),
    });
  } catch (err) {
    next(err);
  }
}

export async function broadcastRefundProposalHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const proposalId = String(req.params.proposalId || "");
    const operatorId = req.user?.id || "unknown-operator";
    const proposal = await escrowArbitrationService.broadcastRefundProposal(
      proposalId,
      operatorId
    );
    res.status(200).json({
      success: true,
      data: sanitizeProposal(proposal),
    });
  } catch (err) {
    next(err);
  }
}

export async function processDisputeTimeoutsHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const operatorId = req.user?.id || "system:timeout-arbiter";
    const transitioned = await escrowArbitrationService.processExpiredDisputes(
      new Date(),
      operatorId
    );
    res.status(200).json({
      success: true,
      data: transitioned.map((p) => sanitizeProposal(p)),
    });
  } catch (err) {
    next(err);
  }
}
