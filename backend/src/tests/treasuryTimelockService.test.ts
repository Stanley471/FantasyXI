import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  TreasuryTimelockService,
  TreasurySecurityError,
  DEFAULT_TIMELOCK_DURATION_MS,
} from "../services/financial/treasuryTimelockService.js";

function createTestSigners() {
  const admin1 = crypto.generateKeyPairSync("ed25519");
  const admin2 = crypto.generateKeyPairSync("ed25519");
  const admin3 = crypto.generateKeyPairSync("ed25519");

  return {
    publicKeys: {
      "admin-1": admin1.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "admin-2": admin2.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "admin-3": admin3.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    privateKeys: {
      "admin-1": admin1.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "admin-2": admin2.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "admin-3": admin3.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
  };
}

test("TreasuryTimelockService: enforces 2-of-3 Ed25519 signature quorum and 48-hour timelock window", () => {
  const signers = createTestSigners();
  const service = new TreasuryTimelockService({
    authorizedSigners: signers.publicKeys,
    requiredSignatures: 2,
    timelockDurationMs: DEFAULT_TIMELOCK_DURATION_MS,
  });

  const t0 = 1_700_000_000_000;
  const proposal = service.createProposal({
    proposerId: "admin-1",
    destinationAddress: "GDESTINATIONTREASURY1234567890",
    assetCode: "USDC",
    amount: 25_000,
    reason: "Q4 Liquidity Rebalance",
    nowMs: t0,
  });

  // 1. First approval by admin-1 keeps status in PENDING_APPROVALS
  const sig1 = TreasuryTimelockService.signProposalPayload(
    proposal,
    signers.privateKeys["admin-1"]
  );
  const afterFirst = service.approveProposal({
    proposalId: proposal.proposalId,
    signerId: "admin-1",
    signatureBase64: sig1,
    nowMs: t0 + 1000,
  });
  assert.equal(afterFirst.status, "PENDING_APPROVALS");

  // Duplicate approval by admin-1 must fail
  assert.throws(
    () =>
      service.approveProposal({
        proposalId: proposal.proposalId,
        signerId: "admin-1",
        signatureBase64: sig1,
        nowMs: t0 + 2000,
      }),
    TreasurySecurityError
  );

  // Forged signature by admin-2 (using admin-3's private key) must fail
  const forgedSig = TreasuryTimelockService.signProposalPayload(
    proposal,
    signers.privateKeys["admin-3"]
  );
  assert.throws(
    () =>
      service.approveProposal({
        proposalId: proposal.proposalId,
        signerId: "admin-2",
        signatureBase64: forgedSig,
        nowMs: t0 + 3000,
      }),
    /Invalid Ed25519 signature/
  );

  // 2. Valid second approval by admin-2 reaches 2-of-3 quorum and starts 48-hour timelock
  const sig2 = TreasuryTimelockService.signProposalPayload(
    proposal,
    signers.privateKeys["admin-2"]
  );
  const quorumTime = t0 + 5000;
  const afterSecond = service.approveProposal({
    proposalId: proposal.proposalId,
    signerId: "admin-2",
    signatureBase64: sig2,
    nowMs: quorumTime,
  });
  assert.equal(afterSecond.status, "TIMELOCK_QUEUED");
  assert.equal(
    afterSecond.timelockExpiresAtMs,
    quorumTime + DEFAULT_TIMELOCK_DURATION_MS
  );

  // 3. Execution attempt at +24 hours (before 48h timelock expires) MUST fail
  assert.throws(
    () =>
      service.executeProposal({
        proposalId: proposal.proposalId,
        executorId: "admin-1",
        nowMs: quorumTime + 24 * 60 * 60 * 1000,
      }),
    /Treasury timelock is still active/
  );

  // 4. Execution at +48 hours + 1 second succeeds
  const executed = service.executeProposal({
    proposalId: proposal.proposalId,
    executorId: "admin-1",
    nowMs: quorumTime + DEFAULT_TIMELOCK_DURATION_MS + 1000,
  });
  assert.equal(executed.status, "EXECUTED");
  assert.ok(executed.executedTxHash?.startsWith("stellar_tx_"));

  // Audit chain integrity must be valid
  assert.equal(service.verifyAuditChainIntegrity(), true);
  assert.equal(service.getAuditChain().length, 5);
});

test("TreasuryTimelockService: allows emergency cancellation during the 48-hour timelock grace window", () => {
  const signers = createTestSigners();
  const service = new TreasuryTimelockService({
    authorizedSigners: signers.publicKeys,
    requiredSignatures: 2,
  });

  const t0 = 1_700_000_000_000;
  const proposal = service.createProposal({
    proposerId: "admin-1",
    destinationAddress: "GSUSPICIOUSDESTINATION999",
    assetCode: "USDC",
    amount: 50_000,
    reason: "Emergency test",
    nowMs: t0,
  });

  service.approveProposal({
    proposalId: proposal.proposalId,
    signerId: "admin-1",
    signatureBase64: TreasuryTimelockService.signProposalPayload(
      proposal,
      signers.privateKeys["admin-1"]
    ),
    nowMs: t0 + 1000,
  });

  service.approveProposal({
    proposalId: proposal.proposalId,
    signerId: "admin-2",
    signatureBase64: TreasuryTimelockService.signProposalPayload(
      proposal,
      signers.privateKeys["admin-2"]
    ),
    nowMs: t0 + 2000,
  });

  // Admin-3 cancels the queued proposal 10 hours into the 48h timelock window
  const cancelled = service.cancelProposal({
    proposalId: proposal.proposalId,
    actorId: "admin-3",
    reason: "Destination address failed cold-storage verification",
    nowMs: t0 + 10 * 60 * 60 * 1000,
  });
  assert.equal(cancelled.status, "CANCELLED");

  // Even after 48 hours have elapsed, a cancelled proposal cannot be executed
  assert.throws(
    () =>
      service.executeProposal({
        proposalId: proposal.proposalId,
        executorId: "admin-1",
        nowMs: t0 + DEFAULT_TIMELOCK_DURATION_MS + 100_000,
      }),
    /cannot be executed from state CANCELLED/
  );
});
