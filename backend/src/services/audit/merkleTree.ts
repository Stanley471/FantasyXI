import crypto from "crypto";
import { canonicalizePayload } from "./cryptoAuditLog.js";

export interface MerkleProofStep {
  position: "left" | "right";
  data: string; // hex hash
}

/**
 * Computes SHA-256 hash formatted as hex string.
 */
export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministically hashes a leaf event using canonical JSON representation.
 */
export function hashEventLeaf(event: Record<string, unknown>): string {
  const canonical = canonicalizePayload(event);
  return sha256(`LEAF:${canonical}`);
}

/**
 * Combines two node hashes into a parent node hash.
 */
export function combineHashes(left: string, right: string): string {
  return sha256(`NODE:${left}:${right}`);
}

export class MerkleTree {
  private leaves: string[];
  private layers: string[][] = [];

  constructor(leaves: string[]) {
    this.leaves = leaves.length > 0 ? [...leaves] : [sha256("EMPTY_TREE")];
    this.buildTree();
  }

  private buildTree(): void {
    this.layers = [this.leaves];
    let currentLayer = this.leaves;

    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        // If odd number of nodes, duplicate the last node
        const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : left;
        nextLayer.push(combineHashes(left, right));
      }
      this.layers.push(nextLayer);
      currentLayer = nextLayer;
    }
  }

  public getRoot(): string {
    const topLayer = this.layers[this.layers.length - 1];
    return topLayer && topLayer.length > 0 ? topLayer[0] : sha256("EMPTY_TREE");
  }

  public getLeaves(): string[] {
    return [...this.leaves];
  }

  public getLayers(): string[][] {
    return this.layers.map((l) => [...l]);
  }

  /**
   * Generates a Merkle inclusion proof for the leaf at `index`.
   */
  public getProof(index: number): MerkleProofStep[] {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Leaf index ${index} out of bounds (total leaves: ${this.leaves.length})`);
    }

    const proof: MerkleProofStep[] = [];
    let currentIndex = index;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const currentLayer = this.layers[i];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < currentLayer.length) {
        proof.push({
          position: isRightNode ? "left" : "right",
          data: currentLayer[siblingIndex],
        });
      } else {
        // Odd element at edge was duplicated with itself
        proof.push({
          position: "right",
          data: currentLayer[currentIndex],
        });
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Cryptographically verifies that `leaf` belongs to a tree with `root` using `proof`.
   */
  public static verifyProof(leaf: string, proof: MerkleProofStep[], root: string): boolean {
    let currentHash = leaf;

    for (const step of proof) {
      if (step.position === "left") {
        currentHash = combineHashes(step.data, currentHash);
      } else {
        currentHash = combineHashes(currentHash, step.data);
      }
    }

    return currentHash === root;
  }
}
