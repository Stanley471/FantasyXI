import { createHash } from "node:crypto";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";

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

export interface MerkleWinnerClaimInput {
  userId?: string;
  rank?: number;
  stellarAddress: string;
  amountStroops: bigint | number | string;
}

export interface MerkleWinnerProof {
  userId?: string;
  rank?: number;
  stellarAddress: string;
  amountStroops: string;
  leaf: string;
  proof: string[];
}

export interface MerkleSettlementTree {
  leagueId: string;
  merkleRoot: string;
  leaves: string[];
  claims: MerkleWinnerProof[];
  getProofForWinner: (stellarAddress: string) => MerkleWinnerProof | undefined;
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

function encodeLeagueIdXdrOrBytes(leagueId: string | number | bigint): Buffer {
  try {
    const numericId =
      typeof leagueId === "bigint"
        ? leagueId
        : typeof leagueId === "number"
          ? BigInt(leagueId)
          : /^\d+$/.test(leagueId)
            ? BigInt(leagueId)
            : null;
    if (numericId !== null && numericId >= 0n) {
      return Buffer.from(nativeToScVal(numericId, { type: "u64" }).toXDR());
    }
  } catch {
    // Fall back to deterministic UTF-8 encoding for non-u64 UUID league IDs
  }
  return Buffer.from(String(leagueId), "utf8");
}

function encodeAddressXdrOrBytes(stellarAddress: string): Buffer {
  try {
    return Buffer.from(new Address(stellarAddress).toScVal().toXDR());
  } catch {
    return Buffer.from(stellarAddress, "utf8");
  }
}

function encodeAmountI128Xdr(amountStroops: bigint | number | string): Buffer {
  const val = BigInt(amountStroops);
  return Buffer.from(nativeToScVal(val, { type: "i128" }).toXDR());
}

/**
 * Computes a 32-byte SHA-256 Merkle leaf compatible with `FantasyXIEscrow::compute_merkle_leaf`
 * (`SHA-256(league_id.to_xdr() || winner.to_xdr() || amount.to_xdr())`).
 */
export function computeSorobanMerkleLeaf(
  leagueId: string | number | bigint,
  stellarAddress: string,
  amountStroops: bigint | number | string
): Buffer {
  const payload = Buffer.concat([
    encodeLeagueIdXdrOrBytes(leagueId),
    encodeAddressXdrOrBytes(stellarAddress),
    encodeAmountI128Xdr(amountStroops),
  ]);
  return createHash("sha256").update(payload).digest();
}

/**
 * Computes a sorted-pair SHA-256 parent node from two 32-byte child hashes,
 * matching `FantasyXIEscrow::hash_merkle_pair`.
 */
export function hashMerklePair(a: Buffer, b: Buffer): Buffer {
  const combined = Buffer.compare(a, b) <= 0 ? Buffer.concat([a, b]) : Buffer.concat([b, a]);
  return createHash("sha256").update(combined).digest();
}

/**
 * Verifies a hex-encoded Merkle branch proof against `merkleRootHex` and `leafHex`.
 */
export function verifyMerkleBranchProof(
  merkleRootHex: string,
  leafHex: string,
  proofHex: string[]
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(merkleRootHex) || !/^[0-9a-f]{64}$/i.test(leafHex)) {
    return false;
  }
  let current: Buffer = Buffer.from(leafHex, "hex");
  for (const siblingHex of proofHex) {
    if (!/^[0-9a-f]{64}$/i.test(siblingHex)) {
      return false;
    }
    const sibling = Buffer.from(siblingHex, "hex");
    current = hashMerklePair(current, sibling);
  }
  return current.toString("hex").toLowerCase() === merkleRootHex.toLowerCase();
}

/**
 * Builds a cryptographic SHA-256 Merkle tree and per-winner branch proofs
 * for large-league Soroban prize distributions.
 */
export function buildPrizeMerkleTree(
  leagueId: string | number | bigint,
  winners: MerkleWinnerClaimInput[]
): MerkleSettlementTree {
  if (!winners || winners.length === 0) {
    throw new Error("Cannot build prize Merkle tree with zero winners");
  }

  const normalized = winners.map((w) => {
    const amount = BigInt(w.amountStroops);
    if (amount <= 0n) {
      throw new Error(`Invalid prize amount for winner ${w.stellarAddress}: must be positive`);
    }
    const leafBuf = computeSorobanMerkleLeaf(leagueId, w.stellarAddress, amount);
    return {
      userId: w.userId,
      rank: w.rank,
      stellarAddress: w.stellarAddress,
      amountStroops: amount.toString(),
      leafBuf,
      leafHex: leafBuf.toString("hex"),
    };
  });

  const n = normalized.length;
  const proofs: string[][] = Array.from({ length: n }, () => []);
  let currentLayer: Buffer[] = normalized.map((item) => item.leafBuf);
  const positions: number[] = normalized.map((_, idx) => idx);

  while (currentLayer.length > 1) {
    const len = currentLayer.length;
    const nextLayer: Buffer[] = [];

    for (let leafIdx = 0; leafIdx < n; leafIdx++) {
      const pos = positions[leafIdx];
      const siblingPos = pos % 2 === 0 ? (pos + 1 < len ? pos + 1 : pos) : pos - 1;
      proofs[leafIdx].push(currentLayer[siblingPos].toString("hex"));
      positions[leafIdx] = Math.floor(pos / 2);
    }

    for (let i = 0; i < len; i += 2) {
      const left = currentLayer[i];
      const right = i + 1 < len ? currentLayer[i + 1] : currentLayer[i];
      nextLayer.push(hashMerklePair(left, right));
    }

    currentLayer = nextLayer;
  }

  const merkleRoot = currentLayer[0].toString("hex");
  const claims: MerkleWinnerProof[] = normalized.map((item, idx) => ({
    userId: item.userId,
    rank: item.rank,
    stellarAddress: item.stellarAddress,
    amountStroops: item.amountStroops,
    leaf: item.leafHex,
    proof: proofs[idx],
  }));

  const byAddress = new Map<string, MerkleWinnerProof>();
  for (const claim of claims) {
    byAddress.set(claim.stellarAddress, claim);
  }

  return {
    leagueId: String(leagueId),
    merkleRoot,
    leaves: normalized.map((item) => item.leafHex),
    claims,
    getProofForWinner: (stellarAddress: string) => byAddress.get(stellarAddress),
  };
}
