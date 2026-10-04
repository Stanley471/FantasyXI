import {
  CryptographicAuditLog,
  CryptoAuditEntry,
  canonicalizePayload,
  calculateAuditHash,
} from "../services/audit/cryptoAuditLog.js";

/**
 * Audit Hash Chain Verification Utility
 * Can be run standalone or invoked programmatically to detect simulated tampering.
 */
export function runTamperVerificationSimulation(): {
  unalteredSuccess: boolean;
  tamperDetected: boolean;
  tamperDetails?: string;
} {
  const logger = new CryptographicAuditLog();

  // 1. Record series of realistic mutations across transfers, USDC deposits, league settings
  logger.record(
    "USDC_DEPOSIT",
    "user_101",
    "wallet",
    "w_101",
    { amount: "100.00", currency: "USDC", stellarTx: "tx_abc123" },
    "2026-09-27T10:00:00.000Z"
  );

  logger.record(
    "SQUAD_TRANSFER",
    "user_101",
    "squad",
    "sq_456",
    { transferInPlayerId: 301, transferOutPlayerId: 105, cost: 4 },
    "2026-09-27T10:05:00.000Z"
  );

  logger.record(
    "LEAGUE_SETTINGS_UPDATE",
    "admin_001",
    "league",
    "lg_789",
    { maxEntries: 20, entryFee: "10.00", isDraft: true },
    "2026-09-27T10:10:00.000Z"
  );

  const chain = logger.getChain();

  // Verify untouched chain passes
  const initialResult = logger.verify(chain);
  const unalteredSuccess = initialResult.valid;

  // 2. Simulate malicious manual DB alteration (tampering with payload in row 1: e.g. altering transfer cost)
  const tamperedChain: CryptoAuditEntry[] = JSON.parse(JSON.stringify(chain));
  (tamperedChain[1].payload as any).cost = 0; // Hacker set cost to 0!

  const tamperedResult = logger.verify(tamperedChain);
  const tamperDetected = !tamperedResult.valid;

  return {
    unalteredSuccess,
    tamperDetected,
    tamperDetails: tamperedResult.error,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("=== Running Cryptographic Audit Chain Verification ===");
  const result = runTamperVerificationSimulation();
  console.log(`Original Chain Verification: ${result.unalteredSuccess ? "PASSED" : "FAILED"}`);
  console.log(`Tamper Detection Check: ${result.tamperDetected ? "PASSED (Tamper caught)" : "FAILED"}`);
  if (result.tamperDetails) {
    console.log(`Tamper Details Caught: ${result.tamperDetails}`);
  }
}
