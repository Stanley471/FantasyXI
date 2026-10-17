import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildPrizeMerkleTree,
  computeSorobanMerkleLeaf,
  createSettlementProof,
  verifyMerkleBranchProof,
} from "../services/financial/settlementProof.js";
import { getMerkleClaimProof } from "../controllers/financial.controller.js";

describe("Cryptographic Merkle-Tree Proof Generator (#258)", () => {
  it("computes deterministic 32-byte SHA-256 leaves for Soroban prize claims", () => {
    const winner = Keypair.random().publicKey();
    const leaf1 = computeSorobanMerkleLeaf(801, winner, 50_000_000n);
    const leaf2 = computeSorobanMerkleLeaf(801, winner, 50_000_000n);
    const diffAmountLeaf = computeSorobanMerkleLeaf(801, winner, 50_000_001n);
    const diffLeagueLeaf = computeSorobanMerkleLeaf(802, winner, 50_000_000n);

    assert.equal(leaf1.length, 32);
    assert.deepEqual(leaf1, leaf2);
    assert.notDeepEqual(leaf1, diffAmountLeaf);
    assert.notDeepEqual(leaf1, diffLeagueLeaf);
  });

  it("builds valid Merkle proofs and verifies every leaf across large leagues (100 winners)", () => {
    const winners = Array.from({ length: 100 }, (_, idx) => ({
      userId: `user-${idx + 1}`,
      rank: idx + 1,
      stellarAddress: Keypair.random().publicKey(),
      amountStroops: BigInt((100 - idx) * 1_000_000),
    }));

    const tree = buildPrizeMerkleTree(1024, winners);
    assert.match(tree.merkleRoot, /^[0-9a-f]{64}$/);
    assert.equal(tree.claims.length, 100);

    for (const claim of tree.claims) {
      const valid = verifyMerkleBranchProof(tree.merkleRoot, claim.leaf, claim.proof);
      assert.equal(valid, true, `Proof failed for rank ${claim.rank}`);

      // Lookup by winner address
      const lookedUp = tree.getProofForWinner(claim.stellarAddress);
      assert.ok(lookedUp);
      assert.equal(lookedUp.leaf, claim.leaf);
    }
  });

  it("rejects tampered winner addresses, forged amounts, and mutated sibling hashes", () => {
    const w1 = Keypair.random().publicKey();
    const w2 = Keypair.random().publicKey();
    const w3 = Keypair.random().publicKey();
    const attacker = Keypair.random().publicKey();

    const tree = buildPrizeMerkleTree(900, [
      { stellarAddress: w1, amountStroops: 60_000_000n },
      { stellarAddress: w2, amountStroops: 30_000_000n },
      { stellarAddress: w3, amountStroops: 10_000_000n },
    ]);

    const claim1 = tree.getProofForWinner(w1)!;
    assert.equal(verifyMerkleBranchProof(tree.merkleRoot, claim1.leaf, claim1.proof), true);

    // Tampered winner address
    const tamperedWinnerLeaf = computeSorobanMerkleLeaf(900, attacker, 60_000_000n).toString("hex");
    assert.equal(verifyMerkleBranchProof(tree.merkleRoot, tamperedWinnerLeaf, claim1.proof), false);

    // Forged amount
    const forgedAmountLeaf = computeSorobanMerkleLeaf(900, w1, 60_000_001n).toString("hex");
    assert.equal(verifyMerkleBranchProof(tree.merkleRoot, forgedAmountLeaf, claim1.proof), false);

    // Corrupted proof sibling
    const badProof = [...claim1.proof];
    badProof[0] = "f".repeat(64);
    assert.equal(verifyMerkleBranchProof(tree.merkleRoot, claim1.leaf, badProof), false);
  });

  it("serves Merkle proofs through the getMerkleClaimProof controller endpoint", async () => {
    const w1 = Keypair.random().publicKey();
    const w2 = Keypair.random().publicKey();

    let statusCode = 200;
    let responseBody: any = null;
    const req: any = {
      user: { id: "admin-1" },
      params: { leagueId: "555", address: w1 },
      query: {},
      body: {
        winners: [
          { userId: "u1", rank: 1, stellarAddress: w1, amountStroops: "70000000" },
          { userId: "u2", rank: 2, stellarAddress: w2, amountStroops: "30000000" },
        ],
      },
    };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        responseBody = payload;
        return this;
      },
    };

    await getMerkleClaimProof(req, res, (err) => {
      if (err) throw err;
    });

    assert.equal(statusCode, 200);
    assert.equal(responseBody.success, true);
    assert.equal(responseBody.data.claim.stellarAddress, w1);
    assert.equal(
      verifyMerkleBranchProof(
        responseBody.data.merkleRoot,
        responseBody.data.claim.leaf,
        responseBody.data.claim.proof
      ),
      true
    );

    // Preserve createSettlementProof backwards compatibility
    const legacyHash = createSettlementProof({
      leagueId: "555",
      grossPool: 100,
      platformFee: 5,
      winners: [
        { rank: 1, userId: "u1", stellarAddress: w1, totalPoints: 90, prizeAmount: 66.5 },
      ],
    });
    assert.match(legacyHash, /^[0-9a-f]{64}$/);
  });
});
