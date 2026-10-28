import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { prisma } from "../config/db.js";
import {
  verifyDepositRangeProof,
  type RangeStatement,
} from "../services/financial/depositRangeProof.js";
import { canonicalizePayload, PersistentCryptoAuditLog } from "../services/audit/cryptoAuditLog.js";

const STROOPS_PER_UNIT = 10_000_000n;

/** Converts a 2-decimal USDC amount (Prisma Decimal / number / string) to stroops. */
export function toStroops(amount: { toString(): string }): bigint {
  const [whole, fraction = ""] = amount.toString().split(".");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0").slice(0, 7));
}

export interface DepositRangeProofOptions {
  db?: {
    league: {
      findUnique(args: {
        where: { id: string };
        select: { isPrivate: true; minBuyIn: true; maxBuyIn: true };
      }): Promise<{
        isPrivate: boolean;
        minBuyIn: { toString(): string } | null;
        maxBuyIn: { toString(): string } | null;
      } | null>;
    };
  };
  auditLog?: Pick<PersistentCryptoAuditLog, "append">;
}

/**
 * Private high-roller leagues with a buy-in range require each deposit to
 * carry a zero-knowledge range proof (`req.body.rangeProof`) that the
 * committed stake lies within [minBuyIn, maxBuyIn]. Leagues without a range
 * pass straight through.
 *
 * Every verification outcome is appended to the tamper-evident crypto audit
 * log with the commitment and a digest of the proof only — never an amount.
 */
export function requireDepositRangeProof(options: DepositRangeProofOptions = {}): RequestHandler {
  const db = options.db ?? (prisma as unknown as NonNullable<DepositRangeProofOptions["db"]>);
  const auditLog = options.auditLog ?? new PersistentCryptoAuditLog();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const leagueId = (req.params.leagueId || req.params.id) as string | undefined;
      const userId = req.user?.id;
      if (!leagueId || !userId) return next();

      const league = await db.league.findUnique({
        where: { id: leagueId },
        select: { isPrivate: true, minBuyIn: true, maxBuyIn: true },
      });
      if (!league?.isPrivate || league.minBuyIn === null || league.maxBuyIn === null) {
        return next();
      }

      const statement: RangeStatement = {
        min: toStroops(league.minBuyIn),
        max: toStroops(league.maxBuyIn),
        context: `${leagueId}:${userId}`,
      };
      const proof = req.body?.rangeProof;
      const result = verifyDepositRangeProof(proof, statement);

      await auditLog.append(
        result.valid ? "DEPOSIT_RANGE_PROOF_VERIFIED" : "DEPOSIT_RANGE_PROOF_REJECTED",
        userId,
        "League",
        leagueId,
        {
          commitment: result.valid ? result.commitment : null,
          proofDigest: createHash("sha256")
            .update(canonicalizePayload(proof ?? null))
            .digest("hex"),
          minStroops: statement.min.toString(),
          maxStroops: statement.max.toString(),
          ...(!result.valid && { reason: result.reason }),
        }
      );

      if (!result.valid) {
        res.status(422).json({
          success: false,
          message: "Deposit range proof verification failed",
          reason: result.reason,
        });
        return;
      }
      res.locals.depositCommitment = result.commitment;
      next();
    } catch (error) {
      next(error);
    }
  };
}
