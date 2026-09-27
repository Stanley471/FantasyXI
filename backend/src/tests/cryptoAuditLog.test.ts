import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CryptographicAuditLog,
  GENESIS_HASH,
  calculateAuditHash,
  canonicalizePayload,
} from "../services/audit/cryptoAuditLog.js";
import { runTamperVerificationSimulation } from "../scripts/verifyAuditChain.js";

describe("Cryptographic Audit Logging & Hash Chaining (Issue 158)", () => {
  it("should chain genesis block to initial entry and maintain sequential continuity", () => {
    const logger = new CryptographicAuditLog();

    const entry1 = logger.record(
      "USDC_DEPOSIT",
      "user_1",
      "wallet",
      "wallet_1",
      { amount: "50.00", txHash: "0x123" }
    );

    assert.strictEqual(entry1.sequence, 1);
    assert.strictEqual(entry1.previousHash, GENESIS_HASH);
    assert.ok(entry1.hash && entry1.hash.length === 64);

    const entry2 = logger.record(
      "SQUAD_TRANSFER",
      "user_1",
      "squad",
      "squad_1",
      { in: 10, out: 12, cost: 0 }
    );

    assert.strictEqual(entry2.sequence, 2);
    assert.strictEqual(entry2.previousHash, entry1.hash);

    const entry3 = logger.record(
      "LEAGUE_SETTINGS_UPDATE",
      "admin_1",
      "league",
      "league_1",
      { maxTeams: 16 }
    );

    assert.strictEqual(entry3.sequence, 3);
    assert.strictEqual(entry3.previousHash, entry2.hash);

    const verification = logger.verify();
    assert.strictEqual(verification.valid, true);
    assert.strictEqual(verification.totalEntries, 3);
    assert.strictEqual(verification.lastVerifiedHash, entry3.hash);
  });

  it("should detect simulated database payload tampering", () => {
    const logger = new CryptographicAuditLog();
    logger.record("USDC_DEPOSIT", "user_1", "wallet", "w_1", { amount: "100.00" });
    logger.record("SQUAD_TRANSFER", "user_1", "squad", "sq_1", { in: 7, out: 9 });

    const chain = logger.getChain();
    // Tamper with amount
    chain[0].payload = { amount: "1000.00" };

    const verification = logger.verify(chain);
    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.tamperedIndex, 0);
    assert.ok(verification.error?.includes("Tampered row detected"));
  });

  it("should detect timestamp or actorId tampering", () => {
    const logger = new CryptographicAuditLog();
    logger.record("USDC_DEPOSIT", "user_1", "wallet", "w_1", { amount: "100.00" }, "2026-09-27T00:00:00Z");

    const chain = logger.getChain();
    // Tamper with actorId
    chain[0].actorId = "attacker_99";

    const verification = logger.verify(chain);
    assert.strictEqual(verification.valid, false);
    assert.strictEqual(verification.tamperedIndex, 0);
  });

  it("should detect deleted, injected, or out-of-order rows", () => {
    const logger = new CryptographicAuditLog();
    logger.record("ACTION_A", "user_1", "item", "1", { a: 1 });
    logger.record("ACTION_B", "user_1", "item", "2", { b: 2 });
    logger.record("ACTION_C", "user_1", "item", "3", { c: 3 });

    const chain = logger.getChain();
    // Swap row 1 and row 2
    const swapped = [chain[0], chain[2], chain[1]];

    const verification = logger.verify(swapped);
    assert.strictEqual(verification.valid, false);
    assert.ok(verification.error?.includes("Sequence mismatch") || verification.error?.includes("Broken hash continuity"));
  });

  it("should produce deterministic hashes regardless of object key order", () => {
    const payloadA = { zebra: 1, apple: 2, dog: 3 };
    const payloadB = { apple: 2, dog: 3, zebra: 1 };

    assert.strictEqual(canonicalizePayload(payloadA), canonicalizePayload(payloadB));

    const hashA = calculateAuditHash(GENESIS_HASH, payloadA, "2026-09-27T10:00:00Z", "user_1");
    const hashB = calculateAuditHash(GENESIS_HASH, payloadB, "2026-09-27T10:00:00Z", "user_1");

    assert.strictEqual(hashA, hashB);
  });

  it("should pass end-to-end tamper verification simulation script", () => {
    const simulation = runTamperVerificationSimulation();
    assert.strictEqual(simulation.unalteredSuccess, true);
    assert.strictEqual(simulation.tamperDetected, true);
    assert.ok(simulation.tamperDetails?.includes("Tampered row detected"));
  });
});
