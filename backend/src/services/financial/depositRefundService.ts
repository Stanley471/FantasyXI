import { Keypair } from "@stellar/stellar-sdk";
import { prisma } from "../../config/db.js";
import { stellarService } from "./stellarService.js";

export class DepositRefundClaimError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "DepositRefundClaimError";
  }
}

export function depositRefundChallenge(exceptionId: string, txHash: string, userId: string): string {
  return `FantasyXI deposit refund v1\nexception:${exceptionId}\ntransaction:${txHash}\nuser:${userId}`;
}

/** Verify wallet ownership, atomically claim the exception, and refund one deposit on Soroban. */
export async function claimDepositRefund(
  userId: string,
  txHash: string,
  publicKey: string,
  signature: string
) {
  const exception = await prisma.depositException.findUnique({
    where: { txHash },
    include: { claim: true },
  });
  if (!exception) throw new DepositRefundClaimError("Deposit exception not found", 404);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { wallet: true, memberships: { select: { stellarAddress: true } } },
  });
  if (!user) throw new DepositRefundClaimError("User not found", 404);
  const verifiedAddresses = new Set([
    user.wallet?.stellarAddress,
    ...user.memberships.map((membership) => membership.stellarAddress),
  ].filter((address): address is string => Boolean(address)));
  if (publicKey !== exception.senderAddress || !verifiedAddresses.has(publicKey)) {
    throw new DepositRefundClaimError("The authenticated user must own the wallet that sent this deposit", 403);
  }

  let verified = false;
  try {
    const signatureBytes = Buffer.from(signature, "base64");
    if (signatureBytes.length === 64 && signatureBytes.toString("base64") === signature) {
      verified = Keypair.fromPublicKey(publicKey).verify(
        Buffer.from(depositRefundChallenge(exception.id, txHash, userId), "utf8"),
        signatureBytes
      );
    }
  } catch {
    verified = false;
  }
  if (!verified) throw new DepositRefundClaimError("Wallet signature is invalid", 400);

  let claimId: string;
  if (exception.claim) {
    if (exception.claim.status === "PAID" || exception.claim.status === "PROCESSING") {
      throw new DepositRefundClaimError("A refund claim already exists for this deposit", 409);
    }
    const retry = await prisma.depositRefundClaim.updateMany({
      where: { id: exception.claim.id, status: "FAILED" },
      data: { status: "PROCESSING", signature, requestedAt: new Date() },
    });
    if (retry.count !== 1) throw new DepositRefundClaimError("A refund claim is already being processed", 409);
    claimId = exception.claim.id;
  } else {
    const claim = await prisma.depositRefundClaim.create({
      data: { exceptionId: exception.id, userId, senderAddress: publicKey, signature, status: "PROCESSING" },
    }).catch((error: { code?: string }) => {
      if (error?.code === "P2002") {
        throw new DepositRefundClaimError("A refund claim already exists for this deposit", 409);
      }
      throw error;
    });
    claimId = claim.id;
  }

  try {
    const payout = await stellarService.refundDeposit(BigInt(exception.contractLeagueId), exception.senderAddress);
    if (!payout.success || !payout.txHash) {
      throw new Error(payout.error || "Soroban did not confirm the refund transaction");
    }
    return await prisma.depositRefundClaim.update({
      where: { id: claimId },
      data: { status: "PAID", refundTxHash: payout.txHash, completedAt: new Date() },
    });
  } catch (error) {
    await prisma.depositRefundClaim.updateMany({
      where: { id: claimId, status: "PROCESSING" },
      data: { status: "FAILED" },
    });
    throw new DepositRefundClaimError((error as Error).message || "Refund payout failed", 502);
  }
}
