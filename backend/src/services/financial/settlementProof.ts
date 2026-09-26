import { createHash } from "node:crypto";

export interface SettlementProofInput {
  leagueId: string;
  grossPool: number;
  platformFee: number;
  winners: Array<{
    rank: number;
    userId: string;
    stellarAddress: string;
    totalPoints: number;
    prizeAmount: number;
  }>;
}

/** Produces a stable SHA-256 commitment to the settlement calculation inputs. */
export function createSettlementProof(input: SettlementProofInput): string {
  const canonical = JSON.stringify({
    leagueId: input.leagueId,
    grossPool: input.grossPool,
    platformFee: input.platformFee,
    winners: [...input.winners]
      .sort((a, b) => a.rank - b.rank)
      .map((winner) => ({
        rank: winner.rank,
        userId: winner.userId,
        stellarAddress: winner.stellarAddress,
        totalPoints: winner.totalPoints,
        prizeAmount: winner.prizeAmount,
      })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
