import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db.js";
import { claimDepositRefund, depositRefundChallenge, DepositRefundClaimError } from "../services/financial/depositRefundService.js";

export async function getMyDepositExceptions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { wallet: true, memberships: { select: { stellarAddress: true } } },
    });
    const addresses = [user?.wallet?.stellarAddress, ...(user?.memberships.map((membership) => membership.stellarAddress) ?? [])]
      .filter((address): address is string => Boolean(address));
    if (addresses.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }
    const exceptions = await prisma.depositException.findMany({
      where: { senderAddress: { in: addresses } },
      include: { claim: { select: { status: true, refundTxHash: true, requestedAt: true, completedAt: true } } },
      orderBy: { detectedAt: "desc" },
    });
    res.json({ success: true, data: exceptions });
  } catch (error) {
    next(error);
  }
}

export async function getDepositRefundChallenge(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const exception = await prisma.depositException.findUnique({ where: { txHash: req.params.txHash as string } });
    if (!exception) {
      res.status(404).json({ success: false, message: "Deposit exception not found" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { wallet: true, memberships: { select: { stellarAddress: true } } },
    });
    const addresses = [user?.wallet?.stellarAddress, ...(user?.memberships.map((membership) => membership.stellarAddress) ?? [])];
    if (!addresses.includes(exception.senderAddress)) {
      res.status(403).json({ success: false, message: "The authenticated user does not own the deposit wallet" });
      return;
    }
    res.json({
      success: true,
      data: {
        txHash: exception.txHash,
        senderAddress: exception.senderAddress,
        message: depositRefundChallenge(exception.id, exception.txHash, req.user.id),
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function submitDepositRefundClaim(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const { txHash, publicKey, signature } = req.body;
    if (typeof txHash !== "string" || typeof publicKey !== "string" || typeof signature !== "string") {
      res.status(400).json({ success: false, message: "txHash, publicKey, and signature are required" });
      return;
    }
    const claim = await claimDepositRefund(req.user.id, txHash, publicKey, signature);
    res.status(201).json({ success: true, message: "Deposit refund completed", data: claim });
  } catch (error) {
    if (error instanceof DepositRefundClaimError) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
}
