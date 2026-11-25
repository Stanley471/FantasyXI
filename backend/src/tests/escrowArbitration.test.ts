import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EscrowArbitrationService,
  LeagueEscrowState,
} from "../services/financial/escrowArbitrationService.js";
import type {
  InvocationResult,
  SorobanContractClient,
} from "../services/financial/sorobanContractClient.js";
import {
  Permission,
  Role,
  hasPermission,
} from "../config/permissions.js";

function createMockContractClient() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    refundWithMultisig: async (
      approverSecrets: string[],
      leagueId: number | bigint,
      participants: string[],
      requiredThreshold: number
    ): Promise<InvocationResult> => {
      calls.push({
        method: "refundWithMultisig",
        args: [approverSecrets, leagueId, participants, requiredThreshold],
      });
      return { success: true, txHash: "0xmultisig_refund_tx_hash_419" };
    },
    executeTimeoutProportionalRefund: async (
      callerSecret: string,
      callerPublic: string,
      leagueId: number | bigint,
      proposalId: number | bigint
    ): Promise<InvocationResult> => {
      calls.push({
        method: "executeTimeoutProportionalRefund",
        args: [callerSecret, callerPublic, leagueId, proposalId],
      });
      return { success: true, txHash: "0xtimeout_refund_tx_hash_419" };
    },
  } as unknown as SorobanContractClient;

  return { client, calls };
}

describe("EscrowArbitrationService (Issue #419)", () => {
  it("enforces 2-of-3 threshold before broadcasting and logs full audit trail", async () => {
    const { client, calls } = createMockContractClient();
    const service = new EscrowArbitrationService({
      contractClient: client,
      defaultThreshold: 2,
      defaultLockWindowMs: 3_600_000,
    });

    const leagueAdmin = Keypair.random();
    const arbitrator = Keypair.random();
    const leagueId = "41900000-0000-0000-0000-000000000001";

    // 1. Initiate refund proposal -> DISPUTED
    const proposal = service.initiateRefundProposal({
      leagueId,
      reason: "Cancelled matchday due to fixture postponement",
      participants: [
        { address: Keypair.random().publicKey(), amountStroops: 10_000_000n },
        { address: Keypair.random().publicKey(), amountStroops: 10_000_000n },
      ],
      operatorId: "admin-op-1",
    });

    assert.equal(proposal.escrowState, LeagueEscrowState.DISPUTED);
    assert.equal(
      service.getLeagueEscrowState(leagueId),
      LeagueEscrowState.DISPUTED
    );

    // 2. Collect 1st signature -> ARBITRATION_PENDING
    service.collectSignature(proposal.id, {
      signerPublicKey: leagueAdmin.publicKey(),
      signerSecret: leagueAdmin.secret(),
      operatorId: "admin-op-1",
      role: "LEAGUE_ADMIN",
    });
    assert.equal(
      service.getLeagueEscrowState(leagueId),
      LeagueEscrowState.ARBITRATION_PENDING
    );

    // 3. Partial signature scenario: broadcast must fail WITHOUT calling Soroban RPC
    await assert.rejects(
      () => service.broadcastRefundProposal(proposal.id, "admin-op-1"),
      /Insufficient signatures to broadcast refund proposal/
    );
    assert.equal(calls.length, 0);

    // 4. Duplicate signer rejected
    assert.throws(
      () =>
        service.collectSignature(proposal.id, {
          signerPublicKey: leagueAdmin.publicKey(),
          signerSecret: leagueAdmin.secret(),
          operatorId: "admin-op-1",
          role: "LEAGUE_ADMIN",
        }),
      /already signed/
    );

    // 5. Collect 2nd signature (2-of-3 quorum reached) and broadcast
    service.collectSignature(proposal.id, {
      signerPublicKey: arbitrator.publicKey(),
      signerSecret: arbitrator.secret(),
      operatorId: "arb-op-2",
      role: "PLATFORM_ARBITRATOR",
    });

    const executed = await service.broadcastRefundProposal(
      proposal.id,
      "arb-op-2"
    );
    assert.equal(executed.escrowState, LeagueEscrowState.REFUNDED);
    assert.equal(executed.txHash, "0xmultisig_refund_tx_hash_419");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "refundWithMultisig");

    // 6. Verify full audit trail with operator IDs, dispute reasons, and tx hashes
    const audit = service.getAuditTrail(leagueId);
    assert.equal(audit.length, 4);
    assert.equal(audit[0].action, "PROPOSAL_INITIATED");
    assert.equal(audit[0].operatorId, "admin-op-1");
    assert.equal(audit[3].action, "MULTISIG_REFUND_BROADCAST");
    assert.equal(audit[3].operatorId, "arb-op-2");
    assert.equal(audit[3].txHash, "0xmultisig_refund_tx_hash_419");
  });

  it("rejects forged cryptographic signatures", () => {
    const { client } = createMockContractClient();
    const service = new EscrowArbitrationService({ contractClient: client });
    const signer = Keypair.random();
    const other = Keypair.random();

    const proposal = service.initiateRefundProposal({
      leagueId: "41900000-0000-0000-0000-000000000002",
      reason: "Contested gameweek payout",
      participants: [
        { address: Keypair.random().publicKey(), amountStroops: 5_000_000n },
      ],
      operatorId: "admin-op-1",
    });

    const forgedSig = other
      .sign(Buffer.from(proposal.payloadDigestHex, "hex"))
      .toString("hex");

    assert.throws(
      () =>
        service.collectSignature(proposal.id, {
          signerPublicKey: signer.publicKey(),
          signatureHex: forgedSig,
          operatorId: "arb-op-2",
          role: "PLATFORM_ARBITRATOR",
        }),
      /Invalid cryptographic signature/
    );
  });

  it("transitions unreviewed disputes to proportional refund mode after consensus timeout", async () => {
    const { client, calls } = createMockContractClient();
    const serviceCaller = Keypair.random();
    const service = new EscrowArbitrationService({
      contractClient: client,
      defaultThreshold: 2,
      defaultLockWindowMs: 60_000,
      serviceCallerSecret: serviceCaller.secret(),
      serviceCallerPublic: serviceCaller.publicKey(),
    });

    const t0 = new Date("2026-11-24T12:00:00.000Z");
    const leagueId = "41900000-0000-0000-0000-000000000003";

    const proposal = service.initiateRefundProposal(
      {
        leagueId,
        reason: "Unresponsive arbitrator consensus timeout",
        participants: [
          { address: Keypair.random().publicKey(), amountStroops: 20_000_000n },
        ],
        operatorId: "admin-op-1",
        onChainProposalId: 7n,
      },
      t0
    );

    // Before lock window elapses: nothing transitions
    const beforeTimeout = await service.processExpiredDisputes(
      new Date(t0.getTime() + 30_000)
    );
    assert.equal(beforeTimeout.length, 0);
    assert.equal(
      service.getLeagueEscrowState(leagueId),
      LeagueEscrowState.DISPUTED
    );

    // After lock window elapses: transitions to proportional refund mode -> REFUNDED
    const afterTimeout = await service.processExpiredDisputes(
      new Date(t0.getTime() + 61_000),
      "system:timeout-arbiter"
    );
    assert.equal(afterTimeout.length, 1);
    assert.equal(afterTimeout[0].id, proposal.id);
    assert.equal(afterTimeout[0].proportionalMode, true);
    assert.equal(afterTimeout[0].escrowState, LeagueEscrowState.REFUNDED);
    assert.equal(afterTimeout[0].txHash, "0xtimeout_refund_tx_hash_419");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "executeTimeoutProportionalRefund");

    const audit = service.getAuditTrail(leagueId);
    const timeoutEntry = audit.find(
      (e) => e.action === "TIMEOUT_PROPORTIONAL_REFUND"
    );
    assert.ok(timeoutEntry);
    assert.equal(timeoutEntry.operatorId, "system:timeout-arbiter");
    assert.equal(timeoutEntry.txHash, "0xtimeout_refund_tx_hash_419");
  });

  it("enforces RBAC permissions for dispute inspection and arbitration", () => {
    assert.equal(hasPermission(Role.USER, Permission.DISPUTE_INSPECT), false);
    assert.equal(hasPermission(Role.USER, Permission.DISPUTE_ARBITRATE), false);
    assert.equal(
      hasPermission(Role.MODERATOR, Permission.DISPUTE_INSPECT),
      true
    );
    assert.equal(
      hasPermission(Role.MODERATOR, Permission.DISPUTE_ARBITRATE),
      false
    );
    assert.equal(hasPermission(Role.ADMIN, Permission.DISPUTE_INSPECT), true);
    assert.equal(hasPermission(Role.ADMIN, Permission.DISPUTE_ARBITRATE), true);
    assert.equal(hasPermission(Role.SERVICE, Permission.DISPUTE_INSPECT), true);
    assert.equal(
      hasPermission(Role.SERVICE, Permission.DISPUTE_ARBITRATE),
      true
    );
  });
});
