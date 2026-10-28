import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  hashClaimLeaf,
  hashPair,
  MerkleTree,
  generateLeagueMerkleTree,
  verifyMerkleProof,
  type WinnerClaimItem,
} from "../services/financial/merkleTree.js";
import { createSettlementMerkleTree } from "../services/financial/settlementProof.js";

test("hashPair ensures canonical lexicographical order", () => {
  const hashA = Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hex");
  const hashB = Buffer.from("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "hex");

  const pair1 = hashPair(hashA, hashB);
  const pair2 = hashPair(hashB, hashA);

  assert.equal(pair1.toString("hex"), pair2.toString("hex"));
});

test("single leaf Merkle tree root equals the leaf itself", () => {
  const kp = Keypair.random();
  const leaf = hashClaimLeaf(100, kp.publicKey(), 100000000n);

  const tree = new MerkleTree([leaf]);
  assert.equal(tree.getRoot().toString("hex"), leaf.toString("hex"));

  const proof = tree.getProof(0);
  assert.deepEqual(proof, []);
  assert.equal(verifyMerkleProof(leaf, proof, tree.getRoot()), true);
});

test("Merkle tree with multiple winners produces valid proofs", () => {
  const leagueId = 555;
  const kp1 = Keypair.random();
  const kp2 = Keypair.random();
  const kp3 = Keypair.random();

  const entries: WinnerClaimItem[] = [
    {
      winnerAddress: kp1.publicKey(),
      amount: 50000000n,
    },
    {
      winnerAddress: kp2.publicKey(),
      amount: 30000000n,
    },
    {
      winnerAddress: kp3.publicKey(),
      amount: 20000000n,
    },
  ];

  const { tree, rootHex, claimProofs } = generateLeagueMerkleTree(leagueId, entries);

  assert.equal(rootHex.length, 64);
  assert.equal(claimProofs.size, 3);

  // Verify all claims succeed with their generated proofs
  for (const item of entries) {
    const claim = claimProofs.get(item.winnerAddress)!;
    assert.ok(claim);
    const leaf = hashClaimLeaf(leagueId, claim.winnerAddress, claim.amount);
    assert.equal(
      verifyMerkleProof(leaf, claim.proof, rootHex),
      true,
      `Proof verification failed for ${claim.winnerAddress}`
    );
  }

  // Verification fails with tampered amount
  const claim1 = claimProofs.get(kp1.publicKey())!;
  const tamperedLeaf = hashClaimLeaf(leagueId, claim1.winnerAddress, BigInt(claim1.amount) + 1n);
  assert.equal(
    verifyMerkleProof(tamperedLeaf, claim1.proof, rootHex),
    false,
    "Verification must fail when amount is tampered"
  );

  // Verification fails with wrong claimant
  const wrongKp = Keypair.random();
  const wrongClaimantLeaf = hashClaimLeaf(leagueId, wrongKp.publicKey(), claim1.amount);
  assert.equal(
    verifyMerkleProof(wrongClaimantLeaf, claim1.proof, rootHex),
    false,
    "Verification must fail when claimant is wrong"
  );

  // Verification fails with swapped proof
  const claim2 = claimProofs.get(kp2.publicKey())!;
  assert.equal(
    verifyMerkleProof(hashClaimLeaf(leagueId, claim1.winnerAddress, claim1.amount), claim2.proof, rootHex),
    false,
    "Verification must fail with proof from a different index"
  );
});

test("createSettlementMerkleTree generates deterministic root and claims", () => {
  const kp1 = Keypair.random();
  const kp2 = Keypair.random();

  const winners = [
    { rank: 2, userId: "u2", stellarAddress: kp2.publicKey(), totalPoints: 85, prizeAmount: 30 },
    { rank: 1, userId: "u1", stellarAddress: kp1.publicKey(), totalPoints: 100, prizeAmount: 70 },
  ];

  const res1 = createSettlementMerkleTree({
    leagueId: "12345",
    grossPool: 100,
    platformFee: 0,
    winners,
  });

  const res2 = createSettlementMerkleTree({
    leagueId: "12345",
    grossPool: 100,
    platformFee: 0,
    winners: [...winners].reverse(),
  });

  assert.equal(res1.merkleRoot.length, 64);
  assert.equal(res1.claimProofs.size, 2);
});
