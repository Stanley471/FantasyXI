import { createHash } from "node:crypto";
import {
  generateLeagueMerkleTree,
  hashClaimLeaf,
  verifyMerkleProof,
  type MerkleClaimProof,
  type WinnerClaimItem,
} from "./merkleTree.js";

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

/**
 * Builds a cryptographic Merkle tree for large-league prize claims, returning
 * the 32-byte Merkle root hex and per-winner claim branch proofs.
 */
export function createSettlementMerkleTree(input: SettlementProofInput): {
  merkleRoot: string;
  claimProofs: Map<string, MerkleClaimProof>;
} {
  const claimItems: WinnerClaimItem[] = input.winners.map((w) => ({
    winnerAddress: w.stellarAddress,
    amount: Math.round(w.prizeAmount * 10_000_000), // convert USDC to stroops (7 decimals)
  }));

  const { rootHex, claimProofs } = generateLeagueMerkleTree(
    input.leagueId,
    claimItems
  );

  return { merkleRoot: rootHex, claimProofs };
}

export { generateLeagueMerkleTree, hashClaimLeaf, verifyMerkleProof };
