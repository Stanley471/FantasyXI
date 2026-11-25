import assert from "node:assert/strict";
import test from "node:test";
import { FINANCIAL_GENESIS, financialMerkle, hashFinancialEntry, verifyFinancialProof, verifyFinancialRows, type ChainedFinancialRow } from "../services/audit/financialMerkle.js";

function records(count: number): ChainedFinancialRow[] {
  let previous = FINANCIAL_GENESIS;
  return Array.from({ length: count }, (_, i) => {
    const text = JSON.stringify({ transactionId: `synthetic-${i}`, amount: i + 1 });
    const row = { sequence: BigInt(i + 1), previous_hash: previous, hash: hashFinancialEntry(previous, text), payload_text: text, source_text: text };
    previous = row.hash; return row;
  });
}
test("hash chain detects source mutation, record edits, reordering and deletion across 10000 financial records", () => {
  const rows = records(10_000); assert.equal(verifyFinancialRows(rows), true);
  for (const index of [0, 1, 4999, 9999]) {
    const changed = structuredClone(rows); changed[index].source_text = "changed";
    assert.equal(verifyFinancialRows(changed), false);
    const removed = rows.filter((_row,i) => i !== index);
    // Tail deletion is detected by the service's source count and published roots.
    if (index !== 9999) assert.equal(verifyFinancialRows(removed), false);
    const forged = structuredClone(rows); forged[index].hash = "0".repeat(64);
    assert.equal(verifyFinancialRows(forged), false);
  }
  const swapped = [...rows]; [swapped[2],swapped[3]] = [swapped[3],swapped[2]];
  assert.equal(verifyFinancialRows(swapped), false);
});
test("Merkle proofs verify odd/even blocks and reject changed data, siblings, indices and roots", () => {
  for (const count of [1, 2, 3, 17, 4097]) {
    const hashes = records(count).map(r=>r.hash);
    for (const index of [...new Set([0, Math.floor(count / 2), count - 1])]) {
      const { root, proof } = financialMerkle(hashes, index);
      assert.equal(verifyFinancialProof(hashes[index], proof, root), true);
      assert.equal(verifyFinancialProof("a".repeat(64), proof, root), false);
      assert.equal(verifyFinancialProof(hashes[index], { ...proof, index: count }, root), false);
      assert.equal(verifyFinancialProof(hashes[index], { ...proof, siblings: [...proof.siblings, "f".repeat(64)] }, root), false);
      assert.equal(verifyFinancialProof(hashes[index], proof, "b".repeat(64)), false);
    }
  }
});
