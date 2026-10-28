/**
 * Cryptographic Merkle Tree Generator and Verifier for Large-League Soroban Prize Claims
 *
 * Implements standard SHA-256 binary Merkle tree calculation compatible with Soroban crypto primitives (env.crypto().sha256).
 * Leaves commit deterministically to (league_id, winner_address, amount_stroops).
 *
 * Complexity:
 * - Build Tree: O(N) time, O(N) space
 * - Generate Proof: O(log N) time, O(log N) space
 * - Verify Proof: O(log N) time, O(1) space
 */

import { createHash } from "node:crypto";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";

export interface WinnerClaimItem {
  winnerAddress: string;
  amount: bigint | string | number; // atomic units (stroops)
}

export interface MerkleClaimProof {
  leagueId: string | number;
  winnerAddress: string;
  amount: string; // stroops as string
  proof: string[]; // 32-byte hex hashes
  root: string; // 32-byte hex hash
}

/**
 * Computes canonical leaf hash for a claim:
 * sha256( league_id.to_xdr() + winner.to_xdr() + amount.to_xdr() )
 */
export function hashClaimLeaf(
  leagueId: string | number,
  winnerAddress: string,
  amount: bigint | string | number
): Buffer {
  const leagueIdBigInt = BigInt(leagueId);
  const amountBigInt = BigInt(amount);

  const leagueVal = nativeToScVal(leagueIdBigInt, { type: "u64" });
  const addrVal = nativeToScVal(Address.fromString(winnerAddress), { type: "address" });
  const amountVal = nativeToScVal(amountBigInt, { type: "i128" });

  const leafBytes = Buffer.concat([
    leagueVal.toXDR(),
    addrVal.toXDR(),
    amountVal.toXDR(),
  ]);

  return createHash("sha256").update(leafBytes).digest();
}

/**
 * Computes sorted parent hash for two sibling 32-byte hashes:
 * if (left <= right) sha256(left + right) else sha256(right + left)
 */
export function hashPair(left: Buffer, right: Buffer): Buffer {
  const sorted =
    Buffer.compare(left, right) <= 0
      ? Buffer.concat([left, right])
      : Buffer.concat([right, left]);
  return createHash("sha256").update(sorted).digest();
}

export class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(leaves: Buffer[]) {
    if (leaves.length === 0) {
      throw new Error("Cannot construct Merkle tree with 0 leaves");
    }
    this.leaves = leaves.map((l) => Buffer.from(l));
    this.layers = [this.leaves];
    this.buildTree();
  }

  private buildTree(): void {
    let current = this.leaves;
    while (current.length > 1) {
      const nextLevel: Buffer[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          nextLevel.push(hashPair(current[i], current[i + 1]));
        } else {
          // If odd number of nodes, pair with itself to ensure binary balance
          nextLevel.push(hashPair(current[i], current[i]));
        }
      }
      this.layers.push(nextLevel);
      current = nextLevel;
    }
  }

  public getRoot(): Buffer {
    return this.layers[this.layers.length - 1][0];
  }

  public getRootHex(): string {
    return this.getRoot().toString("hex");
  }

  /**
   * Generates Merkle branch proof for a leaf at index `leafIndex`.
   */
  public getProof(leafIndex: number): string[] {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of bounds (0..${this.leaves.length - 1})`);
    }

    const proof: string[] = [];
    let idx = leafIndex;

    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level];
      const isRightNode = idx % 2 === 1;
      const siblingIdx = isRightNode ? idx - 1 : idx + 1;

      if (siblingIdx < layer.length) {
        proof.push(layer[siblingIdx].toString("hex"));
      } else {
        // Paired with self
        proof.push(layer[idx].toString("hex"));
      }
      idx = Math.floor(idx / 2);
    }

    return proof;
  }
}

/**
 * Builds a Merkle tree from winner claims and generates all proofs.
 */
export function generateLeagueMerkleTree(
  leagueId: string | number,
  winners: WinnerClaimItem[]
): {
  tree: MerkleTree;
  rootHex: string;
  claimProofs: Map<string, MerkleClaimProof>;
} {
  if (winners.length === 0) {
    throw new Error("Cannot generate Merkle tree for empty winner list");
  }

  const leaves = winners.map((w) =>
    hashClaimLeaf(leagueId, w.winnerAddress, w.amount)
  );

  const tree = new MerkleTree(leaves);
  const rootHex = tree.getRootHex();
  const claimProofs = new Map<string, MerkleClaimProof>();

  winners.forEach((w, idx) => {
    claimProofs.set(w.winnerAddress, {
      leagueId,
      winnerAddress: w.winnerAddress,
      amount: BigInt(w.amount).toString(),
      proof: tree.getProof(idx),
      root: rootHex,
    });
  });

  return { tree, rootHex, claimProofs };
}

/**
 * Verifies a Merkle proof off-chain.
 */
export function verifyMerkleProof(
  leafHash: Buffer,
  proof: (Buffer | string)[],
  expectedRoot: Buffer | string
): boolean {
  let current: Buffer = Buffer.from(leafHash);
  const rootBuf = typeof expectedRoot === "string" ? Buffer.from(expectedRoot, "hex") : expectedRoot;

  for (const item of proof) {
    const siblingBuf = typeof item === "string" ? Buffer.from(item, "hex") : item;
    current = hashPair(current, siblingBuf);
  }

  return current.equals(rootBuf);
}
